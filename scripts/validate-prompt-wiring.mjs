// Static, cost-free proof that action decode and customer replies stay
// separately wired: action uses the repository prompt as Responses instructions;
// reply/phrase use the hosted reply-manager prompt ID/version.
import { readFile } from "node:fs/promises";

const source = await readFile("src/infrastructure/ai.ts", "utf8");
const required = [
  "this.client.responses.create",
  'loadPrompt("haim-action.he.md")',
  "instructions: source.instructions",
  "id: this.c.OPENAI_REPLY_PROMPT_ID",
  "version: this.c.OPENAI_REPLY_PROMPT_VERSION",
  'provider: "openai_responses_decode"',
  'provider: "openai_responses_reply_manager"',
  "async phraseNotice(",
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) throw new Error(`prompt_wiring_missing:${missing.join(",")}`);
const calls = source.match(/this\.client\.responses\.create/g)?.length ?? 0;
if (calls < 2) throw new Error(`prompt_wiring_expected_two_calls:${calls}`);
if (!source.includes('mode: "git"') || !source.includes('mode: "hosted"'))
  throw new Error("prompt_wiring_expected_git_action_and_hosted_reply");
console.log(
  JSON.stringify(
    {
      ok: true,
      responses_calls: calls,
      action_uses_git_instructions: true,
      reply_uses_hosted_prompt: true,
    },
    null,
    2,
  ),
);
