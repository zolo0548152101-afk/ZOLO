import { randomUUID } from "crypto";
import { canonPhone } from "./phone";
import { dbError, getPool, query } from "./db";

const STATUSES = [
  "collecting",
  "available",
  "awaiting_approval",
  "waiting_capacity",
  "coordinated",
  "human",
  "cancel_pending",
  "cancelled",
  "closed",
  "rejected",
] as const;

export const STATUS_LABELS: Record<string, string> = {
  collecting: "בהשלמת פרטים",
  available: "ממתינה למקבל",
  awaiting_approval: "ממתינה לאישור",
  waiting_capacity: "ממתינה למקום בהובלה",
  coordinated: "תואמה",
  human: "בטיפול אנושי",
  cancel_pending: "ממתינה להחלטה לאחר ביטול",
  cancelled: "בוטלה",
  closed: "הושלמה",
  rejected: "לא מתאימה",
};

const TABLE_LABELS: Record<string, string> = {
  requests: "פניות והובלות",
  contacts: "אנשי קשר",
  conversations: "שיחות",
  messages: "הודעות נכנסות",
  deliveries: "הודעות יוצאות",
  contact_identities: "זהויות צ׳אט",
  request_parties: "צדדים בפנייה",
  request_items: "פריטים",
  media: "קבצי מדיה",
  request_media: "תמונות של פנייה",
  request_locations: "מיקומי פנייה",
  request_verifications: "אימותים",
  searches: "חיפושים",
  matches: "התאמות",
  transport_runs: "סבבי הובלה",
  transport_capacity_approvals: "אישורי מכסה",
  request_events: "אירועי פנייה",
  conversation_resets: "איפוסי שיחה",
  request_counter: "מונה פניות",
  service_locations: "יישובים",
  streets: "רחובות",
  app_settings: "הגדרות",
  logs: "יומן",
};

const REQUEST_EDITABLE = [
  "status",
  "run_date",
  "preferred_time",
  "represents_both_parties",
  "human_reason",
  "donor_phone",
  "donor_name",
  "pickup_city",
  "pickup_address",
  "pickup_floor",
  "receiver_phone",
  "receiver_name",
  "destination_city",
  "destination_address",
  "destination_floor",
  "item_description",
  "quantity",
  "needs_disassembly",
];

type ColumnInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_identity: string;
  is_nullable: string;
};

export type TablePayload = {
  table: string;
  label: string;
  columns: string[];
  editable: string[];
  pk: string[];
  types: Record<string, string>;
  options: Record<string, string[]>;
  rows: Record<string, unknown>[];
};

function waha() {
  const base = (process.env.WAHA_BASE_URL || "https://whatsapp-waha.cdpvmq.easypanel.host").replace(/\/$/, "");
  const key = process.env.WAHA_API_KEY || "";
  const session = process.env.WAHA_SESSION || "HAIM_YAHAD";
  return { base, key, session };
}

export function allowedSession(value: string | undefined): string {
  const session = (value || waha().session).trim();
  if (!["HAIM_YAHAD", "default", "TAL_ZOLO"].includes(session)) {
    throw new Error("סשן WhatsApp זה אינו מורשה בדף הניהול.");
  }
  return session;
}

async function wahaFetch(path: string, init: RequestInit = {}) {
  const { base, key } = waha();
  if (!key) throw new Error("חסר WAHA_API_KEY בשרת הניהול. בלי המפתח אי אפשר לבדוק חיבור, להציג QR, לשלוח הודעה או להוריד תמונה.");
  const headers = new Headers(init.headers);
  headers.set("X-Api-Key", key);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(20000) });
}

