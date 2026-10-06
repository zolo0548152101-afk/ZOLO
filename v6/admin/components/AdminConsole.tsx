"use client";

import { useEffect, useMemo, useState } from "react";
import { LogsPanel } from "./LogsPanel";

type Row = Record<string, unknown>;
type TablePayload = {
  table: string;
  label: string;
  columns: string[];
  editable: string[];
  pk: string[];
  types: Record<string, string>;
  options: Record<string, string[]>;
  rows: Row[];
};

const LABELS: Record<string, string> = {
  number: "מספר פנייה", status: "סטטוס", donor_phone: "טלפון מוסר", donor_name: "שם מוסר",
  pickup_city: "יישוב איסוף", pickup_address: "כתובת איסוף", pickup_floor: "קומת איסוף",
  receiver_phone: "טלפון מקבל", receiver_name: "שם מקבל", destination_city: "יישוב יעד",
  destination_address: "כתובת יעד", destination_floor: "קומת יעד", items: "פריטים",
  item_description: "תיאור פריט", quantity: "כמות", needs_disassembly: "נדרש פירוק",
  requested_date: "תאריך מבוקש", preferred_time: "שעה מועדפת", run_date: "תאריך הובלה שאושר",
  proposed_run_date: "מועד מוצע — ממתין לאישור", donor_schedule_approved_date: "אישור מועד המוסר",
  receiver_schedule_approved_date: "אישור מועד המקבל", represents_both_parties: "אותו אדם משני הצדדים",
  closed_at: "נסגר בתאריך", human_reason: "סיבת טיפול אנושי", donor_approved: "המוסר אישר השתתפות",
  receiver_approved: "המקבל אישר השתתפות", photos: "מספר תמונות", media_ids: "תמונות להורדה",
  locations: "מיקומים שנשלחו", created_at: "נוצר בתאריך", updated_at: "עודכן בתאריך",
  phone: "טלפון", kind: "סוג הודעה", text: "תוכן", body: "תוכן", reply: "תשובת הבוט",
  error_code: "קוד שגיאה", received_at: "התקבל בתאריך", mode: "מצב שיחה", session: "סשן",
  chat_id: "מזהה צ׳אט", selected_request_id: "פנייה נבחרת", version: "גרסה", state: "מצב שליחה",
  seq: "מספר", media_id: "תמונה", location: "מיקום", provider_id: "מזהה ספק",
};
const STATUS: Record<string, string> = {
  collecting: "בהשלמת פרטים", available: "ממתינה למקבל", awaiting_approval: "ממתינה לאישור",
  waiting_capacity: "ממתינה למקום בהובלה", coordinated: "תואמה", human: "בטיפול אנושי",
  cancel_pending: "ממתינה להחלטה לאחר ביטול", cancelled: "בוטלה", closed: "הושלמה", rejected: "לא מתאימה",
};

function stamp(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const n = (part: number) => String(part).padStart(2, "0");
  return `${n(date.getDate())}/${n(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)} ${n(date.getHours())}:${n(date.getMinutes())}`;
}

function show(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "status") return STATUS[String(value)] ?? String(value);
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if (typeof value === "object") return JSON.stringify(value);
  if (/(_at|_date)$/.test(key) || ["created_at", "updated_at", "closed_at", "received_at"].includes(key)) return stamp(value);
  return String(value);
}

async function call(body: Record<string, unknown>) {
  const response = await fetch("/api/console", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string }; reply?: string; data_url?: string; connected?: boolean; status?: string; message?: string; rows?: Row[]; media?: Row[]; locations?: Row[]; phone?: string };
  if (!response.ok) throw new Error(json.error?.message || "הפעולה נכשלה");
  return json;
}

