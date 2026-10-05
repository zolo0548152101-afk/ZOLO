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

type PromptSource =
  | { mode: "hosted"; id: string; version: string }
  | { mode: "git"; instructions: string };

function decodePromptSource(c: Config): PromptSource {
  if (c.OPENAI_DECODE_PROMPT_ID)
    return {
      mode: "hosted",
      id: c.OPENAI_DECODE_PROMPT_ID,
      version: c.OPENAI_DECODE_PROMPT_VERSION || "1",
    };
  // Do not fall back to the legacy phrasing hosted prompt — it fights decode.
  // OpenAI is also deprecating reusable prompt objects; git instructions are
  // the supported production path.
  return { mode: "git", instructions: DECODE_PROMPT_TEXT };
}

function phrasePromptSource(c: Config, canonical: string): PromptSource {
  if (c.OPENAI_PHRASE_PROMPT_ID)
    return {
      mode: "hosted",
      id: c.OPENAI_PHRASE_PROMPT_ID,
      version: c.OPENAI_PHRASE_PROMPT_VERSION || "1",
    };
  return {
    mode: "git",
    instructions: PHRASE_PROMPT_TEXT.replace("{{canonical}}", canonical),
  };
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

function actionableAiPlan(translated: {
  understood: boolean;
  plan: Plan;
}): boolean {
  return (
    translated.understood &&
    translated.plan.commands.some((command) => command.type !== "next")
  );
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
            text: { format: { type: "json_object" as const } },
          }),
      input: [
        {
          role: "user",
          content:
            source.mode === "git"
              ? `Return JSON only for this decode request:\n${JSON.stringify(userPayload)}`
              : JSON.stringify({
                  decode_instructions: DECODE_PROMPT_TEXT,
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
    // AI decode is primary when it returns real commands. rulePlan remains a
    // safety net for unclear/empty AI output and for hard Hebrew corpus cases.
    const deterministic = rulePlan(ctx);
    const useAi = actionableAiPlan(translated);
    const plan = useAi
      ? translated.plan
      : (deterministic ?? translated.plan);
    const understood = useAi
      ? true
      : deterministic
        ? true
        : translated.understood;
    return {
      understood,
      plan,
      metadata: {
        provider: "openai_responses_decode",
        prompt_mode: source.mode,
        prompt_id: source.mode === "hosted" ? source.id : "git:prompts/decode.txt",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        model: this.c.OPENAI_MODEL,
        action_source: useAi
          ? "ai_decode"
          : deterministic
            ? "ai_decode_bridged_rules"
            : translated.understood === false
              ? "ai_decode_unclear"
              : "ai_decode",
        understood,
        bridged_rules: !useAi && Boolean(deterministic),
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
    const source = phrasePromptSource(this.c, canonical);
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
              ? "נסח מחדש בלבד את המשפט המחייב. החזר טקסט בלבד, בלי JSON."
              : JSON.stringify({
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
    const text = extractPhraseText(response.output_text, canonical);
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_mode: source.mode,
        prompt_id:
          source.mode === "hosted" ? source.id : "git:prompts/phrase.txt",
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
    if (!this.c.AI_ENABLED) throw new AppError("ai_disabled");
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
              ? `נסח הודעת WhatsApp קצרה ואנושית לצד השני מהמשפט המחייב. החזר טקסט בלבד, בלי JSON.\nנמען: ${notice.phone}`
              : JSON.stringify({
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
    const text = extractPhraseText(response.output_text, notice.text);
    return {
      text,
      metadata: {
        provider: "openai_responses_phrase",
        prompt_mode: source.mode,
        prompt_id:
          source.mode === "hosted" ? source.id : "git:prompts/phrase.txt",
        prompt_version: source.mode === "hosted" ? source.version : "git",
        model: this.c.OPENAI_MODEL,
        response_id: response.id,
        elapsed_ms: Date.now() - started,
        usage: response.usage,
      },
    };
  }
}
