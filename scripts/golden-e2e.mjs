import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const reportPath = resolve(root, process.env.GOLDEN_REPORT ?? "artifacts/qa/golden-report.json");
const statePath = resolve(root, process.env.GOLDEN_STATE ?? "artifacts/qa/golden-run-state.json");
const resume = process.argv.includes("--resume");
const fail = (message) => { console.error(JSON.stringify({ ok: false, error: message }, null, 2)); process.exit(1); };
if (!process.env.TEST_DATABASE_URL) fail("TEST_DATABASE_URL_required_for_golden");

const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.tests.json"], { cwd: root, encoding: "utf8", stdio: "inherit" });
if (compile.status !== 0) fail("golden_test_compilation_failed");
const catalog = spawnSync(process.execPath, [resolve(root, "tests/golden/catalog.test.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (catalog.status !== 0) fail(`golden_catalog_invalid:${catalog.stderr || catalog.stdout}`);
const detectorProof = spawnSync(process.execPath, [resolve(root, "tests/golden/forbidden-detectors.test.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (detectorProof.status !== 0) fail(`forbidden_detector_tests_failed:${detectorProof.stderr || detectorProof.stdout}`);
const detectorProofResult = JSON.parse(detectorProof.stdout.trim().split("\n").at(-1));
const blueprints = JSON.parse(await readFile(resolve(root, "tests/golden/scenarios.json"), "utf8"));
const contracts = JSON.parse(await readFile(resolve(root, "tests/golden/contracts.json"), "utf8"));
const scenarios = blueprints.flatMap((blueprint) => blueprint.variants.map((variant) => ({
  ...variant,
  title: variant.title ?? `${contracts[blueprint.flow].title}: ${variant.id}`,
  flow: blueprint.flow,
  invariant_ids: variant.invariant_ids ?? blueprint.invariant_ids,
  expected: variant.expected ?? contracts[blueprint.flow].expected,
  completion_criteria: variant.completion_criteria ?? contracts[blueprint.flow].completion_criteria,
})));
const catalogDigest = createHash("sha256").update(JSON.stringify(scenarios)).digest("hex");
let state = null;
if (resume) {
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { fail("golden_resume_state_missing"); }
  if (state.catalog_digest !== catalogDigest || (state.git_sha !== (process.env.GIT_SHA ?? "unknown"))) fail("golden_resume_state_incompatible");
} else {
  state = { run_id: randomUUID(), git_sha: process.env.GIT_SHA ?? "unknown", catalog_digest: catalogDigest, total: scenarios.length, completed: 0, passed: 0, failed: 0, timed_out: 0, next_scenario: scenarios[0]?.id ?? null, results: [] };
}
const prior = new Map((state.results ?? []).map((result) => [result.id, result]));
const pending = scenarios.filter((scenario) => !prior.has(scenario.id));
const { runGoldenScenarios } = await import(resolve(root, "dist-tests/tests/support/scenario-runner.js"));
const fresh = await runGoldenScenarios(pending, async (result, completed) => {
  prior.set(result.id, result);
  const ordered = scenarios.map((scenario) => prior.get(scenario.id)).filter(Boolean);
  state.completed = ordered.length;
  state.passed = ordered.filter((item) => item.status === "passed").length;
  state.failed = ordered.filter((item) => item.status === "failed").length;
  state.next_scenario = scenarios.find((scenario) => !prior.has(scenario.id))?.id ?? null;
  state.results = ordered;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
});
const results = scenarios.map((scenario) => prior.get(scenario.id)).filter(Boolean);
const report = {
  ok: results.every((result) => result.status === "passed"),
  generated_at: new Date().toISOString(),
  scenario_count: results.length,
  passed: results.filter((result) => result.status === "passed").length,
  failed: results.filter((result) => result.status === "failed").length,
  flows: Object.fromEntries([...new Set(results.map((result) => result.flow))].map((flow) => [flow, results.filter((result) => result.flow === flow).length])),
  clean: results.filter((result) => result.difficulty === "clean").length,
  challenging: results.filter((result) => result.difficulty === "challenging").length,
  cross_flow: results.filter((result) => result.flow === "cross_flow").length,
  failure_recovery: results.filter((result) => result.flow === "failure_recovery").length,
  git_sha: process.env.GIT_SHA ?? "unknown",
  forbidden_detector_proof: detectorProofResult,
  failure_classifications: Object.fromEntries([...new Set(results.map((result) => result.failure_classification).filter(Boolean))].map((classification) => [classification, results.filter((result) => result.failure_classification === classification).length])),
  environment: { database: "disposable PostgreSQL TEST_DATABASE_URL / haim_core_test", external_provider: "FakeChannel; no WAHA/OpenAI calls" },
  scenarios: results,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
state.next_scenario = scenarios.find((scenario) => !prior.has(scenario.id))?.id ?? null;
state.results = results;
state.completed = results.length;
state.passed = results.filter((item) => item.status === "passed").length;
state.failed = results.filter((item) => item.status === "failed").length;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ ok: report.ok, scenarios: report.scenario_count, passed: report.passed, failed: report.failed, report: reportPath }));
if (!report.ok) process.exitCode = 1;
