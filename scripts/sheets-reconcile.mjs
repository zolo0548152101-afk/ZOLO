import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/sheets-reconcile.mjs <export.csv>");
const mapping = JSON.parse(await readFile(resolve("config/legacy-sheets-v9-mapping.json"), "utf8"));
const bytes = await readFile(file);
function csv(text) {
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
const rows = csv(bytes.toString("utf8"));
const headers = (rows.shift() ?? []).map((x) => x.trim());
const expected = mapping.columns.map((x) => x.source);
const exceptions = [];
if (headers.length !== expected.length || headers.some((x, i) => x !== expected[i]))
  exceptions.push({ type: "header_mismatch", expected_columns: expected.length, actual_columns: headers.length });
const records = rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? "").trim()])));
const required = ["מספר פנייה", "טלפון המוסר", "סטטוס פנייה", "עיר איסוף", "מה מעבירים"];
const numbers = new Map();
for (let i = 0; i < records.length; i++) {
  const record = records[i];
  for (const field of required) if (!record[field]) exceptions.push({ type: "missing_required", row: i + 2, field });
  const number = record["מספר פנייה"];
  if (number) numbers.set(number, [...(numbers.get(number) ?? []), i + 2]);
  const phone = (record["טלפון המוסר"] ?? "").replace(/[\s()-]/g, "");
  if (phone && !/^0?5\d{8}$/.test(phone)) exceptions.push({ type: "invalid_phone", row: i + 2, field: "טלפון המוסר" });
}
for (const [number, rowNumbers] of numbers) if (rowNumbers.length > 1) exceptions.push({ type: "duplicate_request_number", number, rows: rowNumbers });
const mediaRows = records.filter((x) => x["תמונות WhatsApp"]).length;
const locationRows = records.filter((x) => x["עיר איסוף"] || x["עיר יעד"]).length;
const sourceHash = createHash("sha256").update(bytes).digest("hex");
console.log(JSON.stringify({ mode: "reconcile_dry_run", source: file, source_hash: sourceHash, rows: records.length, media_rows: mediaRows, location_rows: locationRows, exceptions, ready_for_import: exceptions.length === 0 }, null, 2));
if (exceptions.length) process.exitCode = 1;
