// Static audit for the twelve historical probes. It proves that every probe
// has a named regression anchor in the current source/test tree; it never
// calls OpenAI, WAHA, a database, or an external service.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const probes = JSON.parse(await readFile(resolve(root, "tests/spec/offline-probes.json"), "utf8"));
const missing = [];
for (const probe of probes) {
  const source = await readFile(resolve(root, probe.file), "utf8");
  if (!source.includes(probe.title)) missing.push({ id: probe.id, file: probe.file, title: probe.title });
}
if (probes.length !== 12 || missing.length) {
  console.error(JSON.stringify({ ok: false, expected: 12, actual: probes.length, missing }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, probes: 12, ids: probes.map((x) => x.id), external_calls: false }, null, 2));
}
