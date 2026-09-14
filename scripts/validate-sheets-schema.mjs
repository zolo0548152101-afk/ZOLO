import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const [file, mappingFile = resolve(dirname(fileURLToPath(import.meta.url)), "../config/legacy-sheets-v9-mapping.json")] = process.argv.slice(2);
if (!file) throw new Error("Usage: node scripts/validate-sheets-schema.mjs <export.csv> [mapping.json]");
const mapping = JSON.parse(await readFile(mappingFile, "utf8"));
const text = await readFile(file, "utf8");
const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
const headers = firstLine.split(",").map((x) => x.replace(/^\"|\"$/g, "").trim());
const expected = mapping.columns.map((x) => x.source);
const missing = expected.filter((x) => !headers.includes(x));
const extra = headers.filter((x) => !expected.includes(x));
const reviewRequired = mapping.columns.filter((x) => x.status === "review_required").map((x) => x.source);
const ok = headers.length === expected.length && missing.length === 0 && extra.length === 0;
console.log(JSON.stringify({ ok, source: file, expected_columns: expected.length, actual_columns: headers.length, missing, extra, review_required: reviewRequired, ready_for_business_import: ok && reviewRequired.length === 0 }, null, 2));
if (!ok) process.exitCode = 1;
