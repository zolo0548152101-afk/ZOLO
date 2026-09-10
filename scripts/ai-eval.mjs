// Explicit opt-in: invokes the real model on synthetic data. No DB or channel adapter.
import { randomUUID } from "node:crypto";
import { readConfig } from "../dist/config.js";
import { OpenAIPlanner } from "../dist/infrastructure/ai.js";
if (process.env.RUN_PAID_AI_EVAL !== "true")
  throw new Error("Set RUN_PAID_AI_EVAL=true to approve API charges");
const c = readConfig({
  ...process.env,
  BOT_MODE: "simulation",
  DB_SCHEMA: "haim_core_sim",
  AI_ENABLED: "true",
  DATABASE_URL: "postgres://unused/unused",
  HAIM_ADMIN_TOKEN: "eval-only-not-used-admin-token-0000000",
  WAHA_WEBHOOK_HMAC_KEY: "eval-only-not-used-webhook-key-0000000",
});
const planner = new OpenAIPlanner(c);
const cases = [
  { text: "יש לי מיטה למסירה", expected: "donate" },
  { text: "אני מחפש מקרר", expected: "seek" },
  { text: "מה הסטטוס?", expected: "status" },
  { text: "אני רוצה לדבר עם אדם", expected: "escalate" },
];
let failed = 0;
try {
  for (const row of cases) {
    const ctx = {
      conversation: {
        id: randomUUID(),
        phone: "500000001",
        chat_id: "972500000001@c.us",
        mode: "bot",
        selected_request_id: null,
        version: 1,
      },
      requests: [],
      candidates: [],
      history: [],
      message: {
        id: randomUUID(),
        seq: "1",
        external_id: randomUUID(),
        trace_id: randomUUID(),
        mode: "simulation",
        chat_id: "972500000001@c.us",
        phone: "500000001",
        kind: "text",
        text: row.text,
        contacts: [],
        location: null,
        media_url: null,
        media_id: null,
        media_state: "none",
        transcript: null,
        processed_at: null,
        ai_plan: null,
      },
    };
    try {
      const result = await planner.plan(ctx);
      const ok = result.plan.commands.some((x) => x.type === row.expected);
      if (!ok) failed++;
      console.log(
        JSON.stringify({
          case: row.expected,
          ok,
          commands: result.plan.commands.map((x) => x.type),
          metadata: result.metadata,
        }),
      );
    } catch (error) {
      failed++;
      console.log(
        JSON.stringify({
          case: row.expected,
          ok: false,
          code: error.code ?? error.name,
        }),
      );
    }
  }
} finally {
  await planner.close();
}
if (failed) process.exitCode = 1;
