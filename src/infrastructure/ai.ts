import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { nextQuestion } from "../domain/policies.js";
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
const DECODE_PROMPT_TEXT = loadPrompt("decode.txt");
const PHRASE_PROMPT_TEXT = loadPrompt("phrase.txt");

export interface DecodeResult {
  understood: boolean;
  plan: Plan;
  metadata: Record<string, unknown>;
}

export interface Planner {
  plan(context: Context): Promise<DecodeResult>;
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

const decodeResponseSchema = z
  .object({
    understood: z.boolean().default(true),
    commands: z.array(z.unknown()).default([]),
    evidence: z.string().default(""),
    reply: z.string().optional(),
  })
  .passthrough();

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

/**
 * Map a decode model payload into a validated Plan.
 * Prefer an explicit commands array. Fall back to legacy updates/actions only
 * for a few safe mappings while the hosted decode prompt is being published.
 */
export function translate(
  payload: unknown,
  ctx: Context,
  text: string,
): { understood: boolean; plan: Plan } {
  const decode = decodeResponseSchema.safeParse(payload);
  if (decode.success && Array.isArray(decode.data.commands) && decode.data.commands.length) {
    const commands = asCommands(decode.data.commands);
    if (commands.length) {
      return {
        understood: decode.data.understood !== false,
        plan: planSchema.parse({
          commands,
          evidence: (decode.data.evidence || text).slice(0, 2000),
        }),
      };
    }
  }

  if (decode.success && decode.data.understood === false) {
    return {
      understood: false,
      plan: { commands: [{ type: "next" }], evidence: text.slice(0, 2000) },
    };
  }

  const managed = managedResponseSchema.safeParse(payload);
  if (!managed.success) {
    return {
      understood: false,
      plan: { commands: [{ type: "next" }], evidence: text.slice(0, 2000) },
    };
  }

  if (managed.data.understood === false || managed.data.intent === "unclear") {
    return {
      understood: false,
      plan: { commands: [{ type: "next" }], evidence: text.slice(0, 2000) },
    };
  }

  if (managed.data.commands?.length) {
    const commands = asCommands(managed.data.commands);
    if (commands.length) {
      return {
        understood: true,
        plan: planSchema.parse({
          commands,
          evidence: (managed.data.evidence || text).slice(0, 2000),
        }),
      };
    }
  }

  const commands: Command[] = [];
  const updates = managed.data.updates;
  const actions = managed.data.actions;
  const open = ctx.requests.find(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );
  const requestNumber = open?.number ?? null;

  if (managedNeedsHuman(actions, updates)) {
    commands.push({
      type: "escalate",
      request_number: requestNumber,
      reason: "unclear",
    });
  } else if (action(actions, "approve_schedule") || updates["מועד"] || updates["proposed_run_date"]) {
    const date =
      (typeof updates["proposed_run_date"] === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(updates["proposed_run_date"])
        ? updates["proposed_run_date"]
        : null) ??
      open?.proposed_run_date?.slice(0, 10) ??
      null;
    if (date && requestNumber)
      commands.push({ type: "approve_schedule", request_number: requestNumber, date });
  } else if (
    action(actions, "approve_self") ||
    boolValue(updates, "אישור") === true ||
    /(?:מאשר|מאשרת)/u.test(text)
  ) {
    if (requestNumber)
      commands.push({ type: "approve_self", request_number: requestNumber });
  }

  if (!commands.length) commands.push({ type: "next" });
  return {
    understood: true,
    plan: planSchema.parse({
      commands,
      evidence: (managed.data.evidence || text).slice(0, 2000),
    }),
  };
}

function snapshotForDecode(ctx: Context) {
  const open = ctx.requests.filter(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );
  const selected =
    open.find((r) => r.id === ctx.conversation.selected_request_id) ?? open[0] ?? null;
  return {
    conversation: ctx.conversation,
    selected_request: selected
      ? {
          number: selected.number,
          status: selected.status,
          origin: selected.origin,
          proposed_run_date: selected.proposed_run_date,
          verification_contacted: selected.verification_contacted,
          parties: selected.parties,
          items: selected.items,
        }
      : null,
    open_requests: open.map((r) => ({
      number: r.number,
      status: r.status,
      origin: r.origin,
    })),
    missing: selected
      ? nextQuestion(selected, ctx.conversation.phone).text
      : null,
    history: ctx.history,
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
    if (!this.c.AI_ENABLED) throw new AppError("ai_disabled");
    const text = ctx.message.transcript ?? ctx.message.text;
    const started = Date.now();
    const snapshot = snapshotForDecode(ctx);
    const promptId = this.c.OPENAI_DECODE_PROMPT_ID || this.c.OPENAI_PROMPT_ID;
    const promptVersion =
      this.c.OPENAI_DECODE_PROMPT_VERSION || this.c.OPENAI_PROMPT_VERSION;
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      prompt: {
        id: promptId,
        version: promptVersion,
      },
      input: [
        {
          role: "user",
          content: JSON.stringify({
            decode_instructions: DECODE_PROMPT_TEXT,
            customer_message: {
              current_message: text,
              recent_history: ctx.history,
              contacts: ctx.message.contacts,
              has_location: ctx.message.location !== null,
            },
            sender_phone: ctx.conversation.phone,
            existing_record: snapshot,
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
    // The hosted OpenAI prompt is still the old phrasing shape, so it often
    // invents approve_self from any «מאשר» and skips addresses/consent. Until a
    // dedicated decode prompt is published, prefer rulePlan whenever it matches;
    // AI still owns unclear (understood=false) and post-commit phrasing.
    const deterministic = rulePlan(ctx);
    const plan =
      translated.understood === false
        ? translated.plan
        : deterministic ?? translated.plan;
    return {
      understood: translated.understood,
      plan,
      metadata: {
        provider: "openai_responses_decode",
        prompt_id: promptId,
        prompt_version: promptVersion,
        model: this.c.OPENAI_MODEL,
        action_source:
          translated.understood === false
            ? "ai_decode_unclear"
            : deterministic
              ? "ai_decode_bridged_rules"
              : "ai_decode",
        understood: translated.understood,
        bridged_rules: Boolean(deterministic) && translated.understood !== false,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }

  async phraseReply(
    canonical: string,
    ctx: Context,
  ): Promise<{ text: string; metadata: Record<string, unknown> }> {
    if (!this.c.AI_ENABLED) throw new AppError("ai_disabled");
    const started = Date.now();
    const promptId = this.c.OPENAI_PHRASE_PROMPT_ID || this.c.OPENAI_PROMPT_ID;
    const promptVersion =
      this.c.OPENAI_PHRASE_PROMPT_VERSION || this.c.OPENAI_PROMPT_VERSION;
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      prompt: {
        id: promptId,
        version: promptVersion,
      },
      input: [
        {
          role: "user",
          content: JSON.stringify({
            phrase_instructions: PHRASE_PROMPT_TEXT.replace(
              "{{canonical}}",
              canonical,
            ),
            customer_message: {
              current_message: `נסח מחדש בלבד: ${canonical}`,
              recent_history: ctx.history,
              has_location: false,
            },
            sender_phone: ctx.conversation.phone,
            existing_record: { canonical },
          }),
        },
      ],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    let text = "";
    try {
      const parsed = managedResponseSchema.parse(JSON.parse(response.output_text));
      text = parsed.reply.trim();
    } catch {
      try {
        const raw = JSON.parse(response.output_text) as { reply?: string; text?: string };
        text = (raw.reply ?? raw.text ?? "").trim();
      } catch {
        text = response.output_text.trim();
      }
    }
    if (!text) text = canonical;
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_id: promptId,
        prompt_version: promptVersion,
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
    if (!this.c.AI_ENABLED) throw new AppError("ai_disabled");
    const started = Date.now();
    const promptId = this.c.OPENAI_PHRASE_PROMPT_ID || this.c.OPENAI_PROMPT_ID;
    const promptVersion =
      this.c.OPENAI_PHRASE_PROMPT_VERSION || this.c.OPENAI_PROMPT_VERSION;
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      prompt: {
        id: promptId,
        version: promptVersion,
      },
      input: [
        {
          role: "user",
          content: JSON.stringify({
            phrase_instructions: PHRASE_PROMPT_TEXT.replace(
              "{{canonical}}",
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
    let managed: z.infer<typeof managedResponseSchema>;
    try {
      managed = managedResponseSchema.parse(JSON.parse(response.output_text));
    } catch {
      throw new AppError("invalid_managed_prompt_response");
    }
    const text = managed.reply.trim() || notice.text;
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_id: promptId,
        prompt_version: promptVersion,
        model: this.c.OPENAI_MODEL,
        managed_intent: managed.intent,
        managed_actions: managed.actions,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }
}
