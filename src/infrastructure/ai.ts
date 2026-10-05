import OpenAI from "openai";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  AppError,
  type Context,
  type Notice,
  type Plan,
  type Request,
} from "../domain/types.js";
import { nextQuestion } from "../domain/policies.js";

export interface Planner {
  plan(
    context: Context,
  ): Promise<{ plan: Plan; metadata: Record<string, unknown> }>;
  phraseNotice(
    context: Context,
    notice: Notice,
    request: Request | null,
  ): Promise<{ text: string; metadata: Record<string, unknown> }>;
  close(): Promise<void>;
}

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
  })
  .passthrough();
type ManagedResponse = z.infer<typeof managedResponseSchema>;

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

/**
 * The hosted prompt may only phrase a sentence. Rules own facts, commands,
 * and rejections. Ignore updates/actions so a model guess cannot write state.
 */
function translate(_managed: ManagedResponse, _ctx: Context, text: string): Plan {
  return { commands: [{ type: "next" }], evidence: text.slice(0, 2000) };
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

  async plan(
    ctx: Context,
  ): Promise<{ plan: Plan; metadata: Record<string, unknown> }> {
    if (!this.c.AI_ENABLED) throw new AppError("ai_disabled");
    const text = ctx.message.transcript ?? ctx.message.text;
    const started = Date.now();
    const existingRecord = {
      conversation: ctx.conversation,
      requests: ctx.requests,
      candidates: ctx.candidates.map((candidate) => ({
        number: candidate.request.number,
        items: candidate.request.items,
        state: candidate.state,
        has_photo: candidate.request.photo_ids.length > 0,
      })),
      next_question: ctx.requests.length === 1 ? nextQuestion(ctx.requests[0]!, ctx.conversation.phone).text : null,
      recent_history: ctx.history,
    };
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      prompt: {
        id: this.c.OPENAI_PROMPT_ID,
        version: this.c.OPENAI_PROMPT_VERSION,
      },
      input: [{ role: "user", content: JSON.stringify({
          customer_message: JSON.stringify({
            current_message: text,
            recent_history: ctx.history,
            contacts: ctx.message.contacts,
            has_location: ctx.message.location !== null,
          }),
          sender_phone: ctx.conversation.phone,
          existing_record: JSON.stringify(existingRecord),
        }) }],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    let managed: ManagedResponse;
    try {
      managed = managedResponseSchema.parse(JSON.parse(response.output_text));
    } catch {
      throw new AppError("invalid_managed_prompt_response");
    }
    return {
      plan: translate(managed, ctx, text),
      metadata: {
        provider: "openai_responses_managed_prompt",
        prompt_id: this.c.OPENAI_PROMPT_ID,
        prompt_version: this.c.OPENAI_PROMPT_VERSION,
        model: this.c.OPENAI_MODEL,
        action_source: "prompt_phrasing_only",
        managed_reply: managed.reply,
        managed_intent: managed.intent,
        managed_actions: managed.actions,
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
    const response = await this.client.responses.create({
      model: this.c.OPENAI_MODEL,
      prompt: {
        id: this.c.OPENAI_PROMPT_ID,
        version: this.c.OPENAI_PROMPT_VERSION,
      },
      input: [{ role: "user", content: JSON.stringify({
          customer_message: JSON.stringify({
            current_message:
              `נסח הודעת WhatsApp קצרה ואנושית לצד השני לפי כללי הפרומפט. ` +
              `זו טיוטת המערכת, אין לשנות את המשמעות: ${notice.text}`,
            recent_history: ctx.history,
            notice_recipient_phone: notice.phone,
            notice_kind: "system_notice",
            has_location: false,
          }),
          sender_phone: ctx.conversation.phone,
          existing_record: JSON.stringify({
            conversation: ctx.conversation,
            request,
            notice,
          }),
        }) }],
      reasoning: { effort: this.c.OPENAI_REASONING_EFFORT },
    });
    let managed: ManagedResponse;
    try {
      managed = managedResponseSchema.parse(JSON.parse(response.output_text));
    } catch {
      throw new AppError("invalid_managed_prompt_response");
    }
    const text = managed.reply.trim();
    if (!text) throw new AppError("empty_managed_notice_response");
    return {
      text,
      metadata: {
        provider: "openai_responses_managed_prompt",
        prompt_id: this.c.OPENAI_PROMPT_ID,
        prompt_version: this.c.OPENAI_PROMPT_VERSION,
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
