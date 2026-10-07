import pg from "pg";
const schema = process.env.DB_SCHEMA || "haim_core";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(`SET search_path TO ${schema}, public`);
for (const t of [
  "contacts",
  "conversations",
  "requests",
  "messages",
  "outbox",
  "parties",
  "items",
  "conversation_turns",
]) {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
    [schema, t],
  );
  console.log(`#${t}`, r.rows.map((x) => x.column_name).join(", "));
}
await c.end();
