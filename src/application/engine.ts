import type pg from "pg";
import { randomUUID } from "node:crypto";
import { Store, type Outbound } from "../infrastructure/store.js";
import { Commands, type Outcome } from "./commands.js";
import type { Planner } from "../infrastructure/ai.js";
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
} from "../domain/types.js";
import {
  isStatus,
  quickReply,
  statusText,
  PHOTO_THANKS,
  HUMAN_REPLY,
  OUTSIDE,
  grounded,
  mutable,
  nextQuestion,
} from "../domain/policies.js";
import { rulePlan } from "./rule-planner.js";

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
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversations(contact_id,session,chat_id) VALUES($1,$2,$3) ON CONFLICT(channel,session,contact_id) DO UPDATE SET chat_id=EXCLUDED.chat_id RETURNING id`,
        [contact, this.s.config.WAHA_SESSION, m.chat_id],
      );
      await c.query(
        "UPDATE messages SET contact_id=$2,conversation_id=$3 WHERE id=$1",
        [m.id, contact, conv.rows[0]!.id],
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
    const next = await this.s.pool.query<{ id: string }>(
      "SELECT m.id FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE c.phone=$1 AND m.processed_at IS NULL ORDER BY m.seq LIMIT 1",
      [trigger.phone],
    );
    if (next.rows[0]) await this.process(next.rows[0].id, lastAiAttempt);
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
    if (!plan) {
      try {
        const deterministic = rulePlan(ctx);
        // The managed prompt owns the user-facing wording for every text
        // message.  Deterministic rules may still choose a safe state change,
        // but never replace the prompt's reply with a hard-coded sentence.
        const prompted = await this.ai.plan(ctx);
        const response = deterministic
          ? {
              plan: deterministic,
              metadata: {
                ...prompted.metadata,
                action_source: "deterministic_flow",
              },
            }
          : prompted;
        plan = planSchema.parse(response.plan);
        if (!grounded(plan, text)) throw new AppError("ungrounded_tool");
        await this.s.pool.query(
          `UPDATE messages SET ai_plan=$2,plan_versions=$3,ai_metadata=$4 WHERE id=$1 AND ai_plan IS NULL AND processed_at IS NULL`,
          [
            id,
            JSON.stringify(plan),
            JSON.stringify(this.versions(ctx)),
            JSON.stringify(response.metadata),
          ],
        );
      } catch (e) {
        if (!lastAiAttempt && !(e instanceof AppError))
          throw new RetryableError("openai_retry");
        await this.finish(id, null, "openai_failure");
        return;
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

  private async finish(
    id: string,
    proposed: Plan | null,
    technicalReason?: string,
  ): Promise<void> {
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
      let reply: string | null = null,
        request: Request | null = null,
        reason: string | undefined = technicalReason;
      const plan = ctx.message.ai_plan
        ? planSchema.parse(ctx.message.ai_plan)
        : proposed;
      if (isStatus(text)) reply = statusText(ctx.requests);
      else if (ctx.conversation.mode === "human") {
        await this.alert(c, ctx, "human_followup", null, null);
      } else if (technicalReason || ctx.message.media_state === "failed") {
        const selected =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
        if (technicalReason === "openai_failure" || technicalReason === "voice_failure") {
          reply = selected
            ? `לא הצלחתי להבין את ההודעה. ${nextQuestion(selected, phone).text}`
            : "לא הצלחתי להבין. אפשר לכתוב, למשל: אני רוצה למסור מיטה.";
          reason = undefined;
          await this.s.event(c, ctx.message, "system", "automatic_fallback", {
            technical_reason: technicalReason,
          }, selected?.id ?? null);
        } else {
          reply =
            "לא הצלחנו להשלים את הטיפול בהודעה. העברתי לבדיקה אנושית. נעדכן.";
          reason ??= "media_failure";
        }
      } else if (quickReply(text) !== null) {
        const quick = quickReply(text)!;
        const selected =
          ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
        reply = selected && quick.startsWith("שלום וברוכים")
          ? nextQuestion(selected, phone).text
          : quick;
      }
      else if (ctx.message.kind === "image") {
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
            let index = 0;
            for (const command of plan.commands) {
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
              await this.s.event(
                c,
                ctx.message,
                phone,
                `command.${command.type}`,
                { command },
                result.request?.id ?? null,
              );
              for (const [n, notice] of result.notices.entries())
                await this.s.outbound(
                  c,
                  ctx.message,
                  notice,
                  `notice:${id}:${index}:${n}`,
                  result.request?.id ?? null,
                );
              index++;
              if (reason || request?.status === "rejected") break;
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
                await this.s.save(c, request);
                reply = "אין כרגע מקום פנוי בהובלה הקרובה. נעדכן.";
              }
              if (coordinated === "coordinated") {
                await this.s.save(c, request);
                reply = statusText([request]);
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
                    await this.s.outbound(
                      c,
                      ctx.message,
                      { phone: p.phone, text: reply },
                      `coordination:${request.id}:${request.run_date}:${p.phone}`,
                      request.id,
                    );
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
      }
      const managedReply =
        typeof ctx.message.ai_metadata?.managed_reply === "string"
          ? ctx.message.ai_metadata.managed_reply.trim()
          : "";
      // The prompt may never override an operational failure, a human handoff,
      // or a missing reply. Those require fixed, auditable wording. For normal
      // conversation, its reply is the exact text delivered to WhatsApp.
      if (!reason && reply && managedReply) reply = managedReply;
      if (reason) await this.alert(c, ctx, reason, reply, request);
      if (reply)
        await this.s.outbound(
          c,
          ctx.message,
          { phone, text: reply },
          `reply:${id}`,
          request?.id ?? null,
        );
      await c.query(
        "INSERT INTO command_results(message_id,command,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          id,
          JSON.stringify(plan ?? { fast_path: true }),
          JSON.stringify({
            reply,
            request_number: request?.number ?? null,
            reason: reason ?? null,
          }),
        ],
      );
      await c.query(
        "UPDATE messages SET processed_at=clock_timestamp(),reply=$2,error_code=$3 WHERE id=$1",
        [id, reply, reason ?? null],
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
      };
    });
    if (committed) this.log.info(committed);
  }

  async send(id: string): Promise<void> {
    const claimed = await this.s.transaction(async (c) => {
      const rows = await c.query<Outbound>(
        "SELECT * FROM outbox WHERE id=$1 FOR UPDATE",
        [id],
      );
      const out = rows.rows[0];
      if (!out) return null;
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
        "UPDATE outbox SET state=$2,error_code=$3 WHERE id=$1",
        [id, certainty === "unknown" ? "uncertain" : "pending", code],
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
        "UPDATE outbox SET state='sent',provider_id=$2,sent_at=clock_timestamp(),error_code=NULL WHERE id=$1",
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
