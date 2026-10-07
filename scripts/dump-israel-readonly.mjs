#!/usr/bin/env node
/** Read-only dump for phone 584152101 — conversations/requests/messages/outbox + parties. */
import pg from "pg";
import fs from "node:fs";

const schema = process.env.DB_SCHEMA || "haim_core";
const phone = "584152101";
const out = process.argv[2] || null;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(`SET search_path TO ${schema}, public`);
await c.query("SET default_transaction_read_only = on");

async function q(sql, params = []) {
  return (await c.query(sql, params)).rows;
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
       FROM contacts WHERE phone LIKE $1 OR phone LIKE '%536662043%'
      ORDER BY created_at`,
    [`%${phone}%`],
  ),
  conversations: await q(
    `SELECT cv.id, co.phone, cv.mode, cv.version, cv.selected_request_id,
            cv.pending_counterparty_name, cv.pending_counterparty_phone, cv.pending_extra_item
       FROM conversations cv JOIN contacts co ON co.id=cv.contact_id
      WHERE co.phone LIKE $1`,
    [`%${phone}%`],
  ),
  requests: await q(
    `SELECT r.id, r.number, r.status, r.origin,
            to_char(r.created_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI:SS') AS created_il,
            to_char(r.updated_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS updated_il
       FROM requests r
      WHERE EXISTS (
        SELECT 1 FROM request_parties p JOIN contacts c ON c.id=p.contact_id
         WHERE p.request_id=r.id AND c.phone LIKE $1
      )
      ORDER BY r.created_at, r.number`,
    [`%${phone}%`],
  ),
  parties: await q(
    `SELECT r.number, p.role, c.phone, coalesce(p.name,'') AS name,
            coalesce(p.settlement,'') AS settlement,
            to_char(p.approved_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS approved_il
       FROM request_parties p
       JOIN contacts c ON c.id=p.contact_id
       JOIN requests r ON r.id=p.request_id
      WHERE EXISTS (
        SELECT 1 FROM request_parties p2 JOIN contacts c2 ON c2.id=p2.contact_id
         WHERE p2.request_id=r.id AND c2.phone LIKE $1
      )
      ORDER BY r.number, p.role`,
    [`%${phone}%`],
  ),
  items: await q(
    `SELECT r.number, i.position, i.kind, i.description, i.quantity, i.free, i.working
       FROM request_items i JOIN requests r ON r.id=i.request_id
      WHERE EXISTS (
        SELECT 1 FROM request_parties p JOIN contacts c ON c.id=p.contact_id
         WHERE p.request_id=r.id AND c.phone LIKE $1
      )
      ORDER BY r.number, i.position`,
    [`%${phone}%`],
  ),
  messages: await q(
    `SELECT m.seq,
            to_char(m.received_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS t,
            m.kind, m.text, m.reply, m.error_code, m.turn_generation, m.contacts,
            left(coalesce(m.ai_plan::text,''),500) AS ai_plan
       FROM messages m JOIN contacts co ON co.id=m.contact_id
      WHERE co.phone LIKE $1
      ORDER BY m.seq`,
    [`%${phone}%`],
  ),
  outbox: await q(
    `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS created,
            to_char(o.sent_at AT TIME ZONE 'Asia/Jerusalem','HH24:MI:SS') AS sent,
            o.state, o.text, o.error_code
       FROM outbox o WHERE o.phone LIKE $1
      ORDER BY o.created_at`,
    [`%${phone}%`],
  ),
  conversation_resets: await q(
    `SELECT to_char(cr.reset_at AT TIME ZONE 'Asia/Jerusalem','YYYY-MM-DD HH24:MI:SS') AS reset_il
       FROM conversation_resets cr
       JOIN conversations cv ON cv.id=cr.conversation_id
       JOIN contacts co ON co.id=cv.contact_id
      WHERE co.phone LIKE $1`,
    [`%${phone}%`],
  ),
};

await c.end();
const text = JSON.stringify(snapshot, null, 2);
if (out) fs.writeFileSync(out, text);
console.log(text);