export async function overview() {
  const [pending, deliveries, ai, requests, uncertain, access] = await Promise.all([
    query<{ n: string }>("SELECT count(*)::int AS n FROM haim.messages WHERE processed_at IS NULL"),
    query<{ n: string }>("SELECT count(*)::int AS n FROM haim.deliveries"),
    query<{ n: string }>("SELECT count(*)::int AS n FROM haim.logs WHERE event = 'agent_note'"),
    query<Record<string, unknown>>(`
      SELECT r.number, r.status,
             COALESCE(string_agg(i.description, ', ' ORDER BY i.position), '') AS items,
             d.name AS donor_name, d.phone AS donor_phone,
             v.name AS receiver_name, v.phone AS receiver_phone,
             r.run_date::text AS run_date, r.proposed_run_date::text AS proposed_run_date
        FROM haim.requests r
        LEFT JOIN haim.request_parties d ON d.request_id = r.id AND d.role = 'donor'
        LEFT JOIN haim.request_parties v ON v.request_id = r.id AND v.role = 'receiver'
        LEFT JOIN haim.request_items i ON i.request_id = r.id
       GROUP BY r.id, d.name, d.phone, v.name, v.phone
       ORDER BY r.number DESC
       LIMIT 100`),
    query<Record<string, unknown>>(`
      SELECT id::text, phone, state::text AS state, COALESCE(error_code, '') AS error_code
        FROM haim.deliveries WHERE state = 'uncertain'
       ORDER BY created_at DESC LIMIT 50`),
    query<{ value: { mode?: string; phones?: string[] } }>(
      "SELECT value FROM haim.app_settings WHERE key = 'bot_access'",
    ),
  ]);
  return {
    metrics: {
      pending: Number(pending[0]?.n ?? 0),
      outbound: Number(deliveries[0]?.n ?? 0),
      queues: 0,
      ai: Number(ai[0]?.n ?? 0),
    },
    requests: requests.map((row) => ({
      ...row,
      status: STATUS_LABELS[String(row.status)] ?? row.status,
    })),
    uncertain,
    access: access[0]?.value ?? { mode: "open", phones: [] },
    jobs: [] as unknown[],
  };
}

async function tableNames(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'haim' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map((row) => row.name);
}

