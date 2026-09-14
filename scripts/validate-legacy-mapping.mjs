import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [sourceFile, mappingFile = "config/legacy-sheets-v9-mapping.json"] = process.argv.slice(2);
if (!sourceFile) throw new Error("Usage: node scripts/validate-legacy-mapping.mjs <AppsScript.gs> [mapping.json]");
const source = await readFile(sourceFile, "utf8");
const block = source.match(/const\s+HEADERS\s*=\s*\[(.*?)\];/s)?.[1];
if (!block) throw new Error("headers_array_not_found");
const sourceHeaders = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const mapping = JSON.parse(await readFile(resolve(mappingFile), "utf8"));
const expected = mapping.columns.map((x) => x.source);
const mismatch = sourceHeaders.length !== expected.length || sourceHeaders.some((x, i) => x !== expected[i]);
console.log(JSON.stringify({ ok: !mismatch, source_columns: sourceHeaders.length, mapping_columns: expected.length, mismatch, review_required: mapping.columns.filter((x) => x.status === "review_required").map((x) => x.source) }, null, 2));
if (mismatch) process.exitCode = 1;
