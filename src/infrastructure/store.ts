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
} from "../domain/types.js";
import {
  ACTIVE,
  canonicalPhone,
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
      `SELECT id,number::int,version,status,origin,run_date::text,earliest_run_date::text,human_reason,created_at::text FROM requests WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    if (!base.rows[0]) throw new AppError("request_not_found", 404);
    const parties = await c.query<Party>(
      `SELECT p.role,co.phone,p.name,p.settlement,p.address,p.floor,p.floor_note_shown,p.approved_at::text,ap.phone AS approved_by,p.schedule_approved FROM request_parties p JOIN contacts co ON co.id=p.contact_id LEFT JOIN contacts ap ON ap.id=p.approved_by WHERE p.request_id=$1 ORDER BY role`,
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
    return {
      ...base.rows[0],
      parties: parties.rows,
      items: items.rows,
      photo_ids: media.rows.map((r) => r.media_id),
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
      `SELECT cv.id,co.phone,cv.chat_id,cv.mode,cv.selected_request_id,cv.version FROM conversations cv JOIN contacts co ON co.id=cv.contact_id JOIN messages m ON m.conversation_id=cv.id WHERE m.id=$1 ${lock ? "FOR UPDATE OF cv" : ""}`,
      [id],
    );
    if (!conv.rows[0]) throw new AppError("conversation_missing", 409);
    const h = await c.query<{
      text: string;
      transcript: string | null;
      reply: string | null;
    }>(
      `SELECT text,transcript,reply FROM messages WHERE conversation_id=$1 AND seq<$2 AND processed_at IS NOT NULL ORDER BY seq DESC LIMIT 8`,
      [conv.rows[0].id, message.seq],
    );
    const history: Context["history"] = [];
    for (const row of h.rows.reverse()) {
      history.push({
        role: "user",
        content: (row.transcript ?? row.text).slice(0, 2000),
      });
      if (row.reply)
        history.push({ role: "assistant", content: row.reply.slice(0, 2000) });
    }
    const latest = await c.query<{ text: string }>(
      `SELECT o.text FROM outbox o JOIN messages current ON current.id=$2 WHERE o.phone=$1 AND o.state IN ('sent','shadow','simulation') AND o.created_at<=current.received_at ORDER BY o.seq DESC LIMIT 1`,
      [message.phone, id],
    );
    if (latest.rows[0] && history.at(-1)?.content !== latest.rows[0].text)
      history.push({
        role: "assistant",
        content: latest.rows[0].text.slice(0, 2000),
      });
    return {
      message,
      conversation: conv.rows[0],
      requests: await this.active(message.phone, c),
      candidates: await this.candidates(message.phone, c),
      history,
    };
  }
  async create(
    c: pg.PoolClient,
    items: Item[],
    parties: Party[],
    origin: Request["origin"],
  ): Promise<Request> {
    const n = await c.query<{ value: string }>(
      "UPDATE request_counter SET value=value+1 RETURNING value",
    );
    const r: Request = {
      id: randomUUID(),
      number: Number(n.rows[0]!.value),
      version: 0,
      status: "collecting",
      origin,
      items,
      parties,
      photo_ids: [],
      run_date: null,
      earliest_run_date: null,
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
      `UPDATE requests SET version=version+1,status=$2,origin=$3,run_date=$4,human_reason=$5,earliest_run_date=$7,updated_at=clock_timestamp() WHERE id=$1 AND version=$6`,
      [
        r.id,
        r.status,
        r.origin,
        r.run_date,
        r.human_reason,
        r.version,
        r.earliest_run_date,
      ],
    );
    if (result.rowCount !== 1) throw new AppError("version_conflict", 409);
    r.version++;
    for (const p of r.parties) {
      const id = await this.contact(c, p.phone);
      await c.query(
        `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,floor_note_shown,approved_at,approved_by,schedule_approved) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(request_id,role) DO UPDATE SET contact_id=EXCLUDED.contact_id,name=EXCLUDED.name,settlement=EXCLUDED.settlement,address=EXCLUDED.address,floor=EXCLUDED.floor,floor_note_shown=EXCLUDED.floor_note_shown,approved_at=EXCLUDED.approved_at,approved_by=EXCLUDED.approved_by,schedule_approved=EXCLUDED.schedule_approved`,
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
          p.schedule_approved,
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
  async region(
    c: DB,
    value: string,
  ): Promise<{ name: string; decision: "allowed" | "outside" | "review" }> {
    const s = norm(value);
    const r = await c.query<{
      name: string;
      decision: "allowed" | "outside" | "review";
    }>(
      "SELECT name,decision FROM service_locations WHERE $1=ANY(aliases) ORDER BY name LIMIT 1",
      [s],
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
    const e = await c.query<{ id: string }>(
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
    await c.query(
      `INSERT INTO integration_outbox(event_id,integration) SELECT $1,name FROM integrations WHERE enabled=true ON CONFLICT DO NOTHING`,
      [e.rows[0]!.id],
    );
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
  ): Promise<void> {
    const phone = canonicalPhone(notice.phone);
    const chat =
      ctx.phone === phone && ctx.chat_id
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
  ): Promise<"not_ready" | "same_day" | "full" | "coordinated"> {
    if (!readyToCoordinate(r)) return "not_ready";
    for (const p of r.parties) {
      const location = await c.query<{ decision: string }>(
        "SELECT decision FROM service_locations WHERE name=$1",
        [p.settlement],
      );
      if (location.rows[0]?.decision !== "allowed") return "not_ready";
    }
    const target = nextTuesday(now);
    if (r.earliest_run_date && r.earliest_run_date > target.date) {
      target.date = r.earliest_run_date;
      target.sameDay = false;
    }
    if (target.sameDay && !adminSameDay) return "same_day";
    await c.query(
      "INSERT INTO transport_runs(date,capacity) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [target.date, this.config.TRANSPORT_CAPACITY],
    );
    const run = await c.query<{ capacity: number; status: string }>(
      "SELECT capacity,status FROM transport_runs WHERE date=$1 FOR UPDATE",
      [target.date],
    );
    const used = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM requests WHERE run_date=$1 AND status IN ('coordinated','closed')",
      [target.date],
    );
    if (
      run.rows[0]!.status !== "open" ||
      used.rows[0]!.n >= run.rows[0]!.capacity
    ) {
      r.status = "waiting_capacity";
      return "full";
    }
    r.status = "coordinated";
    r.run_date = target.date;
    return "coordinated";
  }
}
