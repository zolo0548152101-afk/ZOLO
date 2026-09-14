import pg from "pg";
import { readConfig } from "./dist/config.js";
import { WahaChannel } from "./dist/infrastructure/waha.js";

const config = readConfig();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`SET search_path TO ${process.env.DB_SCHEMA}`);
const id = "ab546e3c-e5b9-4780-a153-1d7b391b0dc4";
const row = await pool.query(
  "SELECT phone,chat_id,text,state FROM outbox WHERE id=$1 FOR UPDATE",
  [id],
);
if (!row.rows[0] || row.rows[0].state !== "pending")
  throw new Error("verification_not_pending");
const out = row.rows[0];
const providerId = await new WahaChannel(config).send(out);
await pool.query(
  "UPDATE outbox SET state='sent',provider_id=$2,sent_at=clock_timestamp(),error_code=NULL WHERE id=$1",
  [id, providerId],
);
await pool.end();
console.log(JSON.stringify({ delivered: true, provider_message_id: providerId }));
