/**
 * OpenAI Responses client. Prompts are owned in the OpenAI dashboard
 * (hosted pmpt_ ids). Code never loads customer prompt files at runtime,
 * never invents customer sentences, and only sends facts + strict schemas.
 */
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  AppError,
  commandSchema,
  planSchema,
  type Command,
  type Context,
  type Notice,
  type Plan,
  type Request,
} from "../domain/types.js";
import { conversationLanguage } from "../domain/customer-language.js";
import {
  conversationAlreadyIntroduced,
  emptyClaims,
  type ReplyClaims,
} from "../domain/ai-guards.js";
import {
  buildStage1Facts,
  buildStage2Facts,
  defaultRulesState,
  renderWriteMapMarkdown,
  type ActionResultFact,
  type NoticeFact,
  type RulesState,
  type TurnFacts,
} from "../domain/turn-facts.js";
import type { ChangedField } from "../domain/field-map.js";

export function promptSha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface DecodeResult {
  understood: boolean;
  plan: Plan;
  metadata: Record<string, unknown>;
}

export interface ReplyResult {
  text: string;
  claims: ReplyClaims;
  metadata: Record<string, unknown>;
}

export interface ReplyInput {
  rules: RulesState;
  commands: unknown[];
  results: ActionResultFact[];
  changed: ChangedField[];
  boundary: TurnFacts["this_turn"]["boundary"];
  notices: NoticeFact[];
  /** Only used when AI is disabled — never a customer template under normal path. */
  fallback?: string;
  guardFeedback?: { rejected_claims: string[] };
}

export interface Planner {
  plan(context: Context, rules?: RulesState): Promise<DecodeResult>;
  reply(context: Context, input: ReplyInput): Promise<ReplyResult>;
  phraseNotice(
    context: Context,
    notice: Notice,
    request: Request | null,
    facts?: Record<string, unknown>,
  ): Promise<{ text: string; metadata: Record<string, unknown> }>;
  close(): Promise<void>;
}

const decodeResponseSchema = z.strictObject({
  commands: z.array(z.unknown()).min(1).max(5),
  evidence: z.string().max(2000),
});
const decodeSchemaSource = z.strictObject({
  commands: z.array(commandSchema).min(1).max(5),
  evidence: z.string().max(2000),
});

const replyClaimsSchema = z.strictObject({
  saved: z.array(z.string()).max(40),
  contacted_counterparty: z.boolean(),
  opened_request: z.number().int().positive().nullable(),
  schedule_date: z.string().nullable(),
  cancelled: z.boolean(),
  human_handoff: z.boolean(),
});

const replyResponseSchema = z.strictObject({
  reply: z.string().trim().min(1).max(4000),
  claims: replyClaimsSchema.default({
    saved: [],
    contacted_counterparty: false,
    opened_request: null,
    schedule_date: null,
    cancelled: false,
    human_handoff: false,
  }),
});

type JsonSchemaObject = Record<string, unknown>;

/** Responses strict JSON Schema requires all object properties to be required. */
function toResponsesStrictSchema(source: JsonSchemaObject): JsonSchemaObject {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const node = value as JsonSchemaObject;
    const result: JsonSchemaObject = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$schema") continue;
      if (key === "oneOf") result.anyOf = visit(child);
      else result[key] = visit(child);
    }
    if (result.type === "object" && result.properties && typeof result.properties === "object") {
      const properties = result.properties as JsonSchemaObject;
      const wasRequired = new Set(
        Array.isArray(node.required)
          ? node.required.filter((field): field is string => typeof field === "string")
          : [],
      );
      for (const [key, property] of Object.entries(properties)) {
        if (!wasRequired.has(key)) properties[key] = { anyOf: [property, { type: "null" }] };
      }
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return visit(source) as JsonSchemaObject;
}

const decodeOutputJsonSchema = toResponsesStrictSchema(
  z.toJSONSchema(decodeSchemaSource) as JsonSchemaObject,
);

const replyOutputJsonSchema = toResponsesStrictSchema(
  z.toJSONSchema(
    z.strictObject({
      reply: z.string().trim().min(1).max(4000),
      claims: replyClaimsSchema,
    }),
  ) as JsonSchemaObject,
);

