import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluationConfigEnv, evaluateCases, writeEvalEvidence } from "../scripts/ai-eval.mjs";

test("remote evaluation always isolates its configuration from production runtime validation", () => {
  const env = evaluationConfigEnv({ NODE_ENV: "production", BOT_MODE: "live", DB_SCHEMA: "haim_core" });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.BOT_MODE, "simulation");
  assert.equal(env.DB_SCHEMA, "haim_core_sim");
});

test("remote evaluation creates its evidence directory in a production runtime image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "haim-ai-eval-"));
  const evidencePath = join(directory, "nested", "t23-remote-prompt-eval.json");
  try {
    await writeEvalEvidence(evidencePath, { ok: true, total: 8 });
    assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), { ok: true, total: 8 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote evaluator preserves burst history and accepts the compatible planner contract", async () => {
  const seen = [];
  const planner = {
    async plan(context) {
      seen.push(context);
      return {
        plan: { commands: [{ type: "donate", items: [], direct: true }], evidence: "synthetic" },
        metadata: {
          managed_intent: "donate",
          managed_actions: {},
          managed_reply: "נבדוק את הפרטים ונחזור אליך.",
          response_id: "resp_synthetic",
          prompt_id: "pmpt_test",
          prompt_version: "1",
          model: "test-model",
        },
      };
    },
  };
  const report = await evaluateCases({
    cases: [
      {
        id: "burst-direct",
        input: ["יש לי מיטה", "לטל 0584152101"],
        expected_intent: "donate",
        expected_command_types: ["donate"],
        require_direct: true,
      },
    ],
    planner,
    now: () => "2026-10-04T00:00:00.000Z",
  });

  assert.equal(report.ok, true);
  assert.equal(report.passed, 1);
  assert.equal(report.forbidden_operational_claims, 0);
  assert.equal(seen[0].message.text, "לטל 0584152101");
  assert.deepEqual(seen[0].history, [{ role: "user", content: "יש לי מיטה" }]);
});

test("remote evaluator rejects duplicate commands and forbidden operational claims", async () => {
  const planner = {
    async plan() {
      return {
        plan: {
          commands: [{ type: "donate", items: [] }, { type: "donate", items: [] }],
          evidence: "synthetic",
        },
        metadata: {
          managed_intent: "donate",
          managed_actions: {},
          managed_reply: "פניתי כבר לצד השני.",
          response_id: "resp_synthetic",
        },
      };
    },
  };
  const report = await evaluateCases({
    cases: [{ id: "unsafe", input: "יש לי מיטה", expected_intent: "donate", expected_command_types: ["donate"] }],
    planner,
    now: () => "2026-10-04T00:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.results[0].violations.sort(), ["duplicate_command:donate", "forbidden_operational_claim"]);
  assert.equal(report.forbidden_operational_claims, 1);
});

test("remote evaluator rejects an operational claim from a synthetic notice", async () => {
  const planner = {
    async phraseNotice() {
      return { text: "פניתי כבר לאדם השני.", metadata: { response_id: "resp_notice" } };
    },
  };
  const report = await evaluateCases({
    cases: [{ id: "notice", mode: "notice", input: "אישור", expected_notice: true }],
    planner,
    now: () => "2026-10-04T00:00:00.000Z",
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.results[0].violations, ["forbidden_operational_claim"]);
});

test("remote evaluator requires a provider response id as availability evidence", async () => {
  const planner = {
    async plan() {
      return {
        plan: { commands: [{ type: "donate", items: [] }], evidence: "synthetic" },
        metadata: { managed_intent: "donate", managed_actions: {}, managed_reply: "נבדוק את הפרטים." },
      };
    },
  };
  const report = await evaluateCases({
    cases: [{ id: "missing-provider-id", input: "יש לי מיטה", expected_intent: "donate", expected_command_types: ["donate"] }],
    planner,
    now: () => "2026-10-04T00:00:00.000Z",
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.results[0].violations, ["missing_response_id"]);
});

test("the checked-in remote contract has eight runnable planner cases including a burst and safety coverage", async () => {
  const cases = JSON.parse(await readFile(new URL("../config/ai-eval-cases.json", import.meta.url), "utf8"));
  assert.equal(cases.length, 8);
  assert.ok(cases.every((row) => row.mode === "notice" || (Array.isArray(row.expected_command_types) && row.expected_command_types.length > 0)));
  assert.ok(cases.some((row) => Array.isArray(row.input)));
  assert.ok(cases.some((row) => Array.isArray(row.forbidden_managed_actions) && row.forbidden_managed_actions.length > 0));
  assert.ok(cases.some((row) => row.mode === "notice"));
});
