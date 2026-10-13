import type pg from "pg";
import type { Context, Plan, Request } from "../domain/types.js";
import {
  PHOTO_STATUS,
  photoGate,
  photoStatusSkipsGate,
} from "../domain/policies.js";
import { isSelfIntroText, CLARIFY_REPLY } from "../domain/ai-guards.js";

/** Detect an AI photo ask in the reply (no fixed code sentences). */
function replyAsksPhoto(reply: string): boolean {
  return /תמונה/.test(reply) && /(?:שלח|לשלוח|אפשר לשלוח|נא לשלוח|אם יש)/u.test(reply);
}

export type TurnFate =
  | "completed"
  | "superseded"
  | "coalesced"
  | "released"
  | "failed";

export type TurnLogRow = {
  conversation_id?: string | null;
  turn_id?: string | null;
  phone?: string | null;
  message_ids?: string[];
  merged_text?: string;
  turn_fate: TurnFate;
  fate_detail?: Record<string, unknown>;
  state_before?: Record<string, unknown>;
  state_after?: Record<string, unknown>;
  model_input?: Record<string, unknown>;
  model_output?: Record<string, unknown>;
  tool_calls?: unknown[];
  policies?: Record<string, unknown>;
  reply_text?: string | null;
  outbox_id?: string | null;
  error_code?: string | null;
  opened_at?: string | Date | null;
  completed_at?: string | Date | null;
};

function partySnap(r: Request | null | undefined) {
  if (!r) return null;
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    origin: r.origin,
    photo_ids: r.photo_ids,
    photo_status: r.photo_status,
    items: r.items.map((i) => ({
      kind: i.kind,
      description: i.description,
      quantity: i.quantity,
    })),
    parties: r.parties.map((p) => ({
      role: p.role,
      phone: p.phone,
      name: p.name,
      settlement: p.settlement,
      address: p.address,
    })),
  };
}

/** Compact conversation + request snapshot for turn_logs. */
export function snapshotTurnState(ctx: Context): Record<string, unknown> {
  const selected =
    ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
    ctx.requests.find(
      (r) =>
        !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
    ) ??
    null;
  return {
    conversation: {
      id: ctx.conversation.id,
      mode: ctx.conversation.mode,
      version: ctx.conversation.version,
      selected_request_id: ctx.conversation.selected_request_id,
      pending_counterparty_name: ctx.conversation.pending_counterparty_name,
      pending_counterparty_phone: ctx.conversation.pending_counterparty_phone,
      pending_extra_item: ctx.conversation.pending_extra_item,
    },
    selected_request: partySnap(selected),
    open_requests: ctx.requests.map((r) => partySnap(r)),
    active_search: ctx.active_search
      ? {
          kind: ctx.active_search.kind,
          state: ctx.active_search.state,
          settlement: ctx.active_search.settlement,
          name: ctx.active_search.name,
        }
      : null,
  };
}

/** Observe which policy gates shaped the reply — never changes decisions. */
export function observePolicies(
  ctx: Context,
  opts: {
    reply: string | null;
    intent?: string | null;
    text?: string;
    introduced?: boolean;
    photoHold?: boolean;
  },
): Record<string, unknown> {
  const reply = opts.reply ?? "";
  const text = opts.text ?? ctx.message.transcript ?? ctx.message.text ?? "";
  const selected =
    ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
    ctx.requests.find((r) => photoGate(r)) ??
    null;
  const policies: Record<string, unknown> = {};

  const askedThisTurn =
    opts.intent === "ask_photo" ||
    Boolean(opts.photoHold) ||
    replyAsksPhoto(reply);
  if (askedThisTurn || (selected && photoGate(selected))) {
    policies.photoGate = {
      fired: true,
      why: selected
        ? `origin=${selected.origin}; photo_status=${selected.photo_status}; photo_ids=${selected.photo_ids.length}; status=${selected.status}`
        : "photo ask this turn",
      shaped_reply: askedThisTurn,
    };
  } else {
    const status = selected?.photo_status ?? PHOTO_STATUS.NOT_ASKED;
    const skipReason = photoStatusSkipsGate(status)
      ? status === PHOTO_STATUS.ASKED
        ? "photo already asked once (בוקשה)"
        : status === PHOTO_STATUS.NO_PHOTO
          ? "customer has no photo (אין תמונה)"
          : "photo already received (התקבלה)"
      : selected
        ? `origin=${selected.origin}; photo_status=${status}; photo_ids=${selected.photo_ids.length}`
        : "no open donation/direct awaiting first photo ask";
    policies.photoGate = {
      fired: false,
      why: skipReason,
    };
  }

  policies.photo_ask = {
    fired: askedThisTurn,
    why: askedThisTurn
      ? opts.photoHold
        ? "holdingForPhoto soft nudge (non-sticky)"
        : "photo ask present in AI reply"
      : selected && photoStatusSkipsGate(selected.photo_status)
        ? `skipped: photo_status=${selected.photo_status}`
        : "not applied this turn",
  };

  const introInReply = isSelfIntroText(reply);
  policies.self_intro = {
    fired: introInReply,
    why: introInReply
      ? opts.introduced
        ? "intro text present but conversation already introduced"
        : "first intro for this conversation window"
      : opts.introduced
        ? "skipped — prior outbox/history already introduced"
        : "no intro line in reply",
    already_introduced: Boolean(opts.introduced),
  };

  const intentAsk =
    /מה תרצה לעשות|למסור פריט או לקבל|מה הפריט שברצונך/.test(reply) ||
    reply === CLARIFY_REPLY ||
    /לא הבנתי את הכוונה/.test(reply);
  policies.intent_question = {
    fired: intentAsk,
    why: intentAsk
      ? /מה תרצה לעשות/.test(reply)
        ? "path not yet known — ask donate vs receive"
        : /כוונה/.test(reply) || reply === CLARIFY_REPLY
          ? "unclear customer intent — ask to rephrase"
          : "missing item/path detail — ask next required field"
      : "path/intent already known or not asked",
    customer_text_preview: text.slice(0, 200),
  };

  return policies;
}