async function describe(table: string): Promise<ColumnInfo[]> {
  return query<ColumnInfo>(
    `SELECT column_name, data_type, udt_name, is_identity, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'haim' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
}

async function primaryKey(table: string): Promise<string[]> {
  const rows = await query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = ('haim.' || quote_ident($1))::regclass
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  return rows.map((row) => row.attname);
}

function typeToken(column: ColumnInfo): string {
  if (column.data_type === "ARRAY") return "array";
  if (column.data_type === "jsonb" || column.data_type === "json") return "json";
  if (column.data_type === "boolean") return "boolean";
  if (column.data_type === "date") return "date";
  if (column.data_type === "integer" || column.data_type === "smallint" || column.data_type === "bigint" || column.data_type === "numeric") return "number";
  if (column.udt_name === "delivery_state") return "enum";
  return "text";
}

const CUSTOM: Record<string, { sql: string; editable: string[]; pk: string[] }> = {
  requests: {
    pk: ["id"],
    editable: REQUEST_EDITABLE,
    sql: `SELECT r.id, r.number, r.status, d.phone AS donor_phone, d.name AS donor_name,
            d.settlement AS pickup_city, d.address AS pickup_address, d.floor AS pickup_floor,
            v.phone AS receiver_phone, v.name AS receiver_name, v.settlement AS destination_city,
            v.address AS destination_address, v.floor AS destination_floor,
            COALESCE(string_agg(i.description, ', ' ORDER BY i.position), '') AS items,
            COALESCE(sum(i.quantity), 0)::int AS quantity, bool_or(i.needs_disassembly) AS needs_disassembly,
            r.earliest_run_date AS requested_date, r.preferred_time, r.proposed_run_date,
            d.schedule_approved_date AS donor_schedule_approved_date,
            v.schedule_approved_date AS receiver_schedule_approved_date,
            r.run_date, r.represents_both_parties, r.closed_at, r.human_reason,
            d.approved_at IS NOT NULL AS donor_approved, v.approved_at IS NOT NULL AS receiver_approved,
            (SELECT count(*)::int FROM haim.request_media rm WHERE rm.request_id = r.id) AS photos,
            (SELECT COALESCE(json_agg(rm.media_id ORDER BY rm.media_id), '[]'::json) FROM haim.request_media rm WHERE rm.request_id = r.id) AS media_ids,
            (SELECT COALESCE(json_agg(json_build_object('role', rl.role, 'latitude', rl.latitude, 'longitude', rl.longitude) ORDER BY rl.role), '[]'::json)
               FROM haim.request_locations rl WHERE rl.request_id = r.id) AS locations,
            r.created_at, r.updated_at
       FROM haim.requests r
       LEFT JOIN haim.request_parties d ON d.request_id = r.id AND d.role = 'donor'
       LEFT JOIN haim.request_parties v ON v.request_id = r.id AND v.role = 'receiver'
       LEFT JOIN haim.request_items i ON i.request_id = r.id
      GROUP BY r.id, d.phone, d.name, d.settlement, d.address, d.floor, d.approved_at, d.schedule_approved_date,
               v.phone, v.name, v.settlement, v.address, v.floor, v.approved_at, v.schedule_approved_date
      ORDER BY r.number DESC
      LIMIT 500`,
  },
  messages: {
    pk: ["id"],
    editable: ["text", "reply", "error_code"],
    sql: `SELECT m.id, m.seq, c.phone, m.kind, m.text, m.reply, m.error_code, m.received_at,
                 m.location, m.media, med.id AS media_id
            FROM haim.messages m
            LEFT JOIN haim.contacts c ON c.id = m.contact_id
            LEFT JOIN haim.media med ON med.message_id = m.id
           ORDER BY m.seq DESC
           LIMIT 500`,
  },
  conversations: {
    pk: ["id"],
    editable: ["mode", "chat_id", "selected_request_id"],
    sql: `SELECT cv.id, co.phone, cv.mode, cv.session, cv.chat_id, cv.selected_request_id, cv.version
            FROM haim.conversations cv
            JOIN haim.contacts co ON co.id = cv.contact_id
           ORDER BY cv.created_at DESC
           LIMIT 500`,
  },
  deliveries: {
    pk: ["id"],
    editable: ["state", "body", "error_code"],
    sql: `SELECT id, phone, state::text AS state, body, error_code, created_at, chat_id, provider_id
            FROM haim.deliveries
           ORDER BY created_at DESC
           LIMIT 500`,
  },
  contacts: {
    pk: ["id"],
    editable: ["phone"],
    sql: "SELECT id, phone, created_at FROM haim.contacts ORDER BY created_at DESC LIMIT 500",
  },
};

export async function listTableChoices() {
  const names = await tableNames();
  const preferred = ["requests", "contacts", "conversations", "messages", "deliveries"];
  const ordered = [...preferred.filter((name) => names.includes(name)), ...names.filter((name) => !preferred.includes(name))];
  return ordered.map((name) => ({ name, label: TABLE_LABELS[name] ?? name }));
}

export async function loadTable(table: string): Promise<TablePayload> {
  const names = await tableNames();
  if (!names.includes(table)) throw new Error("טבלה לא מוכרת");
  const custom = CUSTOM[table];
  const columnsInfo = await describe(table);
  const pk = custom?.pk ?? (await primaryKey(table));
  const rows = custom
    ? await query<Record<string, unknown>>(custom.sql)
    : await query<Record<string, unknown>>(
        `SELECT * FROM haim.${(await query<{ q: string }>("SELECT quote_ident($1) AS q", [table]))[0]!.q} LIMIT 500`,
      );
  const fallbackColumns: Record<string, string[]> = {
    requests: ["number", "status", "donor_phone", "donor_name", "pickup_city", "pickup_address", "pickup_floor", "receiver_phone", "receiver_name", "destination_city", "destination_address", "destination_floor", "items", "quantity", "needs_disassembly", "requested_date", "preferred_time", "proposed_run_date", "donor_schedule_approved_date", "receiver_schedule_approved_date", "run_date", "represents_both_parties", "closed_at", "human_reason", "donor_approved", "receiver_approved", "photos", "media_ids", "locations", "created_at", "updated_at"],
    messages: ["seq", "phone", "kind", "text", "reply", "error_code", "received_at", "location", "media", "media_id"],
    conversations: ["phone", "mode", "session", "chat_id", "selected_request_id", "version"],
    deliveries: ["phone", "state", "body", "error_code", "created_at", "chat_id", "provider_id"],
    contacts: ["phone", "created_at"],
  };
  const columns = custom
    ? (rows[0] ? Object.keys(rows[0]).filter((key) => key !== "id") : fallbackColumns[table] ?? [])
    : columnsInfo.map((column) => column.column_name);
  const types: Record<string, string> = {};
  for (const column of columnsInfo) types[column.column_name] = typeToken(column);
  if (table === "requests") {
    types.status = "enum";
    types.needs_disassembly = "boolean";
    types.represents_both_parties = "boolean";
    types.run_date = "date";
    types.quantity = "number";
    types.pickup_floor = "number";
    types.destination_floor = "number";
    types.item_description = "text";
  }
  const editable = custom
    ? custom.editable
    : columnsInfo
        .filter((column) => column.is_identity !== "YES" && !pk.includes(column.column_name))
        .map((column) => column.column_name);
  const options: Record<string, string[]> = {};
  if (editable.includes("status")) options.status = [...STATUSES];
  if (editable.includes("mode")) options.mode = ["bot", "human"];
  if (editable.includes("state")) options.state = ["pending", "sending", "sent", "uncertain", "failed", "cancelled"];
  return {
    table,
    label: TABLE_LABELS[table] ?? table,
    columns: columns.filter((key) => key !== "id" || !custom),
    editable,
    pk,
    types,
    options,
    rows,
  };
}

function empty(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asBool(value: unknown): boolean | null {
  if (value === null || value === "" || value === undefined) return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("ערך כן/לא אינו תקין");
}

function asNumber(value: unknown): number | null {
  if (value === null || value === "" || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("מספר אינו תקין");
  return n;
}

async function partyUpdate(
  client: import("pg").PoolClient,
  id: string,
  role: "donor" | "receiver",
  changes: Record<string, unknown>,
) {
  const prefix = role === "donor" ? "donor" : "receiver";
  const city = role === "donor" ? "pickup_city" : "destination_city";
  const address = role === "donor" ? "pickup_address" : "destination_address";
  const floor = role === "donor" ? "pickup_floor" : "destination_floor";
  const keys = [`${prefix}_phone`, `${prefix}_name`, city, address, floor];
  if (!keys.some((key) => key in changes)) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  const phoneKey = `${prefix}_phone`;
  if (phoneKey in changes) {
    const phone = canonPhone(String(changes[phoneKey] ?? ""));
    if (!phone) throw new Error("מספר הטלפון אינו תקין");
    values.push(phone);
    sets.push(`phone = $${values.length}`, `contact_id = haim.ensure_contact($${values.length})`);
  }
  if (`${prefix}_name` in changes) {
    values.push(empty(changes[`${prefix}_name`]));
    sets.push(`name = $${values.length}`);
  }
  if (city in changes) {
    values.push(empty(changes[city]));
    sets.push(`settlement = $${values.length}`);
  }
  if (address in changes) {
    values.push(empty(changes[address]));
    sets.push(`address = $${values.length}`);
  }
  if (floor in changes) {
    values.push(asNumber(changes[floor]));
    sets.push(`floor = $${values.length}`);
  }
  values.push(id, role);
  await client.query(
    `UPDATE haim.request_parties SET ${sets.join(", ")} WHERE request_id = $${values.length - 1} AND role = $${values.length}`,
    values,
  );
}

export async function updateRequest(id: string, changes: Record<string, unknown>) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("מזהה לא תקין");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string; run_date: string | null }>(
      "SELECT status, run_date::text FROM haim.requests WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!current.rows[0]) throw new Error("הרשומה לא נמצאה.");
    const sets: string[] = [];
    const values: unknown[] = [];
    if ("status" in changes) {
      const status = String(changes.status);
      if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new Error("סטטוס לא תקין");
      values.push(status);
      sets.push(`status = $${values.length}`);
    }
    if ("run_date" in changes) {
      const date = empty(changes.run_date);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("התאריך אינו תקין");
      if (date) {
        const dow = await client.query<{ d: string }>("SELECT EXTRACT(ISODOW FROM $1::date)::int AS d", [date]);
        if (Number(dow.rows[0]?.d) !== 2) throw new Error("אפשר לשבץ הובלה רק ביום שלישי.");
      }
      values.push(date);
      sets.push(`run_date = $${values.length}`);
    }
    if ("preferred_time" in changes) {
      values.push(empty(changes.preferred_time));
      sets.push(`preferred_time = $${values.length}`);
    }
    if ("represents_both_parties" in changes) {
      values.push(Boolean(asBool(changes.represents_both_parties)));
      sets.push(`represents_both_parties = $${values.length}`);
    }
    if ("human_reason" in changes) {
      values.push(empty(changes.human_reason));
      sets.push(`human_reason = $${values.length}`);
    }
    const nextStatus = "status" in changes ? String(changes.status) : current.rows[0].status;
    const nextDate = "run_date" in changes ? empty(changes.run_date) : current.rows[0].run_date;
    if (nextStatus === "coordinated") {
      if (!nextDate) throw new Error("יש לבחור תאריך הובלה לפני סימון הפנייה כמתואמת.");
      await client.query(
        "INSERT INTO haim.transport_runs(run_date, capacity) VALUES ($1, 10) ON CONFLICT (run_date) DO NOTHING",
        [nextDate],
      );
      const cap = await client.query<{ capacity: number; status: string }>(
        "SELECT capacity, status FROM haim.transport_runs WHERE run_date = $1",
        [nextDate],
      );
      const booked = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM haim.requests
          WHERE id <> $2 AND run_date = $1 AND status IN ('coordinated','closed')`,
        [nextDate, id],
      );
      if (cap.rows[0]?.status !== "open" || booked.rows[0]!.n >= cap.rows[0]!.capacity) {
        throw new Error("המכסה לתאריך הזה מלאה או שהסבב סגור.");
      }
    }
    if (sets.length) {
      values.push(id);
      const updated = await client.query(
        `UPDATE haim.requests SET ${sets.join(", ")}, updated_at = clock_timestamp(), version = version + 1 WHERE id = $${values.length}`,
        values,
      );
      if (!updated.rowCount) throw new Error("הרשומה לא נמצאה.");
    }
    await partyUpdate(client, id, "donor", changes);
    await partyUpdate(client, id, "receiver", changes);
    const itemSets: string[] = [];
    const itemValues: unknown[] = [];
    if ("item_description" in changes) {
      const description = empty(changes.item_description);
      if (!description) throw new Error("תיאור הפריט חסר");
      itemValues.push(description);
      itemSets.push(`description = $${itemValues.length}`);
    }
    if ("quantity" in changes) {
      itemValues.push(asNumber(changes.quantity));
      itemSets.push(`quantity = $${itemValues.length}`);
    }
    if ("needs_disassembly" in changes) {
      itemValues.push(asBool(changes.needs_disassembly));
      itemSets.push(`needs_disassembly = $${itemValues.length}`);
    }
    if (itemSets.length) {
      itemValues.push(id);
      await client.query(
        `UPDATE haim.request_items SET ${itemSets.join(", ")} WHERE request_id = $${itemValues.length} AND position = 0`,
        itemValues,
      );
    }
    const schedule = Object.keys(changes).some((key) => key !== "human_reason");
    if (schedule) {
      await client.query("UPDATE haim.requests SET proposed_run_date = NULL WHERE id = $1", [id]);
      await client.query(
        `UPDATE haim.request_parties
            SET approved_at = NULL, approved_by_phone = NULL, schedule_approved = false,
                schedule_approved_date = NULL, schedule_approved_at = NULL
          WHERE request_id = $1`,
        [id],
      );
    }
    await client.query(
      `SELECT public.haim_log('info','db_update', NULL, NULL, $1::uuid, NULL, $2::jsonb)`,
      [id, JSON.stringify({ action: "admin_edit_request", fields: Object.keys(changes) })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

function coerce(value: unknown, kind: string): unknown {
  if (kind === "boolean") return asBool(value);
  if (kind === "number") return asNumber(value);
  if (kind === "json") {
    if (value === null || value === "") return null;
    if (typeof value === "object") return value;
    return JSON.parse(String(value));
  }
  if (kind === "array") {
    if (Array.isArray(value)) return value;
    const text = empty(value);
    return text ? text.split(",").map((part) => part.trim()).filter(Boolean) : [];
  }
  if (kind === "date" || kind === "text" || kind === "enum") return empty(value);
  return empty(value);
}

export async function updateRow(table: string, keys: Record<string, unknown>, changes: Record<string, unknown>) {
  if (table === "requests") return updateRequest(String(keys.id ?? ""), changes);
  const names = await tableNames();
  if (!names.includes(table)) throw new Error("טבלה לא מוכרת");
  const info = await describe(table);
  const pk = await primaryKey(table);
  const editable = new Set(
    info.filter((column) => column.is_identity !== "YES" && !pk.includes(column.column_name)).map((column) => column.column_name),
  );
  if (table === "messages") ["text", "reply", "error_code"].forEach((key) => editable.add(key));
  if (table === "conversations") ["mode", "chat_id", "selected_request_id"].forEach((key) => editable.add(key));
  if (table === "deliveries") ["state", "body", "error_code"].forEach((key) => editable.add(key));
  if (table === "contacts") editable.add("phone");
  const fields = Object.keys(changes).filter((key) => editable.has(key));
  if (!fields.length) throw new Error("לא נבחרו שדות לעדכון.");
  const types = Object.fromEntries(info.map((column) => [column.column_name, typeToken(column)]));
  const values = fields.map((field) => {
    if (field === "phone") {
      const phone = canonPhone(String(changes[field] ?? ""));
      if (!phone) throw new Error("מספר הטלפון אינו תקין");
      return phone;
    }
    return coerce(changes[field], types[field] ?? "text");
  });
  for (const key of pk) {
    if (keys[key] === undefined || keys[key] === null || keys[key] === "") throw new Error("חסר מפתח רשומה");
    values.push(keys[key]);
  }
  const ident = (await query<{ q: string }>("SELECT quote_ident($1) AS q", [table]))[0]!.q;
  const assignments = fields.map((field, index) => `${(safeIdent(field))} = $${index + 1}`).join(", ");
  const where = pk.map((field, index) => `${safeIdent(field)} = $${fields.length + index + 1}`).join(" AND ");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(`UPDATE haim.${ident} SET ${assignments} WHERE ${where}`, values);
    if (!updated.rowCount) throw new Error("הרשומה לא נמצאה.");
    await client.query(`SELECT public.haim_log('info','db_update', NULL, NULL, NULL, NULL, $1::jsonb)`, [
      JSON.stringify({ action: "admin_edit", table, fields }),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

function safeIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("שם עמודה אינו תקין");
  return name;
}

export async function deleteRow(table: string, keys: Record<string, unknown>) {
  if (table === "request_counter") throw new Error("אי אפשר למחוק את מונה הפניות.");
  const names = await tableNames();
  if (!names.includes(table)) throw new Error("טבלה לא מוכרת");
  const pk = table === "requests" ? ["id"] : await primaryKey(table);
  const values = pk.map((key) => {
    if (keys[key] === undefined || keys[key] === null || keys[key] === "") throw new Error("חסר מפתח רשומה");
    return keys[key];
  });
  const ident = (await query<{ q: string }>("SELECT quote_ident($1) AS q", [table]))[0]!.q;
  const where = pk.map((field, index) => `${safeIdent(field)} = $${index + 1}`).join(" AND ");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (table === "requests") {
      await client.query("UPDATE haim.conversations SET selected_request_id = NULL WHERE selected_request_id = $1", [keys.id]);
    }
    const removed = await client.query(`DELETE FROM haim.${ident} WHERE ${where}`, values);
    if (!removed.rowCount) throw new Error("הרשומה לא נמצאה.");
    await client.query(`SELECT public.haim_log('warn','db_update', NULL, NULL, NULL, NULL, $1::jsonb)`, [
      JSON.stringify({ action: "admin_delete", table }),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

export async function requestFiles(id: string) {
  const media = await query<Record<string, unknown>>(
    `SELECT m.id::text AS id, m.mime_type, m.waha_message_id, msg.media
       FROM haim.request_media rm
       JOIN haim.media m ON m.id = rm.media_id
       JOIN haim.messages msg ON msg.id = m.message_id
      WHERE rm.request_id = $1`,
    [id],
  );
  const locations = await query<Record<string, unknown>>(
    `SELECT role, latitude, longitude FROM haim.request_locations WHERE request_id = $1 ORDER BY role`,
    [id],
  );
  return { media, locations };
}

export async function thread(phoneRaw: string) {
  const phone = canonPhone(phoneRaw);
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  const rows = await query<Record<string, unknown>>(
    `SELECT m.received_at, m.kind, m.text, m.reply, m.location, m.media, med.id::text AS media_id
       FROM haim.messages m
       JOIN haim.contacts c ON c.id = m.contact_id
       LEFT JOIN haim.media med ON med.message_id = m.id
      WHERE c.phone = $1
      ORDER BY m.seq`,
    [phone],
  );
  return { phone, rows };
}

export async function sendDirect(phoneRaw: string, text: string) {
  const phone = canonPhone(phoneRaw);
  const body = text.trim();
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  if (!body) throw new Error("חסר טקסט");
  const session = allowedSession(waha().session);
  const chat = await query<{ chat_id: string }>(
    `SELECT ci.chat_id FROM haim.contact_identities ci
       JOIN haim.contacts c ON c.id = ci.contact_id
      WHERE c.phone = $1 AND ci.session = $2
      LIMIT 1`,
    [phone, session],
  );
  const chatId = chat[0]?.chat_id || `972${phone}@c.us`;
  const response = await wahaFetch("/api/sendText", {
    method: "POST",
    body: JSON.stringify({ session, chatId, text: body }),
  });
  if (!response.ok) throw new Error("שליחת ההודעה ל־WhatsApp נכשלה");
  const payload = (await response.json().catch(() => ({}))) as { id?: string };
  await query(
    `INSERT INTO haim.deliveries(dedupe_key, phone, chat_id, body, state, provider_id, sent_at)
     VALUES ($1, $2, $3, $4, 'sent', $5, clock_timestamp())`,
    [`admin:${randomUUID()}`, phone, chatId, body, payload.id ?? null],
  );
  await query(`SELECT public.haim_log('info','outbound',$1,NULL,NULL,NULL,$2::jsonb)`, [
    phone,
    JSON.stringify({ action: "admin_send", provider_id: payload.id ?? null }),
  ]);
}

export async function setAccess(mode: string, phones: string[]) {
  await query(`SELECT public.haim_set_access($1, $2::jsonb)`, [mode, JSON.stringify(phones)]);
}

export async function resetOne(phoneRaw: string) {
  const phone = canonPhone(phoneRaw);
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  await query(`SELECT public.haim_reset($1)`, [phone]);
}

export async function resetAll() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO haim.conversation_resets(conversation_id, reset_at)
       SELECT id, clock_timestamp() FROM haim.conversations
       ON CONFLICT (conversation_id) DO UPDATE SET reset_at = EXCLUDED.reset_at`,
    );
    const updated = await client.query(
      `UPDATE haim.conversations
          SET mode = 'bot', selected_request_id = NULL, pending_counterparty_name = NULL,
              pending_counterparty_phone = NULL, version = version + 1`,
    );
    await client.query(`SELECT public.haim_log('warn','db_update', NULL, NULL, NULL, NULL, $1::jsonb)`, [
      JSON.stringify({ action: "reset_all", conversations: updated.rowCount ?? 0 }),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

export async function cancelPhone(phoneRaw: string, confirm: string) {
  const phone = canonPhone(phoneRaw);
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  await query(`SELECT public.haim_cancel_phone($1, $2)`, [phone, confirm]);
}

export async function clearPhone(phoneRaw: string, confirm: string) {
  if (confirm !== "מחק מספר") throw new Error("יש לאשר במדויק: מחק מספר");
  const phone = canonPhone(phoneRaw);
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM haim.requests WHERE id IN (SELECT request_id FROM haim.request_parties WHERE phone = $1)`,
      [phone],
    );
    await client.query(`DELETE FROM haim.deliveries WHERE phone = $1`, [phone]);
    await client.query(
      `DELETE FROM haim.messages WHERE contact_id IN (SELECT id FROM haim.contacts WHERE phone = $1)`,
      [phone],
    );
    await client.query(`DELETE FROM haim.contacts WHERE phone = $1`, [phone]);
    await client.query(`SELECT public.haim_log('warn','db_update',$1,NULL,NULL,NULL,'{"action":"clear_phone"}'::jsonb)`, [phone]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

export async function clearAll(confirm: string) {
  await query(`SELECT public.haim_clear_all($1)`, [confirm]);
}

export async function simulate(phoneRaw: string, text: string) {
  const phone = canonPhone(phoneRaw);
  if (!phone) throw new Error("מספר הטלפון אינו תקין");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const turn = await client.query<{ turn: { reply_text?: string } }>(
      `SELECT public.haim_apply_turn($1, $2, $3::jsonb, NULL) AS turn`,
      [
        `sim-${randomUUID()}`,
        phone,
        JSON.stringify({ phase: "full", session: "SIM", kind: "text", text, chat_id: `972${phone}@c.us`, commands: [] }),
      ],
    );
    await client.query("ROLLBACK");
    return turn.rows[0]?.turn?.reply_text || "הבוט עיבד את ההודעה ללא תשובה.";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
    throw new Error(dbError(error));
  } finally {
    client.release();
  }
}

export async function wahaStatus(sessionRaw?: string) {
  const session = allowedSession(sessionRaw);
  try {
    const response = await wahaFetch(`/api/sessions/${encodeURIComponent(session)}`);
    const body = (await response.json().catch(() => ({}))) as { status?: string; me?: { id?: string } };
    const status = body.status || "UNKNOWN";
    return { connected: response.ok && status === "WORKING", session, status, message: body.me?.id || "" };
  } catch (error) {
    return { connected: false, session, status: "UNAVAILABLE", message: error instanceof Error ? error.message : "WAHA אינו זמין" };
  }
}

export async function wahaReconnect(sessionRaw?: string) {
  const session = allowedSession(sessionRaw);
  const response = await wahaFetch("/api/sessions/start", {
    method: "POST",
    body: JSON.stringify({ name: session }),
  });
  if (!response.ok && response.status !== 422) throw new Error("לא ניתן להתחיל את סשן WhatsApp.");
  await query(`SELECT public.haim_log('info','agent_note', NULL, NULL, NULL, NULL, $1::jsonb)`, [
    JSON.stringify({ action: "reconnect_waha", session, started: response.ok }),
  ]);
  return { started: response.ok, session };
}

export async function wahaQr(sessionRaw?: string) {
  const session = allowedSession(sessionRaw);
  const paths = [`/api/${encodeURIComponent(session)}/auth/qr`, `/api/sessions/${encodeURIComponent(session)}/auth/qr`];
  for (const path of paths) {
    const response = await wahaFetch(path);
    if (!response.ok) continue;
    const contentType = response.headers.get("content-type") ?? "image/png";
    if (contentType.includes("json")) {
      const body = (await response.json().catch(() => ({}))) as { value?: string; data?: string };
      const value = body.value || body.data;
      if (value) return { data_url: value.startsWith("data:") ? value : `data:image/png;base64,${value}` };
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { data_url: `data:${contentType.split(";")[0]};base64,${bytes.toString("base64")}` };
    }
  }
  throw new Error("קוד ה־QR עדיין לא זמין. נסה לחבר מחדש ולרענן.");
}

export async function mediaPayload(id: string): Promise<{ bytes: Buffer; type: string } | { error: string }> {
  const rows = await query<{
    mime_type: string | null;
    waha_message_id: string | null;
    session: string;
    media: { url?: string; mimetype?: string } | null;
    chat_id: string | null;
  }>(
    `SELECT m.mime_type, m.waha_message_id, msg.session, msg.media, ci.chat_id
       FROM haim.media m
       JOIN haim.messages msg ON msg.id = m.message_id
       LEFT JOIN haim.contact_identities ci
         ON ci.session = msg.session AND ci.contact_id = msg.contact_id
      WHERE m.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return { error: "התמונה לא נמצאה" };
  const target = mediaUrl(row.media?.url, row.session, row.chat_id, row.waha_message_id);
  if (!target) {
    return { error: "אין כתובת מדיה שמורה. הסוכן צריך להעביר media.url מה־webhook של WAHA." };
  }
  const { key } = waha();
  if (!key) return { error: "חסר WAHA_API_KEY בשרת הניהול, אי אפשר להוריד את התמונה." };
  const response = await fetch(target, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(20000) });
  const type = response.headers.get("content-type") || row.mime_type || row.media?.mimetype || "";
  if (!response.ok || !type.startsWith("image/")) return { error: "הורדת התמונה מ־WAHA נכשלה" };
  return { bytes: Buffer.from(await response.arrayBuffer()), type: type.split(";")[0] || "image/jpeg" };
}

function mediaUrl(stored: string | undefined, session: string, chatId: string | null, messageId: string | null): string | null {
  const { base } = waha();
  if (stored) {
    try {
      const url = new URL(stored, base);
      if (url.pathname.startsWith("/api/")) {
        const allowed = new URL(base);
        if (url.host === allowed.host) return url.toString();
        return `${base}${url.pathname}${url.search}`;
      }
    } catch {
      /* stored value was not a URL */
    }
  }
  if (session && chatId && messageId) {
    return `${base}/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`;
  }
  return null;
}
