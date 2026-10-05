import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAllowlist, qualifyShadowFlows, rollbackPlan, verifyCanaryConfig } from "./t25-canary-gate.mjs";

test("shadow is the safe default", () => {
  const result = verifyCanaryConfig({});
  assert.equal(result.ok, true);
  assert.equal(result.mode, "shadow");
});

test("live rejects missing release evidence", () => {
  const result = verifyCanaryConfig({ BOT_MODE: "live", LIVE_ALLOWLIST: "0584152101,0536662043" });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === "snapshot" && !check.ok));
});

test("allowlist normalizes Israeli formats and rejects extra identities", () => {
  assert.deepEqual(normalizeAllowlist("+972584152101 0536662043"), ["0536662043", "0584152101"]);
  const result = verifyCanaryConfig({ BOT_MODE: "live", LIVE_ALLOWLIST: "0584152101,0536662043,0543414386" });
  assert.equal(result.checks.find((check) => check.name === "allowlist_exact").ok, false);
});

test("four shadow flows require all evidence and zero reconciliation gaps", () => {
  const flow = (name) => ({ name, inbound: true, outbound: true, delivery_verified: true, status_verified: true, reconciliation_gap: 0 });
  const result = qualifyShadowFlows([flow("direct"), flow("open_donation"), flow("self_transfer"), flow("open_request")]);
  assert.equal(result.ok, true);
  assert.equal(result.required_count, 4);
});

test("a missing delivery or reconciliation proof fails qualification", () => {
  const result = qualifyShadowFlows([{ name: "direct", inbound: true, outbound: true, delivery_verified: false, status_verified: true, reconciliation_gap: 0 }]);
  assert.equal(result.ok, false);
});

test("rollback preserves evidence and never deletes data", () => {
  const plan = rollbackPlan();
  assert.equal(plan.destructive_delete, false);
  assert.ok(plan.preserve.includes("inbox"));
  assert.ok(plan.preserve.includes("outbox"));
});