function asCommands(raw: unknown[]): Command[] {
  const out: Command[] = [];
  for (const entry of raw.slice(0, 5)) {
    const parsed = commandSchema.safeParse(normalizeWireCommand(entry));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function normalizeWireCommand(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const command = { ...(raw as Record<string, unknown>) };
  if (command.type === "donate") {
    if (command.counterparty_name === null) delete command.counterparty_name;
    if (command.direct === null) delete command.direct;
  }
  return command;
}

export function translate(
  payload: unknown,
  _ctx: Context,
  text: string,
): { understood: boolean; plan: Plan } {
  const decoded = decodeResponseSchema.safeParse(payload);
  if (!decoded.success) throw new AppError("invalid_action_plan");
  const commands = asCommands(decoded.data.commands);
  if (commands.length !== decoded.data.commands.length)
    throw new AppError("invalid_action_plan");
  return {
    understood: true,
    plan: planSchema.parse({
      commands,
      evidence: decoded.data.evidence || text.slice(0, 2000),
    }),
  };
}

function requireHosted(
  id: string | undefined,
  version: string | undefined,
  kind: "action" | "reply",
): { id: string; version: string } {
  if (!id?.trim() || !version?.trim())
    throw new AppError(`missing_hosted_${kind}_prompt`);
  return { id: id.trim(), version: version.trim() };
}

const OPENING_COMMANDS = new Set(["donate", "receive_from_donor", "seek"]);

function hasOpenRequest(ctx: Context): boolean {
  return ctx.requests.some(
    (request) =>
      !["coordinated", "closed", "cancelled", "rejected", "cancel_pending"].includes(
        request.status,
      ),
  );
}

export function actionableAiPlan(
  translated: { understood: boolean; plan: Plan },
  ctx: Context,
): boolean {
  if (!translated.understood) return false;
  const commands = translated.plan.commands.filter(
    (command) => command.type !== "next",
  );
  if (!commands.length) return false;
  if (hasOpenRequest(ctx)) return true;
  return commands.some((command) => OPENING_COMMANDS.has(command.type));
}

/** Action manager owns the plan. No rule-planner bridge. */
export function selectDecodePlan(
  translated: { understood: boolean; plan: Plan },
  _deterministic: Plan | null,
  _ctx: Context,
): { plan: Plan; useAi: boolean; understood: boolean } {
  return {
    plan: translated.plan,
    useAi: translated.understood,
    understood: translated.understood,
  };
}

export class OpenAIPlanner implements Planner {
  private readonly client: OpenAI;
  constructor(private readonly c: Config) {
    this.client = new OpenAI({
      apiKey: c.OPENAI_API_KEY || "disabled",
      timeout: c.OPENAI_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  async close(): Promise<void> {
    // The OpenAI client has no lifecycle resources that need explicit shutdown.
  }

  async plan(ctx: Context, rules?: RulesState): Promise<DecodeResult> {
    const text = ctx.message.transcript ?? ctx.message.text;
    if (!this.c.AI_ENABLED) {
      return {
        understood: false,
        plan: { commands: [{ type: "next" }], evidence: text.slice(0, 2000) },
        metadata: {
          provider: "rules",
          ai_enabled: false,
          action_source: "unclear_ai_disabled",
        },
      };
    }
    const started = Date.now();
    const hosted = requireHosted(
      this.c.OPENAI_ACTION_PROMPT_ID,
      this.c.OPENAI_ACTION_PROMPT_VERSION,
      "action",
    );
    const rulesState = rules ?? defaultRulesState(this.c.TRANSPORT_CAPACITY);
    const facts = buildStage1Facts({
      ctx,
      rules: rulesState,
      alreadyIntroduced: conversationAlreadyIntroduced(ctx.history),
      customerLanguage: conversationLanguage(ctx),
    });
    // Facts travel in the user JSON payload. Prompt variables are only sent
    // after they are declared on the hosted prompt (dashboard); undeclared
    // variables cause a 400 from the Responses API.
    const userPayload = {
      history: facts.history,
      current_message: facts.current_message,
      sender_phone: facts.sender_phone,
      contacts: facts.contacts,
      has_location: facts.has_location,
      media_kind: facts.media_kind,
      customer_language: facts.customer_language,
      state: facts.state,
      rules: facts.rules,
      completeness: facts.this_turn.completeness,
      data_map: facts.data_map || renderWriteMapMarkdown(),
    };
    const response = await this.client.responses.create({
      prompt: {
        id: hosted.id,
        version: hosted.version,
      },
      text: {
        format: {
          type: "json_schema",
          name: "haim_action_plan",
          strict: true,
          schema: decodeOutputJsonSchema,
        },
      },
      input: [
        {
          role: "user",
          content: JSON.stringify(userPayload),
        },
      ],
    });
    let payload: unknown;
    try {
      payload = JSON.parse(response.output_text);
    } catch {
      throw new AppError("invalid_managed_prompt_response");
    }
    const translated = translate(payload, ctx, text);
    return {
      understood: translated.understood,
      plan: translated.plan,
      metadata: {
        provider: "openai_responses_decode",
        prompt_mode: "hosted",
        prompt_id: hosted.id,
        prompt_version: hosted.version,
        model: response.model ?? this.c.OPENAI_MODEL,
        action_source: "ai_action_manager",
        understood: translated.understood,
        bridged_rules: false,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
        model_input: {
          prompt_mode: "hosted",
          prompt_id: hosted.id,
          prompt_version: hosted.version,
          payload: userPayload,
        },
        model_output: {
          raw: response.output_text,
          parsed: payload,
        },
        raw_output: response.output_text,
      },
    };
  }

  async reply(ctx: Context, input: ReplyInput): Promise<ReplyResult> {
    if (!this.c.AI_ENABLED) {
      return {
        text: input.fallback?.trim() || "קיבלתי.",
        claims: emptyClaims(),
        metadata: { provider: "fallback", ai_enabled: false },
      };
    }
    const started = Date.now();
    const hosted = requireHosted(
      this.c.OPENAI_REPLY_PROMPT_ID,
      this.c.OPENAI_REPLY_PROMPT_VERSION,
      "reply",
    );
    const facts = buildStage2Facts({
      ctx,
      rules: input.rules,
      alreadyIntroduced: conversationAlreadyIntroduced(ctx.history),
      customerLanguage: conversationLanguage(ctx),
      commands: input.commands,
      results: input.results,
      changed: input.changed,
      boundary: input.boundary,
      notices: input.notices,
    });
    const userPayload = {
      history: facts.history,
      current_message: facts.current_message,
      customer_language: facts.customer_language,
      already_introduced: facts.already_introduced,
      sender_phone: facts.sender_phone,
      state: facts.state,
      rules: facts.rules,
      this_turn: facts.this_turn,
      data_map: facts.data_map,
      ...(input.guardFeedback
        ? { guard_feedback: input.guardFeedback }
        : {}),
    };
    const response = await this.client.responses.create({
      prompt: {
        id: hosted.id,
        version: hosted.version,
      },
      text: {
        format: {
          type: "json_schema",
          name: "haim_reply",
          strict: true,
          schema: replyOutputJsonSchema,
        },
      },
      input: [
        {
          role: "user",
          content: JSON.stringify(userPayload),
        },
      ],
    });
    let payload: unknown;
    try {
      payload = JSON.parse(response.output_text);
    } catch {
      throw new AppError("invalid_reply_manager_response");
    }
    const parsed = replyResponseSchema.safeParse(payload);
    if (!parsed.success) throw new AppError("invalid_reply_manager_response");
    return {
      text: parsed.data.reply,
      claims: parsed.data.claims,
      metadata: {
        provider: "openai_responses_reply_manager",
        prompt_mode: "hosted",
        prompt_id: hosted.id,
        prompt_version: hosted.version,
        model: response.model ?? this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
        claims: parsed.data.claims,
        model_input: {
          prompt_mode: "hosted",
          prompt_id: hosted.id,
          prompt_version: hosted.version,
          payload: userPayload,
        },
        model_output: {
          raw: response.output_text,
          parsed: payload,
        },
        raw_output: response.output_text,
      },
    };
  }

  async phraseNotice(
    ctx: Context,
    notice: Notice,
    request: Request | null,
    facts: Record<string, unknown> = {},
  ): Promise<{ text: string; metadata: Record<string, unknown> }> {
    // Notices are still AI-written via the reply hosted prompt in notice mode.
    if (!this.c.AI_ENABLED)
      return {
        text: notice.text,
        metadata: { provider: "fallback", ai_enabled: false },
      };
    const hosted = requireHosted(
      this.c.OPENAI_REPLY_PROMPT_ID,
      this.c.OPENAI_REPLY_PROMPT_VERSION,
      "reply",
    );
    const started = Date.now();
    const userPayload = {
      mode: "notice_to_counterparty",
      notice_recipient_phone: notice.phone,
      notice_facts: facts,
      notice_draft_facts: notice.text,
      sender_phone: ctx.conversation.phone,
      request: request
        ? {
            number: request.number,
            status: request.status,
            items: request.items.map((item) => ({
              kind: item.kind,
              description: item.description,
            })),
            parties: request.parties.map((party) => ({
              role: party.role,
              name: party.name,
              settlement: party.settlement,
            })),
          }
        : null,
      history: ctx.history,
    };
    const response = await this.client.responses.create({
      prompt: {
        id: hosted.id,
        version: hosted.version,
      },
      text: {
        format: {
          type: "json_schema",
          name: "haim_reply",
          strict: true,
          schema: replyOutputJsonSchema,
        },
      },
      input: [{ role: "user", content: JSON.stringify(userPayload) }],
    });
    let payload: unknown;
    try {
      payload = JSON.parse(response.output_text);
    } catch {
      return {
        text: notice.text,
        metadata: { provider: "fallback_parse", ai_enabled: true },
      };
    }
    const parsed = replyResponseSchema.safeParse(payload);
    return {
      text: parsed.success ? parsed.data.reply : notice.text,
      metadata: {
        provider: "openai_responses_notice",
        prompt_mode: "hosted",
        prompt_id: hosted.id,
        prompt_version: hosted.version,
        model: response.model ?? this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }
}
