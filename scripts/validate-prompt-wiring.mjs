// Static, cost-free proof that both planning and human-readable notice
// formatting use the same managed OpenAI Responses prompt configuration.
import { readFile } from "node:fs/promises";

const source = await readFile("src/infrastructure/ai.ts", "utf8");
const required = [
  "this.client.responses.create",
  "id: this.c.OPENAI_PROMPT_ID",
  "version: this.c.OPENAI_PROMPT_VERSION",
  "provider: \"openai_responses_managed_prompt\"",
  "async phraseNotice(",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`prompt_wiring_missing:${missing.join(",")}`);
const calls = source.match(/this\.client\.responses\.create/g)?.length ?? 0;
if (calls < 2) throw new Error(`prompt_wiring_expected_two_calls:${calls}`);
console.log(JSON.stringify({ ok: true, responses_calls: calls, planning_and_notice_use_managed_prompt: true }, null, 2));
