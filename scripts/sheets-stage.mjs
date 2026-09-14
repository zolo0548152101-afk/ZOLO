// Stage a CSV/Sheets export without touching business tables.
// Default is dry-run. Applying is intentionally unavailable here until a
// reviewed field mapping and a migration batch id are supplied.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const file = process.argv[2];
if (!file || process.argv.includes("--apply")) {
  throw new Error("Usage: node scripts/sheets-stage.mjs <export.csv> (dry-run only; apply requires reviewed importer)");
}
const bytes = await readFile(file);
const sourceHash = createHash("sha256").update(bytes).digest("hex");
function csv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(cell); cell = ""; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const rows = csv(bytes.toString("utf8"));
const headers = rows.shift() ?? [];
if (!headers.length) throw new Error("empty_csv");
const normalized = rows.map((r) => Object.fromEntries(headers.map((h, j) => [h.trim(), r[j] ?? ""])));
const hashes = normalized.map((x) => createHash("sha256").update(JSON.stringify(x)).digest("hex"));
const dup = hashes.length - new Set(hashes).size;
console.log(JSON.stringify({ mode: "dry_run", source: file, source_hash: sourceHash, headers, rows: rows.length, duplicate_rows: dup, ready_for_review: true }, null, 2));
if (process.env.TEST_DATABASE_URL && process.env.STAGE_TO_DATABASE === "true") {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query("INSERT INTO sheets_import_batches(source_label,source_hash,mode,row_count) VALUES($1,$2,'dry_run',$3) ON CONFLICT(source_label,source_hash) DO UPDATE SET row_count=EXCLUDED.row_count RETURNING id", [file, sourceHash, normalized.length]);
    for (let i = 0; i < normalized.length; i++) await client.query("INSERT INTO sheets_import_rows(batch_id,row_number,row_hash,source,validation_state) VALUES($1,$2,$3,$4,'valid') ON CONFLICT DO NOTHING", [batch.rows[0].id, i + 2, hashes[i], JSON.stringify(normalized[i])]);
    await client.query("UPDATE sheets_import_batches SET state='validated',completed_at=clock_timestamp() WHERE id=$1", [batch.rows[0].id]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ staged: true, batch_id: batch.rows[0].id }));
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { await client.end(); }
}
