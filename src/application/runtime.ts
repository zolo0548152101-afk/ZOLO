import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ConstructorOptions } from "pg-boss";
import type { Config } from "../config.js";
import { makePool } from "../db/pool.js";
import { Queue, type JobData } from "../infrastructure/queue.js";
import { Store } from "../infrastructure/store.js";
import {
  LocalMediaStorage,
  type MediaStorage,
} from "../infrastructure/media.js";
import { OpenAIPlanner, type Planner } from "../infrastructure/ai.js";
import { WahaChannel, type Channel } from "../infrastructure/waha.js";
import { Engine } from "./engine.js";
import {
  AppError,
  errorCode,
  RetryableError,
  type Log,
  type Request,
} from "../domain/types.js";
import { localDate, nextQuestion, statusText } from "../domain/policies.js";
import {
  integrationAdapters,
  IntegrationDeliveryError,
  type IntegrationAdapter,
  type IntegrationEvent,
} from "./integration-port.js";
const INTEGRATION_MAX_ATTEMPTS = 3;
const INTEGRATION_RETRY_DELAY_SECONDS = 2;
const INTEGRATION_ACTIVE_TIMEOUT_SECONDS = 60;
export interface RuntimeOverrides {
  pool?: pg.Pool;
  planner?: Planner;
  channel?: Channel;
  storage?: MediaStorage;
  queueOptions?: Partial<ConstructorOptions>;
  now?: () => Date;
  integrationAdapters?: ReadonlyMap<string, IntegrationAdapter>;
}
export class Runtime {
  readonly pool: pg.Pool;
  store: Store | null = null;
  engine: Engine | null = null;
  queue: Queue | null = null;
  readonly workerId = randomUUID();
  ready = false;
  private initializing = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private planner: Planner | null = null;
  private readonly adapters: ReadonlyMap<string, IntegrationAdapter>;
  constructor(
    readonly config: Config,
    readonly log: Log,
    private readonly overrides: RuntimeOverrides = {},
  ) {
    this.pool = overrides.pool ?? makePool(config, log);
    this.adapters = overrides.integrationAdapters ?? integrationAdapters;
  }
  async start(workers = true): Promise<void> {
    if (this.initializing || this.ready) return;
    this.initializing = true;
    try {
      const version = await this.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pgmigrations",
      );
      if ((version.rows[0]?.n ?? 0) < 5)
        throw new AppError("migrations_required", 503);
      const queue = new Queue(
        this.config,
        this.log,
        false,
        this.overrides.queueOptions,
      );
      this.queue = queue;
      await queue.start();
      const storage =
        this.overrides.storage ?? new LocalMediaStorage(this.config);
      await storage.init();
      this.planner = this.overrides.planner ?? new OpenAIPlanner(this.config);
      const store = new Store(this.pool, queue, this.config);
      this.store = store;
      const engine = new Engine(
        store,
        this.planner,
        this.overrides.channel ?? new WahaChannel(this.config),
        storage,
        this.log,
        this.overrides.now,
      );
      this.engine = engine;
      if (workers) {
        const settings = {
          batchSize: 1,
          includeMetadata: true as const,
          pollingIntervalSeconds: 0.5,
          notifyPollingIntervalSeconds: 0.5,
          localConcurrency: this.config.WORKER_CONCURRENCY,
        };
        await queue.boss.work<JobData, void, typeof settings>(
          "ingest",
          { ...settings, localConcurrency: 1 },
          async (jobs) => {
            for (const j of jobs) {
              try {
                await engine.ingestNext(j.retryCount >= j.retryLimit);
              } catch (error) {
                if (j.retryCount < j.retryLimit) throw error;
                await engine.abandonIngest(j.data.id, error);
              }
            }
          },
        );
        await queue.boss.work<JobData, void, typeof settings>(
          "capture",
          settings,
          async (jobs) => {
            for (const j of jobs)
              await engine.capture(j.data.id, j.retryCount >= j.retryLimit);
          },
        );
        await queue.boss.work<JobData, void, typeof settings>(
          "conversation",
          settings,
          async (jobs) => {
            for (const j of jobs) {
              try {
                await engine.processNext(j.data.id, j.retryCount >= 1);
              } catch (error) {
                const code = error instanceof AppError ? error.code : "";
                const gone = [
                  "message_not_found",
                  "conversation_missing",
                  "request_not_found",
                ].includes(code);
                if (!gone && j.retryCount < j.retryLimit) throw error;
                await engine.releaseFailedTurn(j.data.id, error);
              }
            }
          },
        );
        await queue.boss.work<JobData, void, typeof settings>(
          "send",
          settings,
          async (jobs) => {
            for (const j of jobs) {
              try {
                await engine.send(j.data.id);
              } catch (error) {
                // Never leave a failed send job freezing this phone's FIFO.
                if (j.retryCount < j.retryLimit) throw error;
                await engine.releaseFailedSend(j.data.id, error);
              }
            }
          },
        );
        if (this.config.INTEGRATION_DISPATCH) {
          await queue.boss.work<JobData, void, typeof settings>(
            "integration",
            { ...settings, localConcurrency: 1 },
            async (jobs) => {
              for (const j of jobs) await this.deliverIntegration(j.data.id);
            },
          );
        }
        await queue.boss.work<JobData, void, typeof settings>(
          "ops",
          { ...settings, localConcurrency: 1 },
          async (jobs) => {
            for (const j of jobs) await this.operations(j.data.id);
          },
        );
        await queue.boss.schedule(
          "ops",
          "5 22 * * 2",
          { id: "tuesday_summary" },
          { tz: "Asia/Jerusalem", key: "tuesday-summary" },
        );
        await queue.boss.schedule(
          "ops",
          "* * * * *",
          { id: "monitor" },
          { tz: "Asia/Jerusalem", key: "monitor" },
        );
        // A deployment or a worker restart must never strand an accepted
        // WhatsApp message or an outbound reply in the database. Rebuild the
        // lightweight queue jobs from durable state before declaring ready.
        await this.reconcileCompletedTurns();
        const recoverIdentity = await this.pool.query<{ id: string }>(
          `SELECT id FROM messages
            WHERE contact_id IS NULL AND processed_at IS NULL
            ORDER BY seq LIMIT 500`,
        );
        for (const row of recoverIdentity.rows) {
          await store.transaction(async (c) => {
            await queue.send(c, "ingest", { id: row.id }, this.config.WAHA_SESSION);
          });
        }
        const recover = await this.pool.query<{
          id: string;
          phone: string;
        }>(
          `SELECT m.id,co.phone
             FROM messages m
             JOIN contacts co ON co.id=m.contact_id
            WHERE m.processed_at IS NULL
            ORDER BY m.seq
            LIMIT 500`,
        );
        for (const row of recover.rows) {
          await store.transaction(async (c) => {
            await queue.send(c, "conversation", { id: row.id }, row.phone);
          });
        }
        const recoverOutbound = await this.pool.query<{
          id: string;
          phone: string;
        }>(
          `SELECT DISTINCT ON (phone) id,phone
             FROM outbox
            WHERE state='pending'
            ORDER BY phone,seq
            LIMIT 500`,
        );
        for (const row of recoverOutbound.rows) {
          await store.transaction(async (c) => {
            const jobId = await queue.send(c, "send", { id: row.id }, row.phone);
            await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
              row.id,
              jobId,
            ]);
          });
        }
        if (this.config.INTEGRATION_DISPATCH) await this.recoverIntegrationQueue();
        await this.beat();
        this.heartbeat = setInterval(
          () =>
            void this.beat().catch(() =>
              this.log.error({ code: "worker_heartbeat_failed" }),
            ),
          10000,
        );
        this.heartbeat.unref();
      }
      this.ready = true;
    } catch (e) {
      if (this.queue) {
        await this.queue.stop().catch(() => {});
        this.queue = null;
      }
      throw e;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * A process can stop after the message commit but before the turn terminal
   * state is written. Once every durable message in a turn is already
   * processed, replaying it is both unnecessary and unsafe; close the turn
   * before startup recovery inspects pending messages.
   */
  async reconcileCompletedTurns(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE conversation_turns t
          SET status='completed', completed_at=COALESCE(completed_at, clock_timestamp())
        WHERE t.status IN ('pending','processing')
          AND EXISTS (SELECT 1 FROM turn_messages tm WHERE tm.turn_id=t.id)
          AND NOT EXISTS (
            SELECT 1
              FROM turn_messages tm
              JOIN messages m ON m.id=tm.message_id
             WHERE tm.turn_id=t.id AND m.processed_at IS NULL
          )`,
    );
    return result.rowCount ?? 0;
  }

  async deliverIntegration(id: string): Promise<void> {
    const row = await this.pool.query<{
      integration: string;
      state: "pending" | "active" | "delivered" | "dead_letter";
      attempts: number;
      event_id: string;
      idempotency_key: string;
      schema_version: number;
      occurred_at: string;
      last_error: string | null;
      event_type: string;
      request_id: string | null;
      data: unknown;
    }>(
      `SELECT io.integration,io.state,io.attempts,io.idempotency_key,
              io.event_id::text,ev.data->>'schema_version' AS schema_version,
              ev.created_at::text AS occurred_at,io.last_error,
              ev.event_type,ev.request_id,ev.data
         FROM integration_outbox io JOIN request_events ev ON ev.id=io.event_id
        WHERE io.id=$1`,
      [id],
    );
    const item = row.rows[0];
    if (!item || item.state !== "pending") return;
    const claim = await this.pool.query<{ attempts: number }>(
      `UPDATE integration_outbox io
          SET state='active',attempts=io.attempts+1,last_attempt_at=clock_timestamp()
        WHERE io.id=$1 AND io.state='pending'
          AND (io.next_attempt_at IS NULL OR io.next_attempt_at<=clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM integration_outbox prior
             WHERE prior.integration=io.integration
               AND prior.event_id<io.event_id
               AND prior.state<>'delivered'
          )
        RETURNING attempts`,
      [id],
    );
    if (!claim.rowCount) return;
    const attempts = claim.rows[0]!.attempts;
    const adapter = this.adapters.get(item.integration);
    if (!adapter) {
      await this.pool.query(
        "UPDATE integration_outbox SET state='dead_letter',last_error='adapter_not_registered',error_class='terminal',terminal_at=clock_timestamp() WHERE id=$1 AND state='active'",
        [id],
      );
      this.log.error({ code: "integration_adapter_missing", integration: item.integration, outbox_id: id });
      return;
    }
    const event = item.data as Record<string, unknown>;
    if (Number(event.schema_version) !== 1) {
      await this.pool.query(
        "UPDATE integration_outbox SET state='dead_letter',last_error='unsupported_schema_version',error_class='terminal',terminal_at=clock_timestamp() WHERE id=$1 AND state='active'",
        [id],
      );
      this.log.error({ code: "integration_schema_version_unsupported", integration: item.integration, outbox_id: id });
      return;
    }
    try {
      await adapter.deliver(
        {
          id: item.event_id,
          type: item.event_type,
              schemaVersion: Number(event.schema_version ?? item.schema_version),
              deliveryKey: (event.delivery_keys as Record<string, string> | undefined)?.[item.integration] ?? item.idempotency_key,
          requestId: item.request_id,
          occurredAt: item.occurred_at,
          data: event.payload ?? item.data,
        } satisfies IntegrationEvent,
        { idempotencyKey: item.idempotency_key, signal: AbortSignal.timeout(30000) },
      );
      await this.pool.query(
        "UPDATE integration_outbox SET state='delivered',delivered_at=clock_timestamp(),last_error=NULL,terminal_at=NULL WHERE id=$1 AND state='active'",
        [id],
      );
    } catch (e) {
      const retryable = typeof e === "object" && e !== null && "retryable" in e && e.retryable === true;
      const ambiguous = typeof e === "object" && e !== null && "ambiguous" in e && e.ambiguous === true;
      const code = (e instanceof IntegrationDeliveryError ? e.message : errorCode(e)).slice(0, 160);
      if (ambiguous || !retryable || attempts >= INTEGRATION_MAX_ATTEMPTS) {
        await this.pool.query(
          "UPDATE integration_outbox SET state='dead_letter',last_error=$2,error_class=$3,terminal_at=clock_timestamp() WHERE id=$1 AND state='active'",
          [id, code, ambiguous ? "ambiguous" : retryable ? "retry_exhausted" : "terminal"],
        );
        if (ambiguous) this.log.error({ code: "integration_ambiguous_delivery", integration: item.integration, outbox_id: id });
        return;
      }
      await this.pool.query(
        "UPDATE integration_outbox SET state='pending',next_attempt_at=clock_timestamp()+($2 * interval '1 second'),last_error=$3,error_class='retryable' WHERE id=$1 AND state='active'",
        [id, INTEGRATION_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), code],
      );
      throw new RetryableError(code);
    }
  }
  async recoverIntegrationQueue(): Promise<void> {
    if (!this.queue) return;
    await this.pool.query(
      `UPDATE integration_outbox
          SET state='pending'
        WHERE state='active'
          AND (last_attempt_at IS NULL OR last_attempt_at < clock_timestamp()-interval '${INTEGRATION_ACTIVE_TIMEOUT_SECONDS} seconds')`,
    );
    const rows = await this.pool.query<{ id: string; integration: string }>(
      `SELECT io.id,io.integration
         FROM integration_outbox io
        WHERE io.state='pending'
          AND (io.next_attempt_at IS NULL OR io.next_attempt_at<=clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM integration_outbox prior
             WHERE prior.integration=io.integration
               AND prior.event_id<io.event_id
               AND prior.state<>'delivered'
          )
        ORDER BY io.event_id
        LIMIT 500`,
    );
    for (const row of rows.rows)
      await this.store?.transaction((c) =>
        this.queue!.send(c, "integration", { id: row.id }, `integration:${row.integration}:${row.id}`),
      );
  }
  private async beat(): Promise<void> {
    await this.pool.query(
      "INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=clock_timestamp()",
      [this.workerId],
    );
    await this.unblockFailedConversations();
    await this.unblockFailedSends();
    if (this.config.INTEGRATION_DISPATCH) await this.recoverIntegrationQueue();
  }
  /**
   * A failed conversation job holds its phone's FIFO key forever. Settle the
   * message and delete the failed row so the queued successors can run.
   */
  private async unblockFailedConversations(): Promise<void> {
    if (!this.queue || !this.engine) return;
    const failed = await this.queue.failedJobs("conversation");
    for (const job of failed) {
      if (job.messageId)
        await this.engine.releaseFailedTurn(job.messageId, new Error("fifo_failed_job"));
      await this.queue.releaseSingleton("conversation", job.singletonKey, ["failed"]);
    }
  }
  /**
   * key_strict_fifo on send means a failed delivery job blocks every later
   * WhatsApp reply for that phone. Release the singleton, cancel ops-alert
   * rows that should never reach customers, and re-queue the head pending
   * customer outbox so chat replies resume.
   */
  private async unblockFailedSends(): Promise<void> {
    if (!this.queue || !this.store) return;
    const failed = await this.queue.failedJobs("send");
    const phones = new Set<string>();
    for (const job of failed) {
      phones.add(job.singletonKey);
      if (job.messageId) {
        await this.pool.query(
          `UPDATE outbox
              SET state=CASE
                    WHEN state IN ('sending','uncertain') THEN 'pending'
                    ELSE state
                  END,
                  error_code=COALESCE(NULLIF(error_code,''), 'send_fifo_released'),
                  format_state=CASE
                    WHEN format_state='pending' THEN 'ready'
                    ELSE format_state
                  END
            WHERE id=$1 AND state IN ('pending','sending','uncertain','failed')`,
          [job.messageId],
        );
      }
      await this.queue.releaseSingleton("send", job.singletonKey, ["failed"]);
    }
    // Ops alerts must never occupy a customer send FIFO head.
    await this.pool.query(
      `UPDATE outbox
          SET state='cancelled', error_code='ops_alert_customer_blocked'
        WHERE state IN ('pending','sending','uncertain','failed')
          AND text LIKE $1
          AND phone <> $2`,
      [`${"נדרשת בדיקת מערכת"}%`, this.config.ADMIN_PHONE],
    );
    for (const phone of phones) {
      const head = await this.pool.query<{ id: string }>(
        `SELECT id FROM outbox
          WHERE phone=$1 AND state='pending' AND format_state='ready'
          ORDER BY seq LIMIT 1`,
        [phone],
      );
      if (!head.rows[0]) continue;
      await this.store.transaction(async (c) => {
        const jobId = await this.queue!.send(
          c,
          "send",
          { id: head.rows[0]!.id },
          phone,
        );
        await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
          head.rows[0]!.id,
          jobId,
        ]);
      });
    }
  }
  async check(): Promise<void> {
    if (!this.ready || !this.engine || !this.queue?.started)
      throw new AppError("not_ready", 503);
    await this.pool.query("SELECT 1");
    await this.engine.storage.check();
    const heartbeat = await this.pool.query(
      "SELECT 1 FROM worker_heartbeats WHERE id=$1 AND updated_at>clock_timestamp()-interval '45 seconds'",
      [this.workerId],
    );
    if (!heartbeat.rowCount && this.heartbeat)
      throw new AppError("workers_unhealthy", 503);
  }
  private async operations(kind: string): Promise<void> {
    if (!this.store || !this.queue) return;
    const store = this.store,
      now = this.overrides.now?.() ?? new Date(),
      date = localDate(now).date;
    if (kind === "tuesday_summary") {
      const ids = await this.pool.query<{ id: string }>(
        "SELECT id FROM requests WHERE run_date=$1 AND status=ANY($2) ORDER BY number",
        [date, ["coordinated", "closed"]],
      );
      const requests: Request[] = [];
      if (!ids.rows.length) return;
      for (const x of ids.rows) requests.push(await store.request(x.id));
      await store.transaction((c) =>
        store.outbound(
          c,
          { trace_id: randomUUID(), mode: this.config.BOT_MODE },
          {
            phone: this.config.ADMIN_PHONE,
            text: `סיכום הובלות ${date}\n${statusText(requests)}\nנא לסמן בממשק הניהול רק פניות שהושלמו בפועל.`,
          },
          `tuesday-summary:${date}`,
        ),
      );
      return;
    }
    const blocked: Record<string, number> = {};
    for (const q of ["ingest", "conversation", "send"])
      blocked[q] = (await this.queue.boss.getBlockedKeys(q)).length;
    const uncertain = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM outbox WHERE state='uncertain'",
    );
    const formatting = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM outbox WHERE format_state='pending' AND state <> 'cancelled' AND created_at<clock_timestamp()-interval '30 seconds'",
    );
    const failedMedia = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM messages WHERE media_state='pending' AND received_at<clock_timestamp()-interval '60 seconds'",
    );
    const integrations = this.config.INTEGRATION_DISPATCH
      ? await this.pool.query<{ n: number; dead: number; stuck: number }>(
          `SELECT count(*)::int n,
                  count(*) FILTER (WHERE state='dead_letter')::int dead,
                  count(*) FILTER (WHERE state='active' AND last_attempt_at < clock_timestamp()-interval '60 seconds')::int stuck
             FROM integration_outbox
            WHERE state='dead_letter'
               OR (state='active' AND last_attempt_at < clock_timestamp()-interval '60 seconds')
               OR (state='pending' AND created_at < clock_timestamp()-interval '60 seconds')`,
        )
      : { rows: [{ n: 0, dead: 0, stuck: 0 }] };
    if (
      Object.values(blocked).some((v) => v > 0) ||
      uncertain.rows[0]!.n > 0 ||
      formatting.rows[0]!.n > 0 ||
      failedMedia.rows[0]!.n > 0 ||
      integrations.rows[0]!.n > 0
    ) {
      this.log.error({
        code: "operations_attention",
        blocked,
        uncertain: uncertain.rows[0]!.n,
        notice_formatting_overdue: formatting.rows[0]!.n,
        media_overdue: failedMedia.rows[0]!.n,
        integrations: integrations.rows[0],
      });
      await store.transaction((c) =>
        store.outbound(
          c,
          { trace_id: randomUUID(), mode: this.config.BOT_MODE },
          {
            phone: this.config.ADMIN_PHONE,
          text: `נדרשת בדיקת מערכת חיים יחד.\nתורים חסומים: ${JSON.stringify(blocked)}\nשליחות לא ודאיות: ${uncertain.rows[0]!.n}\nניסוח הודעות תקוע: ${formatting.rows[0]!.n}\nקבצים בהמתנה מעל דקה: ${failedMedia.rows[0]!.n}\nאינטגרציות תקועות/סופיות: ${integrations.rows[0]!.n} (dead-letter: ${integrations.rows[0]!.dead}, active תקוע: ${integrations.rows[0]!.stuck})\nיש לבדוק במסך הניהול. אם WhatsApp אינו זמין, ההתראה נשמרת בלוג וב־admin API.`,
          },
          `ops:${now.toISOString().slice(0, 13)}`,
        ),
      );
    }
    const waiting = await this.pool.query<{ id: string }>(
      "SELECT id FROM requests WHERE status='waiting_capacity' ORDER BY number LIMIT 20",
    );
    for (const row of waiting.rows)
      await store.transaction(async (c) => {
        const r = await store.request(row.id, c, true);
        if (r.status !== "waiting_capacity") return;
        if (!r.proposed_run_date) {
          const proposed = await store.proposeScheduleDate(c, r, now);
          if (!proposed) return;
          r.proposed_run_date = proposed;
          r.status = "awaiting_approval";
          for (const p of r.parties) {
            p.schedule_approved = false;
            p.schedule_approved_date = null;
            p.schedule_approved_at = null;
          }
          await store.save(c, r);
          const trace_id = randomUUID();
          await store.event(c, { trace_id }, "system", "schedule_proposed_after_capacity_approval", { date: proposed }, r.id);
          for (const p of r.parties) {
            const permission = await c.query<{ state: string }>(
              "SELECT state FROM request_verifications WHERE request_id=$1 AND role=$2",
              [r.id, p.role],
            );
            const authorized = ["consented", "queued", "provider_accepted", "delivered", "approved"].includes(permission.rows[0]?.state ?? "");
            if (!authorized) continue;
            const notice = { phone: p.phone, text: nextQuestion(r, p.phone).text };
            await store.outbound(
              c,
              { trace_id, mode: this.config.BOT_MODE },
              notice,
              `schedule-proposal-after-capacity:${r.id}:${proposed}:${p.phone}`,
              r.id,
              "pending",
            );
          }
          return;
        }
        if ((await store.coordinate(c, r, now)) === "coordinated") {
          await store.save(c, r);
          const trace_id = randomUUID();
          await store.event(
            c,
            { trace_id },
            "system",
            "coordinated_from_waitlist",
            { date: r.run_date },
            r.id,
          );
          for (const p of r.parties)
            await store.outbound(
              c,
              { trace_id, mode: this.config.BOT_MODE },
              { phone: p.phone, text: statusText([r]) },
              `coordination:${r.id}:${r.run_date}:${p.phone}`,
              r.id,
            );
        }
      });
    await this.pool.query(
      "DELETE FROM worker_heartbeats WHERE updated_at<clock_timestamp()-interval '7 days'",
    );
  }
  async stop(): Promise<void> {
    this.ready = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.queue?.stop();
    await this.planner?.close();
    await this.pool.end();
  }
  requireStore(): Store {
    if (!this.ready || !this.store) throw new AppError("not_ready", 503);
    return this.store;
  }
  safeError(e: unknown): void {
    this.log.warn({
      code: errorCode(e),
      stage: "startup_waiting_for_migrations",
    });
  }
}
