import { readCsv } from "./sheets-import-lib.mjs";
const [file, mapping] = process.argv.slice(2);
if (!file) throw new Error("Usage: node scripts/validate-sheets-schema.mjs <export.csv> [mapping.json]");
const source = await readCsv(file, mapping);
console.log(JSON.stringify({ ok: source.headerOk, source: file, expected_columns: source.expected.length, actual_columns: source.header.length, missing: source.expected.filter((x) => !source.header.includes(x)), extra: source.header.filter((x) => !source.expected.includes(x)), ready_for_business_import: source.headerOk }, null, 2));
if (!source.headerOk) process.exitCode = 1;
