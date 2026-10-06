import { PgBoss, type ConstructorOptions } from "pg-boss";
import type pg from "pg";
import type { Config } from "../config.js";
import { RetryableError, type Log } from "../domain/types.js";
export const QUEUES = [
  "ingest",
  "capture",
  "conversation",
  "send",
  "integration",
  "ops",
] as const;
export type QueueName = (typeof QUEUES)[number];
export interface JobData {
  id: string;
}
export class Queue {
  readonly boss: PgBoss;
  readonly schema: string;
  started = false;
  constructor(
    c: Config,
    log: Log,
    migrate = false,
    overrides: Partial<ConstructorOptions> = {},
  ) {
    this.schema = `${c.DB_SCHEMA}_jobs`;
    this.boss = new PgBoss({
      connectionString: c.DATABASE_URL,
      schema: `${c.DB_SCHEMA}_jobs`,
      max: Math.max(4, Math.min(8, c.DB_POOL_MAX)),
      connectionTimeoutMillis: 5000,
      application_name: "haim-pgboss",
      migrate,
      useListenNotify: true,
      superviseIntervalSeconds: 5,
      monitorIntervalSeconds: 5,
      ...overrides,
    });
    this.boss.on("error", () => log.error({ code: "queue_error" }));
    this.boss.on("warning", () => log.warn({ code: "queue_warning" }));
  }
  async start(install = false): Promise<void> {
    await this.boss.start();
    if (install)
      for (const name of QUEUES)
        await this.boss.createQueue(name, {
          policy:
            name === "capture" || name === "ops"
              ? "standard"
              : "key_strict_fifo",
          notify: true,
          retryLimit: 5,
          retryDelay: 2,
          retryBackoff: true,
          retryDelayMax: 20,
          expireInSeconds: 180,
          heartbeatSeconds: 30,
          retentionSeconds: 31536000,
          deleteAfterSeconds: 604800,
        });
    for (const name of QUEUES)
      if (!(await this.boss.getQueue(name)))
        throw new Error("queue_migration_required");
    this.started = true;
  }
  async send(
    client: pg.PoolClient,
    name: QueueName,
    data: JobData,
    key: string,
    options: { startAfter?: number | string | Date } = {},
  ): Promise<string> {
    const id = await this.boss.send(name, data, {
      singletonKey: key,
      ...options,
      db: { executeSql: (text, values) => client.query(text, values) },
    });
    if (!id) throw new RetryableError("job_not_enqueued");
    return id;
  }
  /**
   * Remove jobs that hold a strict-FIFO key. A failed or retry job blocks every
   * later job with the same singleton key until that row is gone.
   */
  async releaseSingleton(
    name: QueueName,
    key: string,
    states: Array<"created" | "retry" | "active" | "failed">,
  ): Promise<number> {
    if (!states.length) return 0;
    const result = await this.boss.getDb().executeSql(
      `DELETE FROM ${this.schema}.job
        WHERE name=$1 AND singleton_key=$2 AND state::text = ANY($3::text[])
        RETURNING id`,
      [name, key, states],
    );
    return result.rows.length;
  }
  async failedJobs(
    name: QueueName,
  ): Promise<{ id: string; singletonKey: string; messageId: string | null }[]> {
    const result = await this.boss.getDb().executeSql(
      `SELECT id::text AS id, singleton_key AS "singletonKey", data->>'id' AS "messageId"
         FROM ${this.schema}.job
        WHERE name=$1 AND state='failed'
        ORDER BY created_on
        LIMIT 20`,
      [name],
    );
    return result.rows as {
      id: string;
      singletonKey: string;
      messageId: string | null;
    }[];
  }
  async stop(): Promise<void> {
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 55000 });
  }
}
