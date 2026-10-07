import type pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store, type Outbound } from "../infrastructure/store.js";
import { Commands, type Outcome } from "./commands.js";
import { type Planner } from "../infrastructure/ai.js";
import { rulePlan } from "./rule-planner.js";
import {
  DeliveryError,
  type Channel,
  transcribe,
} from "../infrastructure/waha.js";
import { downloadMedia, type MediaStorage } from "../infrastructure/media.js";
import {
  AppError,
  RetryableError,
  errorCode,
  planSchema,
  type Plan,
  type Request,
  type Context,
  type Log,
  type Notice,
} from "../domain/types.js";
import {
  isStatus,
  photoGate,
  quickReply,
  statusText,
  PHOTO_THANKS,
  PHOTO_FIRST,
  PHOTO_STATUS,
  SOFT_PHOTO_ASK,
  SAME_DAY_WINDOW,
  sameDayDemand,
  HUMAN_REPLY,
  OUTSIDE,
  isOperationsAlert,
  customerCancelIntent,
  customerInsistsAfterDenial,
  directHandoffIntent,
  mutable,
  nextQuestion,
  nextTuesday,
  readyToProposeSchedule,
  photoDeclined,
  photoAskAlreadySent,
  photoStatusSkipsGate,
  customerIntentClear,
  composeTurnReply,
  openingPhotoReply,
  summarizeTurnChanges,
  noProgressReply,
} from "../domain/policies.js";
import {
  CLARIFY_REPLY,
  FAULT_REPLY,
  probeReply,
  isSelfIntroText,
  stripRepeatedSelfIntro,
  applyClaimGuard,
} from "../domain/ai-guards.js";
import { diffChangedFields, type ChangedField } from "../domain/field-map.js";
import {
  conversationLanguage,
  isCustomerClarify,
  localizeCustomer,
} from "../domain/customer-language.js";
import {
  insertTurnLog,
  messageIdsForTurn,
  modelIOFromMetadata,
  observePolicies,
  snapshotTurnState,
  toolCallsFromPlan,
  type TurnFate,
} from "./turn-log.js";

export class Engine {
  private readonly commands: Commands;
  constructor(
    readonly s: Store,
    private readonly ai: Planner,
    private readonly channel: Channel,
    readonly storage: MediaStorage,
    private readonly log: Log,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.commands = new Commands(s, now);
  }

