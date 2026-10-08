// Static proof that Action + Reply stay hosted-only (no git prompt mode),
// and that the field map covers every customer-facing column in scope.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const source = await readFile("src/infrastructure/ai.ts", "utf8");

const required = [
  "this.client.responses.create",
  "requireHosted",
  "OPENAI_ACTION_PROMPT_ID",
  "OPENAI_REPLY_PROMPT_ID",
  'provider: "openai_responses_decode"',
  'provider: "openai_responses_reply_manager"',
  "async phraseNotice(",
  "allowed_saved",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`prompt_wiring_missing:${missing.join(",")}`);

const forbidden = [
  'loadPrompt("haim-action.he.md")',
  'loadPrompt("haim-reply.he.md")',
  'mode: "git"',
  "git:prompts/haim-reply.he.md",
  "withCanonical(",
  "{{canonical}}",
];
const present = forbidden.filter((value) => source.includes(value));
if (present.length)
  throw new Error(`prompt_wiring_forbidden_present:${present.join(",")}`);

const calls = source.match(/this\.client\.responses\.create/g)?.length ?? 0;
if (calls < 2) throw new Error(`prompt_wiring_expected_two_calls:${calls}`);

const mapSource = await readFile("src/domain/field-map.ts", "utf8");
const mapped = new Set();
for (const match of mapSource.matchAll(
  /table:\s*"([a-z_]+)",\s*column:\s*"([a-z_]+)"/g,
))
  mapped.add(`${match[1]}.${match[2]}`);
const excluded = new Set();
const excludedBlock = mapSource.slice(
  mapSource.indexOf("export const EXCLUDED_COLUMNS"),
  mapSource.indexOf("export const FIELD_MAP"),
);
for (const match of excludedBlock.matchAll(
  /table:\s*"([a-z_]+)",\s*column:\s*"([a-z_]+)"/g,
))
  excluded.add(`${match[1]}.${match[2]}`);

const tables = [
  "requests",
  "request_parties",
  "request_items",
  "request_media",
  "request_locations",
  "request_verifications",
  "searches",
  "matches",
  "conversations",
  "outbox",
];
const schema = new Map(tables.map((table) => [table, new Set()]));
const files = (await readdir("db/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sql = await readFile(join("db/migrations", file), "utf8");
  const up = sql.split(/-- Down Migration/)[0] ?? sql;
  for (const table of tables) {
    const create = up.match(
      new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\);`),
    );
    if (!create) continue;
    for (const line of create[1].split("\n")) {
      const column = line.trim().match(/^([a-z_]+)\s+/);
      if (column && !/^(PRIMARY|UNIQUE|CHECK|CONSTRAINT)$/i.test(column[1]))
        schema.get(table).add(column[1]);
    }
    for (const match of up.matchAll(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN(?: IF NOT EXISTS)? ([a-z_]+)`, "g"),
    ))
      schema.get(table).add(match[1]);
  }
}

const gaps = [];
for (const [table, columns] of schema) {
  for (const column of columns) {
    const key = `${table}.${column}`;
    if (!mapped.has(key) && !excluded.has(key)) gaps.push(key);
  }
}
if (gaps.length) throw new Error(`field_map_gaps:${gaps.join(",")}`);

console.log("prompt_wiring_ok hosted-only field-map-complete");
