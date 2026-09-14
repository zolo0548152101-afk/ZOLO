// Explicit operator-gated activation. Staging and validation are separate;
// this command is the only path that flips the active location dataset.
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file || process.env.LOCATION_ACTIVATION_APPROVAL !== "YES")
  throw new Error("Activation requires LOCATION_ACTIVATION_APPROVAL=YES and a CSV path");
if (process.env.BOT_MODE === "live" && process.env.LIVE_ALLOWLIST !== "LOCATION_DATASET_ONLY")
  throw new Error("live_activation_requires_explicit_location_only_allowlist");

const text = await readFile(file, "utf8");
const checksum = createHash("sha256").update(text).digest("hex");
const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
if (lines.shift() !== "name,settlement,aliases") throw new Error("invalid_location_headers");
const unquote = (value) => value.replace(/^"|"$/g, "").replaceAll('""', '"');
const rows = lines.map((line) => line.split(",").map(unquote)).map(([name, settlement, aliases]) => ({
  name: name.trim(), settlement: settlement.trim(), aliases: (aliases ?? "").split("|").map((x) => x.trim()).filter(Boolean),
}));
if (rows.length < 200 || rows.some((row) => !row.name || row.settlement !== "בית שאן"))
  throw new Error("location_snapshot_failed_integrity_checks");

const schema = process.env.DB_SCHEMA ?? "haim_core_test";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const version = process.env.LOCATION_DATASET_VERSION ?? `beit-shean-official-${checksum.slice(0, 12)}`;
  const dataset = await client.query(
    "INSERT INTO location_datasets(version,source,checksum,active) VALUES($1,$2,$3,false) RETURNING id",
    [version, "data.gov.il:population-authority:321", checksum],
  );
  const id = dataset.rows[0].id;
  for (const row of rows) {
    await client.query(
      "INSERT INTO streets(dataset_id,name,normalized,aliases) VALUES($1,$2,$3,$4)",
      [id, row.name, row.name.normalize("NFKC").replace(/[־–—-]/g, " ").replace(/\s+/g, " ").trim(), row.aliases],
    );
  }
  await client.query("UPDATE location_datasets SET active=false WHERE active=true");
  await client.query("UPDATE location_datasets SET active=true WHERE id=$1", [id]);
  await client.query("COMMIT");
  console.log(JSON.stringify({ activated: true, version, rows: rows.length, checksum, schema }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
