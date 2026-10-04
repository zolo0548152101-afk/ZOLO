// Explicit opt-in remote prompt evaluation. It uses synthetic contexts only and
// deliberately has no database, transport, WAHA, or channel adapter.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const forbiddenOperationalClaim = /(?:פניתי|פנינו|שלחתי|שלחנו|יצרתי\s+קשר|יצרנו\s+קשר|תיאמתי|תיאמנו|בוצע|נשלח)/u;

const truthyActions = (value) =>
  Object.entries(value && typeof value === "object" ? value : {})
    .filter(([, enabled]) => enabled === true || enabled === "true" || enabled === "כן")
    .map(([key]) => key)
    .sort();

const commandSignature = (command) => JSON.stringify(command);

export function buildEvalContext(input) {
  const messages = Array.isArray(input) ? input : [input];
  if (!messages.length || messages.some((message) => typeof message !== "string" || !message.trim()))
    throw new Error("eval_case_input_must_be_nonempty_strings");
  const current = messages.at(-1);
  return {
    conversation: {
      id: randomUUID(), phone: "500000001", chat_id: "972500000001@c.us", mode: "bot",
      selected_request_id: null, version: 1,
    },
    requests: [], candidates: [],
    history: messages.slice(0, -1).map((content) => ({ role: "user", content })),
    message: {
      id: randomUUID(), seq: "1", external_id: randomUUID(), trace_id: randomUUID(),
      mode: "simulation", chat_id: "972500000001@c.us", phone: "500000001", kind: "text", text: current,
      contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null,
      processed_at: null, ai_plan: null,
    },
  };
}

export function evaluationConfigEnv(env) {
  return {
    ...env,
    // A remote prompt eval must not inherit live-runtime validation or connect
    // to its database/transport. The paid call receives synthetic data only.
    NODE_ENV: "test",
    BOT_MODE: "simulation",
    DB_SCHEMA: "haim_core_sim",
    AI_ENABLED: "true",
    DATABASE_URL: "postgres://unused/unused",
    HAIM_ADMIN_TOKEN: "eval-only-not-used-admin-token-0000000",
    WAHA_WEBHOOK_HMAC_KEY: "eval-only-not-used-webhook-key-0000000",
  };
}

function evaluateResult(row, result) {
  const commands = Array.isArray(result?.plan?.commands) ? result.plan.commands : [];
  const commandTypes = commands.map((command) => command.type);
  const metadata = result?.metadata ?? {};
  const actions = truthyActions(metadata.managed_actions);
  const violations = [];
  const responseIdPresent = typeof metadata.response_id === "string" && metadata.response_id.length > 0;
  if (!responseIdPresent) violations.push("missing_response_id");
  if (metadata.managed_intent !== row.expected_intent)
    violations.push(`intent:${String(metadata.managed_intent)}!=${row.expected_intent}`);
  for (const expected of row.expected_command_types ?? [])
    if (!commandTypes.includes(expected)) violations.push(`missing_command:${expected}`);
  for (const expected of row.expected_managed_actions ?? [])
    if (!actions.includes(expected)) violations.push(`missing_managed_action:${expected}`);
  for (const forbidden of row.forbidden_managed_actions ?? [])
    if (actions.includes(forbidden)) violations.push(`forbidden_managed_action:${forbidden}`);
  if (row.require_direct && !commands.some((command) => command.type === "donate" && command.direct === true))
    violations.push("missing_direct_donation");
  const signatures = new Set();
  for (const command of commands) {
    const signature = commandSignature(command);
    if (signatures.has(signature)) violations.push(`duplicate_command:${command.type}`);
    signatures.add(signature);
  }
  if (forbiddenOperationalClaim.test(String(metadata.managed_reply ?? "")))
    violations.push("forbidden_operational_claim");
  return {
    id: row.id,
    ok: violations.length === 0,
    violations,
    observed: {
      intent: metadata.managed_intent ?? null,
      command_types: commandTypes,
      managed_actions: actions,
      response_id_present: responseIdPresent,
    },
  };
}

