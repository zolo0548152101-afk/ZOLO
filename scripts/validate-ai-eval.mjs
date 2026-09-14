import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "config/ai-eval-cases.json");
const cases = JSON.parse(await readFile(path, "utf8"));
const requiredIntents = new Set(["donate", "request", "direct", "status", "verification", "outside", "escalate"]);
if (!Array.isArray(cases) || cases.length < 8) throw new Error("ai_eval_requires_eight_cases");
const ids = new Set();
for (const row of cases) {
  if (!row.id || ids.has(row.id)) throw new Error(`invalid_or_duplicate_case:${row.id ?? "unknown"}`);
  ids.add(row.id);
  if (!(typeof row.input === "string" || Array.isArray(row.input))) throw new Error(`invalid_input:${row.id}`);
  if (!requiredIntents.has(row.expected_intent)) throw new Error(`unsupported_expected_intent:${row.id}`);
  if (!Array.isArray(row.expected_actions) || row.expected_actions.length === 0) throw new Error(`missing_expected_actions:${row.id}`);
  if (row.forbidden && !Array.isArray(row.forbidden)) throw new Error(`forbidden_must_be_array:${row.id}`);
}
for (const intent of requiredIntents) if (!cases.some((x) => x.expected_intent === intent)) throw new Error(`missing_intent_case:${intent}`);
console.log(JSON.stringify({ ok: true, cases: cases.length, intents: [...new Set(cases.map((x) => x.expected_intent))], forbidden_claim_cases: cases.filter((x) => x.forbidden?.length).length, remote_call: false }, null, 2));
