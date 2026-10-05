import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("./regression-catalog.json", import.meta.url), "utf8"));
const probes = JSON.parse(await readFile(new URL("./offline-probes.json", import.meta.url), "utf8"));
const ids = new Set(catalog.flatMap((entry) => entry.probe_ids ?? []));

if (!Array.isArray(catalog) || catalog.length < 20) throw new Error("regression_catalog_does_not_reconcile_history");
if (probes.length !== 12 || ids.size !== 12) throw new Error("all_twelve_probes_must_be_mapped");
for (const probe of probes) if (!ids.has(probe.id)) throw new Error(`probe_unmapped:${probe.id}`);
for (const entry of catalog) {
  if (!/^REG-[0-9]{3}$/.test(entry.id)) throw new Error(`bad_regression_id:${entry.id}`);
  if (!Array.isArray(entry.invariants) || entry.invariants.length === 0) throw new Error(`missing_invariants:${entry.id}`);
  if (!Array.isArray(entry.test_refs) || entry.test_refs.length === 0) throw new Error(`missing_test_refs:${entry.id}`);
  for (const ref of entry.test_refs) {
    if (!ref || !["unit", "integration", "command"].includes(ref.kind) || !ref.id) throw new Error(`invalid_test_ref:${entry.id}`);
    if (ref.kind !== "command" && !ref.name) throw new Error(`missing_stable_test_name:${entry.id}`);
    if (ref.kind === "command" && (!Array.isArray(ref.argv) || ref.argv.length === 0)) throw new Error(`missing_command:${entry.id}`);
  }
}

console.log(JSON.stringify({ ok: true, regressions: catalog.length, probes: ids.size }));
