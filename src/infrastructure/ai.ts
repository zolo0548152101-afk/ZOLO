import OpenAI from "openai";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  AppError,
  type Command,
  type Context,
  type ItemKind,
  type Notice,
  type Plan,
  type Request,
} from "../domain/types.js";
import {
  donationIntent,
  explicitApproval,
  grounded,
  nextQuestion,
} from "../domain/policies.js";

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

const textValue = (updates: Record<string, unknown>, key: string): string | null => {
  const value = updates[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
};

const numberValue = (
  updates: Record<string, unknown>,
  key: string,
): number | null => {
  const value = updates[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value))
    return Number(value);
  return null;
};

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

function itemKind(value: string): ItemKind {
  const t = value.toLowerCase();
  if (/מיטה|bed/.test(t)) return "bed";
  if (/ספה|כורס|sofa/.test(t)) return "sofa";
  if (/ארון|wardrobe/.test(t)) return "wardrobe";
  if (/מקרר|fridge/.test(t)) return "fridge";
  if (/תנור|oven/.test(t)) return "oven";
  if (/מכונת כביסה|washing/.test(t)) return "washing_machine";
  if (/מייבש|dryer/.test(t)) return "dryer";
  if (/מקפיא|freezer/.test(t)) return "freezer";
  if (/מדיח|dishwasher/.test(t)) return "dishwasher";
  if (/שולחן.*כיס|כיס.*שולחן/.test(t)) return "table_set";
  if (/שולחן|table/.test(t)) return "table";
  if (/כיסאות|כיסא|chairs/.test(t)) return "chairs";
  if (/פסנתר|piano/.test(t)) return "piano";
  if (/דירה מלאה|הובלת דירה|house.?move/.test(t)) return "house_move";
  return "other";
}

function descriptionFrom(
  updates: Record<string, unknown>,
  text: string,
  request?: Request,
): string {
  const value = textValue(updates, "מה מעבירים");
  if (value) return value;
  const known = request?.items[0]?.description;
  if (known) return known;
  return text.replace(/\s+/g, " ").trim().slice(0, 120) || "פריט";
}

function phoneFrom(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\D/g, "").length >= 9 ? value : null;
}

function floorFrom(value: string | null): number | null {
  if (!value) return null;
  if (/קרקע|ground/i.test(value)) return 0;
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function activeRequest(ctx: Context): Request | undefined {
  return (
    ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
    (ctx.requests.length === 1 ? ctx.requests[0] : undefined)
  );
}

function translate(
  managed: ManagedResponse,
  ctx: Context,
  text: string,
): Plan {
  const updates = managed.updates;
  const actions = managed.actions;
  const current = activeRequest(ctx);
  const prior = ctx.history.at(-1)?.content ?? "";
  const commands: Command[] = [];

  if (managed.intent === "cancellation") {
    const choice = /(?:לגמרי|סופית|לא רלוונטי|לא צריך)/.test(text)
      ? "final"
      : /(?:שבוע הבא|רלוונטי)/.test(text)
        ? "next_week"
        : "ask";
    commands.push({ type: "cancel", request_number: current?.number ?? null, choice });
  } else if (action(actions, "needs_human") || textValue(updates, "נדרש טיפול אנושי")) {
    commands.push({
      type: "escalate",
      request_number: current?.number ?? null,
      reason: /מנוף|חלון|גישה/.test(text)
        ? "unusual_access"
        : /גבול|מחוץ|יישוב/.test(text)
          ? "borderline_area"
          : "unclear",
    });
  } else if (managed.intent === "donate" && (donationIntent(text) || !current)) {
    const description = descriptionFrom(updates, text);
    const quantity = numberValue(updates, "כמות פריטים") ?? 1;
    commands.push({
      type: "donate",
      items: [
        {
          kind: itemKind(description),
          description,
          quantity: Math.max(1, Math.min(20, quantity)),
        },
      ],
      counterparty_phone: phoneFrom(textValue(updates, "נייד מקבל")),
      free: true,
      working: boolValue(updates, "תקינות") ?? boolValue(updates, "תקין"),
    });
  } else if (managed.intent === "request" && !current) {
    const description = descriptionFrom(updates, text);
    commands.push({ type: "seek", kind: itemKind(description) });
  } else if (managed.intent === "transport" || current) {
    const donorSettlement = textValue(updates, "עיר איסוף");
    const donorAddress = textValue(updates, "כתובת איסוף");
    const donorName = textValue(updates, "שם המוסר");
    const donorFloor = floorFrom(textValue(updates, "קומה איסוף"));
    const receiverSettlement = textValue(updates, "עיר יעד");
    const receiverAddress = textValue(updates, "כתובת יעד");
    const receiverName = textValue(updates, "שם המקבל");
    const receiverFloor = floorFrom(textValue(updates, "קומה יעד"));

    if (donorSettlement || donorAddress || donorName || donorFloor !== null)
      commands.push({
        type: "details",
        request_number: current?.number ?? null,
        role: "donor",
        name: donorName,
        settlement: donorSettlement,
        address: donorAddress,
        floor: donorFloor,
      });
    if (receiverSettlement || receiverAddress || receiverName || receiverFloor !== null)
      commands.push({
        type: "details",
        request_number: current?.number ?? null,
        role: "receiver",
        name: receiverName,
        settlement: receiverSettlement,
        address: receiverAddress,
        floor: receiverFloor,
      });

    const counterpartyPhone = phoneFrom(textValue(updates, "נייד מקבל"));
    const counterpartyName = textValue(updates, "שם המקבל");
    if (counterpartyPhone || (counterpartyName && !receiverSettlement && !receiverAddress))
      commands.push({
        type: "counterparty",
        request_number: current?.number ?? null,
        phone: counterpartyPhone,
        name: counterpartyName,
      });

    const asksWorking = /תקין|שמיש|עובד/.test(prior);
    const asksDisassembly = /פירוק/.test(prior);
    const working = asksWorking
      ? /לא\s*(?:תקין|שמיש|עובד)|מקולקל|שבור/.test(text)
        ? false
        : explicitApproval(text)
          ? true
          : null
      : null;
    const needsDisassembly = asksDisassembly
      ? /^(?:לא|אין)/.test(text.trim())
        ? false
        : /כן|נדרש|צריך/.test(text)
          ? true
          : null
      : null;
    const newDescription = textValue(updates, "מה מעבירים");
    const items = newDescription
      ? [{ kind: itemKind(newDescription), description: newDescription, quantity: numberValue(updates, "כמות פריטים") ?? 1 }]
      : current?.items.map((i) => ({ kind: i.kind, description: i.description, quantity: i.quantity })) ?? null;
    const ovenType = /בילט/.test(text) ? "built_in" : /משולב/.test(text) ? "combined" : null;
    if (items && (newDescription || working !== null || needsDisassembly !== null || ovenType))
      commands.push({
        type: "item_facts",
        request_number: current?.number ?? null,
        items,
        free: null,
        working,
        needs_disassembly: needsDisassembly,
        wardrobe_small_whole: null,
        oven_type: ovenType,
        evacuation: null,
      });

    if (
      textValue(updates, "אישורמוסר") === "כן" ||
      textValue(updates, "אישור מקבל") === "כן" ||
      (explicitApproval(text) && /אשר|אישור|חלקך/.test(prior))
    )
      commands.push({ type: "approve_self", request_number: current?.number ?? null });
  }

  if (!commands.length) commands.push({ type: "next" });
  const plan = { commands: commands.slice(0, 5), evidence: text.slice(0, 2000) };
  if (!grounded(plan, text)) throw new AppError("ungrounded_managed_prompt");
  return plan;
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
