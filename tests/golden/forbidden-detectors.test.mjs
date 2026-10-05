import assert from "node:assert/strict";
import { forbiddenEffectErrors } from "../../dist-tests/tests/support/scenario-runner.js";

const scenario = (effect) => ({ flow: "direct_handoff", steps: [{ forbidden_effects: [effect] }] });
const base = { requests: [], searches: [], outbox: [], events: [], actualIntent: "acknowledge", phone: "584152101", message: null };

const cases = [
  {
    name: "stale_ai_plan_commit fires on stale plan",
    effect: "stale_ai_plan_commit",
    snapshot: { ...base, message: { error_code: "stale_plan", ai_plan: { commands: [] } } },
    expected: ["stale_ai_plan_commit"],
  },
  {
    name: "stale_ai_plan_commit stays quiet for current plan",
    effect: "stale_ai_plan_commit",
    snapshot: { ...base, message: { error_code: null, ai_plan: { commands: [] } } },
    expected: [],
  },
  {
    name: "wrong_party_notification fires on reply to another phone",
    effect: "wrong_party_notification",
    snapshot: { ...base, outbox: [{ phone: "536662043", text: "reply", dedupe_key: "reply:1" }] },
    expected: ["wrong_party_notification"],
  },
  {
    name: "wrong_party_notification stays quiet for current phone",
    effect: "wrong_party_notification",
    snapshot: { ...base, outbox: [{ phone: "584152101", text: "reply", dedupe_key: "reply:1" }] },
    expected: [],
  },
  {
    name: "blind_retry_after_uncertain_send fires on provider-bound uncertain row",
    effect: "blind_retry_after_uncertain_send",
    snapshot: { ...base, outbox: [{ state: "uncertain", provider_id: "provider-1", dedupe_key: "reply:1" }] },
    expected: ["blind_retry_after_uncertain_send:uncertain_row_has_provider_id"],
  },
  {
    name: "blind_retry_after_uncertain_send stays quiet for unique unbound uncertain row",
    effect: "blind_retry_after_uncertain_send",
    snapshot: { ...base, outbox: [{ state: "uncertain", provider_id: null, dedupe_key: "reply:1" }] },
    expected: [],
  },
];

for (const testCase of cases) {
  const actual = forbiddenEffectErrors(scenario(testCase.effect), 0, testCase.snapshot, null);
  assert.deepEqual(actual, testCase.expected, testCase.name);
}

console.log(JSON.stringify({ ok: true, cases: cases.length, passed: cases.length }));
