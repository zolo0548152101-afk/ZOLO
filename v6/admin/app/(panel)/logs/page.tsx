import { LogsLive } from "@/components/LogsLive";
import { loadLogs } from "@/lib/logs";

const levels = ["", "debug", "info", "warn", "error"];
const events = ["", "inbound", "outbound", "db_update", "rejected_update", "escalation", "error", "agent_note"];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = {
    phone: one(params.phone),
    level: one(params.level),
    event: one(params.event),
    from: one(params.from),
    to: one(params.to),
    conversation: one(params.conversation),
  };
  const rows = await loadLogs(filters);
  const query = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();

  return (
    <div className="stack">
      <div>
        <h1>יומן</h1>
        <p className="sub">
          {filters.conversation
            ? "ציר זמן של שיחה אחת, מהחדש לישן."
            : "סינון לפי טלפון, רמה, אירוע וטווח זמן. השעה לפי ירושלים."}
        </p>
      </div>
      <form className="card filters" method="get">
        <label>
          טלפון
          <input name="phone" defaultValue={filters.phone} inputMode="tel" placeholder="052…" />
        </label>
        <label>
          רמה
          <select name="level" defaultValue={filters.level}>
            {levels.map((level) => <option key={level || "all"} value={level}>{level || "הכול"}</option>)}
          </select>
        </label>
        <label>
          אירוע
          <select name="event" defaultValue={filters.event}>
            {events.map((event) => <option key={event || "all"} value={event}>{event || "הכול"}</option>)}
          </select>
        </label>
        <label>
          מ־
          <input type="datetime-local" name="from" defaultValue={filters.from} />
        </label>
        <label>
          עד
          <input type="datetime-local" name="to" defaultValue={filters.to} />
        </label>
        <input type="hidden" name="conversation" value={filters.conversation} />
        <button type="submit">סנן</button>
        <a className="button secondary" href="/logs">נקה</a>
      </form>
      <LogsLive initial={rows} query={query ? `?${query}` : ""} />
    </div>
  );
}

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
