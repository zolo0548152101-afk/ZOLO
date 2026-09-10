import { runner } from "node-pg-migrate";
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "../config.js";
const dir = resolve("db/migrations");
export async function migrate(
  c: Pick<Config, "DATABASE_URL" | "DB_SCHEMA">,
): Promise<void> {
  if (!/^haim_core(?:_shadow|_sim|_test)?$/.test(c.DB_SCHEMA))
    throw new Error("invalid_schema");
  const client = new pg.Client({
    connectionString: c.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      `haim-migrate:${c.DB_SCHEMA}`,
    ]);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const hashes = new Map<string, string>();
    for (const f of files)
      hashes.set(
        f,
        createHash("sha256")
          .update(await readFile(resolve(dir, f)))
          .digest("hex"),
      );
    const exists = await client.query<{ name: string | null }>(
      "SELECT to_regclass($1)::text AS name",
      [`${c.DB_SCHEMA}.schema_checksums`],
    );
    if (exists.rows[0]?.name) {
      const rows = await client.query<{ name: string; checksum: string }>(
        `SELECT name,checksum FROM ${c.DB_SCHEMA}.schema_checksums`,
      );
      for (const r of rows.rows)
        if (hashes.get(r.name) !== r.checksum)
          throw new Error("modified_applied_migration");
    }
    await runner({
      dbClient: client,
      dir,
      direction: "up",
      migrationsTable: "pgmigrations",
      schema: c.DB_SCHEMA,
      createSchema: true,
      checkOrder: true,
      singleTransaction: true,
      log: () => {},
      advisoryLockMode: "wait",
    });
    for (const [name, hash] of hashes)
      await client.query(
        `INSERT INTO ${c.DB_SCHEMA}.schema_checksums VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [name, hash],
      );
  } finally {
    await client.end();
  }
}
