// T25 release qualification gate. It is side-effect free unless an external
// caller explicitly supplies a live adapter; the default is shadow only.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const TEST_NUMBERS = ["0584152101", "0536662043"];

export function normalizePhone(value) {
  const digits = String(value ?? "").trim().replace(/[^0-9]/g, "");
  if (digits.startsWith("9725") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith("5") && digits.length === 9) return `0${digits}`;
  return digits;
}

export function normalizeAllowlist(value) {
  return [...new Set(String(value ?? "").split(/[\s,;]+/).map(normalizePhone).filter(Boolean))].sort();
}

export function verifyCanaryConfig(env = process.env) {
  const mode = env.BOT_MODE ?? "shadow";
  const allowlist = normalizeAllowlist(env.LIVE_ALLOWLIST);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("shadow_default", mode !== "live", "shadow is the safe default and performs no external send");
  if (mode === "live") {
    add("operator_approval", env.APPROVE_LIVE_RELEASE === "YES", "explicit operator approval is required");
    add("allowlist_exact", JSON.stringify(allowlist) === JSON.stringify([...TEST_NUMBERS].sort()), "only the two approved test identities may receive canary traffic");
    add("snapshot", Boolean(env.RELEASE_SNAPSHOT_ID), "pre-release DB/media snapshot is required");
    add("dependencies", env.LIVE_DEPENDENCIES_VERIFIED === "true", "WAHA/API dependency smoke evidence is required");
    add("schema", env.DB_SCHEMA === "haim_core", "the target schema must be explicit");
    add("media", env.MEDIA_VOLUME_CONFIRMED === "true", "media volume and restore path must be confirmed");
    add("prompt", env.REMOTE_PROMPT_EVAL_PASSED === "true", "the pinned prompt evaluation must pass");
    add("location", env.LOCATION_DATASET_ACTIVATED === "true" && Boolean(env.LOCATION_DATASET_VERSION), "location dataset must be activated and versioned");
    add("qa_scope", env.QA_DISPOSABLE_DB_VERIFIED === "YES" && Boolean(env.QA_DATA_SCOPE_EVIDENCE_ID), "QA data scope must be evidenced");
  }
  return { ok: checks.every((check) => check.ok), mode, allowlist, checks };
}

export function qualifyShadowFlows(flows) {
  const required = ["direct", "open_donation", "self_transfer", "open_request"];
  const results = required.map((name) => {
    const flow = flows?.find((candidate) => candidate.name === name);
    const ok = Boolean(flow && flow.inbound && flow.outbound && flow.delivery_verified && flow.status_verified && flow.reconciliation_gap === 0);
    return { name, ok, detail: ok ? "inbound/outbound/delivery/status/reconciliation verified" : "required evidence is incomplete" };
  });
  return { ok: results.every((result) => result.ok), required_count: required.length, results };
}

export function rollbackPlan() {
  return {
    pause_gate: "stop new canary sends and workers before rollback",
    preserve: ["inbox", "outbox", "provider receipts", "snapshot", "evidence"],
    restore: "return webhook/traffic routing to the previous verified revision",
    destructive_delete: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = verifyCanaryConfig();
  console.log(JSON.stringify({ ...result, rollback: rollbackPlan() }, null, 2));
  if (!result.ok && result.mode === "live") process.exitCode = 1;
}
