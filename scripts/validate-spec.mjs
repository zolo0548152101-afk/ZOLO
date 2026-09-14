import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, "../tests/spec/scenarios.json");
const required = ["id", "origin", "actor", "input", "state_before", "expected_actions", "expected_message_intent"];
const scenarios = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(scenarios) || scenarios.length < 4) throw new Error("spec_requires_at_least_four_scenarios");

const ids = new Set();
for (const scenario of scenarios) {
  if (!scenario || typeof scenario !== "object") throw new Error("scenario_must_be_object");
  for (const field of required) {
    if (!(field in scenario)) throw new Error(`missing_${field}:${String(scenario.id ?? "unknown")}`);
  }
  if (ids.has(scenario.id)) throw new Error(`duplicate_id:${scenario.id}`);
  ids.add(scenario.id);
  if (!Array.isArray(scenario.input) || scenario.input.length === 0) throw new Error(`input_must_be_nonempty:${scenario.id}`);
  if (!Array.isArray(scenario.expected_actions) || scenario.expected_actions.length === 0)
    throw new Error(`expected_actions_must_be_nonempty:${scenario.id}`);
  if (typeof scenario.expected_message_intent !== "string" || scenario.expected_message_intent.length < 3)
    throw new Error(`message_intent_invalid:${scenario.id}`);
  if (scenario.origin === "direct" && scenario.state_before.photo_required === true)
    throw new Error(`direct_cannot_require_photo:${scenario.id}`);
  if (scenario.origin === "open" && scenario.id === "open-donation-photo-first" && scenario.state_before.photo_required !== true)
    throw new Error(`open_donation_must_be_photo_first:${scenario.id}`);
}

console.log(JSON.stringify({ ok: true, scenarios: scenarios.length, ids: [...ids] }, null, 2));
