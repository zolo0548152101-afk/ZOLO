import { query } from "./db";
import { canonPhone } from "./phone";

export type LogRow = {
  id: string;
  ts: string;
  level: string;
  phone: string | null;
  conversation_id: string | null;
  request_id: string | null;
  waha_message_id: string | null;
  event: string;
  details: unknown;
};

export type LogFilters = {
  phone?: string;
  level?: string;
  event?: string;
  from?: string;
  to?: string;
  conversation?: string;
};

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const EVENTS = new Set([
  "inbound",
  "outbound",
  "db_update",
  "rejected_update",
  "escalation",
  "error",
  "agent_note",
]);

export async function loadLogs(filters: LogFilters): Promise<LogRow[]> {
  const phone = filters.phone ? canonPhone(filters.phone) ?? filters.phone.trim() : "";
  const level = filters.level && LEVELS.has(filters.level) ? filters.level : "";
  const event = filters.event && EVENTS.has(filters.event) ? filters.event : "";
  const conversation = filters.conversation?.trim() ?? "";
  return query<LogRow>(
    `SELECT id::text, ts, level, phone, conversation_id::text, request_id::text,
            waha_message_id, event, details
       FROM haim.logs
      WHERE ($1 = '' OR phone = $1)
        AND ($2 = '' OR level = $2)
        AND ($3 = '' OR event = $3)
        AND ($4 = '' OR ts >= ($4::timestamp AT TIME ZONE 'Asia/Jerusalem'))
        AND ($5 = '' OR ts <= ($5::timestamp AT TIME ZONE 'Asia/Jerusalem'))
        AND ($6 = '' OR conversation_id::text = $6)
      ORDER BY ts DESC
      LIMIT 300`,
    [phone, level, event, filters.from ?? "", filters.to ?? "", conversation],
  );
}
