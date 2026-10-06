// Static, cost-free proof that action decode and customer replies stay
// separately wired from git prompts, and that the field map covers every
// customer-facing column in the in-scope tables.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = await readFile("src/infrastructure/ai.ts", "utf8");
const required = [
  "this.client.responses.create",
  'loadPrompt("haim-action.he.md")',
  'loadPrompt("haim-reply.he.md")',
  'loadPrompt("haim-data-map.he.md")',
  "instructions: source.instructions",
  'provider: "openai_responses_decode"',
  'provider: "openai_responses_reply_manager"',
  "async phraseNotice(",
  "git:prompts/haim-reply.he.md",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`prompt_wiring_missing:${missing.join(",")}`);
const calls = source.match(/this\.client\.responses\.create/g)?.length ?? 0;
if (calls < 2) throw new Error(`prompt_wiring_expected_two_calls:${calls}`);
if (!source.includes('mode: "git"'))
  throw new Error("prompt_wiring_expected_git_action_and_reply");
if (source.includes("id: this.c.OPENAI_REPLY_PROMPT_ID"))
  throw new Error("prompt_wiring_reply_still_hosted");
if (!source.includes("משפט מחייב:\\n${canonical}") && !source.includes("משפט מחייב:\\n${notice.text}"))
  throw new Error("prompt_wiring_git_phrase_missing_canonical");
if (!source.includes("notice.text"))
  throw new Error("prompt_wiring_notice_missing_canonical");
if (!source.includes("withCanonical("))
  throw new Error("prompt_wiring_missing_canonical_slot_injection");
const replyPrompt = await readFile("prompts/haim-reply.he.md", "utf8");
if (!replyPrompt.includes("{{canonical}}"))
  throw new Error("prompt_wiring_reply_prompt_missing_canonical_slot");

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
  }
  for (const match of up.matchAll(/ALTER TABLE ([a-z_]+)([\s\S]*?);/g)) {
    const table = match[1];
    if (!schema.has(table)) continue;
    for (const column of match[2].matchAll(
      /ADD COLUMN(?: IF NOT EXISTS)? ([a-z_]+)/g,
    ))
      schema.get(table).add(column[1]);
  }
}

const uncovered = [];
for (const [table, columns] of schema) {
  for (const column of columns) {
    const key = `${table}.${column}`;
    if (!mapped.has(key) && !excluded.has(key)) uncovered.push(key);
  }
}
if (uncovered.length)
  throw new Error(`field_map_missing_columns:${uncovered.sort().join(",")}`);

const mappedWritable = [
  ...mapSource.matchAll(
    /table:\s*"([a-z_]+)",\s*column:\s*"([a-z_]+)",\s*hebrew:\s*"[^"]+",\s*writer:\s*"([a-z_]+)"/g,
  ),
];
const commandNames = new Set();
const types = await readFile("src/domain/types.ts", "utf8");
for (const match of types.matchAll(/type:\s*z\.literal\("([a-z_]+)"\)/g))
  commandNames.add(match[1]);
const writers = new Set(["system", "engine", "read_only", ...commandNames]);
for (const match of mappedWritable) {
  if (!writers.has(match[3]))
    throw new Error(
      `field_map_unknown_writer:${match[1]}.${match[2]}=${match[3]}`,
    );
}

const { renderDataMap } = await import(
  pathToFileURL(join(process.cwd(), "dist/domain/field-map.js")).href,
).catch(() => ({ renderDataMap: null }));
let rendered;
if (renderDataMap) rendered = renderDataMap();
else rendered = await readFile("prompts/haim-data-map.he.md", "utf8");
const existing = await readFile("prompts/haim-data-map.he.md", "utf8").catch(
  () => "",
);
if (renderDataMap && existing !== rendered) {
  await writeFile("prompts/haim-data-map.he.md", rendered);
  if (existing)
    throw new Error(
      "field_map_prompt_stale:prompts/haim-data-map.he.md regenerated; commit the file",
    );
}
if (!rendered.includes("searches") || !rendered.includes("preferred_time"))
  throw new Error("field_map_prompt_missing_core_fields");

console.log(
  JSON.stringify(
    {
      ok: true,
      responses_calls: calls,
      action_uses_git_instructions: true,
      reply_uses_git_instructions: true,
      mapped_fields: mapped.size,
      excluded_fields: excluded.size,
    },
    null,
    2,
  ),
);
