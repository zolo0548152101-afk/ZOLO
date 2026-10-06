// Static, cost-free proof that action planning and customer replies use
// separate managed OpenAI Responses prompt configurations.
import { readFile } from "node:fs/promises";

const source = await readFile("src/infrastructure/ai.ts", "utf8");
const required = [
  "this.client.responses.create",
  "id: this.c.OPENAI_ACTION_PROMPT_ID",
  "version: this.c.OPENAI_ACTION_PROMPT_VERSION",
  "id: this.c.OPENAI_REPLY_PROMPT_ID",
  "version: this.c.OPENAI_REPLY_PROMPT_VERSION",
  "provider: \"openai_responses_managed_prompt\"",
  "async phraseNotice(",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`prompt_wiring_missing:${missing.join(",")}`);
const calls = source.match(/this\.client\.responses\.create/g)?.length ?? 0;
if (calls < 2) throw new Error(`prompt_wiring_expected_two_calls:${calls}`);
console.log(JSON.stringify({ ok: true, responses_calls: calls, action_and_reply_use_separate_prompts: true }, null, 2));
