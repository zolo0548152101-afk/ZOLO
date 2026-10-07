#!/usr/bin/env node
/**
 * Dump conversation snapshot for Israel's phone from live Postgres.
 * Usage: DATABASE_URL=... DB_SCHEMA=haim_core node scripts/dump-israel-phone-db.mjs [out.json]
 */
import pg from "pg";
import fs from "node:fs";

const phone = process.env.DUMP_PHONE || "584152101";
const contactPhone = process.env.DUMP_CONTACT_PHONE || "536662043";
const outPath = process.argv[2] || null;
const schema = process.env.DB_SCHEMA || "haim_core";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(`SET search_path TO ${schema}, public`);

async function q(sql, params = []) {
  const r = await c.query(sql, params);
  return r.rows;
}

const snapshot = {
  israel_now: (
    await q(
      `SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI:SS') AS t`,
    )
  )[0]?.t,
  contacts: await q(
    `SELECT id, phone,
            to_char(created_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI:SS') AS created_il
       FROM contacts
      WHERE phone LIKE $1 OR phone LIKE $2
      ORDER BY created_at`,
    [`%${phone}%`, `%${contactPhone}%`],
  ),
  conversations: await q(
    `SELECT cv.id, co.phone, cv.mode, cv.version, cv.selected_request_id,
            cv.pending_counterparty_name, cv.pending_counterparty_phone, cv.pending_extra_item
       FROM conversations cv
       JOIN contacts co ON co.id=cv.contact_id
      WHERE co.phone LIKE $1`,
    [`%${phone}%`],
  ),
  requests: await q(
    `SELECT r.number, r.status, r.origin,
            to_char(r.created_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS created_il,
            (SELECT string_agg(p.role||':'||coalesce(p.name,'')||'/'||c.phone, ', ')
               FROM request_parties p JOIN contacts c ON c.id=p.contact_id
              WHERE p.request_id=r.id) AS parties,
            (SELECT string_agg(i.description||'/'||coalesce(i.kind,''), ', ' ORDER BY i.position)
               FROM request_items i WHERE i.request_id=r.id) AS items
       FROM requests r
      WHERE EXISTS (
              SELECT 1 FROM request_parties p
              JOIN contacts c ON c.id=p.contact_id
             WHERE p.request_id=r.id AND c.phone LIKE $1
            )
      ORDER BY r.number`,
    [`%${phone}%`],
  ),
  messages: await q(
    `SELECT m.seq,
            to_char(m.received_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS t,
            m.kind, left(m.text,200) AS text,
            left(coalesce(m.reply,''),300) AS reply,
            m.error_code,
            to_char(m.processed_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS processed,
            m.turn_generation,
            m.contacts,
            left(coalesce(m.ai_plan::text,''),400) AS ai_plan,
            left(coalesce(m.ai_metadata::text,''),400) AS ai_metadata
       FROM messages m
       JOIN contacts co ON co.id=m.contact_id
      WHERE co.phone LIKE $1
      ORDER BY m.seq`,
    [`%${phone}%`],
  ),
  turns: await q(
    `SELECT t.generation, t.status,
            to_char(t.opened_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS opened,
            to_char(t.deadline_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS deadline,
            to_char(t.completed_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS completed
       FROM conversation_turns t
       JOIN conversations cv ON cv.id=t.conversation_id
       JOIN contacts co ON co.id=cv.contact_id
      WHERE co.phone LIKE $1
      ORDER BY t.generation`,
    [`%${phone}%`],
  ),
  outbox: await q(
    `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS created,
            to_char(o.sent_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS sent,
            o.state, left(o.text,300) AS text, o.error_code
       FROM outbox o
      WHERE o.phone LIKE $1
      ORDER BY o.created_at`,
    [`%${phone}%`],
  ),
  conversation_jobs: await q(
    `SELECT id::text, state, singleton_key, data,
            to_char(created_on AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS created,
            to_char(started_on AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS started,
            to_char(completed_on AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS completed
       FROM ${schema}_jobs.job
      WHERE name='conversation' AND singleton_key LIKE $1
      ORDER BY created_on DESC
      LIMIT 40`,
    [`%${phone}%`],
  ),
};

await c.end();
const text = JSON.stringify(snapshot, null, 2);
if (outPath) fs.writeFileSync(outPath, text);
console.log(text);
