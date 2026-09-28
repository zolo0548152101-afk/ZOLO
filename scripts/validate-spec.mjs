import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, "../tests/spec/scenarios.json");
const invariantsPath = resolve(here, "../tests/spec/domain-invariants.json");
const required = ["id", "origin", "actor", "input", "state_before", "expected_actions", "expected_message_intent"];
const scenarios = JSON.parse(await readFile(path, "utf8"));
const invariants = JSON.parse(await readFile(invariantsPath, "utf8"));
if (!Array.isArray(scenarios) || scenarios.length < 4) throw new Error("spec_requires_at_least_four_scenarios");
if (!Array.isArray(invariants) || invariants.length < 20) throw new Error("invariant_catalog_too_small");
const invariantIds = new Set(invariants.map((item) => item?.id));
if (invariantIds.size !== invariants.length || [...invariantIds].some((id) => typeof id !== "string" || id.length < 3))
  throw new Error("invariant_ids_must_be_unique_strings");

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
  if (!Array.isArray(scenario.invariant_ids) || scenario.invariant_ids.length === 0)
    throw new Error(`scenario_invariants_missing:${scenario.id}`);
  for (const invariantId of scenario.invariant_ids) {
    if (!invariantIds.has(invariantId)) throw new Error(`unknown_invariant:${scenario.id}:${invariantId}`);
  }
  if (scenario.origin === "direct" && scenario.state_before.photo_required === true)
    throw new Error(`direct_cannot_require_photo:${scenario.id}`);
  if (scenario.origin === "open" && scenario.id === "open-donation-photo-first" && scenario.state_before.photo_required !== true)
    throw new Error(`open_donation_must_be_photo_first:${scenario.id}`);
}

console.log(JSON.stringify({ ok: true, scenarios: scenarios.length, invariants: invariants.length, ids: [...ids] }, null, 2));
