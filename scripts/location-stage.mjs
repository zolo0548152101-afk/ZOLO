// Validate a versioned street snapshot without touching business tables.
// Activation is deliberately unavailable from this dry-run tool.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file || process.argv.includes("--activate"))
  throw new Error("Usage: node scripts/location-stage.mjs <streets.csv> (dry-run only)");

const bytes = await readFile(file);
const sourceHash = createHash("sha256").update(bytes).digest("hex");
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { row.push(cell); cell = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const rows = parseCsv(bytes.toString("utf8"));
const headers = (rows.shift() ?? []).map((x) => x.trim().toLowerCase());
if (headers.join(",") !== "name,settlement,aliases")
  throw new Error("expected_headers:name,settlement,aliases");
const seen = new Set();
const normalized = [];
for (const row of rows) {
  const value = Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? "").trim()]));
  if (!value.name || !value.settlement) throw new Error("street_name_and_settlement_required");
  if (value.settlement !== "בית שאן") throw new Error(`unexpected_settlement:${value.settlement}`);
  const key = value.name.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (seen.has(key)) throw new Error(`duplicate_street:${value.name}`);
  seen.add(key);
  normalized.push({ name: value.name, settlement: value.settlement, aliases: value.aliases ? value.aliases.split("|").map((x) => x.trim()).filter(Boolean) : [] });
}
if (!normalized.length) throw new Error("empty_street_snapshot");
console.log(JSON.stringify({ mode: "dry_run", source: file, source_hash: sourceHash, settlement: "בית שאן", rows: normalized.length, aliases: normalized.reduce((n, x) => n + x.aliases.length, 0), ready_for_review: true }, null, 2));