export function AdminConsole({ openPhone = "" }: { openPhone?: string }) {
  const [notice, setNotice] = useState("הדף מחובר עם עוגייה חתומה. הסיסמה לא נשמרת בדפדפן.");
  const [kind, setKind] = useState("");
  const [metrics, setMetrics] = useState({ pending: "—", outbound: "—", queues: "—", ai: "—" });
  const [requests, setRequests] = useState<Row[]>([]);
  const [uncertain, setUncertain] = useState<Row[]>([]);
  const [accessMode, setAccessMode] = useState("open");
  const [allowlist, setAllowlist] = useState("");
  const [session, setSession] = useState("HAIM_YAHAD");
  const [wahaText, setWahaText] = useState("התחבר כדי לבדוק את מצב החיבור.");
  const [wahaOk, setWahaOk] = useState("");
  const [qr, setQr] = useState("");
  const [chat, setChat] = useState<{ text: string; who: "me" | "bot" }[]>([]);
  const [simPhone, setSimPhone] = useState("584152101");
  const [simText, setSimText] = useState("");
  const [resetPhone, setResetPhone] = useState("");
  const [tables, setTables] = useState<{ name: string; label: string }[]>([]);
  const [table, setTable] = useState("requests");
  const [payload, setPayload] = useState<TablePayload | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("");
  const [sortDir, setSortDir] = useState(1);
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [threadPhone, setThreadPhone] = useState("");
  const [threadRows, setThreadRows] = useState<Row[]>([]);
  const [direct, setDirect] = useState("");
  const [files, setFiles] = useState<{ media: Row[]; locations: Row[] } | null>(null);

  function say(text: string, next = "") {
    setNotice(text);
    setKind(next);
  }

  async function refresh() {
    say("טוען נתונים…");
    const response = await fetch("/api/console", { cache: "no-store" });
    const json = await response.json();
    if (!response.ok) return say(json.error?.message || "הטעינה נכשלה", "error");
    setMetrics({
      pending: String(json.metrics.pending),
      outbound: String(json.metrics.outbound),
      queues: String(json.metrics.queues),
      ai: String(json.metrics.ai),
    });
    setRequests(json.requests || []);
    setUncertain(json.uncertain || []);
    setAccessMode(json.access?.mode || "open");
    setAllowlist((json.access?.phones || []).join("\n"));
    setTables(json.tables || []);
    say("עודכן עכשיו", "ok");
  }

  async function loadDb(next = table) {
    const response = await fetch(`/api/console?table=${encodeURIComponent(next)}`, { cache: "no-store" });
    const json = await response.json();
    if (!response.ok) return say(json.error?.message || "טעינת המסד נכשלה", "error");
    setPayload(json as TablePayload);
    setPage(1);
    say("רשומות המסד נטענו", "ok");
  }

  async function openThread(phone: string) {
    try {
      const json = await call({ action: "thread", phone });
      setThreadPhone(json.phone || phone);
      setThreadRows(json.rows || []);
    } catch (error) {
      say(error instanceof Error ? error.message : "טעינת ההתכתבות נכשלה", "error");
    }
  }

  useEffect(() => {
    void refresh();
    void loadDb("requests");
    if (openPhone) void openThread(openPhone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const rows = payload?.rows ?? [];
    const term = search.trim().toLocaleLowerCase();
    let next = rows.filter((row) => !term || Object.values(row).some((value) => String(value ?? "").toLocaleLowerCase().includes(term)));
    if (sortKey) {
      next = [...next].sort((a, b) => String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), "he", { numeric: true }) * sortDir);
    }
    return next;
  }, [payload, search, sortKey, sortDir]);
  const pages = Math.max(1, Math.ceil(visible.length / 20));
  const slice = visible.slice((Math.min(page, pages) - 1) * 20, Math.min(page, pages) * 20);

  function keysOf(row: Row): Record<string, unknown> {
    const keys: Record<string, unknown> = {};
    for (const key of payload?.pk ?? ["id"]) keys[key] = row[key];
    return keys;
  }

  function beginEdit(row: Row) {
    const next: Record<string, string> = {};
    for (const key of payload?.editable ?? []) {
      const value = key === "item_description" ? String(row.items ?? "").split(",")[0] : row[key];
      next[key] = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    setDraft(next);
    setEdit(row);
  }

  async function saveEdit() {
    if (!payload || !edit) return;
    const changes: Record<string, unknown> = {};
    for (const key of payload.editable) {
      const previous = key === "item_description" ? String(edit.items ?? "").split(",")[0]?.trim() : edit[key];
      const current = draft[key] ?? "";
      const prevText = previous === null || previous === undefined ? "" : typeof previous === "object" ? JSON.stringify(previous) : String(previous);
      if (current !== prevText) changes[key] = current;
    }
    if (!Object.keys(changes).length) {
      setEdit(null);
      return;
    }
    if (!window.confirm("לשמור את השינויים שבחרת?")) return;
    try {
      await call({ action: "update-row", table: payload.table, keys: keysOf(edit), changes });
      setEdit(null);
      await loadDb();
      say("הרשומה עודכנה", "ok");
    } catch (error) {
      say(error instanceof Error ? error.message : "העדכון נכשל", "error");
    }
  }

  async function removeRow(row: Row) {
    if (!payload) return;
    if (!window.confirm("למחוק את הרשומה? פעולה זו אינה ניתנת לביטול.")) return;
    try {
      await call({ action: "delete-row", table: payload.table, keys: keysOf(row) });
      await loadDb();
      say("הרשומה נמחקה", "ok");
    } catch (error) {
      say(error instanceof Error ? error.message : "המחיקה נכשלה", "error");
    }
  }

  async function copyLocation(value: unknown) {
    const data = typeof value === "string" ? JSON.parse(value) : value;
    const text = data && typeof data === "object" && "latitude" in (data as Row)
      ? `${(data as Row).latitude}, ${(data as Row).longitude}`
      : String(value);
    try {
      await navigator.clipboard.writeText(text);
      say("המיקום הועתק", "ok");
    } catch {
      say("לא ניתן להעתיק את המיקום", "error");
    }
  }

  async function download(id: string) {
    const response = await fetch(`/api/media/${id}`);
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.startsWith("image/")) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || "הורדת התמונה נכשלה");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "image";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div>
      <div className={`notice ${kind}`}>{notice}</div>
      <div className="actions" style={{ marginTop: 0 }}>
        <button type="button" className="secondary" onClick={() => void refresh()}>רענן נתונים</button>
      </div>
      <section className="grid" id="metrics">
        <div className="card metric"><span>תיבת כניסה ממתינה</span><b>{metrics.pending}</b></div>
        <div className="card metric"><span>הודעות יוצאות</span><b>{metrics.outbound}</b></div>
        <div className="card metric"><span>תורי עבודה</span><b>{metrics.queues}</b></div>
        <div className="card metric"><span>קריאות AI</span><b>{metrics.ai}</b></div>
      </section>
      <p className="hint">תורי העבודה הם 0: בגרסה 6 אין pg-boss. קריאות AI הן אירועי agent_note ביומן.</p>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>חיבור WhatsApp</h2>
        <label>סשן לחיבור
          <select id="waha-session" value={session} onChange={(event) => setSession(event.target.value)}>
            <option value="HAIM_YAHAD">HAIM_YAHAD</option>
            <option value="default">default</option>
            <option value="TAL_ZOLO">TAL_ZOLO</option>
          </select>
        </label>
        <div className={`notice ${wahaOk}`}>{wahaText}</div>
        <div className="actions">
          <button className="secondary" type="button" onClick={() => void call({ action: "waha-status", session }).then((json) => {
            setWahaText(json.connected ? `מחובר · ${json.status}` : `מנותק · ${json.status || "לא זמין"}${json.message ? ` · ${json.message}` : ""}`);
            setWahaOk(json.connected ? "ok" : "error");
          }).catch((error) => { setWahaText(error.message); setWahaOk("error"); })}>בדוק חיבור</button>
          <button type="button" onClick={() => void call({ action: "waha-reconnect", session }).then(() => say("בקשת חיבור מחדש נשלחה", "ok")).catch((error) => say(error.message, "error"))}>חבר מחדש</button>
          <button className="secondary" type="button" onClick={() => void call({ action: "waha-qr", session }).then((json) => { if (!json.data_url) throw new Error("QR עדיין לא זמין"); setQr(json.data_url); say("קוד QR נטען", "ok"); }).catch((error) => say(error.message, "error"))}>הצג QR</button>
        </div>
        {qr ? <div style={{ marginTop: 12, textAlign: "center" }}><img src={qr} alt="קוד QR לחיבור WhatsApp" style={{ maxWidth: 280, background: "white", padding: 10, borderRadius: 10 }} /><div className="hint">סרוק את הקוד מתוך WhatsApp בטלפון. לאחר הסריקה לחץ על בדוק חיבור.</div></div> : null}
      </section>

      <section className="two">
        <div className="card">
          <h2>רשומות הובלות</h2>
          <div className="hint">כל הובלה נשמרת במסד הנתונים ומופיעה כאן.</div>
          <div className="table">
            <table>
              <thead><tr><th>#</th><th>סטטוס</th><th>פריטים</th><th>מוסר ← מקבל</th><th>תאריך</th></tr></thead>
              <tbody>
                {requests.length === 0 ? <tr><td colSpan={5}>אין נתונים</td></tr> : requests.map((row) => (
                  <tr key={String(row.number)}>
                    <td>{String(row.number)}</td>
                    <td>{String(row.status)}</td>
                    <td>{String(row.items || "—")}</td>
                    <td>{String(row.donor_name || row.donor_phone || "—")} ← {String(row.receiver_name || row.receiver_phone || "—")}</td>
                    <td>{String(row.run_date || (row.proposed_run_date ? `מוצע — ממתין לאישור: ${row.proposed_run_date}` : "—"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>תור הודעות לא ודאיות</h2>
          <div className="table">
            <table>
              <thead><tr><th>טלפון</th><th>מצב</th><th>שגיאה</th></tr></thead>
              <tbody>
                {uncertain.length === 0 ? <tr><td colSpan={3}>אין נתונים</td></tr> : uncertain.map((row) => (
                  <tr key={String(row.id)}><td><button className="secondary" type="button" onClick={() => void openThread(String(row.phone))}>{String(row.phone)}</button></td><td>{String(row.state)}</td><td>{String(row.error_code || "—")}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="two" id="chat">
        <div className="card">
          <h2>סימולציית צ׳אט</h2>
          <div className="hint">ההודעה רצה על כללי ה־SQL בתוך עסקה שמבוטלת. היא לא נשמרת ולא נשלחת ל־WhatsApp. אין מנוע שפה מקומי.</div>
          <div className="chat">
            {chat.length === 0 ? <div className="hint">כתוב הודעה כדי לדבר עם הבוט.</div> : chat.map((item, index) => <div key={index} className={`bubble ${item.who}`}>{item.text}</div>)}
          </div>
          <form className="form" onSubmit={(event) => {
            event.preventDefault();
            const text = simText;
            setChat((items) => [...items, { text, who: "me" }]);
            setSimText("");
            say("הבוט חושב…");
            void call({ action: "simulate", phone: simPhone, text }).then((json) => {
              setChat((items) => [...items, { text: json.reply || "הבוט עיבד את ההודעה ללא תשובה.", who: "bot" }]);
              say("הסימולציה הושלמה", "ok");
            }).catch((error) => {
              setChat((items) => [...items, { text: `לא התקבלה תשובה: ${error.message}`, who: "bot" }]);
              say(error.message, "error");
            });
          }}>
            <input value={simPhone} onChange={(event) => setSimPhone(event.target.value)} inputMode="numeric" placeholder="טלפון לדוגמה, למשל 584152101" required />
            <textarea value={simText} onChange={(event) => setSimText(event.target.value)} rows={3} placeholder="כתוב הודעה לבוט…" required />
            <button type="submit">שלח לבוט</button>
          </form>
        </div>
        <div className="card" id="access">
          <h2>גישת בוט</h2>
          <div className="radios">
            <label><input type="radio" name="access" checked={accessMode === "open"} onChange={() => setAccessMode("open")} /> פתוח לכולם</label>
            <label><input type="radio" name="access" checked={accessMode === "allowlist"} onChange={() => setAccessMode("allowlist")} /> פתוח רק למספרים שאגדיר</label>
          </div>
          <label>מספרים מורשים
            <textarea value={allowlist} onChange={(event) => setAllowlist(event.target.value)} rows={5} placeholder="מספר אחד בכל שורה או מופרד בפסיקים" />
          </label>
          <div className="hint">מספר חסום אינו מקבל תגובה מהבוט.</div>
          <div className="actions">
            <button type="button" onClick={() => void call({ action: "access", mode: accessMode, phones: allowlist.split(/[\s,]+/).filter(Boolean) }).then(() => say("הגדרת הגישה נשמרה", "ok")).catch((error) => say(error.message, "error"))}>שמור הגדרת גישה</button>
          </div>
          <hr />
          <h2>איפוס שיחה</h2>
          <input value={resetPhone} onChange={(event) => setResetPhone(event.target.value)} inputMode="numeric" placeholder="מספר טלפון לאיפוס" />
          <div className="actions">
            <button className="secondary" type="button" onClick={() => {
              if (!resetPhone.trim()) return say("יש להזין מספר טלפון", "error");
              if (!window.confirm(`לאפס את זיכרון השיחה עבור ${resetPhone}? רשומות ההובלה לא יימחקו.`)) return;
              void call({ action: "reset-one", phone: resetPhone }).then(() => say("השיחה אופסה", "ok")).catch((error) => say(error.message, "error"));
            }}>אפס שיחה למספר</button>
            <button className="danger" type="button" onClick={() => {
              if (!window.confirm("לאפס את זיכרון הבוט לכל המשתמשים? רשומות ההובלה יישמרו.")) return;
              void call({ action: "reset-all" }).then(() => say("זיכרון הבוט אופס לכל המשתמשים", "ok")).catch((error) => say(error.message, "error"));
            }}>אפס את כל זיכרון הבוט</button>
          </div>
          <div className="hint">הפעולה מתחילה שיחה חדשה; רשומות ההובלות וההיסטוריה נשמרות.</div>
          <hr />
          <h2>ביטול פניות</h2>
          <div className="hint">מוחק את הפניות של המספר ואת ההודעות שלו. יש להקליד בדיוק: בטל פניות</div>
          <button className="danger" type="button" onClick={() => {
            const phone = window.prompt("מספר לביטול פניות");
            if (!phone) return;
            const confirmText = window.prompt("פעולה בלתי הפיכה. להקליד בדיוק: בטל פניות");
            if (confirmText !== "בטל פניות") return say("הביטול בוטל", "error");
            void call({ action: "cancel-phone", phone, confirm: confirmText }).then(() => { say("הפניות בוטלו", "ok"); void refresh(); }).catch((error) => say(error.message, "error"));
          }}>בטל פניות</button>
        </div>
      </section>

      <section className="two">
        <div className="card">
          <h2>תורים שנכשלו</h2>
          <div className="hint">בגרסה 6 אין תור pg-boss, ולכן אין עבודות שנכשלו ואין ניסיון חוזר.</div>
          <div className="table"><table><thead><tr><th>תור</th><th>ניסיונות</th><th>מזהה</th></tr></thead><tbody><tr><td colSpan={3}>אין נתונים</td></tr></tbody></table></div>
        </div>
      </section>

      <section className="card" id="database" style={{ marginTop: 14 }}>
        <h2>מסד הנתונים</h2>
        <div className="hint">צפייה, עריכה ומחיקה של רשומות. סיסמאות ומסוף SQL אינם חשופים בדף. נטענות עד 500 רשומות, 20 בעמוד.</div>
        <div className="actions">
          <select value={table} onChange={(event) => setTable(event.target.value)}>
            {tables.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
          </select>
          <button type="button" onClick={() => void loadDb()}>טען רשומות</button>
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="חיפוש בכל העמודות…" aria-label="חיפוש בכל העמודות" />
        </div>
        <div className="table db-table-wrap">
          <table>
            <thead>
              <tr>
                {(payload?.columns ?? []).map((key) => (
                  <th key={key} style={{ cursor: "pointer" }} title="לחץ למיון" onClick={() => { setSortDir(sortKey === key ? -sortDir : 1); setSortKey(key); }}>{LABELS[key] || key}</th>
                ))}
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {slice.length === 0 ? <tr><td colSpan={(payload?.columns.length ?? 0) + 1}>אין רשומות</td></tr> : slice.map((row, index) => (
                <tr key={index}>
                  {(payload?.columns ?? []).map((key) => (
                    <td key={key}>
                      {["phone", "donor_phone", "receiver_phone"].includes(key) && row[key] ? (
                        <button className="secondary" type="button" onClick={() => void openThread(String(row[key]))}>{String(row[key])}<br />צפה בשיחה</button>
                      ) : key === "media_ids" ? (
                        Array.isArray(row[key]) && (row[key] as unknown[]).length
                          ? (row[key] as string[]).map((id) => <span key={id}><button className="secondary" type="button" onClick={() => void download(String(id)).catch((error) => say(error.message, "error"))}>הורד תמונה</button><br /></span>)
                          : "—"
                      ) : key === "media_id" && row[key] ? (
                        <button className="secondary" type="button" onClick={() => void download(String(row[key])).catch((error) => say(error.message, "error"))}>הורד תמונה</button>
                      ) : key === "locations" ? (
                        Array.isArray(row[key]) && (row[key] as unknown[]).length
                          ? (row[key] as Row[]).map((location, locationIndex) => <span key={locationIndex}><button className="secondary" type="button" onClick={() => void copyLocation(location)}>העתק מיקום {locationIndex + 1}</button><br /></span>)
                          : "—"
                      ) : key === "location" && row[key] ? (
                        <button className="secondary" type="button" onClick={() => void copyLocation(row[key])}>העתק מיקום</button>
                      ) : show(key, row[key])}
                    </td>
                  ))}
                  <td>
                    <button className="secondary" type="button" onClick={() => beginEdit(row)}>עריכת שדות</button>{" "}
                    <button className="danger" type="button" onClick={() => void removeRow(row)}>מחק</button>
                    {payload?.table === "requests" ? <><br /><button className="secondary" type="button" onClick={() => void call({ action: "files", id: row.id }).then((json) => setFiles({ media: json.media || [], locations: json.locations || [] })).catch((error) => say(error.message, "error"))}>תמונות ומיקומים</button></> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button className="secondary" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>הקודם</button>
          <span>עמוד {Math.min(page, pages)} מתוך {pages} · {visible.length} רשומות</span>
          <button className="secondary" type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>הבא</button>
        </div>
        <div className="actions">
          <button className="danger" type="button" onClick={() => {
            const phone = window.prompt("הזן מספר למחיקת כל הנתונים הקשורים אליו");
            if (!phone?.trim()) return;
            const confirmText = window.prompt("פעולה בלתי הפיכה. להקליד בדיוק: מחק מספר");
            if (confirmText !== "מחק מספר") return say("המחיקה בוטלה", "error");
            if (!window.confirm(`למחוק לצמיתות את כל נתוני המספר ${phone}?`)) return;
            void call({ action: "clear-phone", phone, confirm: confirmText }).then(() => { say("נתוני המספר נמחקו", "ok"); void refresh(); void loadDb(); }).catch((error) => say(error.message, "error"));
          }}>מחק נתוני מספר</button>
          <button className="danger" type="button" onClick={() => {
            const confirmText = window.prompt("פעולה בלתי הפיכה. להקליד בדיוק: מחק הכל");
            if (confirmText !== "מחק הכל") return say("המחיקה בוטלה", "error");
            void call({ action: "clear-all", confirm: confirmText }).then(() => { say("כל הרשומות נמחקו", "ok"); void refresh(); void loadDb(); }).catch((error) => say(error.message, "error"));
          }}>מחק את כל הרשומות</button>
        </div>
        <div className="hint">מחק הכל מוחק נתונים תפעוליים ויומן. הגדרות מערכת ורשימות יישובים נשארות. מונה הפניות עצמו לא נמחק כשורה.</div>
      </section>

      <section className="card" id="logs" style={{ marginTop: 14 }}>
        <h2>יומן</h2>
        <div className="hint">סינון לפי טלפון, רמה, אירוע וטווח זמן. רענון אוטומטי כל 5 שניות. ציר זמן נפתח לפי שיחה.</div>
        <LogsPanel />
      </section>

      {edit && payload ? (
        <div className="modal-back">
          <div className="card modal">
            <h2>{payload.table === "requests" ? "עריכת פרטי פנייה" : "עריכת רשומה — כל השדות"}</h2>
            <div className="form">
              {payload.editable.map((key) => (
                <label key={key}>{LABELS[key] || key}
                  {payload.options[key] ? (
                    <select value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}>
                      {payload.options[key].map((option) => <option key={option} value={option}>{STATUS[option] || option}</option>)}
                    </select>
                  ) : payload.types[key] === "boolean" ? (
                    <select value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}>
                      <option value="">לא צוין</option>
                      <option value="true">כן</option>
                      <option value="false">לא</option>
                    </select>
                  ) : payload.types[key] === "date" ? (
                    <input type="date" value={(draft[key] ?? "").slice(0, 10)} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                  ) : payload.types[key] === "json" ? (
                    <textarea rows={3} value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                  ) : (
                    <input value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                  )}
                </label>
              ))}
            </div>
            <div className="actions">
              <button type="button" onClick={() => void saveEdit()}>שמור שינויים</button>
              <button className="secondary" type="button" onClick={() => setEdit(null)}>ביטול</button>
            </div>
          </div>
        </div>
      ) : null}

      {threadPhone ? (
        <div className="modal-back">
          <div className="card modal">
            <h2>כל ההתכתבות עם {threadPhone}</h2>
            <div className="chat">
              {threadRows.length === 0 ? "אין הודעות שמורות" : threadRows.map((row, index) => (
                <div key={index} className="bubble me">
                  {stamp(row.received_at)} · {String(row.kind || "הודעה")}{"\n"}{String(row.text || "")}
                  {row.reply ? `\nתשובת הבוט: ${String(row.reply)}` : ""}
                  {row.media_id ? <div><button className="secondary" type="button" onClick={() => void download(String(row.media_id)).catch((error) => say(error.message, "error"))}>הורד תמונה</button></div> : null}
                  {row.location ? <div><button className="secondary" type="button" onClick={() => void copyLocation(row.location)}>העתק מיקום</button></div> : null}
                </div>
              ))}
            </div>
            <form className="actions" onSubmit={(event) => {
              event.preventDefault();
              void call({ action: "send", phone: threadPhone, text: direct }).then(() => { setDirect(""); say("ההודעה נשלחה", "ok"); }).catch((error) => say(error.message, "error"));
            }}>
              <textarea rows={2} required placeholder="כתוב הודעה ישירה ל־WhatsApp…" value={direct} onChange={(event) => setDirect(event.target.value)} />
              <button type="submit">שלח הודעה</button>
              <button className="secondary" type="button" onClick={() => setThreadPhone("")}>סגור</button>
            </form>
          </div>
        </div>
      ) : null}

      {files ? (
        <div className="modal-back">
          <div className="card modal">
            <h2>תמונות ומיקומים</h2>
            <div>{files.media.length ? "תמונות שמורות:" : "אין תמונות"}</div>
            {files.media.map((item) => <div key={String(item.id)}><button className="secondary" type="button" onClick={() => void download(String(item.id)).catch((error) => say(error.message, "error"))}>הורד תמונה</button></div>)}
            <div style={{ marginTop: 14 }}>{files.locations.length ? "מיקומים שנשלחו:" : "אין מיקומים שמורים"}</div>
            {files.locations.map((item) => <div key={String(item.role)}><button className="secondary" type="button" onClick={() => void copyLocation(item)}>העתק מיקום {String(item.role)}</button></div>)}
            <div className="actions"><button className="secondary" type="button" onClick={() => setFiles(null)}>סגור</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
