import pg from "pg";
import type { Config } from "../config.js";
import type { Log } from "../domain/types.js";
export function makePool(c: Config, log: Log): pg.Pool {
  const pool = new pg.Pool({
    connectionString: c.DATABASE_URL,
    max: c.DB_POOL_MAX,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    statement_timeout: 8000,
    options: `-c search_path=${c.DB_SCHEMA},public -c timezone=UTC -c idle_in_transaction_session_timeout=15000`,
    application_name: `haim-v5-${c.BOT_MODE}`,
  });
  pool.on("error", () => log.error({ code: "db_pool_error" }));
  return pool;
}
export async function tx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      client.release(true);
      destroyed = true;
      throw e;
    }
    throw e;
  } finally {
    if (!destroyed) client.release();
  }
}
