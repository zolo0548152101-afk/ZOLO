import { readFile } from "node:fs/promises";

const invariants = JSON.parse(await readFile(new URL("./domain-invariants.json", import.meta.url), "utf8"));
const scenarios = JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8"));
const known = new Set(invariants.map((item) => item.id));

if (!Array.isArray(invariants) || invariants.length < 20) throw new Error("invariant_catalog_too_small");
for (const scenario of scenarios) {
  if (!Array.isArray(scenario.invariant_ids) || scenario.invariant_ids.length === 0)
    throw new Error(`scenario_missing_invariants:${scenario.id}`);
  for (const id of scenario.invariant_ids) {
    if (!known.has(id)) throw new Error(`unknown_invariant:${scenario.id}:${id}`);
  }
}

console.log(JSON.stringify({ ok: true, invariants: invariants.length, scenarios: scenarios.length }));