export async function insertTurnLog(
  db: { query: pg.Pool["query"] },
  row: TurnLogRow,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO turn_logs(
       conversation_id, turn_id, phone, message_ids, merged_text,
       turn_fate, fate_detail, state_before, state_after,
       model_input, model_output, tool_calls, policies,
       reply_text, outbox_id, error_code, opened_at, completed_at
     ) VALUES (
       $1,$2,$3,$4::uuid[],$5,
       $6,$7::jsonb,$8::jsonb,$9::jsonb,
       $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,
       $14,$15,$16,$17,$18
     ) RETURNING id`,
    [
      row.conversation_id ?? null,
      row.turn_id ?? null,
      row.phone ?? null,
      row.message_ids ?? [],
      row.merged_text ?? "",
      row.turn_fate,
      JSON.stringify(row.fate_detail ?? {}),
      JSON.stringify(row.state_before ?? {}),
      JSON.stringify(row.state_after ?? {}),
      JSON.stringify(row.model_input ?? {}),
      JSON.stringify(row.model_output ?? {}),
      JSON.stringify(row.tool_calls ?? []),
      JSON.stringify(row.policies ?? {}),
      row.reply_text ?? null,
      row.outbox_id ?? null,
      row.error_code ?? null,
      row.opened_at ?? null,
      row.completed_at ?? new Date().toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function messageIdsForTurn(
  db: { query: pg.Pool["query"] },
  messageId: string,
): Promise<{ turn_id: string | null; message_ids: string[] }> {
  const turn = await db.query<{ turn_id: string | null }>(
    "SELECT turn_id FROM messages WHERE id=$1",
    [messageId],
  );
  const turnId = turn.rows[0]?.turn_id ?? null;
  if (!turnId) return { turn_id: null, message_ids: [messageId] };
  const rows = await db.query<{ message_id: string }>(
    "SELECT message_id FROM turn_messages WHERE turn_id=$1 ORDER BY position",
    [turnId],
  );
  return {
    turn_id: turnId,
    message_ids: rows.rows.map((r) => r.message_id),
  };
}

export function toolCallsFromPlan(plan: Plan | null | undefined): unknown[] {
  if (!plan) return [];
  return plan.commands.map((command) => ({
    type: command.type,
    command,
  }));
}

export function modelIOFromMetadata(
  meta: Record<string, unknown> | null | undefined,
): { model_input: Record<string, unknown>; model_output: Record<string, unknown> } {
  if (!meta) return { model_input: {}, model_output: {} };
  const model_input =
    meta.model_input && typeof meta.model_input === "object"
      ? (meta.model_input as Record<string, unknown>)
      : {
          provider: meta.provider ?? null,
          prompt_mode: meta.prompt_mode ?? null,
          prompt_id: meta.prompt_id ?? null,
          prompt_version: meta.prompt_version ?? null,
          model: meta.model ?? null,
        };
  const model_output =
    meta.model_output && typeof meta.model_output === "object"
      ? (meta.model_output as Record<string, unknown>)
      : {
          raw: meta.raw_output ?? null,
          action_source: meta.action_source ?? null,
          understood: meta.understood ?? null,
          response_id: meta.response_id ?? null,
          elapsed_ms: meta.elapsed_ms ?? null,
          reply: meta.reply ?? null,
        };
  return { model_input, model_output };
}
