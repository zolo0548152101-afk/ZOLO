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
  type Log,
  type Request,
} from "../domain/types.js";
import { localDate, statusText } from "../domain/policies.js";
export interface RuntimeOverrides {
  pool?: pg.Pool;
  planner?: Planner;
  channel?: Channel;
  storage?: MediaStorage;
  queueOptions?: Partial<ConstructorOptions>;
  now?: () => Date;
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
  constructor(
    readonly config: Config,
    readonly log: Log,
    private readonly overrides: RuntimeOverrides = {},
  ) {
    this.pool = overrides.pool ?? makePool(config, log);
  }
  async start(workers = true): Promise<void> {
    if (this.initializing || this.ready) return;
    this.initializing = true;
    try {
      const version = await this.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pgmigrations",
      );
      if (version.rows[0]?.n !== 2)
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
            for (const j of jobs)
              await engine.ingestNext(j.retryCount >= j.retryLimit);
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
            for (const j of jobs)
              await engine.processNext(j.data.id, j.retryCount >= 1);
          },
        );
        await queue.boss.work<JobData, void, typeof settings>(
          "send",
          settings,
          async (jobs) => {
            for (const j of jobs) await engine.send(j.data.id);
          },
        );
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
  private async beat(): Promise<void> {
    await this.pool.query(
      "INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=clock_timestamp()",
      [this.workerId],
    );
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
    const failedMedia = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM messages WHERE media_state='pending' AND received_at<clock_timestamp()-interval '60 seconds'",
    );
    if (
      Object.values(blocked).some((v) => v > 0) ||
      uncertain.rows[0]!.n > 0 ||
      failedMedia.rows[0]!.n > 0
    ) {
      this.log.error({
        code: "operations_attention",
        blocked,
        uncertain: uncertain.rows[0]!.n,
        media_overdue: failedMedia.rows[0]!.n,
      });
      await store.transaction((c) =>
        store.outbound(
          c,
          { trace_id: randomUUID(), mode: this.config.BOT_MODE },
          {
            phone: this.config.ADMIN_PHONE,
            text: `נדרשת בדיקת מערכת חיים יחד.\nתורים חסומים: ${JSON.stringify(blocked)}\nשליחות לא ודאיות: ${uncertain.rows[0]!.n}\nקבצים בהמתנה מעל דקה: ${failedMedia.rows[0]!.n}\nיש לבדוק במסך הניהול. אם WhatsApp אינו זמין, ההתראה נשמרת בלוג וב־admin API.`,
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
