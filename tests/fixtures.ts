import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.js";
import { readConfig } from "../src/config.js";
import type {
  Command,
  Context,
  Plan,
  Request,
  Party,
  Item,
} from "../src/domain/types.js";
import type { Planner } from "../src/infrastructure/ai.js";
import type { Channel, Delivery } from "../src/infrastructure/waha.js";
import { asItem } from "../src/application/commands.js";
export const log = { info: () => {}, warn: () => {}, error: () => {} };
export const JPEG = Buffer.from([
  255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217,
]);
export const monday = new Date("2026-09-14T09:00:00Z");
export function config(extra: Partial<Config> = {}): Config {
  return {
    ...readConfig({
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:55432/postgres",
      DB_SCHEMA: "haim_core_test",
      BOT_MODE: "shadow",
      AI_ENABLED: "false",
      ENABLE_SIMULATE: "false",
      WAHA_WEBHOOK_HMAC_KEY: "test-only-hmac-key-not-a-secret-000000",
      HAIM_ADMIN_TOKEN: "test-only-admin-key-not-a-secret-00000",
      MEDIA_ROOT: "/tmp/haim-v5-test-media",
    }),
    ...extra,
  };
}
export class FakePlanner implements Planner {
  readonly plans = new Map<string, Plan>();
  calls = 0;
  fail = false;
  async plan(
    ctx: Context,
  ): Promise<{ plan: Plan; metadata: Record<string, unknown> }> {
    this.calls++;
    if (this.fail) throw new Error("simulated_openai_timeout");
    const plan = this.plans.get(ctx.message.id);
    if (!plan) throw new Error("missing_test_plan");
    return { plan, metadata: { test_double: true } };
  }
  async close(): Promise<void> {}
}
export class FakeChannel implements Channel {
  readonly sent: Delivery[] = [];
  error: Error | null = null;
  lidPhone = "501111111";
  async resolve(chat: string): Promise<string> {
    return chat.endsWith("@lid")
      ? this.lidPhone
      : chat.replace(/@.*/, "").replace(/^972/, "");
  }
  async send(d: Delivery): Promise<string> {
    this.sent.push(d);
    if (this.error) throw this.error;
    return `fake:${randomUUID()}`;
  }
}
export const donate = (
  description = "מיטה",
  kind: Item["kind"] = "bed",
): Command => ({
  type: "donate",
  items: [{ kind, description, quantity: 1 }],
  counterparty_phone: null,
  free: null,
  working: null,
});
export const facts = (
  over: Partial<Extract<Command, { type: "item_facts" }>> = {},
): Command => ({
  type: "item_facts",
  request_number: null,
  items: null,
  free: null,
  working: null,
  needs_disassembly: null,
  wardrobe_small_whole: null,
  oven_type: null,
  evacuation: null,
  ...over,
});
export const details = (
  over: Partial<Extract<Command, { type: "details" }>> = {},
): Command => ({
  type: "details",
  request_number: null,
  role: null,
  name: null,
  settlement: null,
  address: null,
  floor: null,
  ...over,
});
export function sampleRequest(): Request {
  const p = (role: Party["role"], phone: string): Party => ({
    role,
    phone,
    name: role === "donor" ? "מוסר בדיקה" : "מקבל בדיקה",
    settlement: "מחולה",
    address: "בכניסה",
    floor: 0,
    floor_note_shown: false,
    approved_at: monday.toISOString(),
    approved_by: phone,
    schedule_approved: true,
  });
  return {
    id: randomUUID(),
    number: 1,
    version: 1,
    status: "collecting",
    origin: "direct",
    items: [
      {
        ...asItem({ kind: "fridge", description: "מקרר", quantity: 1 }),
        free: true,
        working: true,
        needs_disassembly: false,
      },
    ],
    parties: [p("donor", "501111111"), p("receiver", "502222222")],
    photo_ids: [randomUUID()],
    run_date: null,
    earliest_run_date: null,
    human_reason: null,
    created_at: monday.toISOString(),
  };
}
