import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { conversationAlreadyIntroduced } from "../domain/ai-guards.js";
import { nextQuestion } from "../domain/policies.js";
import { dataMapSection } from "../domain/field-map.js";
import { rulePlan } from "../application/rule-planner.js";

const here = dirname(fileURLToPath(import.meta.url));
function loadPrompt(name: string): string {
  const candidates = [
    join(process.cwd(), "prompts", name),
    join(here, "../../prompts", name),
    join(here, "../../../prompts", name),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`missing_prompt_file:${name}`);
}
const ACTION_PROMPT_TEXT = loadPrompt("haim-action.he.md");
const REPLY_PROMPT_TEXT = loadPrompt("haim-reply.he.md");
const DATA_MAP_TEXT = loadPrompt("haim-data-map.he.md");
const ACTION_INSTRUCTIONS = `${ACTION_PROMPT_TEXT}\n\n${dataMapSection(DATA_MAP_TEXT, "מה נשמר ואיפה")}`;
const REPLY_INSTRUCTIONS = `${REPLY_PROMPT_TEXT}\n\n${dataMapSection(DATA_MAP_TEXT, "מה מותר לומר")}`;

export function promptSha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface DecodeResult {
  understood: boolean;
  plan: Plan;
  metadata: Record<string, unknown>;
}

