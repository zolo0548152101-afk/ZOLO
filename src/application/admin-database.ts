import type pg from "pg";
import { AppError } from "../domain/types.js";
import { canonicalPhone } from "../domain/policies.js";

/** Friendly aliases → real table names in the app schema. */
export const TABLE_ALIASES: Record<string, string> = {
  parties: "request_parties",
  items: "request_items",
  events: "request_events",
  locations: "request_locations",
  allowlist: "app_settings",
  jobs: "job", // resolved against jobs schema
};

const BLOCKED = new Set([
  "pgmigrations",
  "schema_checksums",
  "bam",
  "version",
  "warning",
  "subscription",
  "schedule",
  "queue",
  "queue_stats",
  "job_common",
  "job_dependency",
]);

export type TableListItem = {
  name: string;
  schema: string;
  alias_of?: string;
  kind: "data" | "jobs" | "alias";
};

export async function listSchemaTables(
  pool: pg.Pool,
  schema: string,
): Promise<TableListItem[]> {
  const data = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname=$1
      ORDER BY tablename`,
    [schema],
  );
  const jobsSchema = `${schema}_jobs`;
  const jobs = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname=$1
      ORDER BY tablename`,
    [jobsSchema],
  );
  const out: TableListItem[] = [];
  for (const row of data.rows) {
    if (BLOCKED.has(row.tablename)) continue;
    out.push({ name: row.tablename, schema, kind: "data" });
  }
  for (const [alias, real] of Object.entries(TABLE_ALIASES)) {
    if (real === "job") {
      out.push({
        name: alias,
        schema: jobsSchema,
        alias_of: real,
        kind: "alias",
      });
      continue;
    }
    if (data.rows.some((r) => r.tablename === real))
      out.push({ name: alias, schema, alias_of: real, kind: "alias" });
  }
  for (const row of jobs.rows) {
    if (BLOCKED.has(row.tablename) || row.tablename.startsWith("queue_stats_"))
      continue;
    out.push({ name: row.tablename, schema: jobsSchema, kind: "jobs" });
  }
  return out;
}

function resolveTable(
  requested: string,
  schema: string,
): { schema: string; table: string } {
  const alias = TABLE_ALIASES[requested];
  if (alias === "job") return { schema: `${schema}_jobs`, table: "job" };
  if (alias) return { schema, table: alias };
  if (requested === "job" || requested.startsWith("job_"))
    return { schema: `${schema}_jobs`, table: requested };
  return { schema, table: requested };
}

async function assertReadableTable(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<string[]> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(schema))
    throw new AppError("database_table_invalid", 400, "שם טבלה לא תקין.");
  if (BLOCKED.has(table))
    throw new AppError("database_table_forbidden", 403, "הטבלה אינה זמינה.");
  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  if (!cols.rows.length)
    throw new AppError("database_table_not_found", 404, "הטבלה לא נמצאה.");
  return cols.rows.map((r) => r.column_name);
}

function timeColumn(columns: string[]): string | null {
  for (const c of [
    "received_at",
    "created_at",
    "opened_at",
    "sent_at",
    "updated_at",
    "captured_at",
    "created_on",
  ])
    if (columns.includes(c)) return c;
  return null;
}

export async function readTableRows(
  pool: pg.Pool,
  appSchema: string,
  opts: {
    table: string;
    limit?: number;
    phone?: string | null;
    since?: string | null;
    until?: string | null;
  },
): Promise<{
  table: string;
  resolved: { schema: string; table: string };
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  const resolved = resolveTable(opts.table, appSchema);
  const columns = await assertReadableTable(pool, resolved.schema, resolved.table);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  let phone = opts.phone?.trim() || null;
  if (phone) {
    try {
      phone = canonicalPhone(phone);
    } catch {
      throw new AppError("invalid_phone", 400, "מספר טלפון לא תקין.");
    }
  }

  if (phone) {
    if (columns.includes("phone")) {
      params.push(phone);
      where.push(`phone = $${params.length}`);
    } else if (resolved.table === "messages" || resolved.table === "conversations") {
      params.push(phone);
      where.push(
        `contact_id IN (SELECT id FROM ${appSchema}.contacts WHERE phone = $${params.length})`,
      );
    } else if (
      resolved.table === "request_parties" ||
      resolved.table === "request_items" ||
      resolved.table === "request_events" ||
      resolved.table === "request_media" ||
      resolved.table === "request_locations" ||
      resolved.table === "request_verifications" ||
      resolved.table === "matches"
    ) {
      params.push(phone);
      where.push(
        `request_id IN (
           SELECT rp.request_id FROM ${appSchema}.request_parties rp
           JOIN ${appSchema}.contacts c ON c.id=rp.contact_id
           WHERE c.phone = $${params.length}
         )`,
      );
    } else if (resolved.table === "requests") {
      params.push(phone);
      where.push(
        `id IN (
           SELECT rp.request_id FROM ${appSchema}.request_parties rp
           JOIN ${appSchema}.contacts c ON c.id=rp.contact_id
           WHERE c.phone = $${params.length}
         )`,
      );
    } else if (resolved.table === "turn_logs") {
      params.push(phone);
      where.push(`phone = $${params.length}`);
    } else if (resolved.table === "media") {
      params.push(phone);
      where.push(
        `message_id IN (
           SELECT m.id FROM ${appSchema}.messages m
           JOIN ${appSchema}.contacts c ON c.id=m.contact_id
           WHERE c.phone = $${params.length}
         )`,
      );
    } else if (resolved.table === "app_settings") {
      params.push("bot_access");
      where.push(`key = $${params.length}`);
    } else if (resolved.table === "job") {
      params.push(`%${phone}%`);
      where.push(`singleton_key LIKE $${params.length}`);
    }
  }

  const tcol = timeColumn(columns);
  if (opts.since) {
    if (!tcol)
      throw new AppError("database_no_time_column", 400, "לטבלה אין עמודת זמן.");
    params.push(opts.since);
    where.push(`${tcol} >= $${params.length}::timestamptz`);
  }
  if (opts.until) {
    if (!tcol)
      throw new AppError("database_no_time_column", 400, "לטבלה אין עמודת זמן.");
    params.push(opts.until);
    where.push(`${tcol} <= $${params.length}::timestamptz`);
  }

  const order = tcol
    ? `${tcol} DESC`
    : columns.includes("seq")
      ? "seq DESC"
      : columns.includes("id")
        ? "id DESC"
        : "1";
  params.push(limit);
  const sql = `SELECT * FROM ${resolved.schema}.${resolved.table}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order}
    LIMIT $${params.length}`;
  const rows = await pool.query(sql, params);
  return {
    table: opts.table,
    resolved,
    columns,
    rows: rows.rows,
  };
}
