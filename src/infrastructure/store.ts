import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  AppError,
  type Request,
  type Party,
  type Item,
  type Context,
  type Incoming,
  type Conversation,
  type Candidate,
  type Notice,
  type Mode,
  type RequestLocation,
  type VerificationState,
} from "../domain/types.js";
import {
  ACTIVE,
  canonicalPhone,
  isOperationsAlert,
  DEFAULT_TRANSPORT_CAPACITY,
  MAX_TRANSPORT_CAPACITY,
  norm,
  nextTuesday,
  readyToCoordinate,
} from "../domain/policies.js";
import { tx } from "../db/pool.js";
import type { Config } from "../config.js";
import { Queue } from "./queue.js";
import type { ParsedMessage } from "./webhook.js";
import type { StoredMedia } from "./media.js";
type DB = pg.Pool | pg.PoolClient;
export interface Outbound {
  id: string;
  seq: string;
  phone: string;
  chat_id: string;
  text: string;
  media_id: string | null;
  match_id: string | null;
  state: string;
  mode: Mode;
  trace_id: string;
  job_id: string | null;
  format_state: "ready" | "pending" | "failed";
}
export interface BotAccess {
  mode: "open" | "allowlist";
  phones: string[];
}
export class Store {
  constructor(
    readonly pool: pg.Pool,
    readonly queue: Queue,
    readonly config: Config,
  ) {}
  async transaction<T>(f: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return tx(this.pool, f);
  }
  async contact(c: DB, phone: string): Promise<string> {
    const p = canonicalPhone(phone);
    const r = await c.query<{ id: string }>(
      "INSERT INTO contacts(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id",
      [p],
    );
    return r.rows[0]!.id;
  }
  async ingest(
    p: ParsedMessage,
    mode: Mode = this.config.BOT_MODE,
    captured?: StoredMedia,
  ): Promise<{ id: string; duplicate: boolean; trace_id: string }> {
    return this.transaction(async (c) => {
      // A short DB-only admission lock makes accepted sequence order unambiguous,
      // including concurrent webhook requests. Never held across network I/O.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `admit:${this.config.DB_SCHEMA}:${this.config.WAHA_SESSION}`,
      ]);
      const r = await c.query<{ id: string; trace_id: string }>(
        `INSERT INTO messages(session,external_id,trace_id,mode,chat_id,kind,text,contacts,location,media_url,media_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(channel,session,external_id) DO NOTHING RETURNING id,trace_id`,
        [
          this.config.WAHA_SESSION,
          p.external_id,
          randomUUID(),
          mode,
          p.chat_id,
          p.kind,
          p.text,
          JSON.stringify(p.contacts),
          p.location ? JSON.stringify(p.location) : null,
          p.media_url,
          ["image", "voice"].includes(p.kind) ? "pending" : "none",
        ],
      );
      if (!r.rows[0]) {
        const prev = await c.query<{ id: string; trace_id: string }>(
          "SELECT id,trace_id FROM messages WHERE channel=$1 AND session=$2 AND external_id=$3",
          ["whatsapp", this.config.WAHA_SESSION, p.external_id],
        );
        return { ...prev.rows[0]!, duplicate: true };
      }
      const message = r.rows[0];
      if (captured) {
        const mediaId = randomUUID();
        await c.query(
          "INSERT INTO media(id,message_id,storage_key,checksum,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6)",
          [
            mediaId,
            message.id,
            captured.key,
            captured.checksum,
            captured.mime,
            captured.size,
          ],
        );
        await c.query(
          "UPDATE messages SET media_state='ready',media_id=$2,media_url=NULL WHERE id=$1",
          [message.id, mediaId],
        );
      }
      await this.queue.send(
        c,
        "ingest",
        { id: message.id },
        this.config.WAHA_SESSION,
      );
      if (!captured && ["image", "voice"].includes(p.kind))
        await this.queue.send(c, "capture", { id: message.id }, message.id);
      return { ...message, duplicate: false };
    });
  }
  async message(
    id: string,
    c: DB = this.pool,
    lock = false,
  ): Promise<Incoming> {
    const r = await c.query<Incoming>(
      `SELECT m.id,m.seq::text,m.external_id,m.trace_id,m.mode,m.chat_id,co.phone,m.kind,m.text,m.contacts,m.location,m.media_url,m.media_id,m.media_state,m.transcript,m.processed_at::text,m.ai_plan
      FROM messages m LEFT JOIN contacts co ON co.id=m.contact_id WHERE m.id=$1 ${lock ? "FOR UPDATE OF m" : ""}`,
      [id],
    );
    if (!r.rows[0]) throw new AppError("message_not_found", 404);
    return r.rows[0];
  }
  async request(id: string, c: DB = this.pool, lock = false): Promise<Request> {
    const base = await c.query<
      Omit<Request, "parties" | "items" | "photo_ids">
    >(
      `SELECT id,number::int,version,status,origin,verification_contacted,run_date::text,proposed_run_date::text,earliest_run_date::text,preferred_time,represents_both_parties,closed_at::text,human_reason,created_at::text FROM requests WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    if (!base.rows[0]) throw new AppError("request_not_found", 404);
    const parties = await c.query<Party>(
      `SELECT p.role,co.phone,p.name,p.settlement,p.address,p.floor,p.floor_note_shown,p.approved_at::text,ap.phone AS approved_by,(p.schedule_approved_date::date=COALESCE(r.proposed_run_date,r.run_date)::date AND p.schedule_approved_date IS NOT NULL) AS schedule_approved,p.schedule_approved_date::text,p.schedule_approved_at::text FROM request_parties p JOIN requests r ON r.id=p.request_id JOIN contacts co ON co.id=p.contact_id LEFT JOIN contacts ap ON ap.id=p.approved_by WHERE p.request_id=$1 ORDER BY role`,
      [id],
    );
    const items = await c.query<Item>(
      "SELECT kind,description,quantity,free,working,needs_disassembly,wardrobe_small_whole,oven_type,evacuation FROM request_items WHERE request_id=$1 ORDER BY position",
      [id],
    );
    const media = await c.query<{ media_id: string }>(
      "SELECT rm.media_id FROM request_media rm JOIN media m ON m.id=rm.media_id WHERE rm.request_id=$1 AND m.mime_type LIKE $2 ORDER BY m.created_at",
      [id, "image/%"],
    );
    const locations = await c.query<RequestLocation>(
      "SELECT role,latitude::float,longitude::float,captured_at::text FROM request_locations WHERE request_id=$1 ORDER BY role",
      [id],
    );
    const verification = await c.query<VerificationState>(
      "SELECT role,state FROM request_verifications WHERE request_id=$1 ORDER BY role",
      [id],
    );
    return {
      ...base.rows[0],
      parties: parties.rows,
      items: items.rows,
      photo_ids: media.rows.map((r) => r.media_id),
      locations: locations.rows,
      verification_states: verification.rows,
    };
  }
  async active(phone: string, c: DB = this.pool): Promise<Request[]> {
    const ids = await c.query<{ id: string }>(
      `SELECT DISTINCT r.id,r.number FROM requests r JOIN request_parties p ON p.request_id=r.id JOIN contacts co ON co.id=p.contact_id WHERE co.phone=$1 AND r.status=ANY($2) ORDER BY r.number`,
      [phone, [...ACTIVE]],
    );
    const list: Request[] = [];
    for (const r of ids.rows) list.push(await this.request(r.id, c));
    return list;
  }
  async botAccess(c: DB = this.pool): Promise<BotAccess> {
    const row = await c.query<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key='bot_access'",
    );
    const value = row.rows[0]?.value;
    if (
      !value ||
      typeof value !== "object" ||
      !("mode" in value) ||
      (value.mode !== "open" && value.mode !== "allowlist") ||
      !("phones" in value) ||
      !Array.isArray(value.phones) ||
      !value.phones.every((phone) => typeof phone === "string")
    )
      return { mode: "open", phones: [] };
    return { mode: value.mode, phones: value.phones };
  }
  async allowed(phone: string, c: DB = this.pool): Promise<boolean> {
    const access = await this.botAccess(c);
    return access.mode === "open" || access.phones.includes(phone);
  }
  async candidates(phone: string, c: DB = this.pool): Promise<Candidate[]> {
    const ids = await c.query<{
      id: string;
      match_id: string | null;
      state: Candidate["state"];
    }>(
      `SELECT r.id,m.id AS match_id,m.state FROM requests r
      JOIN request_items i ON i.request_id=r.id JOIN searches s ON s.kind=i.kind
      JOIN contacts co ON co.id=s.contact_id LEFT JOIN matches m ON m.request_id=r.id AND m.contact_id=co.id
      WHERE co.phone=$1 AND s.state='active' AND r.status IN ('collecting','available','awaiting_approval')
        AND NOT EXISTS(SELECT 1 FROM request_parties p WHERE p.request_id=r.id AND p.role='receiver')
        AND NOT EXISTS(SELECT 1 FROM request_parties p WHERE p.request_id=r.id AND p.contact_id=co.id)
        AND NOT EXISTS(SELECT 1 FROM request_items bad WHERE bad.request_id=r.id AND (bad.free=false OR bad.working=false))
      GROUP BY r.id,m.id,m.state ORDER BY r.number LIMIT 5`,
      [phone],
    );
    const out: Candidate[] = [];
    for (const r of ids.rows)
      out.push({
        request: await this.request(r.id, c),
        match_id: r.match_id,
        state: r.state,
      });
    return out;
  }
  async context(id: string, c: DB = this.pool, lock = false): Promise<Context> {
    const message = await this.message(id, c, lock);
    if (!message.phone) throw new AppError("identity_unresolved", 409);
    const conv = await c.query<Conversation>(
      `SELECT cv.id,co.phone,cv.chat_id,cv.mode,cv.selected_request_id,cv.version,cv.pending_counterparty_name,cv.pending_counterparty_phone FROM conversations cv JOIN contacts co ON co.id=cv.contact_id JOIN messages m ON m.conversation_id=cv.id WHERE m.id=$1 ${lock ? "FOR UPDATE OF cv" : ""}`,
      [id],
    );
    if (!conv.rows[0]) throw new AppError("conversation_missing", 409);
    const reset = await c.query<{ reset_at: string | null }>(
      "SELECT reset_at::text FROM conversation_resets WHERE conversation_id=$1",
      [conv.rows[0].id],
    );
    const resetAt = reset.rows[0]?.reset_at ?? null;
    const requests = (await this.active(message.phone, c)).filter(
      (r) => !resetAt || r.created_at > resetAt,
    );
    // History for the open business conversation only. A finished/coordinated
    // handoff is out of scope. Prefer the selected open request, else the
    // earliest still-open request for this phone.
    const open = requests.filter(
      (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
    );
    const selectedOpen =
      open.find((r) => r.id === conv.rows[0]!.selected_request_id) ??
      [...open].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ??
      null;
    const historySince = selectedOpen?.created_at ?? resetAt;
    const h = await c.query<{
      text: string;
      transcript: string | null;
      reply: string | null;
    }>(
      `SELECT m.text,m.transcript,m.reply FROM messages m
       LEFT JOIN conversation_resets cr ON cr.conversation_id=m.conversation_id
       WHERE m.conversation_id=$1 AND m.seq<$2 AND m.processed_at IS NOT NULL
         AND coalesce(m.error_code,'') NOT LIKE 'coalesced_into:%'
         AND (cr.reset_at IS NULL OR m.received_at>cr.reset_at)
         AND (
           $3::timestamptz IS NULL
           OR m.received_at>=$3::timestamptz
           OR EXISTS (
             SELECT 1 FROM request_events e
             WHERE e.message_id=m.id AND e.request_id=$4::uuid
           )
         )
       ORDER BY m.seq ASC`,
      [conv.rows[0].id, message.seq, historySince, selectedOpen?.id ?? null],
    );
    const history: Context["history"] = [];
    const important = /(מאשר|מאשרת|תיקון|טעיתי|בעצם|התכוונתי|אל תפנה|ליצור קשר)/u;
    const rows = h.rows;
    const MAX_TURNS = 40;
    const selectedRows =
      rows.length <= MAX_TURNS
        ? rows
        : [
            ...rows.slice(0, 4),
            ...rows.slice(4, -12).filter((row) =>
              important.test(`${row.transcript ?? row.text}\n${row.reply ?? ""}`),
            ),
            ...rows.slice(-12),
          ];
    if (rows.length > MAX_TURNS) {
      history.push({
        role: "assistant",
        content: `סיכום שיחה פתוחה: נשמרו ${rows.length} הודעות; מוצגות ההודעות הראשונות, אישורים/תיקונים, וההודעות האחרונות.`,
      });
    }
    for (const row of selectedRows) {
      history.push({
        role: "user",
        content: (row.transcript ?? row.text).slice(0, 2000),
      });
      if (row.reply)
        history.push({ role: "assistant", content: row.reply.slice(0, 2000) });
    }
    const latest = await c.query<{ text: string }>(
      `SELECT o.text FROM outbox o JOIN messages current ON current.id=$2
       LEFT JOIN conversation_resets cr ON cr.conversation_id=current.conversation_id
       WHERE o.phone=$1 AND o.state IN ('sent','shadow','simulation') AND o.created_at<=current.received_at
         AND (cr.reset_at IS NULL OR o.created_at>cr.reset_at)
         AND ($3::timestamptz IS NULL OR o.created_at>=$3::timestamptz)
       ORDER BY o.seq DESC LIMIT 1`,
      [message.phone, id, historySince],
    );
    if (latest.rows[0] && history.at(-1)?.content !== latest.rows[0].text)
      history.push({
        role: "assistant",
        content: latest.rows[0].text.slice(0, 2000),
      });
    const messageText = (message.transcript ?? message.text).trim();
    if (/(?:טעיתי|תיקון|בעצם|התכוונתי)/.test(messageText)) {
      const correction = await c.query<{ id: string }>(
        `SELECT DISTINCT r.id,r.number
         FROM requests r
         JOIN request_parties p ON p.request_id=r.id
         JOIN contacts co ON co.id=p.contact_id
         WHERE co.phone=$1 AND r.status='rejected'
           AND ($2::timestamptz IS NULL OR r.created_at>$2)
           AND EXISTS(
             SELECT 1 FROM request_events e
             WHERE e.request_id=r.id AND e.event_type='outside_area_rejected'
           )
         ORDER BY r.number DESC LIMIT 2`,
        [message.phone, resetAt],
      );
      if (correction.rows.length === 1)
        requests.push(await this.request(correction.rows[0]!.id, c));
    }
    const candidates = (await this.candidates(message.phone, c)).filter(
      (candidate) => !resetAt || candidate.request.created_at > resetAt,
    );
    return {
      message,
      conversation: conv.rows[0],
      requests,
      candidates,
      history,
    };
  }
  async create(
    c: pg.PoolClient,
    items: Item[],
    parties: Party[],
    origin: Request["origin"],
  ): Promise<Request> {
    // The counter is seed data, but keeping this self-healing makes a clean
    // test database safe as well.
    await c.query(
      "INSERT INTO request_counter(id,value) VALUES(true,0) ON CONFLICT(id) DO NOTHING",
    );
    const n = await c.query<{ value: string }>(
      "UPDATE request_counter SET value=value+1 RETURNING value",
    );
    const r: Request = {
      id: randomUUID(),
      number: Number(n.rows[0]!.value),
      version: 0,
      status: "collecting",
      origin,
      verification_contacted: false,
      items,
      parties,
      photo_ids: [],
      run_date: null,
      proposed_run_date: null,
      earliest_run_date: null,
      preferred_time: null,
      represents_both_parties: false,
      closed_at: null,
      human_reason: null,
      created_at: new Date().toISOString(),
    };
    await c.query(
      "INSERT INTO requests(id,number,status,origin) VALUES($1,$2,$3,$4)",
      [r.id, r.number, r.status, r.origin],
    );
    await this.save(c, r);
    return r;
  }
  async save(c: pg.PoolClient, r: Request): Promise<void> {
    const result = await c.query(
      `UPDATE requests SET version=version+1,status=$2,origin=$3,run_date=$4,proposed_run_date=$12,human_reason=$5,preferred_time=$7,earliest_run_date=$8,verification_contacted=$9,represents_both_parties=$10,closed_at=$11,updated_at=clock_timestamp() WHERE id=$1 AND version=$6`,
      [
        r.id,
        r.status,
        r.origin,
        r.run_date,
        r.human_reason,
        r.version,
        r.preferred_time ?? null,
        r.earliest_run_date,
        r.verification_contacted,
        r.represents_both_parties ?? false,
        r.closed_at,
        r.proposed_run_date,
      ],
    );
    if (result.rowCount !== 1) throw new AppError("version_conflict", 409);
    r.version++;
    for (const p of r.parties) {
      const id = await this.contact(c, p.phone);
      await c.query(
        `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,floor_note_shown,approved_at,approved_by,schedule_approved,schedule_approved_date,schedule_approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(request_id,role) DO UPDATE SET contact_id=EXCLUDED.contact_id,name=EXCLUDED.name,settlement=EXCLUDED.settlement,address=EXCLUDED.address,floor=EXCLUDED.floor,approved_at=EXCLUDED.approved_at,approved_by=EXCLUDED.approved_by,schedule_approved=EXCLUDED.schedule_approved,schedule_approved_date=EXCLUDED.schedule_approved_date,schedule_approved_at=EXCLUDED.schedule_approved_at`,
        [
          r.id,
          p.role,
          id,
          p.name,
          p.settlement,
          p.address,
          p.floor,
          p.floor_note_shown,
          p.approved_at,
          p.approved_by ? id : null,
          Boolean(
            (r.proposed_run_date ?? r.run_date) &&
              p.schedule_approved_date &&
              p.schedule_approved_date.slice(0, 10) ===
                (r.proposed_run_date ?? r.run_date)?.slice(0, 10),
          ),
          p.schedule_approved_date,
          p.schedule_approved_at,
        ],
      );
    }
    await c.query("DELETE FROM request_items WHERE request_id=$1", [r.id]);
    for (const [i, v] of r.items.entries())
      await c.query(
        "INSERT INTO request_items(request_id,position,kind,description,quantity,free,working,needs_disassembly,wardrobe_small_whole,oven_type,evacuation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          r.id,
          i,
          v.kind,
          v.description,
          v.quantity,
          v.free,
          v.working,
          v.needs_disassembly,
          v.wardrobe_small_whole,
          v.oven_type,
          v.evacuation,
        ],
      );
  }
  async prepareTransportRun(c: pg.PoolClient, date: string): Promise<void> {
    await c.query(
      "INSERT INTO transport_runs(date,capacity) VALUES($1,$2) ON CONFLICT(date) DO NOTHING",
      [date, Math.min(this.config.TRANSPORT_CAPACITY, DEFAULT_TRANSPORT_CAPACITY)],
    );
  }
  private async askForCapacityApproval(
    c: pg.PoolClient,
    r: Request,
    date: string,
    capacity: number,
  ): Promise<"pending" | "denied" | "limit"> {
    if (capacity >= MAX_TRANSPORT_CAPACITY) return "limit";
    const inserted = await c.query<{ id: string; status: string }>(
      `INSERT INTO transport_capacity_approvals(run_date,requested_capacity,request_id)
       VALUES($1,$2,$3) ON CONFLICT(run_date,requested_capacity) DO NOTHING
       RETURNING id,status`,
      [date, capacity + 1, r.id],
    );
    const approval = inserted.rows[0] ?? (await c.query<{ id: string; status: string }>(
      "SELECT id,status FROM transport_capacity_approvals WHERE run_date=$1 AND requested_capacity=$2",
      [date, capacity + 1],
    )).rows[0];
    if (!approval) throw new AppError("capacity_approval_not_persisted", 500);
    if (approval.status === "denied") return "denied";
    if (inserted.rows[0]) {
      const [year, month, day] = date.split("-");
      const trace_id = randomUUID();
      const text = `הגענו ל־${capacity} הובלות מאושרות ביום שלישי ${day}/${month}/${year}. האם לאשר הובלה נוספת אחת (מכסה ${capacity + 1})?\nהשב/י: כן ${date} או לא ${date}. עד לאישור, לא נציע ולא נתאם הובלות נוספות ליום זה.`;
      await this.outbound(
        c,
        { trace_id, mode: this.config.BOT_MODE, phone: this.config.ADMIN_PHONE },
        { phone: this.config.ADMIN_PHONE, text },
        `capacity-approval:${approval.id}`,
        r.id,
      );
      await this.event(c, { trace_id }, "system", "capacity_approval_requested", {
        date,
        current_capacity: capacity,
        requested_capacity: capacity + 1,
        approval_id: approval.id,
      }, r.id);
    }
    return "pending";
  }
  async proposeScheduleDate(
    c: pg.PoolClient,
    r: Request,
    now: Date,
  ): Promise<string | null> {
    const first = nextTuesday(now).date;
    let date = first;
    if (r.earliest_run_date && r.earliest_run_date > date)
      date = r.earliest_run_date;
    const start = new Date(`${date}T12:00:00Z`);
    const day = (2 - start.getUTCDay() + 7) % 7;
    start.setUTCDate(start.getUTCDate() + day);
    date = start.toISOString().slice(0, 10);

    await this.prepareTransportRun(c, date);
    const run = await c.query<{ capacity: number; status: string }>(
      "SELECT capacity,status FROM transport_runs WHERE date=$1 FOR UPDATE",
      [date],
    );
    const used = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM requests WHERE run_date=$1 AND status IN ('coordinated','closed')",
      [date],
    );
    if (run.rows[0]?.status !== "open" || (date === first && nextTuesday(now).sameDay))
      return null;
    const proposed = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM requests WHERE proposed_run_date=$1 AND status='awaiting_approval'",
      [date],
    );
    if (used.rows[0]!.n >= run.rows[0]!.capacity) {
      await this.askForCapacityApproval(c, r, date, run.rows[0]!.capacity);
      return null;
    }
    if (used.rows[0]!.n + proposed.rows[0]!.n >= run.rows[0]!.capacity)
      return null;
    return date;
  }
  async region(
    c: DB,
    value: string,
  ): Promise<{ name: string; decision: "allowed" | "outside" | "review" }> {
    const allowedExact: Record<string, string> = {
      "בית שאן": "בית שאן",
      "מסילות": "מסילות",
      "ירדנה": "ירדנה",
      "בית אלפא": "בית אלפא",
      "טירת צבי": "טירת צבי",
      "קיבוץ טירת צבי": "טירת צבי",
      "כפר רופין": "כפר רופין",
      "מחולה": "מחולה",
    };
    const s = norm(value),
      lookup = s.replace(/^(?:רחוב|שכונת|שכונה|שדרות|שד[׳']?)\s+/, "").trim();
    const exact = allowedExact[lookup];
    if (exact) return { name: exact, decision: "allowed" };
    const candidates = [lookup, lookup.replace(/\s+\d+[א-ת]?\s*$/, "").trim()].filter(
      (value, index, all) => value && all.indexOf(value) === index,
    );
    const r = await c.query<{
      name: string;
      decision: "allowed" | "outside" | "review";
    }>(
      `SELECT name,decision FROM service_locations
       WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS candidate WHERE candidate=ANY(aliases))
       UNION ALL
       SELECT st.name,'allowed'::text FROM streets st
       JOIN location_datasets ds ON ds.id=st.dataset_id AND ds.active=true
       WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS candidate
                     WHERE candidate=st.normalized OR candidate=ANY(st.aliases))
       ORDER BY name LIMIT 1`,
      [candidates],
    );
    return r.rows[0] ?? { name: s, decision: "review" };
  }
  async event(
    c: pg.PoolClient,
    ctx: { trace_id: string; id?: string },
    actor: string,
    type: string,
    data: unknown = {},
    requestId: string | null = null,
  ): Promise<void> {
    const e = await c.query<{ id: string; created_at: string }>(
      "INSERT INTO request_events(request_id,message_id,trace_id,actor,event_type,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [
        requestId,
        ctx.id ?? null,
        ctx.trace_id,
        actor,
        type,
        JSON.stringify(data),
      ],
    );
    const eventId = e.rows[0]!.id;
    const payload = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { value: data };
    const enabled = await c.query<{ name: string }>(
      "SELECT name FROM integrations WHERE enabled=true ORDER BY name",
    );
    const deliveryKeys = Object.fromEntries(
      enabled.rows.map(({ name }) => [name, `integration:${name}:${eventId}`]),
    );
    await c.query(
      `UPDATE request_events
          SET data=$2
        WHERE id=$1`,
      [eventId, JSON.stringify({ ...payload, event_id: eventId, event_type: type, schema_version: 1, request_id: requestId, occurred_at: new Date().toISOString(), delivery_keys: deliveryKeys, payload })],
    );
    if (!this.config.INTEGRATION_DISPATCH) return;
    const integrations = await c.query<{ id: string; integration: string }>(
      `INSERT INTO integration_outbox(event_id,integration,idempotency_key)
       SELECT $1::bigint,name,'integration:'||name||':'||($1::bigint)::text FROM integrations WHERE enabled=true
       ON CONFLICT DO NOTHING RETURNING id,integration`,
      [eventId],
    );
    for (const row of integrations.rows)
      await this.queue.send(c, "integration", { id: row.id }, `integration:${row.integration}:${row.id}`);
  }
  async outbound(
    c: pg.PoolClient,
    ctx: {
      id?: string;
      trace_id: string;
      mode: Mode;
      chat_id?: string;
      phone?: string | null;
    },
    notice: Notice,
    key: string,
    requestId: string | null = null,
    formatState: "ready" | "pending" = "ready",
  ): Promise<string | null> {
    const phone = canonicalPhone(notice.phone);
    if (isOperationsAlert(notice.text) && phone !== this.config.ADMIN_PHONE)
      return null;
    const chat = isOperationsAlert(notice.text)
      ? `972${phone}@c.us`
      : ctx.phone === phone && ctx.chat_id
        ? ctx.chat_id
        : ((
            await c.query<{ chat_id: string }>(
              "SELECT chat_id FROM conversations cv JOIN contacts co ON co.id=cv.contact_id WHERE co.phone=$1 ORDER BY cv.version DESC LIMIT 1",
              [phone],
            )
          ).rows[0]?.chat_id ?? `972${phone}@c.us`);
    const row = await c.query<{ id: string }>(
      `INSERT INTO outbox(dedupe_key,message_id,request_id,trace_id,mode,phone,chat_id,text,media_id,match_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      [
        key,
        ctx.id ?? null,
        requestId,
        ctx.trace_id,
        ctx.mode,
        phone,
        chat,
        notice.text,
        notice.media_id ?? null,
        notice.match_id ?? null,
      ],
    );
    if (row.rows[0]) {
      // Schedule only the head of this recipient's queue. Scheduling every
      // row at once races the FIFO worker and can permanently strand later
      // WhatsApp replies behind a retried job.
      const older = await c.query(
        `SELECT 1 FROM outbox
          WHERE phone=$1 AND seq<(SELECT seq FROM outbox WHERE id=$2)
            AND state IN ('pending','sending','uncertain','failed')
          LIMIT 1`,
        [phone, row.rows[0].id],
      );
      if (!older.rowCount) {
        const job = await this.queue.send(
          c,
          "send",
          { id: row.rows[0].id },
          phone,
        );
      await c.query("UPDATE outbox SET job_id=$2 WHERE id=$1", [
          row.rows[0].id,
          job,
        ]);
      }
    }
    if (!row.rows[0]) return null;
    if (formatState === "pending")
      await c.query("UPDATE outbox SET format_state='pending' WHERE id=$1", [row.rows[0].id]);
    return row.rows[0].id;
  }
  async linkPhoto(c: pg.PoolClient, r: Request, m: Incoming): Promise<void> {
    if (
      !m.media_id ||
      m.kind !== "image" ||
      m.media_state !== "ready" ||
      !r.parties.some((p) => p.role === "donor" && p.phone === m.phone)
    )
      throw new AppError("photo_authorization_failed", 403);
    await c.query(
      "INSERT INTO request_media(request_id,media_id,added_by) SELECT $1,$2,id FROM contacts WHERE phone=$3 ON CONFLICT DO NOTHING",
      [r.id, m.media_id, m.phone],
    );
    if (!r.photo_ids.includes(m.media_id)) r.photo_ids.push(m.media_id);
  }
  async matchPhoto(
    c: pg.PoolClient,
    r: Request,
    phone: string,
    ctx: Incoming,
  ): Promise<void> {
    const contact = await this.contact(c, phone),
      photo = r.photo_ids[0];
    const m = await c.query<{ id: string; state: string }>(
      `INSERT INTO matches(request_id,contact_id,state) VALUES($1,$2,$3) ON CONFLICT(request_id,contact_id) DO UPDATE SET state=CASE WHEN matches.state='waiting_photo' AND EXCLUDED.state='queued_photo' THEN 'queued_photo' ELSE matches.state END RETURNING id,state`,
      [r.id, contact, photo ? "queued_photo" : "waiting_photo"],
    );
    const row = m.rows[0]!;
    if (photo && row.state === "queued_photo")
      await this.outbound(
        c,
        ctx,
        {
          phone,
          text: `פנייה ${r.number}: ${r.items.map((i) => i.description).join(", ")}. האם הפריט מתאים לך?`,
          media_id: photo,
          match_id: row.id,
        },
        `match-photo:${row.id}`,
        r.id,
      );
    if (!photo) {
      const donor = r.parties.find((p) => p.role === "donor");
      if (donor)
        await this.outbound(
          c,
          ctx,
          {
            phone: donor.phone,
            text: `יש מתעניין בפריט שבפנייה ${r.number}. נא לשלוח תמונה של הפריט.`,
          },
          `match-photo-request:${r.id}`,
          r.id,
        );
    }
  }
  async coordinate(
    c: pg.PoolClient,
    r: Request,
    now: Date,
    adminSameDay = false,
  ): Promise<"not_ready" | "same_day" | "full" | "capacity_denied" | "coordinated"> {
    if (!readyToCoordinate(r)) return "not_ready";
    for (const p of r.parties) {
      const location = await c.query<{ decision: string }>(
        "SELECT decision FROM service_locations WHERE name=$1",
        [p.settlement],
      );
      if (location.rows[0]?.decision !== "allowed") return "not_ready";
    }
    const date = r.proposed_run_date;
    if (!date) return "not_ready";
    const today = nextTuesday(now);
    if (today.sameDay && today.date === date && !adminSameDay) return "same_day";
    await this.prepareTransportRun(c, date);
    const run = await c.query<{ capacity: number; status: string }>(
      "SELECT capacity,status FROM transport_runs WHERE date=$1 FOR UPDATE",
      [date],
    );
    const used = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM requests WHERE run_date=$1 AND status IN ('coordinated','closed')",
      [date],
    );
    if (run.rows[0]!.status !== "open") {
      r.status = "waiting_capacity";
      return "full";
    }
    if (used.rows[0]!.n >= run.rows[0]!.capacity) {
      r.status = "waiting_capacity";
      const approval = await this.askForCapacityApproval(c, r, date, run.rows[0]!.capacity);
      return approval === "denied" ? "capacity_denied" : "full";
    }
    r.status = "coordinated";
    r.run_date = date;
    r.proposed_run_date = null;
    return "coordinated";
  }
  async resolveCapacityApproval(
    c: pg.PoolClient,
    date: string | null,
    approved: boolean,
    adminPhone: string,
  ): Promise<"approved" | "denied" | "none" | "ambiguous"> {
    if (canonicalPhone(adminPhone) !== this.config.ADMIN_PHONE)
      throw new AppError("admin_required", 403);
    const pending = await c.query<{ id: string; run_date: string; requested_capacity: number }>(
      `SELECT id,run_date::text,requested_capacity FROM transport_capacity_approvals
       WHERE status='pending' AND ($1::date IS NULL OR run_date=$1)
       ORDER BY requested_at FOR UPDATE`,
      [date],
    );
    if (!pending.rows.length) return "none";
    if (pending.rows.length !== 1) return "ambiguous";
    const row = pending.rows[0]!;
    if (approved) {
      await c.query("SELECT date FROM transport_runs WHERE date=$1 FOR UPDATE", [row.run_date]);
      const run = await c.query<{ status: string }>(
        "SELECT status FROM transport_runs WHERE date=$1",
        [row.run_date],
      );
      if (run.rows[0]?.status !== "open") throw new AppError("transport_run_closed", 409);
      if (row.requested_capacity > MAX_TRANSPORT_CAPACITY)
        throw new AppError("transport_capacity_limit", 409);
      await c.query("UPDATE transport_runs SET capacity=$2 WHERE date=$1", [row.run_date, row.requested_capacity]);
    }
    await c.query(
      "UPDATE transport_capacity_approvals SET status=$2,resolved_at=clock_timestamp(),resolved_by=$3 WHERE id=$1",
      [row.id, approved ? "approved" : "denied", this.config.ADMIN_PHONE],
    );
    await this.event(c, { trace_id: randomUUID() }, "admin", approved ? "capacity_approval_granted" : "capacity_approval_denied", {
      date: row.run_date,
      requested_capacity: row.requested_capacity,
      approval_id: row.id,
      admin_phone: this.config.ADMIN_PHONE,
    }, null);
    return approved ? "approved" : "denied";
  }

  /**
   * Named cleanup for one phone: delete that phone's requests (so Tuesday
   * capacity is freed) and reset the conversation, counters, and history.
   * Safe in live: it does not use the destructive clear-all guard.
   */
  async purgePhone(
    phone: string,
  ): Promise<{ deletedRequests: number; releasedJobs: number }> {
    const canonical = canonicalPhone(phone);
    const releasedJobs = await this.queue.releaseSingleton(
      "conversation",
      canonical,
      ["created", "retry", "failed"],
    );
    const deletedRequests = await this.transaction(async (c) => {
      const contacts = await c.query<{ id: string }>(
        "SELECT id FROM contacts WHERE phone=$1 FOR UPDATE",
        [canonical],
      );
      const contactIds = contacts.rows.map((row) => row.id);
      const requests = await c.query<{ id: string }>(
        `SELECT DISTINCT r.id
           FROM requests r
           JOIN request_parties p ON p.request_id=r.id
           JOIN contacts co ON co.id=p.contact_id
          WHERE co.phone=$1`,
        [canonical],
      );
      const requestIds = requests.rows.map((row) => row.id);
      if (requestIds.length) {
        await c.query(
          "UPDATE conversations SET selected_request_id=NULL WHERE selected_request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query(
          "DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE request_id=ANY($1::uuid[]))",
          [requestIds],
        );
        await c.query(
          "DELETE FROM request_events WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query(
          "DELETE FROM request_verifications WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query(
          "DELETE FROM outbox WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query("DELETE FROM matches WHERE request_id=ANY($1::uuid[])", [
          requestIds,
        ]);
        await c.query(
          "DELETE FROM request_media WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query(
          "DELETE FROM request_parties WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query(
          "DELETE FROM request_items WHERE request_id=ANY($1::uuid[])",
          [requestIds],
        );
        await c.query("DELETE FROM requests WHERE id=ANY($1::uuid[])", [
          requestIds,
        ]);
      }
      if (!contactIds.length) return requestIds.length;
      const conversations = await c.query<{ id: string }>(
        "SELECT id FROM conversations WHERE contact_id=ANY($1::uuid[])",
        [contactIds],
      );
      const conversationIds = conversations.rows.map((row) => row.id);
      const messages = await c.query<{ id: string }>(
        `SELECT id FROM messages
          WHERE contact_id=ANY($1::uuid[])
             OR conversation_id=ANY($2::uuid[])`,
        [contactIds, conversationIds],
      );
      const messageIds = messages.rows.map((row) => row.id);
      if (messageIds.length) {
        await c.query(
          "DELETE FROM request_events WHERE message_id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query(
          "DELETE FROM command_results WHERE message_id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query(
          "DELETE FROM outbox WHERE message_id=ANY($1::uuid[]) OR phone=$2",
          [messageIds, canonical],
        );
        await c.query(
          "DELETE FROM request_locations WHERE message_id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query(
          "DELETE FROM turn_messages WHERE message_id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query(
          "UPDATE messages SET media_id=NULL WHERE id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query("DELETE FROM media WHERE message_id=ANY($1::uuid[])", [
          messageIds,
        ]);
        await c.query(
          "UPDATE messages SET turn_id=NULL WHERE id=ANY($1::uuid[])",
          [messageIds],
        );
        await c.query("DELETE FROM messages WHERE id=ANY($1::uuid[])", [
          messageIds,
        ]);
      } else {
        await c.query("DELETE FROM outbox WHERE phone=$1", [canonical]);
      }
      if (conversationIds.length) {
        await c.query(
          "DELETE FROM conversation_resets WHERE conversation_id=ANY($1::uuid[])",
          [conversationIds],
        );
        await c.query(
          "DELETE FROM conversation_turns WHERE conversation_id=ANY($1::uuid[])",
          [conversationIds],
        );
        await c.query(
          `UPDATE conversations
              SET mode='bot', selected_request_id=NULL, pending_counterparty_name=NULL,
                  pending_counterparty_phone=NULL, version=version+1
            WHERE id=ANY($1::uuid[])`,
          [conversationIds],
        );
      }
      await c.query("DELETE FROM searches WHERE contact_id=ANY($1::uuid[])", [
        contactIds,
      ]);
      return requestIds.length;
    });
    return { deletedRequests, releasedJobs };
  }
}
