import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const catalog = JSON.parse(await readFile(resolve(root, "tests/spec/regression-catalog.json"), "utf8"));
const probes = JSON.parse(await readFile(resolve(root, "tests/spec/offline-probes.json"), "utf8"));
const reportPath = resolve(root, process.env.REGRESSION_REPORT ?? "artifacts/qa/regression-report.json");
const report = { ok: false, generated_at: new Date().toISOString(), suites: {}, regressions: [] };

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
  throw new Error(message);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ...result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function parseTap(output) {
  const tests = new Map();
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].match(/^# Subtest: (.+)$/);
    if (!heading) continue;
    const name = heading[1];
    for (let j = i + 1; j < lines.length; j += 1) {
      const status = lines[j].match(/^(ok|not ok) \d+ - (.+?)(?:\s+#.*)?$/);
      if (status) {
        tests.set(name, { name, status: status[1] === "ok" ? "passed" : "failed" });
        break;
      }
      if (lines[j].startsWith("# Subtest:")) break;
    }
  }
  return tests;
}

function assertCatalog() {
  if (!Array.isArray(catalog) || catalog.length < 20) fail("regression_catalog_must_reconcile_all_confirmed_history");
  if (catalog.some((entry) => !/^REG-[0-9]{3}$/.test(entry.id) || entry.status !== "covered")) fail("catalog_has_uncovered_or_invalid_entries");
  const knownProbeIds = new Set(probes.map((probe) => probe.id));
  const mappedProbeIds = new Set(catalog.flatMap((entry) => entry.probe_ids ?? []));
  if (mappedProbeIds.size !== probes.length || [...knownProbeIds].some((id) => !mappedProbeIds.has(id))) fail("offline_probe_not_mapped_to_regression");
  for (const entry of catalog) {
    if (!Array.isArray(entry.test_refs) || entry.test_refs.length === 0) fail(`missing_test_refs:${entry.id}`);
    for (const ref of entry.test_refs) {
      if (!ref || !["unit", "integration", "command"].includes(ref.kind) || !ref.id) fail(`invalid_test_ref:${entry.id}`);
      if (ref.kind !== "command" && !ref.name) fail(`missing_stable_test_name:${entry.id}`);
      if (ref.kind === "command" && (!Array.isArray(ref.argv) || ref.argv.length === 0)) fail(`missing_command:${entry.id}`);
    }
  }
}

assertCatalog();
const compile = run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.tests.json"]);
if (compile.status !== 0) fail("test_compilation_failed");

for (const suite of ["unit", "integration"]) {
  if (suite === "integration" && !process.env.TEST_DATABASE_URL) fail("TEST_DATABASE_URL_required_for_integration_regressions");
  const file = suite === "unit" ? "dist-tests/tests/unit.test.js" : "dist-tests/tests/integration.test.js";
  const result = run(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", file]);
  const tests = parseTap(result.output);
  report.suites[suite] = { status: result.status === 0 ? "passed" : "failed", tests: [...tests.values()], exit_code: result.status };
  if (result.status !== 0) fail(`${suite}_suite_failed`);
}

for (const entry of catalog) {
  const resolved = [];
  for (const ref of entry.test_refs) {
    if (ref.kind === "command") {
      const result = run(process.execPath, ref.argv.map((arg) => arg.endsWith(".mjs") ? resolve(root, arg) : arg));
      resolved.push({ kind: ref.kind, id: `command:${ref.id}`, status: result.status === 0 ? "passed" : "failed" });
      if (result.status !== 0) fail(`command_regression_failed:${entry.id}:${ref.id}`);
      continue;
    }
    const actual = report.suites[ref.kind].tests.find((test) => test.name === ref.name);
    if (!actual) fail(`referenced_test_not_found_or_not_executed:${entry.id}:${ref.kind}:${ref.name}`);
    if (actual.status !== "passed") fail(`referenced_test_failed:${entry.id}:${ref.kind}:${ref.name}`);
    resolved.push({ kind: ref.kind, id: `${ref.kind}:${ref.name}`, status: actual.status });
  }
  report.regressions.push({ id: entry.id, status: "PASS", tests: resolved });
}

report.ok = true;
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
for (const regression of report.regressions) {
  console.log(`${regression.id} PASS`);
  for (const test of regression.tests) console.log(`  ${test.kind}: ${test.id}`);
}
console.log(JSON.stringify({ ok: true, regressions: report.regressions.length, probes: probes.length, report: reportPath }));
