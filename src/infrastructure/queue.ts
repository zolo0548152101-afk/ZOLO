import { PgBoss, type ConstructorOptions } from "pg-boss";
import type pg from "pg";
import type { Config } from "../config.js";
import { RetryableError, type Log } from "../domain/types.js";
export const QUEUES = [
  "ingest",
  "capture",
  "conversation",
  "send",
  "ops",
] as const;
export type QueueName = (typeof QUEUES)[number];
export interface JobData {
  id: string;
}
export class Queue {
  readonly boss: PgBoss;
  started = false;
  constructor(
    c: Config,
    log: Log,
    migrate = false,
    overrides: Partial<ConstructorOptions> = {},
  ) {
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
  ): Promise<string> {
    const id = await this.boss.send(name, data, {
      singletonKey: key,
      db: { executeSql: (text, values) => client.query(text, values) },
    });
    if (!id) throw new RetryableError("job_not_enqueued");
    return id;
  }
  async stop(): Promise<void> {
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 55000 });
  }
}