function evaluateNotice(row, result) {
  const text = String(result?.text ?? "").trim();
  const metadata = result?.metadata ?? {};
  const violations = [];
  const responseIdPresent = typeof metadata.response_id === "string" && metadata.response_id.length > 0;
  if (!responseIdPresent) violations.push("missing_response_id");
  if (!text) violations.push("empty_notice");
  if (forbiddenOperationalClaim.test(text)) violations.push("forbidden_operational_claim");
  return {
    id: row.id,
    ok: violations.length === 0,
    violations,
    observed: {
      intent: metadata.managed_intent ?? null,
      command_types: [],
      managed_actions: truthyActions(metadata.managed_actions),
      response_id_present: responseIdPresent,
    },
  };
}

export async function evaluateCases({ cases, planner, now = () => new Date().toISOString() }) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("ai_eval_requires_cases");
  if (!planner) throw new Error("ai_eval_requires_planner");
  const startedAt = now();
  const results = [];
  for (const row of cases) {
    try {
      const context = buildEvalContext(row.input);
      if (row.mode === "notice") {
        if (typeof planner.phraseNotice !== "function") throw new Error("notice_planner_unavailable");
        results.push(evaluateNotice(row, await planner.phraseNotice(
          context,
          { phone: "500000002", text: "התקבלה בקשה לאימות. האם נוח לך שנמשיך?" },
          null,
        )));
      } else {
        if (typeof planner.plan !== "function") throw new Error("planner_unavailable");
        results.push(evaluateResult(row, await planner.plan(context)));
      }
    } catch (error) {
      results.push({
        id: row.id, ok: false,
        violations: [`planner_error:${String(error?.code ?? error?.name ?? "unknown")}`],
        observed: { intent: null, command_types: [], managed_actions: [], response_id_present: false },
      });
    }
  }
  const failed = results.filter((result) => !result.ok);
  return {
    schema_version: 1, kind: "remote_prompt_eval", started_at: startedAt, finished_at: now(),
    total: results.length, passed: results.length - failed.length, failed: failed.length,
    forbidden_operational_claims: results.filter((result) => result.violations.includes("forbidden_operational_claim")).length,
    ok: failed.length === 0, results,
  };
}

export async function writeEvalEvidence(filePath, evidence) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function resolveEvalEvidencePath(env) {
  return env.AI_EVAL_EVIDENCE_PATH || "/tmp/haim-t23-remote-prompt-eval.json";
}

async function main() {
  if (process.env.RUN_PAID_AI_EVAL !== "true")
    throw new Error("Set RUN_PAID_AI_EVAL=true to approve API charges");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for remote evaluation");
  const [{ readConfig }, { OpenAIPlanner }] = await Promise.all([
    import("../dist/config.js"), import("../dist/infrastructure/ai.js"),
  ]);
  const c = readConfig(evaluationConfigEnv(process.env));
  const cases = JSON.parse(await readFile(resolve(process.cwd(), "config/ai-eval-cases.json"), "utf8"));
  if (cases.length < 8) throw new Error("ai_eval_requires_eight_cases");
  const planner = new OpenAIPlanner(c);
  try {
    const report = await evaluateCases({ cases, planner });
    const evidence = {
      ...report,
      prompt: { id: c.OPENAI_PROMPT_ID, version: c.OPENAI_PROMPT_VERSION, model: c.OPENAI_MODEL },
      synthetic_only: true, database_accessed: false, channel_accessed: false,
    };
    await writeEvalEvidence(resolveEvalEvidencePath(process.env), evidence);
    console.log(JSON.stringify({ ok: evidence.ok, total: evidence.total, passed: evidence.passed, forbidden_operational_claims: evidence.forbidden_operational_claims }, null, 2));
    if (!evidence.ok || evidence.forbidden_operational_claims !== 0) process.exitCode = 1;
  } finally {
    await planner.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