  async ingestNext(lastAttempt = false): Promise<void> {
    const first = await this.s.pool.query<{ id: string }>(
      "SELECT id FROM messages WHERE contact_id IS NULL AND processed_at IS NULL ORDER BY seq LIMIT 1",
    );
    if (!first.rows[0]) return;
    const m = await this.s.message(first.rows[0].id);
    let phone: string;
    try {
      const cached = await this.s.pool.query<{ phone: string }>(
        "SELECT c.phone FROM contact_identities i JOIN contacts c ON c.id=i.contact_id WHERE i.session=$1 AND i.chat_id=$2",
        [this.s.config.WAHA_SESSION, m.chat_id],
      );
      phone = cached.rows[0]?.phone ?? (await this.channel.resolve(m.chat_id));
    } catch (e) {
      if (!lastAttempt) throw new RetryableError("identity_retry");
      await this.s.transaction(async (c) => {
        const current = await this.s.message(m.id, c, true);
        if (current.processed_at) return;
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),error_code='identity_unresolved' WHERE id=$1",
          [m.id],
        );
        await this.s.event(c, m, "system", "identity_unresolved", {
          code: errorCode(e),
        });
        await this.s.outbound(
          c,
          m,
          {
            phone: this.s.config.ADMIN_PHONE,
            text: `נדרש טיפול: זהות WhatsApp לא נפתרה.\nמספר פנייה: טרם נפתחה\nטלפון: לא ידוע (${m.chat_id})\nפריט ומסלול: לא ידועים\nסיבה: identity_unresolved\nהודעה אחרונה: ${m.text.slice(0, 1000)}\nתשובת הבוט: לא נשלחה\nנא לברר ולחזור ללקוח.`,
          },
          `identity-alert:${m.id}`,
        );
      });
      return;
    }
    await this.s.transaction(async (c) => {
      const current = await this.s.message(m.id, c, true);
      if (current.phone || current.processed_at) return;
      const contact = await this.s.contact(c, phone);
      await c.query(
        "INSERT INTO contact_identities(session,chat_id,contact_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [this.s.config.WAHA_SESSION, m.chat_id, contact],
      );
      // Avoid taking a write lock on the conversation for every inbound
      // message. A concurrent turn can lock its pending messages before the
      // conversation row; an unconditional upsert here locks the conversation
      // first and can deadlock when that turn is waiting on this message row.
      let conversation = await c.query<{ id: string; chat_id: string }>(
        "SELECT id,chat_id FROM conversations WHERE channel='whatsapp' AND session=$1 AND contact_id=$2",
        [this.s.config.WAHA_SESSION, contact],
      );
      if (!conversation.rows[0]) {
        const inserted = await c.query<{ id: string; chat_id: string }>(
          `INSERT INTO conversations(contact_id,session,chat_id) VALUES($1,$2,$3)
           ON CONFLICT(channel,session,contact_id) DO NOTHING RETURNING id,chat_id`,
          [contact, this.s.config.WAHA_SESSION, m.chat_id],
        );
        conversation = inserted.rows.length
          ? inserted
          : await c.query<{ id: string; chat_id: string }>(
              "SELECT id,chat_id FROM conversations WHERE channel='whatsapp' AND session=$1 AND contact_id=$2",
              [this.s.config.WAHA_SESSION, contact],
            );
      }
      if (!conversation.rows[0]) throw new AppError("conversation_missing", 409);
      if (conversation.rows[0].chat_id !== m.chat_id) {
        await c.query("UPDATE conversations SET chat_id=$2 WHERE id=$1", [
          conversation.rows[0].id,
          m.chat_id,
        ]);
      }
      await c.query(
        "UPDATE messages SET contact_id=$2,conversation_id=$3 WHERE id=$1",
        [m.id, contact, conversation.rows[0].id],
      );
      await this.s.queue.send(c, "conversation", { id: m.id }, phone);
    });
  }

  async capture(id: string, lastAttempt = false): Promise<void> {
    const m = await this.s.message(id);
    if (m.media_state === "ready" || m.media_state === "failed") return;
    try {
      if (!m.media_url || !["image", "voice"].includes(m.kind))
        throw new AppError("missing_media_url");
      const file = await this.storage.put(
        await downloadMedia(m.media_url, this.s.config),
        m.kind === "image" ? "image" : "voice",
      );
      await this.s.transaction(async (c) => {
        const current = await this.s.message(id, c, true);
        if (current.media_state === "ready") return;
        const media = await c.query<{ id: string }>(
          "INSERT INTO media(id,message_id,storage_key,checksum,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id) DO UPDATE SET message_id=EXCLUDED.message_id RETURNING id",
          [randomUUID(), id, file.key, file.checksum, file.mime, file.size],
        );
        await c.query(
          "UPDATE messages SET media_id=$2,media_state='ready',media_url=NULL WHERE id=$1",
          [id, media.rows[0]!.id],
        );
      });
    } catch (e) {
      if (!(e instanceof AppError) && !lastAttempt)
        throw new RetryableError("capture_retry");
      await this.s.pool.query(
        "UPDATE messages SET media_state='failed',error_code=$2 WHERE id=$1 AND media_state<>'ready'",
        [id, errorCode(e)],
      );
    }
  }

  async processNext(triggerId: string, lastAiAttempt = false): Promise<void> {
    const trigger = await this.s.message(triggerId);
    if (!trigger.phone) return;
    // WhatsApp users often split one thought across several bubbles. Wait for
    // a real quiet window after the newest message before merging the burst.
    const quietMs = this.s.config.MESSAGE_COALESCE_QUIET_MS;
    const maxMs = this.s.config.MESSAGE_COALESCE_MAX_MS;
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const remaining = maxMs - (Date.now() - started);
      await delay(Math.min(quietMs, remaining));
      const newest = await this.s.pool.query<{ age_ms: number }>(
        `SELECT GREATEST(0, (extract(epoch FROM clock_timestamp()-m.received_at)*1000))::int AS age_ms
           FROM messages m JOIN contacts c ON c.id=m.contact_id
          WHERE c.phone=$1 AND m.processed_at IS NULL
          ORDER BY m.seq DESC LIMIT 1`,
        [trigger.phone],
      );
      if (!newest.rows[0]) return;
      if (newest.rows[0].age_ms >= quietMs) break;
      const waitMore = quietMs - newest.rows[0].age_ms;
      const cap = maxMs - (Date.now() - started);
      if (cap <= 0) break;
      await delay(Math.min(waitMore, cap));
    }
    const pending = await this.s.pool.query<{
      id: string;
      text: string;
      contacts: { phone: string; name: string | null }[];
      kind: string;
      media_state: string;
      conversation_id: string;
      turn_id: string | null;
      turn_generation: number | null;
    }>(
      `SELECT m.id,m.text,m.contacts,m.kind,m.media_state,m.conversation_id,m.turn_id,m.turn_generation
         FROM messages m JOIN contacts c ON c.id=m.contact_id
        WHERE c.phone=$1 AND m.processed_at IS NULL
        ORDER BY m.seq`,
      [trigger.phone],
    );
    if (!pending.rows[0]) return;
    // Simple rule: if more inbound text arrived before the previous reply was
    // delivered, drop the unsent reply and answer once for the merged burst.
    // A task must never stay frozen behind an old unsent outbox.
    await this.s.pool.query(
      `UPDATE outbox
          SET state='cancelled', format_state='ready', error_code='awaiting_merged_reply'
        WHERE phone=$1
          AND state IN ('pending','sending','uncertain')
          AND text NOT LIKE $2`,
      [trigger.phone, "נדרשת בדיקת מערכת%"],
    );
    // Admit the whole quiet-window candidate set durably before any text is
    // merged. This preserves the exact message sequence across worker restarts
    // and also records media/location messages that are intentionally processed
    // separately by the domain handlers.
    await this.s.transaction(async (c) => {
      const locked = await c.query<{
        id: string;
        conversation_id: string;
        turn_id: string | null;
        turn_generation: number | null;
      }>(
        `SELECT id,conversation_id,turn_id,turn_generation
           FROM messages
          WHERE id=ANY($1::uuid[]) AND processed_at IS NULL
          ORDER BY seq FOR UPDATE`,
        [pending.rows.map((m) => m.id)],
      );
      if (!locked.rows.length) return;
      const existing = locked.rows.find((m) => m.turn_id);
      let turnId = existing?.turn_id ?? null;
      let generation = existing?.turn_generation ?? null;
      if (!turnId) {
        const nextGeneration = await c.query<{ generation: number }>(
          `SELECT COALESCE(max(generation)+1,0)::int AS generation
             FROM conversation_turns WHERE conversation_id=$1`,
          [locked.rows[0]!.conversation_id],
        );
        generation = nextGeneration.rows[0]!.generation;
        const created = await c.query<{ id: string }>(
          `INSERT INTO conversation_turns(conversation_id,generation,deadline_at)
           VALUES($1,$2,clock_timestamp()+($3::int * interval '1 millisecond'))
           RETURNING id`,
          [locked.rows[0]!.conversation_id, generation, quietMs],
        );
        turnId = created.rows[0]!.id;
      }
      for (const [position, message] of locked.rows.entries()) {
        await c.query(
          `INSERT INTO turn_messages(turn_id,message_id,position)
           VALUES($1,$2,$3) ON CONFLICT(turn_id,message_id) DO NOTHING`,
          [turnId, message.id, position],
        );
        await c.query(
          `UPDATE messages SET turn_id=$2,turn_generation=$3
             WHERE id=$1 AND turn_id IS NULL`,
          [message.id, turnId, generation],
        );
      }
      await c.query(
        `UPDATE conversation_turns SET status='processing'
          WHERE id=$1 AND status='pending'`,
        [turnId],
      );
    });
    let next = pending.rows[0]!.id;
    // Merge a quiet-window burst of text and contact cards into one answer.
    // Images/voice/location stay separate so durable capture is never lost.
    const burstable = pending.rows.filter(
      (m) =>
        (m.kind === "text" || m.kind === "contact") && m.media_state === "none",
    );
    const images = pending.rows.filter(
      (m) => m.kind === "image" && m.media_state === "ready",
    );
    if (pending.rows.length > 1 && burstable.length === pending.rows.length) {
      const last = burstable.at(-1)!;
      const parts = burstable.map((m) => m.text.trim()).filter(Boolean);
      const shortBurst = parts.length > 1 && parts.every((part) => part.length <= 48);
      const mergedText = parts.join(shortBurst ? " " : "\n");
      const mergedContacts = burstable.flatMap((m) => m.contacts);
      await this.s.transaction(async (c) => {
        const current = await c.query<{ id: string }>(
          `SELECT m.id FROM messages m JOIN contacts co ON co.id=m.contact_id
            WHERE co.phone=$1 AND m.processed_at IS NULL ORDER BY m.seq FOR UPDATE`,
          [trigger.phone],
        );
        // A newer arrival gets its own coalescing window instead of being
        // silently swallowed into this answer.
        if (
          current.rows.length === pending.rows.length &&
          current.rows.every((m, i) => m.id === pending.rows[i]!.id)
        ) {
          await c.query(
            "UPDATE messages SET text=$2,contacts=$3,kind=$4 WHERE id=$1",
            [
              last.id,
              mergedText,
              JSON.stringify(mergedContacts),
              mergedContacts.length ? "contact" : "text",
            ],
          );
          await c.query(
            "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id = ANY($1::uuid[])",
            [burstable.slice(0, -1).map((m) => m.id), `coalesced_into:${last.id}`],
          );
          next = last.id;
        }
      });
      if (next === last.id && burstable.length > 1) {
        for (const m of burstable.slice(0, -1)) {
          void this.auditTurn(m.id, {
            fate: "coalesced",
            fate_detail: {
              carried_to: last.id,
              merged_text: mergedText,
            },
            reply_text: null,
            error_code: `coalesced_into:${last.id}`,
          });
        }
      }
    } else if (burstable.length && images.length) {
      const lastText =
        [...burstable].reverse().find((m) => m.kind === "text") ??
        burstable.at(-1)!;
      const earlier = burstable.filter((m) => m.id !== lastText.id);
      await this.s.transaction(async (c) => {
        if (earlier.length || burstable.length > 1) {
          const parts = burstable.map((m) => m.text.trim()).filter(Boolean);
          const shortBurst =
            parts.length > 1 && parts.every((part) => part.length <= 48);
          await c.query(
            "UPDATE messages SET text=$2,contacts=$3,kind=$4 WHERE id=$1",
            [
              lastText.id,
              parts.join(shortBurst ? " " : "\n"),
              JSON.stringify(burstable.flatMap((m) => m.contacts)),
              burstable.some((m) => m.contacts.length) ? "contact" : "text",
            ],
          );
          if (earlier.length) {
            await c.query(
              "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id = ANY($1::uuid[])",
              [earlier.map((m) => m.id), `coalesced_into:${lastText.id}`],
            );
          }
        }
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id = ANY($1::uuid[])",
          [images.map((m) => m.id), `attached_to:${lastText.id}`],
        );
      });
      next = lastText.id;
      for (const m of earlier) {
        void this.auditTurn(m.id, {
          fate: "coalesced",
          fate_detail: { carried_to: lastText.id },
          reply_text: null,
          error_code: `coalesced_into:${lastText.id}`,
        });
      }
      for (const m of images) {
        void this.auditTurn(m.id, {
          fate: "coalesced",
          fate_detail: { carried_to: lastText.id, kind: "image_attached" },
          reply_text: null,
          error_code: `attached_to:${lastText.id}`,
        });
      }
    }
    await this.process(next, lastAiAttempt);
  }

  async process(id: string, lastAiAttempt = false): Promise<void> {
    let ctx = await this.s.context(id);
    if (ctx.message.processed_at) return;
    if (!(await this.s.allowed(ctx.conversation.phone))) {
      await this.s.transaction(async (c) => {
        const current = await this.s.message(id, c, true);
        if (current.processed_at) return;
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),error_code='access_denied' WHERE id=$1",
          [id],
        );
        await this.s.event(c, current, "system", "access_denied", {
          phone: ctx.conversation.phone,
        });
      });
      return;
    }
    if (ctx.message.media_state === "pending")
      throw new RetryableError("waiting_for_media");
    if (
      ctx.message.kind === "voice" &&
      ctx.message.media_state === "ready" &&
      !ctx.message.transcript
    ) {
      try {
        const media = await this.s.pool.query<{
          storage_key: string;
          mime_type: string;
        }>(
          "SELECT storage_key,mime_type FROM media WHERE id=$1",
          [ctx.message.media_id],
        );
        const text = await transcribe(
          await this.storage.get(media.rows[0]!.storage_key),
          this.s.config,
          media.rows[0]!.mime_type,
        );
        await this.s.pool.query(
          "UPDATE messages SET transcript=$2 WHERE id=$1 AND transcript IS NULL",
          [id, text],
        );
        ctx = await this.s.context(id);
      } catch {
        if (!lastAiAttempt) throw new RetryableError("voice_retry");
        await this.finish(id, null, "voice_failure");
        return;
      }
    }
    const text = ctx.message.transcript ?? ctx.message.text;
    if (
      ctx.message.kind === "image" ||
      ctx.message.kind === "location" ||
      ctx.message.media_state === "failed" ||
      ctx.conversation.mode === "human"
    ) {
      await this.finish(id, null);
      return;
    }
    let plan = ctx.message.ai_plan;
    if (plan) {
      try {
        plan = planSchema.parse(plan);
      } catch {
        // A persisted malformed/forged plan must become a durable human
        // escalation, never an uncaught worker failure or partial execution.
        await this.finish(id, null, "openai_failure");
        return;
      }
    }
    // Resolve cheap deterministic messages outside the AI error/retry block;
    // a transient DB ordering retry must not be mislabeled as an OpenAI error.
    // A bare כן/לא is not one of those: it may approve a party, confirm a
    // handoff, or answer the admin's capacity question. finish() decides.
    if (
      !plan &&
      (quickReply(text) !== null ||
        isStatus(text) ||
        (ctx.conversation.phone === this.s.config.ADMIN_PHONE &&
          /^#פניות(?:\s+(?:ל)?חיים\s+יחד)?\s*$/.test(text.trim())))
    ) {
      await this.finish(id, null);
      return;
    }
    if (!plan) {
      try {
        // Free-form Hebrew is decoded by the AI. The action manager owns every
        // field value from the prompt; commands.apply is the DB write tool.
        const response = await this.ai.plan(ctx);
        const parsed = planSchema.parse(response.plan);
        plan = parsed;
        await this.s.pool.query(
          `UPDATE messages SET ai_plan=$2,plan_versions=$3,ai_metadata=$4 WHERE id=$1 AND ai_plan IS NULL AND processed_at IS NULL`,
          [
            id,
            JSON.stringify(plan),
            JSON.stringify(this.versions(ctx)),
            JSON.stringify(response.metadata),
          ],
        );
        // If the model returned actionable commands, execute them even when
        // understood=false. Only fall through to rules when there is nothing
        // to write.
        const actionable = plan.commands.some((command) => command.type !== "next");
        if (!response.understood && !actionable)
          throw new AppError("action_manager_unclear");
      } catch (e) {
        // Transient API failures retry once. After the last attempt, rulePlan
        // is only a fallback when the action manager itself failed — never to
        // override a successful AI plan.
        if (!lastAiAttempt && !(e instanceof AppError))
          throw new RetryableError("openai_retry");
        const deterministic = rulePlan(ctx);
        if (deterministic) {
          plan = deterministic;
          await this.s.pool.query(
            `UPDATE messages SET ai_plan=$2,plan_versions=$3,ai_metadata=$4 WHERE id=$1 AND ai_plan IS NULL AND processed_at IS NULL`,
            [
              id,
              JSON.stringify(plan),
              JSON.stringify(this.versions(ctx)),
              JSON.stringify({
                provider: "rules",
                action_source: "rules_fallback",
                ai_error: errorCode(e),
              }),
            ],
          );
        } else if (this.softContinuePastPhoto(ctx, text)) {
          await this.finishNextDetail(id);
          return;
        } else if (this.holdingForPhoto(ctx, text)) {
          await this.finishPhotoHold(id);
          return;
        } else if (
          e instanceof AppError &&
          (e.code === "ai_disabled" || e.code === "action_manager_unclear")
        ) {
          await this.finishUnclear(id);
          return;
        } else {
          await this.finishFault(id, e);
          return;
        }
      }
    }
    try {
      await this.finish(id, plan);
    } catch (e) {
      if (e instanceof RetryableError && e.code === "stale_plan")
        await this.s.pool.query(
          "UPDATE messages SET ai_plan=NULL,plan_versions=NULL WHERE id=$1 AND processed_at IS NULL",
          [id],
        );
      throw e;
    }
  }

  private versions(ctx: Context): Record<string, number> {
    return Object.fromEntries(
      [...ctx.requests, ...ctx.candidates.map((c) => c.request)].map((r) => [
        r.id,
        r.version,
      ]),
    );
  }
  private async alert(
    c: pg.PoolClient,
    ctx: Context,
    reason: string,
    reply: string | null,
    request: Request | null,
  ): Promise<void> {
    await c.query("UPDATE conversations SET mode='human' WHERE id=$1", [
      ctx.conversation.id,
    ]);
    const r =
      request ??
      ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
      (ctx.requests.length === 1 ? ctx.requests[0] : null);
    // One ops alert per request (or per phone when no request yet).
    const dedupe = r?.id
      ? `human-alert:${r.id}`
      : `human-alert-phone:${ctx.conversation.phone}`;
    const already = await c.query(
      "SELECT 1 FROM outbox WHERE dedupe_key=$1 LIMIT 1",
      [dedupe],
    );
    if (already.rowCount) {
      await this.s.event(
        c,
        ctx.message,
        "system",
        "human_escalation_suppressed",
        { reason, dedupe },
        r?.id ?? null,
      );
      return;
    }
    const d = r?.parties.find((p) => p.role === "donor"),
      v = r?.parties.find((p) => p.role === "receiver");
    await this.s.outbound(
      c,
      ctx.message,
      {
        phone: this.s.config.ADMIN_PHONE,
        text: `נדרש טיפול אנושי\nמספר פנייה: ${r?.number ?? "טרם נפתחה"}\nטלפון: ${ctx.conversation.phone}\nפריט: ${r?.items.map((i) => i.description).join(", ") ?? "לא ידוע"}\nמסלול: ${d?.settlement ?? "לא ידוע"} → ${v?.settlement ?? "לא ידוע"}\nסיבה: ${reason}\nהודעת הלקוח האחרונה: ${(ctx.message.transcript ?? ctx.message.text).slice(0, 1500)}\nתשובת הבוט: ${reply ?? "לא נשלחה תגובה אוטומטית"}\nנא לחזור ללקוח.`,
      },
      dedupe,
      r?.id ?? null,
    );
    await this.s.event(
      c,
      ctx.message,
      "system",
      "human_escalation",
      { reason },
      r?.id ?? null,
    );
  }

  private async consecutiveReplyCount(
    conversationId: string,
    beforeSeq: string,
    match: (reply: string) => boolean,
    c: { query: Store["pool"]["query"] } = this.s.pool,
  ): Promise<number> {
    const rows = await c.query<{ reply: string | null }>(
      `SELECT reply FROM messages
        WHERE conversation_id=$1 AND seq<$2 AND processed_at IS NOT NULL
          AND coalesce(error_code,'') NOT LIKE 'coalesced_into:%'
          AND coalesce(error_code,'') NOT LIKE 'superseded_by:%'
        ORDER BY seq DESC LIMIT 8`,
      [conversationId, beforeSeq],
    );
    let count = 0;
    for (const row of rows.rows) {
      if (match((row.reply ?? "").trim())) count += 1;
      else break;
    }
    return count;
  }

  private async unclearCount(
    conversationId: string,
    beforeSeq: string,
    c: { query: Store["pool"]["query"] } = this.s.pool,
  ): Promise<number> {
    return this.consecutiveReplyCount(
      conversationId,
      beforeSeq,
      (reply) =>
        isCustomerClarify(reply) ||
        /^(?:למי תרצה למסור|איזה פריט|מה תרצה לעשות|מה תרצה לקבל|מאיפה או ממי)/u.test(
          reply,
        ),
      c,
    );
  }

  private async faultCount(
    conversationId: string,
    beforeSeq: string,
    c: { query: Store["pool"]["query"] } = this.s.pool,
  ): Promise<number> {
    return this.consecutiveReplyCount(
      conversationId,
      beforeSeq,
      (reply) => reply === FAULT_REPLY,
      c,
    );
  }

  /**
   * A conversation job that cannot be processed must not stay failed.
   * pg-boss key_strict_fifo blocks every later message for that phone while
   * a failed or retry job still holds the singleton key.
   */
  async releaseFailedTurn(messageId: string, error: unknown): Promise<void> {
    try {
      let message: Awaited<ReturnType<Store["message"]>> | null = null;
      try {
        message = await this.s.message(messageId);
      } catch (e) {
        if (e instanceof AppError && e.code === "message_not_found") return;
        throw e;
      }
      if (!message || message.processed_at) return;
      await this.finishFault(messageId, error);
    } catch (e) {
      this.log.error({
        code: errorCode(e),
        stage: "release_failed_turn",
        message_id: messageId,
      });
      await this.s.pool
        .query(
          "UPDATE messages SET processed_at=clock_timestamp(),error_code='conversation_released' WHERE id=$1 AND processed_at IS NULL",
          [messageId],
        )
        .catch(() => undefined);
    }
  }

  /**
   * Never freeze WhatsApp delivery for a phone. Cancel the failed/uncertain
   * outbox row, release the send singleton, and queue the next pending reply.
   */
  async releaseFailedSend(outboxId: string, error: unknown): Promise<void> {
    const code = errorCode(error);
    try {
      await this.s.transaction(async (c) => {
        const row = await c.query<{ phone: string; state: string }>(
          "SELECT phone, state FROM outbox WHERE id=$1 FOR UPDATE",
          [outboxId],
        );
        const out = row.rows[0];
        if (!out) return;
        if (["sent", "shadow", "simulation", "cancelled"].includes(out.state)) {
          await this.s.queue.releaseSingleton("send", out.phone, [
            "failed",
            "retry",
          ]);
          return;
        }
        await c.query(
          `UPDATE outbox
              SET state='cancelled', format_state='ready', error_code=$2
            WHERE id=$1 AND state IN ('pending','sending','uncertain','failed')`,
          [outboxId, code || "send_released"],
        );
        await this.s.queue.releaseSingleton("send", out.phone, [
          "failed",
          "retry",
        ]);
        const next = await c.query<{ id: string }>(
          `SELECT id FROM outbox
            WHERE phone=$1 AND state='pending' AND format_state='ready'
            ORDER BY seq LIMIT 1`,
          [out.phone],
        );
        if (next.rows[0]) {
          const job = await this.s.queue.send(
            c,
            "send",
            { id: next.rows[0].id },
            out.phone,
          );
          await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
            next.rows[0].id,
            job,
          ]);
        }
        this.log.error({
          code: "send_released_without_freeze",
          outbox_id: outboxId,
          phone: out.phone,
          cause: code,
        });
      });
    } catch (e) {
      this.log.error({
        code: errorCode(e),
        stage: "release_failed_send",
        outbox_id: outboxId,
      });
    }
  }

  async abandonIngest(messageId: string, error: unknown): Promise<void> {
    this.log.error({
      code: errorCode(error),
      stage: "ingest_released",
      message_id: messageId,
    });
    await this.s.pool
      .query(
        "UPDATE messages SET processed_at=clock_timestamp(),error_code='ingest_released' WHERE id=$1 AND processed_at IS NULL",
        [messageId],
      )
      .catch(() => undefined);
  }

  private async finishFault(id: string, error: unknown): Promise<void> {
    await this.s.transaction(async (c) => {
      const ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const phone = ctx.conversation.phone;
      const prior = await this.faultCount(ctx.conversation.id, ctx.message.seq, c);
      const next = prior + 1;
      await this.s.event(c, ctx.message, "system", "ai_fault", {
        code: errorCode(error),
        fault_count: next,
      });
      // The first AI/API failure goes to a human, even with no open request.
      // It does not count as unclear.
      const open =
        ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
        ctx.requests.find(
          (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
        ) ??
        null;
      if (open) {
        open.status = "human";
        open.human_reason = "ai_fault_after_retries";
        await this.s.save(c, open);
      }
      await this.alert(c, ctx, "ai_fault_after_retries", FAULT_REPLY, open);
      const faultReply = this.voiced(ctx, FAULT_REPLY);
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: faultReply },
        `reply:${id}`,
        open?.id ?? null,
      );
      await c.query(
        "INSERT INTO command_results(message_id,command,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          id,
          JSON.stringify({ fault: true, code: errorCode(error) }),
          JSON.stringify({
            reply: faultReply,
            intent: "fault",
            code: errorCode(error),
          }),
        ],
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1 AND processed_at IS NULL",
        [id, faultReply, "openai_failure_escalated"],
      );
      await c.query(
        "UPDATE conversations SET mode='human',version=version+1 WHERE id=$1",
        [ctx.conversation.id],
      );
    });
    await this.auditTurn(id, {
      fate: "failed",
      fate_detail: { path: "finishFault" },
      error_code: "openai_failure_escalated",
      intent: "fault",
    });
  }

  private async finishUnclear(id: string): Promise<void> {
    await this.s.transaction(async (c) => {
      const ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const phone = ctx.conversation.phone;
      const prior = await this.unclearCount(ctx.conversation.id, ctx.message.seq, c);
      const next = prior + 1;
      if (next >= 2) {
        const open =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          ctx.requests.find(
            (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
          ) ??
          null;
        if (open) {
          open.status = "human";
          open.human_reason = "unclear_after_two_clarifications";
          await this.s.save(c, open);
        }
        await this.alert(c, ctx, "unclear_after_two_clarifications", HUMAN_REPLY, open);
        const handoff = this.voiced(ctx, HUMAN_REPLY);
        await this.s.outbound(
          c,
          ctx.message,
          { phone, text: handoff },
          `reply:${id}`,
          open?.id ?? null,
        );
        await this.s.event(c, ctx.message, phone, "unclear_escalated", {
          unclear_count: next,
        });
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1 AND processed_at IS NULL",
          [id, handoff, "unclear_escalated"],
        );
        await c.query(
          "UPDATE conversations SET mode='human',version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        return;
      }
      const reply = this.voiced(
        ctx,
        probeReply(ctx.message.transcript ?? ctx.message.text),
      );
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: reply },
        `reply:${id}`,
        null,
      );
      await this.s.event(c, ctx.message, phone, "unclear_clarify", {
        unclear_count: next,
        probe: reply !== this.voiced(ctx, CLARIFY_REPLY),
      });
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2 WHERE id=$1 AND processed_at IS NULL",
        [id, reply],
      );
    });
    await this.auditTurn(id, {
      fate: "completed",
      fate_detail: { path: "finishUnclear" },
      intent: "clarification",
    });
  }

  /** Open donation still missing photo — never sticky for direct; never repeats. */
  private holdingForPhoto(ctx: Context, text: string): boolean {
    if (!text.trim() || customerCancelIntent(text)) return false;
    if (photoDeclined(text)) return false;
    if (photoAskAlreadySent(ctx.history)) return false;
    // Direct handoff: photo is optional; never park the turn on it.
    if (
      directHandoffIntent(text) ||
      ctx.conversation.pending_counterparty_name ||
      ctx.conversation.pending_counterparty_phone ||
      ctx.conversation.pending_extra_item ||
      ctx.requests.some((r) => r.origin === "direct" && photoGate(r))
    )
      return false;
    const waiting = ctx.requests.some(
      (request) =>
        photoGate(request) &&
        request.origin === "donation" &&
        ![
          "coordinated",
          "closed",
          "cancelled",
          "rejected",
          "human",
          "cancel_pending",
        ].includes(request.status),
    );
    if (!waiting) return false;
    const planned = rulePlan(ctx);
    if (
      planned?.commands.some((command) =>
        command.type === "donate" ||
        command.type === "seek" ||
        command.type === "cancel" ||
        command.type === "counterparty" ||
        command.type === "counterparty_candidate" ||
        command.type === "confirm_counterparty",
      )
    )
      return false;
    return true;
  }

  /** After a soft photo ask: decline or other text → next missing field (no re-ask). */
  private softContinuePastPhoto(ctx: Context, text: string): boolean {
    if (!text.trim() || customerCancelIntent(text)) return false;
    const open = (request: Request) =>
      ![
        "coordinated",
        "closed",
        "cancelled",
        "rejected",
        "human",
        "cancel_pending",
      ].includes(request.status);
    // Already asked once — any follow-up text continues past photo.
    if (
      ctx.requests.some(
        (request) =>
          open(request) && request.photo_status === PHOTO_STATUS.ASKED,
      )
    )
      return true;
    const waiting = ctx.requests.some(
      (request) => photoGate(request) && open(request),
    );
    if (!waiting) return false;
    return (
      photoDeclined(text) ||
      photoAskAlreadySent(ctx.history) ||
      ctx.requests.some((r) => r.origin === "direct" && photoGate(r))
    );
  }

  private async finishPhotoHold(id: string): Promise<void> {
    await this.s.transaction(async (c) => {
      const ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const phone = ctx.conversation.phone;
      const request =
        ctx.requests.find(
          (candidate) =>
            candidate.id === ctx.conversation.selected_request_id &&
            photoGate(candidate),
        ) ??
        ctx.requests.find((candidate) => photoGate(candidate)) ??
        null;
      const text = ctx.message.transcript ?? ctx.message.text;
      const continuePast =
        !request ||
        photoDeclined(text) ||
        photoAskAlreadySent(ctx.history) ||
        request.origin === "direct" ||
        photoStatusSkipsGate(request.photo_status);
      if (request && continuePast) {
        if (
          request.photo_status === PHOTO_STATUS.NOT_ASKED ||
          request.photo_status === PHOTO_STATUS.ASKED
        ) {
          request.photo_status = PHOTO_STATUS.NO_PHOTO;
          await this.s.save(c, request);
        }
      } else if (request && photoGate(request)) {
        request.photo_status = PHOTO_STATUS.ASKED;
        await this.s.save(c, request);
      }
      const photoReply = this.voiced(
        ctx,
        request
          ? continuePast
            ? // No new write this turn — ask next field only, no full-chat summary.
              nextQuestion(request, phone).text
            : openingPhotoReply(request, phone, null)
          : SOFT_PHOTO_ASK,
      );
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: photoReply },
        `reply:${id}`,
        request?.id ?? null,
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2 WHERE id=$1 AND processed_at IS NULL",
        [id, photoReply],
      );
    });
    await this.auditTurn(id, {
      fate: "completed",
      fate_detail: { path: "finishPhotoHold" },
      intent: "ask_photo",
      photoHold: true,
    });
  }

  private async finishNextDetail(id: string): Promise<void> {
    await this.s.transaction(async (c) => {
      const ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const phone = ctx.conversation.phone;
      const request =
        ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
        ctx.requests.find((r) => photoGate(r)) ??
        ctx.requests.find(
          (r) =>
            !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
        ) ??
        null;
      if (
        request &&
        (request.photo_status === PHOTO_STATUS.ASKED ||
          (request.photo_status === PHOTO_STATUS.NOT_ASKED &&
            photoAskAlreadySent(ctx.history)))
      ) {
        request.photo_status = PHOTO_STATUS.NO_PHOTO;
        await this.s.save(c, request);
      }
      const reply = this.voiced(
        ctx,
        request
          ? nextQuestion(request, phone).text
          : "מה הפרט הבא שתרצה להשלים?",
      );
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: reply },
        `reply:${id}`,
        request?.id ?? null,
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2 WHERE id=$1 AND processed_at IS NULL",
        [id, reply],
      );
    });
    await this.auditTurn(id, {
      fate: "completed",
      fate_detail: { path: "finishNextDetail" },
      intent: "ask_details",
    });
  }

  private voiced(ctx: Context, text: string): string {
    return localizeCustomer(text, conversationLanguage(ctx));
  }

  /** Best-effort audit row — never throws into the turn path. */
  private async recordTurnLogSafe(
    row: Parameters<typeof insertTurnLog>[1],
  ): Promise<void> {
    try {
      await insertTurnLog(this.s.pool, row);
    } catch (e) {
      this.log.error({
        code: "turn_log_write_failed",
        error: errorCode(e),
        turn_fate: row.turn_fate,
        phone: row.phone ?? null,
      });
    }
  }

  private async auditTurn(
    id: string,
    opts: {
      fate: TurnFate;
      fate_detail?: Record<string, unknown>;
      state_before?: Record<string, unknown>;
      reply_text?: string | null;
      outbox_id?: string | null;
      error_code?: string | null;
      opened_at?: string | null;
      intent?: string | null;
      photoHold?: boolean;
      introduced?: boolean;
    },
  ): Promise<void> {
    try {
      const ctx = await this.s.context(id);
      const ids = await messageIdsForTurn(this.s.pool, id);
      const extras = await this.s.pool.query<{
        ai_metadata: Record<string, unknown> | null;
        reply: string | null;
        error_code: string | null;
        ai_plan: Plan | null;
      }>(
        "SELECT ai_metadata, reply, error_code, ai_plan FROM messages WHERE id=$1",
        [id],
      );
      const row = extras.rows[0];
      const meta = row?.ai_metadata ?? null;
      const { model_input, model_output } = modelIOFromMetadata(meta);
      const replyMeta =
        meta && meta.reply && typeof meta.reply === "object"
          ? (meta.reply as Record<string, unknown>)
          : null;
      if (replyMeta) {
        const replyIO = modelIOFromMetadata(replyMeta);
        model_input.reply = replyIO.model_input;
        model_output.reply = replyIO.model_output;
      }
      const planSource = row?.ai_plan ?? ctx.message.ai_plan;
      const plan = planSource
        ? planSchema.safeParse(planSource).success
          ? planSchema.parse(planSource)
          : null
        : null;
      const replyText = opts.reply_text ?? row?.reply ?? null;
      await this.recordTurnLogSafe({
        conversation_id: ctx.conversation.id,
        turn_id: ids.turn_id,
        phone: ctx.conversation.phone,
        message_ids: ids.message_ids,
        merged_text: ctx.message.transcript ?? ctx.message.text,
        turn_fate: opts.fate,
        fate_detail: opts.fate_detail ?? {},
        state_before: opts.state_before ?? {},
        state_after: snapshotTurnState(ctx),
        model_input,
        model_output,
        tool_calls: toolCallsFromPlan(plan),
        policies: observePolicies(ctx, {
          reply: replyText,
          intent: opts.intent,
          text: ctx.message.transcript ?? ctx.message.text,
          introduced: opts.introduced,
          photoHold: opts.photoHold,
        }),
        reply_text: replyText,
        outbox_id: opts.outbox_id ?? null,
        error_code: opts.error_code ?? row?.error_code ?? null,
        opened_at: opts.opened_at ?? null,
        completed_at: new Date().toISOString(),
      });
    } catch (e) {
      this.log.error({
        code: "turn_log_audit_failed",
        error: errorCode(e),
        message_id: id,
      });
    }
  }

  private async finish(
    id: string,
    proposed: Plan | null,
    technicalReason?: string,
  ): Promise<void> {
    const openedAt = new Date().toISOString();
    let stateBefore: Record<string, unknown> = {};
    try {
      stateBefore = snapshotTurnState(await this.s.context(id));
    } catch {
      /* pre-snapshot is best-effort */
    }
    const deferredNotices: {
      outboxId: string;
      notice: Notice;
      requestId: string | null;
    }[] = [];
    const committed = await this.s.transaction(async (c) => {
      let ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const text = ctx.message.transcript ?? ctx.message.text,
        phone = ctx.conversation.phone;
      const older = await c.query(
        "SELECT 1 FROM messages m JOIN contacts co ON co.id=m.contact_id WHERE co.phone=$1 AND m.seq<$2 AND m.processed_at IS NULL LIMIT 1",
        [phone, ctx.message.seq],
      );
      if (older.rowCount) throw new RetryableError("earlier_message_pending");
      // AI may have been evaluating while a newer message arrived. The old
      // answer is no longer authoritative: close it without an outbox reply,
      // leave a durable audit trail, and let the newer turn own the response.
      const newer = await c.query<{ id: string }>(
        `SELECT m.id FROM messages m
          WHERE m.conversation_id=$1 AND m.seq>$2 AND m.processed_at IS NULL
          ORDER BY m.seq LIMIT 1`,
        [ctx.conversation.id, ctx.message.seq],
      );
      if (newer.rows[0]) {
        const successorId = newer.rows[0].id;
        const successor = await c.query<{
          kind: string;
          text: string;
          contacts: { phone: string; name: string | null }[];
        }>(
          "SELECT kind,text,contacts FROM messages WHERE id=$1",
          [successorId],
        );
        const successorKind = successor.rows[0]?.kind ?? "text";
        // A pending image/voice/location follow-up must not cancel the older
        // text turn that opens the request. FIFO processes media after this
        // commit. Newer text OR contact-card turns may supersede a stale plan
        // so a burst never yields two customer replies for one thought.
        if (successorKind === "text" || successorKind === "contact") {
          // Keep donate handoff sticky when the abandoned plan already knew
          // "רוצה למסור לטל" — otherwise the next short bubble re-asks path.
          const abandoned = ctx.message.ai_plan as {
            commands?: Array<{
              type?: string;
              counterparty_name?: string | null;
              counterparty_phone?: string | null;
            }>;
          } | null;
          for (const cmd of abandoned?.commands ?? []) {
            if (
              cmd.type === "donate" &&
              (cmd.counterparty_name || cmd.counterparty_phone)
            ) {
              await c.query(
                `UPDATE conversations
                    SET pending_counterparty_name=COALESCE($2, pending_counterparty_name),
                        pending_counterparty_phone=COALESCE($3, pending_counterparty_phone),
                        version=version+1
                  WHERE id=$1`,
                [
                  ctx.conversation.id,
                  cmd.counterparty_name ?? null,
                  cmd.counterparty_phone ?? null,
                ],
              );
              if (cmd.counterparty_name)
                ctx.conversation.pending_counterparty_name =
                  ctx.conversation.pending_counterparty_name ??
                  cmd.counterparty_name;
              if (cmd.counterparty_phone)
                ctx.conversation.pending_counterparty_phone =
                  ctx.conversation.pending_counterparty_phone ??
                  cmd.counterparty_phone;
            }
          }
          // Fold the superseded bubble into the successor so decode still sees
          // "רוצה למסור" / "לטל" when the user split them across messages.
          const priorText = (ctx.message.transcript ?? ctx.message.text ?? "").trim();
          const nextText = (successor.rows[0]?.text ?? "").trim();
          if (priorText && nextText && !nextText.includes(priorText)) {
            const merged = `${priorText} ${nextText}`.trim();
            const mergedContacts = [
              ...(ctx.message.contacts ?? []),
              ...(successor.rows[0]?.contacts ?? []),
            ];
            await c.query(
              "UPDATE messages SET text=$2,contacts=$3 WHERE id=$1",
              [successorId, merged, JSON.stringify(mergedContacts)],
            );
          }
          await c.query(
            "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id=$1 AND processed_at IS NULL",
            [id, `superseded_by:${successorId}`],
          );
          await c.query(
            `UPDATE conversation_turns SET status='superseded',completed_at=clock_timestamp()
               WHERE id=(SELECT turn_id FROM messages WHERE id=$1)`,
            [id],
          );
          await this.s.event(c, ctx.message, "system", "turn_superseded", {
            successor_message_id: successorId,
          });
          return {
            trace_id: ctx.message.trace_id,
            message_id: id,
            mode: ctx.message.mode,
            stage: "superseded",
            request_number: null,
            code: "turn_superseded",
          };
        }
      }
      let reply: string | null = null,
        request: Request | null = null,
        reason: string | undefined = technicalReason,
        protectedReply = false,
        intent = "other";
      const plan = ctx.message.ai_plan
        ? planSchema.parse(ctx.message.ai_plan)
        : proposed;
      if (proposed && !ctx.message.ai_plan) {
        await c.query(
          `UPDATE messages SET ai_plan=$2,plan_versions=$3,
            ai_metadata=coalesce(ai_metadata,'{}'::jsonb) || $4::jsonb
           WHERE id=$1 AND ai_plan IS NULL AND processed_at IS NULL`,
          [
            id,
            JSON.stringify(proposed),
            JSON.stringify(this.versions(ctx)),
            JSON.stringify({ action_source: "rules", provider: "rules" }),
          ],
        );
      }
      const beforeRequest = structuredClone(
        ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          ctx.requests.find(
            (r) =>
              !["coordinated", "closed", "cancelled", "rejected"].includes(
                r.status,
              ),
          ) ??
          null,
      );
      const beforeSearch = structuredClone(ctx.active_search ?? null);
      let changedFields: ChangedField[] = [];
      let capacityDecision = /^(כן|לא)(?:\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}))?\s*$/.exec(text.trim());
      // A bare "כן"/"לא" is ordinary conversation unless the configured
      // administrator actually has a pending capacity decision. A dated
      // answer remains an explicit capacity command so unauthorized actors
      // receive the correct rejection instead of mutating a request.
      if (capacityDecision && !capacityDecision[2]) {
        if (phone !== this.s.config.ADMIN_PHONE) capacityDecision = null;
        else {
          const pending = await c.query(
            "SELECT 1 FROM transport_capacity_approvals WHERE status='pending' LIMIT 1",
          );
          if (!pending.rowCount) capacityDecision = null;
        }
      }
      if (capacityDecision) {
        intent = "acknowledge";
        if (phone !== this.s.config.ADMIN_PHONE) {
          reply = "רק המנהל המורשה יכול לאשר הובלה מעבר למכסה. הבקשה שלך לא שינתה את התיאום.";
          protectedReply = true;
        } else {
          const suppliedDate = capacityDecision[2];
          const date = suppliedDate
            ? suppliedDate.includes("/")
              ? suppliedDate.split("/").reverse().join("-")
              : suppliedDate
            : null;
          const parsedDate = date ? new Date(`${date}T12:00:00Z`) : null;
          if (
            date &&
            (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              Number.isNaN(parsedDate?.getTime()) ||
              parsedDate?.toISOString().slice(0, 10) !== date)
          ) {
            reply = "התאריך לא תקין. נא להשיב כן או לא בצירוף תאריך בפורמט YYYY-MM-DD.";
            protectedReply = true;
          } else {
            const result = await this.s.resolveCapacityApproval(
              c,
              date,
              capacityDecision[1] === "כן",
              phone,
            );
            reply =
              result === "approved"
                ? "אישרת הובלה נוספת אחת. המכסה הוגדלה באותו יום בלבד; ההובלה עדיין תתואם רק לאחר אישורי הצדדים."
                : result === "denied"
                  ? "הבנתי. לא אוסיף הובלה לאותו יום; הפניות הממתינות יישארו ללא תיאום."
                  : result === "ambiguous"
                    ? "יש כמה בקשות ממתינות. נא להשיב כן או לא בצירוף תאריך בפורמט YYYY-MM-DD."
                    : "אין בקשת הגדלת מכסה ממתינה כרגע.";
            protectedReply = true;
          }
        }
      } else if (
        phone === this.s.config.ADMIN_PHONE &&
        /^#פניות(?:\s+(?:ל)?חיים\s+יחד)?\s*$/.test(text.trim())
      ) {
        intent = "acknowledge";
        const ids = await c.query<{ id: string }>(
          "SELECT id FROM requests ORDER BY number",
        );
        const requests: Request[] = [];
        for (const row of ids.rows) requests.push(await this.s.request(row.id, c));
        reply = statusText(requests);
        protectedReply = true;
        for (const current of requests)
          for (const mediaId of current.photo_ids)
            await this.s.outbound(c, ctx.message, { phone, text: `תמונה שמורה מפנייה ${current.number}`, media_id: mediaId }, `admin-status-media:${id}:${current.id}:${mediaId}`, current.id);
      } else if (isStatus(text)) { reply = statusText(ctx.requests); intent = "other"; }
      else if (ctx.conversation.mode === "human") {
        // Already handed off — no repeat ops alerts. Keep collecting silently
        // only if the customer insists again is already covered by mode=human.
        intent = "human_escalation";
        const open =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : null);
        reply = open
          ? `הפנייה בטיפול אנושי. ${nextQuestion(open, phone).text}`
          : "הפנייה בטיפול אנושי. נחזור אליך.";
      } else if (
        customerInsistsAfterDenial(text) &&
        ctx.history.some(
          (entry) =>
            entry.role === "assistant" &&
            (entry.content.includes(OUTSIDE) ||
              /לא נוכל לסייע|מחוץ לאזור|לא במדיניות|אי אפשר/.test(entry.content)),
        )
      ) {
        intent = "human_escalation";
        const open =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : null);
        if (open && open.status !== "coordinated") {
          open.status = "human";
          open.human_reason = "customer_insisted";
          await this.s.save(c, open);
          request = open;
        }
        reply = HUMAN_REPLY;
        reason = "customer_insisted";
      } else if (technicalReason || ctx.message.media_state === "failed") {
        intent = technicalReason ? "clarification" : "human_escalation";
        const selected =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
        if (technicalReason === "openai_failure" || technicalReason === "voice_failure") {
          reply = selected
            ? `לא הצלחתי להבין את ההודעה. ${nextQuestion(selected, phone).text}`
            : "לא הצלחתי להבין. אפשר לכתוב, למשל: אני רוצה למסור מיטה.";
          // A final AI failure is a real human-handling event. Keep the safe
          // fallback for the customer, but also create the durable admin alert.
          reason = technicalReason;
          await this.s.event(c, ctx.message, "system", "automatic_fallback", {
            technical_reason: technicalReason,
          }, selected?.id ?? null);
        } else {
          reply =
            "לא הצלחנו להשלים את הטיפול בהודעה. העברתי לבדיקה אנושית. נעדכן.";
          reason ??= "media_failure";
        }
      } else if (quickReply(text) !== null) {
        intent = "acknowledge";
        const quick = quickReply(text)!;
        const selected =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
        reply = selected && quick.startsWith("שלום וברוכים")
          ? nextQuestion(selected, phone).text
          : quick;
      }
      else if (ctx.message.kind === "image") {
        intent = "ask_details";
        const owned = ctx.requests.filter(
          (r) =>
            r.parties.some((p) => p.role === "donor" && p.phone === phone) &&
            ![
              "coordinated",
              "closed",
              "cancelled",
              "rejected",
              "cancel_pending",
            ].includes(r.status),
        );
        const selected =
          owned.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (owned.length === 1 ? owned[0] : undefined);
        if (selected) request = await this.s.request(selected.id, c, true);
        if (
          request &&
          ![
            "coordinated",
            "closed",
            "cancelled",
            "rejected",
            "cancel_pending",
          ].includes(request.status)
        ) {
          await this.s.linkPhoto(c, request, ctx.message);
          if (request.parties.length === 1) request.status = "available";
          await this.s.save(c, request);
          const watchers = await c.query<{ phone: string }>(
            "SELECT co.phone FROM matches m JOIN contacts co ON co.id=m.contact_id WHERE m.request_id=$1 AND m.state=$2",
            [request.id, "waiting_photo"],
          );
          for (const watcher of watchers.rows)
            await this.s.matchPhoto(c, request, watcher.phone, ctx.message);
          await this.s.event(
            c,
            ctx.message,
            phone,
            "photo_received",
            { media_id: ctx.message.media_id },
            request.id,
          );
        } else
          await this.s.event(c, ctx.message, phone, "unassigned_photo", {
            media_id: ctx.message.media_id,
          });
        reply = request
          ? `${PHOTO_THANKS}\n${nextQuestion(request, phone).text}`
          : PHOTO_THANKS;
      } else if (ctx.message.kind === "location") {
        intent = "ask_address";
        const selected =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
        if (selected) {
          request = await this.s.request(selected.id, c, true);
          const party = request.parties.find((p) => p.phone === phone);
          if (party && ctx.message.location)
            await c.query(
              `INSERT INTO request_locations(request_id,role,latitude,longitude,message_id)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(request_id,role) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,message_id=EXCLUDED.message_id,captured_at=clock_timestamp()`,
              [
                request.id,
                party.role,
                ctx.message.location.latitude,
                ctx.message.location.longitude,
                ctx.message.id,
              ],
            );
        }
        await this.s.event(
          c,
          ctx.message,
          phone,
          "location_received",
          { location: ctx.message.location },
          request?.id ?? ctx.conversation.selected_request_id,
        );
        reply = request
          ? `נקודת המיקום התקבלה. ${nextQuestion(request, phone).text}`
          : "נקודת המיקום התקבלה. נא לציין גם את שם היישוב אם עדיין לא נמסר.";
      } else if (plan) {
        const stored = await c.query<{
          plan_versions: Record<string, number> | null;
        }>("SELECT plan_versions FROM messages WHERE id=$1", [id]);
        const expected = stored.rows[0]?.plan_versions ?? {};
        for (const rid of Object.keys(expected).sort()) {
          const current = await this.s.request(rid, c, true);
          if (current.version !== expected[rid])
            throw new RetryableError("stale_plan");
        }
        await c.query("SAVEPOINT business_commands");
        try {
          // A clear outside endpoint takes precedence over all collection/escalation
          // commands from this message. Never alert a human for this rejection.
          const outside = [];
          for (const cmd of plan.commands)
            if (
              cmd.type === "details" &&
              cmd.settlement &&
              !(
                cmd.address &&
                /^(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד)/.test(cmd.address) &&
                cmd.address.includes(cmd.settlement)
              ) &&
              (await this.s.region(c, cmd.settlement)).decision === "outside"
            )
              outside.push(cmd);
          if (outside.length) {
            const n = outside[0]!.request_number;
            const r =
              ctx.requests.find((r) =>
                n
                  ? r.number === n
                  : r.id === ctx.conversation.selected_request_id,
              ) ?? (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
            if (r) {
              request = await this.s.request(r.id, c, true);
              mutable(request);
              request.status = "rejected";
              await this.s.save(c, request);
            }
            reply = OUTSIDE;
            await this.s.event(
              c,
              ctx.message,
              phone,
              "outside_area_rejected",
              {},
              request?.id ?? null,
            );
          } else {
            const handoffTransitionPlanned = plan.commands.some((candidate) =>
              candidate.type === "counterparty_candidate" ||
              candidate.type === "confirm_counterparty" ||
              candidate.type === "counterparty" ||
              (candidate.type === "donate" &&
                (candidate.direct === true ||
                  Boolean(candidate.counterparty_name) ||
                  Boolean(candidate.counterparty_phone)))
            );
            // Run the action-manager plan in dependency order. Do not drop or
            // skip commands for photo/status gates — those only shape the reply
            // after every write has been attempted.
            const orderedCommands = [...plan.commands];
            for (let detailsIndex = 0; detailsIndex < orderedCommands.length; detailsIndex++) {
              const detailsCommand = orderedCommands[detailsIndex]!;
              if (detailsCommand.type !== "details" || detailsCommand.role !== "receiver") continue;
              const counterpartyIndex = orderedCommands.findIndex(
                (candidate, candidateIndex) =>
                  candidateIndex > detailsIndex &&
                  candidate.type === "counterparty" &&
                  candidate.request_number === detailsCommand.request_number,
              );
              if (counterpartyIndex < 0) continue;
              const [counterpartyCommand] = orderedCommands.splice(counterpartyIndex, 1);
              orderedCommands.splice(detailsIndex, 0, counterpartyCommand!);
              detailsIndex++;
            }
            let index = 0;
            for (const command of orderedCommands) {
              ctx = await this.s.context(id, c);
              const result: Outcome = await this.commands.apply(
                c,
                ctx,
                command,
              );
              if (result.request) {
                request = result.request;
                await this.s.save(c, request);
              }
              reply = result.reply;
              reason = result.humanReason;
              intent =
                command.type === "counterparty" ||
                command.type === "contact_counterparty"
                  ? "ask_verification"
                  : command.type === "details"
                    ? "ask_details"
                    : command.type === "donate" &&
                        (/תמונה/.test(result.reply ?? "") ||
                          result.request?.origin !== "direct")
                      ? "ask_photo"
                      : "acknowledge";
              await this.s.event(
                c,
                ctx.message,
                phone,
                `command.${command.type}`,
                { command },
                result.request?.id ?? null,
              );
              for (const [n, notice] of result.notices.entries()) {
                const dedupeKey = `notice:${id}:${index}:${n}`;
                const outboxId = await this.s.outbound(
                  c,
                  ctx.message,
                  notice,
                  dedupeKey,
                  result.request?.id ?? null,
                  "pending",
                );
                if (outboxId)
                  deferredNotices.push({
                    outboxId,
                    notice,
                    requestId: result.request?.id ?? null,
                  });
              }
              index++;
              if (reason || request?.status === "rejected") break;
            }
            // If this turn just marked «בוקשה» (commands or below), keep the soft
            // ask even when a later command overwrote the reply with nextQuestion.
            const photoAskedThisTurn =
              Boolean(request) &&
              request!.photo_status === PHOTO_STATUS.ASKED &&
              (beforeRequest?.photo_status ?? PHOTO_STATUS.NOT_ASKED) ===
                PHOTO_STATUS.NOT_ASKED;
            let attachedPhotoThisTurn = false;
            if (request) {
              const attached = await c.query<{
                id: string;
                media_id: string | null;
                phone: string | null;
              }>(
                `SELECT m.id,m.media_id,co.phone
                   FROM messages m
                   LEFT JOIN contacts co ON co.id=m.contact_id
                  WHERE m.conversation_id=$1 AND m.error_code=$2 AND m.kind='image'`,
                [ctx.conversation.id, `attached_to:${id}`],
              );
              for (const photo of attached.rows) {
                if (!photo.media_id) continue;
                try {
                  await this.s.linkPhoto(c, request, {
                    ...ctx.message,
                    id: photo.id,
                    kind: "image",
                    media_id: photo.media_id,
                    media_state: "ready",
                    phone: photo.phone ?? ctx.message.phone,
                  });
                } catch {
                  // Seeker photos or unauthorized images stay attached for audit
                  // without blocking the text reply.
                }
              }
              if (attached.rows.length && request.photo_ids.length) {
                attachedPhotoThisTurn = true;
                if (request.parties.length === 1 && request.origin === "donation")
                  request.status = "available";
                request.photo_status = PHOTO_STATUS.RECEIVED;
                await this.s.save(c, request);
                if (reply && !reply.includes(PHOTO_THANKS))
                  reply = `${PHOTO_THANKS}\n${reply}`;
                else if (!reply) reply = PHOTO_THANKS;
              }
            }
            // Soft optional photo ask once. Persist «בוקשה»; never re-ask after that.
            const explicitClarification =
              /כבר קיימת פנייה|הפרטים האלה כבר רשומים|כתוב "במקום" או "בנוסף"|כתוב "אותו מקבל" או "מקבל אחר"|עד שני רהיטים לכל מוסר|רשמתי שמדובר במסירה|מה הפריט שברצונך למסור/.test(
                reply ?? "",
              );
            const photoAsked = photoAskAlreadySent(ctx.history);
            const declinedPhoto = photoDeclined(text);
            // Entered turn already «בוקשה»: any non-photo answer → «אין תמונה».
            // Do not flip on the same turn we just asked (before was still לא בוקשה).
            if (
              request &&
              !reason &&
              beforeRequest?.photo_status === PHOTO_STATUS.ASKED &&
              ctx.message.kind !== "image" &&
              !attachedPhotoThisTurn
            ) {
              request.photo_status = PHOTO_STATUS.NO_PHOTO;
              await this.s.save(c, request);
            }
            if (
              request &&
              !reason &&
              !explicitClarification &&
              photoGate(request) &&
              !ctx.conversation.pending_extra_item &&
              !["cancelled", "rejected", "human", "closed", "coordinated"].includes(
                request.status,
              )
            ) {
              void handoffTransitionPlanned;
              if (!declinedPhoto && !photoAsked) {
                // Soft photo once, ack only fields written this turn (before→after).
                const soft = openingPhotoReply(request, phone, beforeRequest);
                if (
                  !reply ||
                  reply === PHOTO_FIRST ||
                  reply === SOFT_PHOTO_ASK ||
                  reply.includes(PHOTO_FIRST) ||
                  /^רשמתי מסירה/.test(reply)
                )
                  reply = soft;
                else if (!/תמונה/.test(reply)) {
                  const ack = summarizeTurnChanges(beforeRequest, request);
                  reply = ack ? `${ack}\n${reply}\n${SOFT_PHOTO_ASK}` : `${reply}\n${SOFT_PHOTO_ASK}`;
                }
                intent = "ask_photo";
                request.photo_status = PHOTO_STATUS.ASKED;
                await this.s.save(c, request);
              } else {
                // Declined before ask persisted — mark no photo and continue.
                request.photo_status = PHOTO_STATUS.NO_PHOTO;
                await this.s.save(c, request);
                reply = nextQuestion(request, phone).text;
                intent = "ask_details";
              }
            } else if (
              request &&
              !reason &&
              !explicitClarification &&
              photoAskedThisTurn &&
              !declinedPhoto &&
              !(reply?.includes(SOFT_PHOTO_ASK) || reply?.includes(PHOTO_FIRST))
            ) {
              // Commands already set «בוקשה» but a later command dropped the ask.
              reply = openingPhotoReply(request, phone, beforeRequest);
              intent = "ask_photo";
            } else if (
              request &&
              !reason &&
              photoStatusSkipsGate(request.photo_status) &&
              !photoAskedThisTurn &&
              (reply?.includes(PHOTO_FIRST) || reply?.includes(SOFT_PHOTO_ASK))
            ) {
              // Never re-surface a photo ask after the gate closed on a prior turn.
              reply = nextQuestion(request, phone).text;
              if (intent === "ask_photo") intent = "ask_details";
            }
            if (
              reply &&
              sameDayDemand(text) &&
              (reply.includes(SOFT_PHOTO_ASK) || reply.includes(PHOTO_FIRST)) &&
              !reply.includes(SAME_DAY_WINDOW)
            )
              reply = `${SAME_DAY_WINDOW}\n${reply}`;
            if (
              request &&
              !reason &&
              request.status !== "coordinated" &&
              readyToProposeSchedule(request) &&
              (!request.proposed_run_date || request.proposed_run_date < nextTuesday(this.now()).date)
            ) {
              const previousProposal = request.proposed_run_date;
              const proposed = await this.s.proposeScheduleDate(c, request, this.now());
              if (!proposed) {
                request.status = "waiting_capacity";
                const capacityApproval = await c.query<{ status: string }>(
                  "SELECT status FROM transport_capacity_approvals WHERE request_id=$1 ORDER BY requested_at DESC LIMIT 1",
                  [request.id],
                );
                reply = capacityApproval.rows[0]?.status === "pending"
                  ? "מכסת ההובלות ליום שלישי מלאה. שלחתי למנהל בקשה לאשר הובלה נוספת. הפנייה ממתינה, ולא ייקבע מועד נוסף עד לאישור מפורש."
                  : capacityApproval.rows[0]?.status === "denied"
                    ? "המנהל לא אישר הובלה נוספת ליום שלישי זה. הפנייה נשארה בהמתנה ולא תואמה."
                    : "אין כרגע מועד שניתן להציע. השארתי את הפנייה בהמתנה; לא תואם מועד נוסף.";
                await this.s.save(c, request);
              } else {
                request.proposed_run_date = proposed;
                request.status = "awaiting_approval";
                if (previousProposal !== proposed)
                  for (const p of request.parties) {
                    p.schedule_approved = false;
                    p.schedule_approved_date = null;
                    p.schedule_approved_at = null;
                  }
                await this.s.save(c, request);
                reply = nextQuestion(request, phone).text;
                intent = "ask_schedule_approval";
                for (const p of request.parties) {
                  if (p.phone === phone || request.represents_both_parties) continue;
                  const permission = await c.query<{ state: string }>(
                    "SELECT state FROM request_verifications WHERE request_id=$1 AND role=$2",
                    [request.id, p.role],
                  );
                  const authorized = ["consented", "queued", "provider_accepted", "delivered", "approved"].includes(permission.rows[0]?.state ?? "");
                  if (!authorized) continue;
                  const notice = { phone: p.phone, text: nextQuestion(request, p.phone).text };
                  const outboxId = await this.s.outbound(
                    c,
                    ctx.message,
                    notice,
                    `schedule-proposal:${request.id}:${proposed}:${p.phone}`,
                    request.id,
                    "pending",
                  );
                  if (outboxId)
                    deferredNotices.push({ outboxId, notice, requestId: request.id });
                }
              }
            }
            if (request && !reason) {
              const coordinated = await this.s.coordinate(
                c,
                request,
                this.now(),
              );
              if (coordinated === "same_day") {
                reason = "same_day_admin_approval";
                reply = HUMAN_REPLY;
              }
              if (coordinated === "full") {
                const fullDate = request.proposed_run_date!;
                request.status = "waiting_capacity";
                await this.s.save(c, request);
                const approval = await c.query<{ status: string }>(
                  "SELECT status FROM transport_capacity_approvals WHERE run_date=$1 ORDER BY requested_at DESC LIMIT 1",
                  [fullDate],
                );
                reply = approval.rows[0]?.status === "pending"
                  ? `הגענו למכסת ההובלות ליום שלישי ${fullDate}. שלחתי למנהל בקשה לאשר הובלה נוספת. הפנייה ממתינה; לא אעביר אותה אוטומטית לשבוע הבא ולא אתאם בלי אישור.`
                  : `מכסת ההובלות ליום שלישי ${fullDate} מלאה ולא אושרה הובלה נוספת. הפנייה נשארה בהמתנה ללא תיאום.`;
              } else if (coordinated === "capacity_denied") {
                request.status = "waiting_capacity";
                await this.s.save(c, request);
                reply = "המנהל לא אישר הובלה נוספת ליום שלישי הזה. הפנייה נשארה בהמתנה ולא תואמה.";
              }
              if (coordinated === "coordinated") {
                await this.s.save(c, request);
                reply = statusText([request]);
                intent = "coordinated";
                await this.s.event(
                  c,
                  ctx.message,
                  "system",
                  "coordinated",
                  { date: request.run_date },
                  request.id,
                );
                for (const p of request.parties)
                  if (p.phone !== phone)
                    {
                    const notice = { phone: p.phone, text: reply };
                    const outboxId = await this.s.outbound(
                      c,
                      ctx.message,
                      notice,
                      `coordination:${request.id}:${request.run_date}:${p.phone}`,
                      request.id,
                      "pending",
                    );
                    if (outboxId)
                      deferredNotices.push({ outboxId, notice, requestId: request.id });
                    }
              }
            }
          }
          await c.query("RELEASE SAVEPOINT business_commands");
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT business_commands");
          if (!(e instanceof AppError)) throw e;
          request = null;
          reason = undefined;
          reply = e.publicMessage;
          intent = "clarification";
          await this.s.event(c, ctx.message, phone, "tool_rejected", {
            code: e.code,
          });
          if (e.status === 403) {
            reason = `tool_authorization:${e.code}`;
            reply = HUMAN_REPLY;
          }
        }
      } else {
        reply = HUMAN_REPLY;
        reason = "no_plan";
        intent = "human_escalation";
      }
      const afterCtx = await this.s.context(id, c);
      changedFields = diffChangedFields({
        beforeRequest,
        afterRequest: request,
        beforeSearch,
        afterSearch: afterCtx.active_search ?? null,
      });
      // Rebuild ack from DB writes this turn only — never invent, never repeat
      // the full conversation summary when nothing new was persisted.
      if (
        request &&
        !reason &&
        (intent === "ask_photo" ||
          intent === "ask_details" ||
          intent === "acknowledge" ||
          /^(?:מעולה, )?רשמתי/.test(reply ?? ""))
      ) {
        // Keep this-turn soft ask when intent is ask_photo; never re-open gate.
        const ask =
          intent === "ask_photo" ? SOFT_PHOTO_ASK : nextQuestion(request, phone).text;
        const rebuilt = composeTurnReply(ask, beforeRequest, request);
        if (rebuilt.trim()) reply = rebuilt;
      }
      // No-progress: nothing new in DB → never resend the identical previous ask.
      // Keep command clarifications that are already distinct from the bare next
      // ask (e.g. explicit third-party contact confirmation after a bare «כן»).
      if (request && !reason && changedFields.length === 0 && intent !== "ask_photo") {
        const previousBot =
          [...ctx.history]
            .reverse()
            .find((entry) => entry.role === "assistant")?.content ?? "";
        const next = nextQuestion(request, phone).text;
        const slice = (s: string) => s.slice(0, Math.min(24, s.length));
        const replyDistinctFromAsk =
          Boolean(reply?.trim()) &&
          reply !== next &&
          !(next && reply!.includes(slice(next)));
        const replyRepeatsPrevious = Boolean(
          reply && previousBot && previousBot.includes(slice(reply)),
        );
        if (!replyDistinctFromAsk || replyRepeatsPrevious || !reply?.trim())
          reply = noProgressReply(request, phone, text, previousBot);
      }
      // protectedReply still marks operational replies that must not be
      // replaced by free model text; claim-guard handles phrasing instead.
      void protectedReply;
      if (reason) await this.alert(c, ctx, reason, reply, request);
      // Every processed customer turn must produce an outbound reply.
      if (!reply?.trim())
        reply = request
          ? nextQuestion(request, phone).text || CLARIFY_REPLY
          : CLARIFY_REPLY;
      let customerOutboxId: string | null = null;
      customerOutboxId = await this.s.outbound(
        c,
        ctx.message,
        { phone, text: reply },
        `reply:${id}`,
        request?.id ?? null,
        "pending",
      );
      await c.query(
        "INSERT INTO command_results(message_id,command,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          id,
          JSON.stringify(plan ?? { fast_path: true }),
          JSON.stringify({
            reply,
            intent,
            request_number: request?.number ?? null,
            reason: reason ?? null,
          }),
        ],
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1",
        [id, reply, reason ?? null],
      );
      await c.query(
        `UPDATE conversation_turns t SET status='completed',completed_at=clock_timestamp()
           WHERE t.id=(SELECT turn_id FROM messages WHERE id=$1)
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.turn_id=t.id AND m.processed_at IS NULL
             )`,
        [id],
      );
      await c.query("UPDATE conversations SET version=version+1 WHERE id=$1", [
        ctx.conversation.id,
      ]);
      return {
        trace_id: ctx.message.trace_id,
        message_id: id,
        mode: ctx.message.mode,
        stage: "processed",
        request_number: request?.number ?? null,
        code: reason ?? "ok",
        customerOutboxId,
        canonicalReply: reply,
        requestId: request?.id ?? null,
        provenOperational: request?.status === "coordinated" || deferredNotices.length > 0,
        operation: {
          action_results: { intent, reason: reason ?? null },
          request_status: request?.status ?? null,
          request_number: request?.number ?? null,
          persisted: !reason,
          outbound_notices_queued: deferredNotices.length,
          changed_fields: changedFields,
          missing_required: request
            ? nextQuestion(request, phone).missing
            : null,
          active_search: afterCtx.active_search ?? null,
        },
        changedFields,
      };
    });
    if (committed) this.log.info(committed);
    let auditedReply: string | null =
      committed && "canonicalReply" in committed
        ? (committed.canonicalReply as string | null)
        : null;
    let auditedIntroduced = false;
    let auditedMergedInto: string | null = null;
    // Phrase the customer reply only after COMMIT. Claim-guard rejects any
    // invented save/send/approval wording.
    if (
      committed &&
      "customerOutboxId" in committed &&
      committed.customerOutboxId &&
      committed.canonicalReply
    ) {
      const newerText = await this.s.pool.query<{ id: string }>(
        `SELECT m.id FROM messages m
          WHERE m.conversation_id=(SELECT conversation_id FROM messages WHERE id=$1)
            AND m.seq>(SELECT seq FROM messages WHERE id=$1)
            AND m.processed_at IS NULL AND m.kind IN ('text','contact')
            ORDER BY m.seq LIMIT 1`,
        [id],
      );
      if (newerText.rows[0]) {
        const successorId = newerText.rows[0].id;
        auditedMergedInto = successorId;
        await this.s.transaction(async (c) => {
          await c.query(
            "UPDATE outbox SET state='cancelled',format_state='ready',error_code='reply_merged_into_next_turn' WHERE id=$1",
            [committed.customerOutboxId],
          );
          await c.query(
            "UPDATE messages SET reply=NULL,error_code=$2 WHERE id=$1",
            [id, `reply_merged_into:${successorId}`],
          );
          await this.s.event(
            c,
            await this.s.message(id, c),
            "system",
            "reply_merged_into_next_turn",
            { successor_message_id: successorId },
          );
        });
      } else {
      const ctx = await this.s.context(id);
      let text = committed.canonicalReply;
      let rejected = false;
      let replyMeta: Record<string, unknown> | null = null;
      try {
        const generated = await this.ai.reply(ctx, {
          fallback: committed.canonicalReply,
          operation: committed.operation,
        });
        replyMeta = generated.metadata;
        // Reply manager owns customer wording. Do not replace it with the
        // canonical template when the model produced text.
        const phrased = (generated.text ?? "").trim();
        const guarded = applyClaimGuard(
          committed.canonicalReply,
          phrased || committed.canonicalReply,
          Boolean(committed.provenOperational),
          committed.changedFields ?? [],
        );
        text = guarded.text;
        rejected = guarded.rejected;
      } catch (e) {
        this.log.error({
          code: errorCode(e),
          outbox_id: committed.customerOutboxId,
          stage: "customer_phrase",
        });
      }
      // Intro-once against outbox: if this phone already received any sent
      // reply since reset, never introduce again — even when the first reply
      // itself skipped the intro line.
      const priorOutbox = await this.s.pool.query<{ n: number; intro: number }>(
        `SELECT count(*)::int AS n,
                count(*) FILTER (
                  WHERE o.text LIKE '%סוכן האוטומטי%' OR o.text LIKE '%בהרצה ניסיונית%'
                )::int AS intro
           FROM outbox o
           JOIN messages current ON current.id=$2
           LEFT JOIN conversation_resets cr ON cr.conversation_id=current.conversation_id
          WHERE o.phone=$1
            AND o.id <> $3
            AND o.state IN ('sent','shadow','simulation')
            AND o.created_at <= current.received_at
            AND (cr.reset_at IS NULL OR o.created_at > cr.reset_at)`,
        [ctx.conversation.phone, id, committed.customerOutboxId],
      );
      const introduced =
        (priorOutbox.rows[0]?.n ?? 0) > 0 ||
        (priorOutbox.rows[0]?.intro ?? 0) > 0 ||
        ctx.history.some(
          (entry) => entry.role === "assistant" && isSelfIntroText(entry.content),
        );
      auditedIntroduced = introduced;
      // Intro only when intent is unclear. Clear donate/receive paths skip it.
      const clearIntent =
        customerIntentClear(ctx.message.transcript ?? ctx.message.text) ||
        ctx.requests.length > 0;
      const suppressIntro = introduced || clearIntent;
      const canonical = committed.canonicalReply;
      // Never lock the whole reply to the fixed PHOTO_FIRST line — allow natural
      // phrasing, but keep a photo ask if the canonical soft-ask included one.
      text = stripRepeatedSelfIntro(text, ctx.history, suppressIntro);
      const lang = conversationLanguage(ctx);
      const fromTemplate = localizeCustomer(canonical, lang);
      text =
        fromTemplate !== canonical
          ? fromTemplate
          : localizeCustomer(text, lang);
      text = stripRepeatedSelfIntro(text, ctx.history, suppressIntro);
      // If the model dropped a required soft photo ask, restore canonical (DB-backed).
      if (
        committed.operation?.action_results?.intent === "ask_photo" &&
        /תמונה/.test(canonical) &&
        !/תמונה/.test(text)
      )
        text = stripRepeatedSelfIntro(canonical, ctx.history, suppressIntro);
      // Do not re-attach a full-chat “רשמתי מסירה…” — ack is only for this turn’s writes.
      auditedReply = text;
      await this.s.transaction(async (c) => {
        const stillNewer = await c.query<{ id: string }>(
          `SELECT m.id FROM messages m
            WHERE m.conversation_id=(SELECT conversation_id FROM messages WHERE id=$1)
              AND m.seq>(SELECT seq FROM messages WHERE id=$1)
              AND m.processed_at IS NULL AND m.kind IN ('text','contact')
            ORDER BY m.seq LIMIT 1`,
          [id],
        );
        if (stillNewer.rows[0]) {
          auditedMergedInto = stillNewer.rows[0].id;
          await c.query(
            "UPDATE outbox SET state='cancelled',format_state='ready',error_code='reply_merged_into_next_turn' WHERE id=$1",
            [committed.customerOutboxId],
          );
          await c.query(
            "UPDATE messages SET reply=NULL,error_code=$2 WHERE id=$1",
            [id, `reply_merged_into:${stillNewer.rows[0].id}`],
          );
          return;
        }
        await c.query(
          "UPDATE outbox SET text=$2,format_state='ready' WHERE id=$1 AND format_state='pending'",
          [committed.customerOutboxId, text],
        );
        await c.query(
          "UPDATE messages SET reply=$2 WHERE id=$1",
          [id, text],
        );
        // Persist reply-manager provenance next to decode metadata so OpenAI
        // Responses can be retrieved by id and distinguished from action decode.
        if (replyMeta) {
          await c.query(
            `UPDATE messages
                SET ai_metadata = coalesce(ai_metadata, '{}'::jsonb) || jsonb_build_object('reply', $2::jsonb)
              WHERE id=$1`,
            [id, JSON.stringify(replyMeta)],
          );
          await this.s.event(
            c,
            ctx.message,
            "system",
            "reply_manager_completed",
            {
              provider: replyMeta.provider ?? null,
              prompt_id: replyMeta.prompt_id ?? null,
              prompt_version: replyMeta.prompt_version ?? null,
              response_id: replyMeta.response_id ?? null,
              rejected,
            },
            committed.requestId,
          );
        }
        if (rejected)
          await this.s.event(c, ctx.message, "system", "phrase_claim_rejected", {
            claim: text.slice(0, 500),
          }, committed.requestId);
      });
      }
    }
    // Notice wording is AI-assisted, but it is never allowed to hold the
    // business transaction open. Outbox rows wait in format_state=pending;
    // send() refuses them until this post-commit formatting step completes.
    if (deferredNotices.length) {
      const ctx = await this.s.context(id);
      for (const item of deferredNotices) {
        let text = item.notice.text;
        let state: "ready" | "failed" = "ready";
        try {
          const request = item.requestId
            ? await this.s.request(item.requestId)
            : null;
          text = (await this.ai.phraseNotice(ctx, item.notice, request)).text;
          text = text.trim() || item.notice.text;
        } catch (e) {
          state = "failed";
          this.log.error({ code: errorCode(e), outbox_id: item.outboxId, stage: "notice_format" });
        }
        await this.s.transaction(async (c) => {
          await c.query(
            "UPDATE outbox SET text=$2,format_state=$3 WHERE id=$1 AND format_state='pending'",
            [item.outboxId, text, state],
          );
          await this.s.event(c, ctx.message, "system", "managed_notice_formatted", {
            outbox_id: item.outboxId,
            format_state: state,
          }, item.requestId);
        });
      }
    }
    if (committed) {
      const stage =
        "stage" in committed ? String(committed.stage) : "processed";
      const fate: TurnFate =
        stage === "superseded"
          ? "superseded"
          : auditedMergedInto
            ? "superseded"
            : technicalReason
              ? "failed"
              : "completed";
      await this.auditTurn(id, {
        fate,
        fate_detail: {
          stage,
          code: "code" in committed ? committed.code : null,
          carried_to: auditedMergedInto,
          request_number:
            "request_number" in committed ? committed.request_number : null,
        },
        state_before: stateBefore,
        reply_text: auditedMergedInto ? null : auditedReply,
        outbox_id:
          "customerOutboxId" in committed
            ? (committed.customerOutboxId as string | null)
            : null,
        error_code:
          fate === "failed"
            ? technicalReason ?? null
            : auditedMergedInto
              ? `reply_merged_into:${auditedMergedInto}`
              : "code" in committed && committed.code !== "ok"
                ? String(committed.code)
                : null,
        opened_at: openedAt,
        intent:
          committed &&
          "operation" in committed &&
          committed.operation &&
          typeof committed.operation === "object" &&
          "action_results" in committed.operation
            ? String(
                (committed.operation as { action_results?: { intent?: string } })
                  .action_results?.intent ?? "",
              ) || null
            : null,
        introduced: auditedIntroduced,
      });
    }
  }

  async send(id: string): Promise<void> {
    const claimed = await this.s.transaction(async (c) => {
      const rows = await c.query<Outbound>(
        "SELECT * FROM outbox WHERE id=$1 FOR UPDATE",
        [id],
      );
      const out = rows.rows[0];
      if (!out) return null;
      if (isOperationsAlert(out.text) && out.phone !== this.s.config.ADMIN_PHONE) {
        await c.query(
          "UPDATE outbox SET state='cancelled',error_code='ops_alert_customer_blocked' WHERE id=$1",
          [id],
        );
        this.log.error({
          code: "ops_alert_customer_blocked",
          outbox_id: id,
          phone: out.phone,
        });
        return null;
      }
      if (isOperationsAlert(out.text)) {
        out.chat_id = `972${out.phone}@c.us`;
        await c.query("UPDATE outbox SET chat_id=$2 WHERE id=$1", [id, out.chat_id]);
      }
      if (["sent", "shadow", "simulation", "cancelled"].includes(out.state))
        return null;
      // Cancelled/sent rows must never block the send FIFO. Format pending is
      // only meaningful for live rows still waiting on notice phrasing.
      if (out.format_state === "pending")
        throw new RetryableError("notice_format_pending");
      // Never freeze behind uncertain/failed older rows — abandon them and
      // continue with the current reply.
      await c.query(
        `UPDATE outbox
            SET state='cancelled', format_state='ready', error_code='stale_send_released'
          WHERE phone=$1 AND seq<$2 AND state IN ('uncertain','failed')`,
        [out.phone, out.seq],
      );
      const older = await c.query(
        "SELECT 1 FROM outbox WHERE phone=$1 AND seq<$2 AND state IN ($3,$4) LIMIT 1",
        [out.phone, out.seq, "pending", "sending"],
      );
      if (older.rowCount) throw new RetryableError("earlier_send_pending");
      if (out.state === "sending" || out.state === "uncertain") {
        // Do not park the phone on delivery_uncertain — cancel and move on.
        await c.query(
          `UPDATE outbox
              SET state='cancelled', format_state='ready', error_code='delivery_uncertain_released'
            WHERE id=$1`,
          [id],
        );
        const next = await c.query<{ id: string }>(
          `SELECT id FROM outbox
            WHERE phone=$1 AND state='pending' AND format_state='ready'
            ORDER BY seq LIMIT 1`,
          [out.phone],
        );
        if (next.rows[0]) {
          const job = await this.s.queue.send(
            c,
            "send",
            { id: next.rows[0].id },
            out.phone,
          );
          await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
            next.rows[0].id,
            job,
          ]);
        }
        return null;
      }
      if (out.mode !== "live") {
        await c.query(
          "UPDATE outbox SET state=$2,sent_at=clock_timestamp() WHERE id=$1",
          [id, out.mode],
        );
        if (out.match_id)
          await c.query(
            "UPDATE matches SET state='presented',presented_at=clock_timestamp() WHERE id=$1 AND state='queued_photo'",
            [out.match_id],
          );
        return null;
      }
      if (this.s.config.BOT_MODE !== "live")
        throw new AppError("mode_mismatch", 409);
      const allow = this.s.config.LIVE_ALLOWLIST.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length && !allow.includes(out.phone))
        throw new RetryableError("recipient_not_in_live_allowlist");
      await c.query(
        "UPDATE outbox SET state='sending',error_code=NULL WHERE id=$1",
        [id],
      );
      return out;
    });
    if (!claimed) return;
    let providerId: string;
    try {
      let media: { bytes: Buffer; mime: string; filename: string } | undefined;
      if (claimed.media_id) {
        const r = await this.s.pool.query<{
          storage_key: string;
          mime_type: string;
        }>("SELECT storage_key,mime_type FROM media WHERE id=$1", [
          claimed.media_id,
        ]);
        if (!r.rows[0]) throw new AppError("media_missing");
        media = {
          bytes: await this.storage.get(r.rows[0].storage_key),
          mime: r.rows[0].mime_type,
          filename: r.rows[0].storage_key,
        };
      }
      providerId = await this.channel.send({
        phone: claimed.phone,
        chat_id: claimed.chat_id,
        text: claimed.text,
        media,
      });
    } catch (e) {
      const certainty =
        e instanceof DeliveryError
          ? e.certainty
          : e instanceof AppError
            ? "rejected"
            : "unknown";
      const code = e instanceof DeliveryError ? e.code : errorCode(e);
      await this.s.pool.query(
        "UPDATE outbox SET state=$2,delivery_state=$3,error_code=$4 WHERE id=$1",
        [
          id,
          certainty === "unknown" ? "uncertain" : "pending",
          certainty === "unknown" ? "uncertain" : "failed",
          code,
        ],
      );
      this.log.error({
        code,
        trace_id: claimed.trace_id,
        outbox_id: id,
        stage: "send",
        certainty,
      });
      throw new RetryableError(code);
    }
    await this.s.transaction(async (c) => {
      await c.query(
        "UPDATE outbox SET state='sent',delivery_state='accepted',provider_id=$2,sent_at=clock_timestamp(),provider_accepted_at=clock_timestamp(),error_code=NULL WHERE id=$1",
        [id, providerId],
      );
      if (claimed.match_id)
        await c.query(
          "UPDATE matches SET state='presented',presented_at=clock_timestamp() WHERE id=$1 AND state='queued_photo'",
          [claimed.match_id],
        );
      const next = await c.query<{ id: string }>(
        "SELECT id FROM outbox WHERE phone=$1 AND state='pending' ORDER BY seq LIMIT 1",
        [claimed.phone],
      );
      if (next.rows[0]) {
        const job = await this.s.queue.send(
          c,
          "send",
          { id: next.rows[0].id },
          claimed.phone,
        );
        await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
          next.rows[0].id,
          job,
        ]);
      }
      this.log.info({
        stage: "sent",
        trace_id: claimed.trace_id,
        outbox_id: id,
      });
    });
  }
}