export interface Planner {
  plan(context: Context): Promise<DecodeResult>;
  reply(
    context: Context,
    input: { operation: Record<string, unknown>; fallback: string },
  ): Promise<{ text: string; metadata: Record<string, unknown> }>;
  phraseReply(
    canonical: string,
    context: Context,
  ): Promise<{ text: string; metadata: Record<string, unknown> }>;
  phraseNotice(
    context: Context,
    notice: Notice,
    request: Request | null,
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
const replyResponseSchema = z.strictObject({ reply: z.string().trim().min(1).max(4000) });

/** Legacy hosted-prompt shape still accepted while the decode prompt is rolled out. */
const managedResponseSchema = z
  .object({
    reply: z.string().default(""),
    service: z
      .enum(["furniture_transport", "sukkah", "unclear"])
      .default("unclear"),
    intent: z
      .enum([
        "donate",
        "request",
        "transport",
        "self_move",
        "cancellation",
        "unclear",
      ])
      .default("unclear"),
    updates: z.record(z.string(), z.unknown()).default({}),
    actions: z.record(z.string(), z.unknown()).default({}),
    understood: z.boolean().optional(),
    commands: z.array(z.unknown()).optional(),
    evidence: z.string().optional(),
  })
  .passthrough();

const boolValue = (
  updates: Record<string, unknown>,
  key: string,
): boolean | null => {
  const value = updates[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (/^(?:כן|yes|true|1)$/i.test(value.trim())) return true;
  if (/^(?:לא|no|false|0)$/i.test(value.trim())) return false;
  return null;
};

const action = (actions: Record<string, unknown>, key: string): boolean =>
  actions[key] === true || actions[key] === "true" || actions[key] === "כן";

export function managedNeedsHuman(
  actions: Record<string, unknown>,
  updates: Record<string, unknown>,
): boolean {
  return (
    action(actions, "needs_human") ||
    boolValue(updates, "נדרש טיפול אנושי") === true
  );
}

function asCommands(raw: unknown[]): Command[] {
  const out: Command[] = [];
  for (const entry of raw.slice(0, 5)) {
    const parsed = commandSchema.safeParse(entry);
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

/**
 * Map a decode model payload into a validated Plan.
 * Prefer an explicit commands array. Fall back to legacy updates/actions only
 * for a few safe mappings while the hosted decode prompt is being published.
 */
export function translate(payload: unknown, _ctx: Context, text: string): { understood: boolean; plan: Plan } {
  const decoded = decodeResponseSchema.safeParse(payload);
  if (!decoded.success) throw new AppError("invalid_action_plan");
  const commands = asCommands(decoded.data.commands.map(normalizeWireCommand));
  if (commands.length !== decoded.data.commands.length) throw new AppError("invalid_action_plan");
  return { understood: true, plan: planSchema.parse({ commands, evidence: decoded.data.evidence || text.slice(0, 2000) }) };
}

function snapshotForDecode(ctx: Context) {
  const open = ctx.requests.filter(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );
  const selected =
    open.find((r) => r.id === ctx.conversation.selected_request_id) ??
    ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
    open[0] ??
    ctx.requests[0] ??
    null;
  const missing =
    selected && selected.status !== "rejected"
      ? nextQuestion(selected, ctx.conversation.phone).missing
      : selected?.status === "rejected"
        ? {
            field: "settlement",
            role: selected.parties.find((p) => p.phone === ctx.conversation.phone)
              ?.role ?? null,
            request_number: selected.number,
          }
        : null;
  return {
    conversation: ctx.conversation,
    selected_request: selected
      ? {
          number: selected.number,
          status: selected.status,
          origin: selected.origin,
          proposed_run_date: selected.proposed_run_date,
          preferred_time: selected.preferred_time ?? null,
          represents_both_parties: selected.represents_both_parties ?? false,
          verification_contacted: selected.verification_contacted,
          verification_states: selected.verification_states ?? [],
          parties: selected.parties,
          items: selected.items,
        }
      : null,
    open_requests: open.map((r) => ({
      number: r.number,
      status: r.status,
      origin: r.origin,
    })),
    recoverable_requests: ctx.requests
      .filter((r) => r.status === "rejected")
      .map((r) => ({
        number: r.number,
        status: r.status,
        origin: r.origin,
        reason: "outside_area_or_rules",
      })),
    missing_required: missing,
    active_search: ctx.active_search ?? null,
    history: ctx.history,
  };
}

type PromptSource =
  | { mode: "hosted"; id: string; version: string }
  | { mode: "git"; instructions: string };

function decodePromptSource(_c: Config): PromptSource {
  // The hosted action prompt currently contains an older "missing detail => next"
  // rule that suppresses explicit facts such as "I want to give a bed to Tal".
  // Keep the action contract versioned in the repository and send it as the
  // actual Responses instruction so the model cannot treat it as user data.
  return { mode: "git", instructions: ACTION_INSTRUCTIONS };
}

function withCanonical(instructions: string, canonical: string): string {
  return instructions.split("{{canonical}}").join(canonical);
}

function replyPromptSource(_c: Config, canonical = ""): PromptSource {
  return { mode: "git", instructions: withCanonical(REPLY_INSTRUCTIONS, canonical) };
}

function phrasePromptSource(_c: Config, canonical: string): PromptSource {
  return { mode: "git", instructions: withCanonical(REPLY_INSTRUCTIONS, canonical) };
}

function extractPhraseText(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = managedResponseSchema.safeParse(JSON.parse(trimmed));
    if (parsed.success && parsed.data.reply.trim())
      return parsed.data.reply.trim();
    const loose = JSON.parse(trimmed) as { reply?: string; text?: string };
    const fromLoose = (loose.reply ?? loose.text ?? "").trim();
    if (fromLoose) return fromLoose;
  } catch {
    /* plain text from git phrase instructions */
  }
  return trimmed;
}

function phraseUserContent(mode: PromptSource["mode"], canonical: string, ctx: Context): string {
  const lang = conversationLanguage(ctx);
  const languageLine =
    lang === "he"
      ? ""
      : `\nCustomer language: ${lang}. Return the same meaning in that language only.`;
  if (mode === "git")
    return `נסח מחדש בלבד את המשפט המחייב. החזר טקסט בלבד, בלי JSON.${languageLine}\n\nמשפט מחייב:\n${canonical}`;
  return JSON.stringify({
    phrase_instructions: withCanonical(REPLY_PROMPT_TEXT, canonical),
    customer_message: {
      current_message: `נסח מחדש בלבד: ${canonical}${languageLine}`,
      recent_history: ctx.history,
      has_location: false,
    },
    sender_phone: ctx.conversation.phone,
    existing_record: { canonical },
    ...(lang === "he" ? {} : { customer_language: lang }),
  });
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

/**
 * AI decode is primary only when its commands can actually run.
 * Bare details/approvals with no open request are not actionable openings —
 * they must not override rulePlan's donate/seek for a new conversation.
 */
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

/**
 * When the action manager understood the turn, its plan is authoritative.
 * rulePlan is only a fallback for unclear/empty AI output or AI disabled.
 * Exception: sticky replace/add soft-gate owns the turn until answered.
 */
export function selectDecodePlan(
  translated: { understood: boolean; plan: Plan },
  deterministic: Plan | null,
  ctx: Context,
): { plan: Plan; useAi: boolean; understood: boolean } {
  if (
    ctx.conversation.pending_extra_item &&
    deterministic?.commands.some(
      (command) =>
        command.type === "resolve_extra_item" ||
        command.type === "resolve_extra_recipient" ||
        command.type === "next",
    )
  )
    return { plan: deterministic, useAi: false, understood: true };
  if (translated.understood) {
    return { plan: translated.plan, useAi: true, understood: true };
  }
  if (deterministic)
    return { plan: deterministic, useAi: false, understood: true };
  return {
    plan: translated.plan,
    useAi: false,
    understood: false,
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

  async plan(ctx: Context): Promise<DecodeResult> {
    const text = ctx.message.transcript ?? ctx.message.text;
    if (!this.c.AI_ENABLED) {
      const deterministic = rulePlan(ctx);
      if (deterministic)
        return {
          understood: true,
          plan: deterministic,
          metadata: {
            provider: "rules",
            ai_enabled: false,
            action_source: "rules_ai_disabled",
          },
        };
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
    const snapshot = snapshotForDecode(ctx);
    const source = decodePromptSource(this.c);
    const userPayload = {
      customer_message: {
        current_message: text,
        recent_history: ctx.history,
        contacts: ctx.message.contacts,
        has_location: ctx.message.location !== null,
      },
      sender_phone: ctx.conversation.phone,
      existing_record: snapshot,
    };
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      ...(source.mode === "hosted"
        ? { prompt: { id: source.id, version: source.version } }
        : {
            instructions: source.instructions,
            text: {
              format: {
                type: "json_schema",
                name: "haim_action_plan",
                strict: true,
                schema: decodeOutputJsonSchema,
              },
            },
          }),
      input: [
        {
          role: "user",
          content:
            source.mode === "git"
              ? `Return JSON only for this decode request:\n${JSON.stringify(userPayload)}`
              : JSON.stringify({
                  decode_instructions: ACTION_PROMPT_TEXT,
                  ...userPayload,
                }),
        },
      ],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    let payload: unknown;
    try {
      payload = JSON.parse(response.output_text);
    } catch {
      throw new AppError("invalid_managed_prompt_response");
    }
    const translated = translate(payload, ctx, text);
    // Action manager owns the plan. rulePlan only fills in when the model
    // marks the turn unclear / not understood.
    const deterministic = rulePlan(ctx);
    const selected = selectDecodePlan(translated, deterministic, ctx);
    const { plan, useAi, understood } = selected;
    return {
      understood,
      plan,
      metadata: {
        provider: "openai_responses_decode",
        prompt_mode: source.mode,
        prompt_id: source.mode === "hosted" ? source.id : "git:prompts/haim-action.he.md",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        prompt_sha: promptSha(ACTION_INSTRUCTIONS),
        model: this.c.OPENAI_MODEL,
        action_source: useAi
          ? "ai_action_manager"
          : deterministic
            ? "ai_decode_bridged_rules"
            : translated.understood === false
              ? "ai_decode_unclear"
              : "ai_action_manager",
        understood,
        bridged_rules: !useAi && Boolean(deterministic),
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
        // Observability only — never fed back into planning.
        model_input: {
          prompt_mode: source.mode,
          prompt_id: source.mode === "hosted" ? source.id : "git:prompts/haim-action.he.md",
          prompt_version: source.mode === "hosted" ? source.version : "git",
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

  async reply(
    ctx: Context,
    input: { operation: Record<string, unknown>; fallback: string },
  ): Promise<{ text: string; metadata: Record<string, unknown> }> {
    if (!this.c.AI_ENABLED)
      return { text: input.fallback, metadata: { provider: "fallback", ai_enabled: false } };
    const started = Date.now();
    const source = replyPromptSource(this.c, input.fallback);
    const replyInput = {
      sender_phone: ctx.conversation.phone,
      current_message: ctx.message.transcript ?? ctx.message.text,
      history: ctx.history,
      requests: ctx.requests,
      candidates: ctx.candidates,
      active_search: ctx.active_search ?? null,
      operation_result: input.operation,
      fallback_reply: input.fallback,
      canonical: input.fallback,
      already_introduced: conversationAlreadyIntroduced(ctx.history),
    };
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      ...(source.mode === "hosted"
        ? { prompt: { id: source.id, version: source.version } }
        : {
            instructions: source.instructions,
            text: {
              format: {
                type: "json_schema",
                name: "haim_reply",
                strict: true,
                schema: {
                  type: "object",
                  properties: { reply: { type: "string" } },
                  required: ["reply"],
                  additionalProperties: false,
                },
              },
            },
          }),
      input: [{
        role: "user",
        content: JSON.stringify(replyInput),
      }],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    let payload: unknown;
    try { payload = JSON.parse(response.output_text); } catch { throw new AppError("invalid_reply_manager_response"); }
    const parsed = replyResponseSchema.safeParse(payload);
    if (!parsed.success) throw new AppError("invalid_reply_manager_response");
    return {
      text: parsed.data.reply,
      metadata: {
        provider: "openai_responses_reply_manager",
        prompt_mode: source.mode,
        prompt_id: source.mode === "hosted" ? source.id : "git:prompts/haim-reply.he.md",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        prompt_sha: promptSha(REPLY_INSTRUCTIONS),
        model: this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
        model_input: {
          prompt_mode: source.mode,
          prompt_id: source.mode === "hosted" ? source.id : "git:prompts/haim-reply.he.md",
          prompt_version: source.mode === "hosted" ? source.version : "git",
          payload: replyInput,
        },
        model_output: {
          raw: response.output_text,
          parsed: payload,
        },
        raw_output: response.output_text,
      },
    };
  }

  async phraseReply(
    canonical: string,
    ctx: Context,
  ): Promise<{ text: string; metadata: Record<string, unknown> }> {
    if (!this.c.AI_ENABLED)
      return {
        text: canonical,
        metadata: { provider: "rules", ai_enabled: false, action_source: "canonical" },
      };
    const started = Date.now();
    const source = phrasePromptSource(this.c, canonical);
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      ...(source.mode === "hosted"
        ? { prompt: { id: source.id, version: source.version } }
        : { instructions: source.instructions }),
      input: [
        {
          role: "user",
          content: phraseUserContent(source.mode, canonical, ctx),
        },
      ],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    const text = extractPhraseText(response.output_text, canonical);
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_mode: source.mode,
        prompt_id:
          source.mode === "hosted" ? source.id : "git:prompts/haim-reply.he.md",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        model: this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }

  async phraseNotice(
    ctx: Context,
    notice: Notice,
    request: Request | null,
  ): Promise<{ text: string; metadata: Record<string, unknown> }> {
    if (!this.c.AI_ENABLED)
      return {
        text: notice.text,
        metadata: { provider: "rules", ai_enabled: false, action_source: "canonical" },
      };
    const started = Date.now();
    const source = phrasePromptSource(this.c, notice.text);
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      ...(source.mode === "hosted"
        ? { prompt: { id: source.id, version: source.version } }
        : { instructions: source.instructions }),
      input: [
        {
          role: "user",
          content:
            source.mode === "git"
              ? `נסח הודעת WhatsApp קצרה ואנושית לצד השני מהמשפט המחייב. החזר טקסט בלבד, בלי JSON.\nנמען: ${notice.phone}\n\nמשפט מחייב:\n${notice.text}`
              : JSON.stringify({
                  phrase_instructions: withCanonical(
                    REPLY_PROMPT_TEXT,
                    notice.text,
                  ),
                  customer_message: {
                    current_message: `נסח הודעת WhatsApp קצרה ואנושית לצד השני. טיוטת המערכת: ${notice.text}`,
                    recent_history: ctx.history,
                    notice_recipient_phone: notice.phone,
                    notice_kind: "system_notice",
                    has_location: false,
                  },
                  sender_phone: ctx.conversation.phone,
                  existing_record: {
                    conversation: ctx.conversation,
                    request,
                    notice,
                  },
                }),
        },
      ],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    const text = extractPhraseText(response.output_text, notice.text);
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_mode: source.mode,
        prompt_id:
          source.mode === "hosted" ? source.id : "git:prompts/haim-reply.he.md",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        model: this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }
}
