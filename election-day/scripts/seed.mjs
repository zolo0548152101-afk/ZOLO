import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";

config({ path: ".env.local", override: true });

if (!process.env.DATABASE_URL?.startsWith("postgres")) {
  throw new Error("DATABASE_URL missing or invalid");
}

const sql = neon(process.env.DATABASE_URL);
const clusters = JSON.parse(readFileSync("data/clusters.json", "utf8"));
const coords = JSON.parse(readFileSync("data/settlement_coords.json", "utf8"));

await sql`TRUNCATE settlements, clusters`;

const settEntries = Object.entries(coords);
for (let i = 0; i < settEntries.length; i += 300) {
  const chunk = settEntries.slice(i, i + 300);
  const names = chunk.map(([n]) => n);
  const lats = chunk.map(([, v]) => v[0]);
  const lngs = chunk.map(([, v]) => v[1]);
  await sql`
    INSERT INTO settlements (name_he, lat, lng)
    SELECT * FROM UNNEST(${names}::text[], ${lats}::float8[], ${lngs}::float8[])
    ON CONFLICT (name_he) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng
  `;
  console.log("settlements", Math.min(i + 300, settEntries.length));
}

for (let i = 0; i < clusters.length; i += 400) {
  const chunk = clusters.slice(i, i + 400);
  await sql`
    INSERT INTO clusters (
      ashkol, settlement_name, settlement_code, bzb, voters, valid,
      right_votes, turnout_pct, right_pct, ballot_count
    )
    SELECT * FROM UNNEST(
      ${chunk.map((c) => c.ashkol)}::text[],
      ${chunk.map((c) => c.settlement_name)}::text[],
      ${chunk.map((c) => c.settlement_code)}::text[],
      ${chunk.map((c) => c.bzb)}::int4[],
      ${chunk.map((c) => c.voters)}::int4[],
      ${chunk.map((c) => c.valid)}::int4[],
      ${chunk.map((c) => c.right_votes)}::int4[],
      ${chunk.map((c) => c.turnout_pct)}::float8[],
      ${chunk.map((c) => c.right_pct)}::float8[],
      ${chunk.map((c) => c.ballot_count)}::int4[]
    )
    ON CONFLICT (ashkol) DO NOTHING
  `;
  console.log("clusters", Math.min(i + 400, clusters.length));
}

const [{ count: sc }] = await sql`SELECT count(*)::int AS count FROM settlements`;
const [{ count: cc }] = await sql`SELECT count(*)::int AS count FROM clusters`;
const [{ count: fc }] =
  await sql`SELECT count(*)::int AS count FROM clusters WHERE right_pct >= 70 AND turnout_pct < 60`;
console.log({ settlements: sc, clusters: cc, defaultFilter: fc });
