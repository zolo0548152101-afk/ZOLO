import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "config/ai-eval-cases.json");
const cases = JSON.parse(await readFile(path, "utf8"));
const supportedManagedIntents = new Set(["donate", "request", "transport", "self_move", "cancellation", "unclear"]);
if (!Array.isArray(cases) || cases.length < 8) throw new Error("ai_eval_requires_eight_cases");
const ids = new Set();
for (const row of cases) {
  if (!row.id || ids.has(row.id)) throw new Error(`invalid_or_duplicate_case:${row.id ?? "unknown"}`);
  ids.add(row.id);
  if (!(typeof row.input === "string" || Array.isArray(row.input))) throw new Error(`invalid_input:${row.id}`);
  if (row.mode === "notice") {
    if (row.expected_notice !== true) throw new Error(`notice_case_requires_expected_notice:${row.id}`);
    continue;
  }
  if (!supportedManagedIntents.has(row.expected_intent)) throw new Error(`unsupported_expected_intent:${row.id}`);
  if (row.expected_command_types && (!Array.isArray(row.expected_command_types) || row.expected_command_types.length === 0))
    throw new Error(`invalid_expected_command_types:${row.id}`);
  if (row.expected_managed_actions && !Array.isArray(row.expected_managed_actions))
    throw new Error(`expected_managed_actions_must_be_array:${row.id}`);
  if (row.forbidden_managed_actions && !Array.isArray(row.forbidden_managed_actions))
    throw new Error(`forbidden_managed_actions_must_be_array:${row.id}`);
}
if (!cases.some((row) => Array.isArray(row.input))) throw new Error("missing_multi_message_case");
if (!cases.some((row) => row.expected_intent === "transport" && !row.expected_command_types))
  throw new Error("missing_freeform_transport_case");
if (!cases.some((row) => row.expected_command_types?.length)) throw new Error("missing_command_contract_case");
if (!cases.some((row) => row.expected_managed_actions?.includes("needs_human"))) throw new Error("missing_escalation_case");
if (!cases.some((row) => row.forbidden_managed_actions?.length)) throw new Error("missing_forbidden_action_case");
if (!cases.some((row) => row.mode === "notice")) throw new Error("missing_notice_case");
console.log(JSON.stringify({ ok: true, cases: cases.length, intents: [...new Set(cases.filter((x) => x.mode !== "notice").map((x) => x.expected_intent))], forbidden_action_cases: cases.filter((x) => x.forbidden_managed_actions?.length).length, remote_call: false }, null, 2));
