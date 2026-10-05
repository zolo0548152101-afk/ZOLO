import type pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store, type Outbound } from "../infrastructure/store.js";
import { Commands, type Outcome } from "./commands.js";
import { selectDecodePlan, type Planner } from "../infrastructure/ai.js";
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
  HUMAN_REPLY,
  OUTSIDE,
  namedOutsideSettlement,
  customerCancelIntent,
  grounded,
  mutable,
  nextQuestion,
  nextTuesday,
  readyToProposeSchedule,
} from "../domain/policies.js";
import {
  applyClaimGuard,
  CLARIFY_REPLY,
  FAULT_REPLY,
  probeReply,
} from "../domain/ai-guards.js";

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
    // Merge only a burst of plain text. Media remains separate so its durable
    // capture and attachment semantics are never lost.
    if (
      pending.rows.length > 1 &&
      pending.rows.every((m) => m.kind === "text" && m.media_state === "none")
    ) {
      const last = pending.rows.at(-1)!;
      const parts = pending.rows.map((m) => m.text.trim()).filter(Boolean);
      const shortBurst = parts.length > 1 && parts.every((part) => part.length <= 48);
      const mergedText = parts.join(shortBurst ? " " : "\n");
      const mergedContacts = pending.rows.flatMap((m) => m.contacts);
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
          await c.query("UPDATE messages SET text=$2,contacts=$3 WHERE id=$1", [
            last.id,
            mergedText,
            JSON.stringify(mergedContacts),
          ]);
          await c.query(
            "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id = ANY($1::uuid[])",
            [pending.rows.slice(0, -1).map((m) => m.id), `coalesced_into:${last.id}`],
          );
          next = last.id;
        }
      });
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
    const outsideTown = this.outsideTown(ctx, text);
    if (outsideTown) {
      await this.finishOutside(id, outsideTown);
      return;
    }
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
    let supersessionCheck = false;
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
        // Free-form Hebrew is decoded by the AI. Hard limits stay in
        // commands.apply / policies after the model returns commands.
        const response = await this.ai.plan(ctx);
        supersessionCheck = true;
        const parsed = planSchema.parse(response.plan);
        const selected = selectDecodePlan(
          { understood: response.understood, plan: parsed },
          rulePlan(ctx),
          ctx,
        );
        plan = selected.plan;
        if (selected.understood && selected.useAi && !grounded(plan, text))
          throw new AppError("ungrounded_tool");
        await this.s.pool.query(
          `UPDATE messages SET ai_plan=$2,plan_versions=$3,ai_metadata=$4 WHERE id=$1 AND ai_plan IS NULL AND processed_at IS NULL`,
          [
            id,
            JSON.stringify(plan),
            JSON.stringify(this.versions(ctx)),
            JSON.stringify(response.metadata),
          ],
        );
        if (!selected.understood) {
          await this.finishUnclear(id);
          return;
        }
      } catch (e) {
        if (!lastAiAttempt && !(e instanceof AppError))
          throw new RetryableError("openai_retry");
        await this.finishFault(id, e);
        return;
      }
    }
    try {
      await this.finish(id, plan, undefined, supersessionCheck);
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
    const d = r?.parties.find((p) => p.role === "donor"),
      v = r?.parties.find((p) => p.role === "receiver");
    await this.s.outbound(
      c,
      ctx.message,
      {
        phone: this.s.config.ADMIN_PHONE,
        text: `נדרש טיפול אנושי\nמספר פנייה: ${r?.number ?? "טרם נפתחה"}\nטלפון: ${ctx.conversation.phone}\nפריט: ${r?.items.map((i) => i.description).join(", ") ?? "לא ידוע"}\nמסלול: ${d?.settlement ?? "לא ידוע"} → ${v?.settlement ?? "לא ידוע"}\nסיבה: ${reason}\nהודעת הלקוח האחרונה: ${(ctx.message.transcript ?? ctx.message.text).slice(0, 1500)}\nתשובת הבוט: ${reply ?? "לא נשלחה תגובה אוטומטית"}\nנא לחזור ללקוח.`,
      },
      `human:${ctx.message.id}`,
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
        reply === CLARIFY_REPLY ||
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
      // The first AI/API failure goes to a human. It does not count as unclear.
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
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: FAULT_REPLY },
        `reply:${id}`,
        open?.id ?? null,
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1 AND processed_at IS NULL",
        [id, FAULT_REPLY, "openai_failure_escalated"],
      );
      await c.query(
        "UPDATE conversations SET mode='human',version=version+1 WHERE id=$1",
        [ctx.conversation.id],
      );
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
        await this.s.outbound(
          c,
          ctx.message,
          { phone, text: HUMAN_REPLY },
          `reply:${id}`,
          open?.id ?? null,
        );
        await this.s.event(c, ctx.message, phone, "unclear_escalated", {
          unclear_count: next,
        });
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1 AND processed_at IS NULL",
          [id, HUMAN_REPLY, "unclear_escalated"],
        );
        await c.query(
          "UPDATE conversations SET mode='human',version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        return;
      }
      const reply = probeReply(ctx.message.text);
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: reply },
        `reply:${id}`,
        null,
      );
      await this.s.event(c, ctx.message, phone, "unclear_clarify", {
        unclear_count: next,
        probe: reply !== CLARIFY_REPLY,
      });
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2 WHERE id=$1 AND processed_at IS NULL",
        [id, reply],
      );
    });
  }

  /** Named out-of-area town in the customer's own words, before any plan runs. */
  private outsideTown(ctx: Context, text: string): string | null {
    if (!text.trim() || customerCancelIntent(text)) return null;
    const town = namedOutsideSettlement(text);
    if (!town) return null;
    if (/(?:תיקון|טעיתי)/u.test(text)) {
      const own = ctx.requests
        .flatMap((request) => request.parties)
        .find((party) => party.phone === ctx.conversation.phone && party.settlement);
      if (own?.settlement && !namedOutsideSettlement(own.settlement)) return null;
    }
    return town;
  }

  private async finishOutside(id: string, settlement: string): Promise<void> {
    await this.s.transaction(async (c) => {
      const ctx = await this.s.context(id, c, true);
      if (ctx.message.processed_at) return;
      const phone = ctx.conversation.phone;
      const terminal = ["coordinated", "closed", "cancelled", "rejected", "cancel_pending"];
      const open =
        ctx.requests.find(
          (request) =>
            request.id === ctx.conversation.selected_request_id &&
            !terminal.includes(request.status),
        ) ??
        ctx.requests.find((request) => !terminal.includes(request.status)) ??
        null;
      let request: Request | null = null;
      if (open) {
        request = await this.s.request(open.id, c, true);
        if (!terminal.includes(request.status)) {
          request.status = "rejected";
          request.human_reason = null;
          await this.s.save(c, request);
        }
      }
      await this.s.event(
        c,
        ctx.message,
        phone,
        "outside_area_rejected",
        { settlement },
        request?.id ?? null,
      );
      await this.s.outbound(
        c,
        ctx.message,
        { phone, text: OUTSIDE },
        `reply:${id}`,
        request?.id ?? null,
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1 AND processed_at IS NULL",
        [id, OUTSIDE, "outside_area_rejected"],
      );
    });
  }

  private async finish(
    id: string,
    proposed: Plan | null,
    technicalReason?: string,
    supersessionCheck = false,
  ): Promise<void> {
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
      const newer = supersessionCheck
        ? await c.query<{ id: string }>(
            `SELECT m.id FROM messages m
              WHERE m.conversation_id=$1 AND m.seq>$2 AND m.processed_at IS NULL
              ORDER BY m.seq LIMIT 1`,
            [ctx.conversation.id, ctx.message.seq],
          )
        : { rows: [] as { id: string }[] };
      if (newer.rows[0]) {
        const successor = newer.rows[0].id;
        await c.query(
          "UPDATE messages SET processed_at=clock_timestamp(),error_code=$2 WHERE id=$1 AND processed_at IS NULL",
          [id, `superseded_by:${successor}`],
        );
        await c.query(
          `UPDATE conversation_turns SET status='superseded',completed_at=clock_timestamp()
             WHERE id=(SELECT turn_id FROM messages WHERE id=$1)`,
          [id],
        );
        await this.s.event(c, ctx.message, "system", "turn_superseded", {
          successor_message_id: successor,
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
      let reply: string | null = null,
        request: Request | null = null,
        reason: string | undefined = technicalReason,
        protectedReply = false,
        intent = "other";
      const plan = ctx.message.ai_plan
        ? planSchema.parse(ctx.message.ai_plan)
        : proposed;
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
        intent = "human_escalation";
        await this.alert(c, ctx, "human_followup", null, null);
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
              candidate.type === "counterparty"
            );
            // AI may return receiver details before the command that creates
            // that receiver. Preserve the plan otherwise, but satisfy this
            // explicit dependency for an already-open request so the whole
            // transaction is not rolled back as forbidden_party.
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
            const executableCommands = orderedCommands.filter((command) => {
              if (command.type !== "details" || !command.role) return true;
              const createsCounterparty = orderedCommands.some(
                (candidate) =>
                  candidate.type === "counterparty" &&
                  candidate.request_number === command.request_number,
              );
              if (!createsCounterparty) return true;
              const targetRequest = ctx.requests.find(
                (candidate) => candidate.number === command.request_number,
              );
              const actorRole = targetRequest?.parties.find(
                (candidate) => candidate.phone === phone,
              )?.role;
              // A donor may identify/link a receiver, but cannot assert that
              // receiver's profile fields. Keep the valid counterparty
              // transition and let the receiver provide their own details.
              return !actorRole || actorRole === command.role;
            });
            let index = 0;
            const hasSameMessageDonorDetails = executableCommands.some(
              (candidate) =>
                candidate.type === "details" && candidate.role === "donor",
            );
            for (const command of executableCommands) {
              // Once an open donation is created, PHOTO-FIRST blocks every
              // later command in the same AI batch until an image arrives,
              // except donor details extracted from that same opening message.
              if (
                request &&
                photoGate(request) &&
                !handoffTransitionPlanned &&
                command.type !== "details" &&
                command.type !== "clarify_duplicate"
              ) {
                reply = PHOTO_FIRST;
                break;
              }
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
              intent = command.type === "counterparty"
                ? "ask_verification"
                : command.type === "details"
                  ? "ask_details"
                  : command.type === "donate" && result.request?.origin !== "direct"
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
              // Open donations are PHOTO-FIRST. Do not let a multi-command
              // prompt collect names/addresses before the required photo.
              if (
                command.type === "donate" &&
                result.request &&
                photoGate(result.request) &&
                !handoffTransitionPlanned &&
                !hasSameMessageDonorDetails
              ) {
                reply = PHOTO_FIRST;
                break;
              }
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
            // Donor facts extracted from the opening message are retained, but
            // the first operational gate remains the photo request. A later
            // details command must not replace PHOTO-FIRST with a condition
            // or another detail question.
            const explicitClarification = /כבר קיימת פנייה/.test(reply ?? "");
            if (
              request &&
              !reason &&
              !explicitClarification &&
              request.origin === "donation" &&
              photoGate(request) &&
              !handoffTransitionPlanned &&
              !["cancelled", "rejected", "human", "closed", "coordinated"].includes(
                request.status,
              )
            ) {
              reply = PHOTO_FIRST;
              intent = "ask_photo";
            }
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
      // protectedReply still marks operational replies that must not be
      // replaced by free model text; claim-guard handles phrasing instead.
      void protectedReply;
      if (reason) await this.alert(c, ctx, reason, reply, request);
      let customerOutboxId: string | null = null;
      if (reply)
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
        provenOperational:
          request?.status === "coordinated" ||
          deferredNotices.length > 0,
      };
    });
    if (committed) this.log.info(committed);
    // Phrase the customer reply only after COMMIT. Claim-guard rejects any
    // invented save/send/approval wording.
    if (
      committed &&
      "customerOutboxId" in committed &&
      committed.customerOutboxId &&
      committed.canonicalReply
    ) {
      const ctx = await this.s.context(id);
      let text = committed.canonicalReply;
      let rejected = false;
      try {
        const phrased = await this.ai.phraseReply(committed.canonicalReply, ctx);
        const guarded = applyClaimGuard(
          committed.canonicalReply,
          phrased.text,
          Boolean(committed.provenOperational),
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
      await this.s.transaction(async (c) => {
        await c.query(
          "UPDATE outbox SET text=$2,format_state='ready' WHERE id=$1 AND format_state='pending'",
          [committed.customerOutboxId, text],
        );
        await c.query(
          "UPDATE messages SET reply=$2 WHERE id=$1",
          [id, text],
        );
        if (rejected)
          await this.s.event(c, ctx.message, "system", "phrase_claim_rejected", {
            claim: text.slice(0, 500),
          }, committed.requestId);
      });
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
          const guarded = applyClaimGuard(item.notice.text, text, true);
          text = guarded.text;
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
  }

  async send(id: string): Promise<void> {
    const claimed = await this.s.transaction(async (c) => {
      const rows = await c.query<Outbound>(
        "SELECT * FROM outbox WHERE id=$1 FOR UPDATE",
        [id],
      );
      const out = rows.rows[0];
      if (!out) return null;
      if (out.format_state === "pending")
        throw new RetryableError("notice_format_pending");
      if (["sent", "shadow", "simulation", "cancelled"].includes(out.state))
        return null;
      const older = await c.query(
        "SELECT 1 FROM outbox WHERE phone=$1 AND seq<$2 AND state IN ($3,$4,$5,$6) LIMIT 1",
        [out.phone, out.seq, "pending", "sending", "uncertain", "failed"],
      );
      if (older.rowCount) throw new RetryableError("earlier_send_pending");
      if (out.state === "sending" || out.state === "uncertain") {
        await c.query(
          "UPDATE outbox SET state='uncertain',error_code='reconcile_required' WHERE id=$1",
          [id],
        );
        return { ...out, state: "uncertain" };
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
    if (claimed.state === "uncertain")
      throw new RetryableError("delivery_uncertain");
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
