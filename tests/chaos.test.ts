import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { migrate } from "../src/db/migrate.js";
import { makePool } from "../src/db/pool.js";
import { Queue } from "../src/infrastructure/queue.js";
import { Store } from "../src/infrastructure/store.js";
import { LocalMediaStorage } from "../src/infrastructure/media.js";
import { Engine } from "../src/application/engine.js";
import { Runtime } from "../src/application/runtime.js";
import { makeHttp } from "../src/http.js";
import { canonicalPhone } from "../src/domain/policies.js";
import type { Command, Context, Party, Plan } from "../src/domain/types.js";
import { asItem } from "../src/application/commands.js";
import {
  config,
  log,
  JPEG,
  FakePlanner,
  FakeChannel,
  monday,
} from "./fixtures.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:disposable-test-only@127.0.0.1:5432/haim_chaos";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DATABASE_URL) && process.env.CHAOS_ALLOW_REMOTE !== "1")
  throw new Error("test:chaos refuses a non-local database");
process.env.TEST_DATABASE_URL = DATABASE_URL;

const CUSTOMERS = ["0584152101", "0536662043"].map(canonicalPhone);
const OTHER = "520000111";
const DATE = "2026-09-15";
const FORBIDDEN = ["נקבעה", "נאסוף", "ניקח", "נגיע לאסוף", "we'll pick up", "scheduled"];
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(16),
]);

type AiMode = "rules" | "next" | "fault" | "unclear" | "commands";
type ScenarioMessage = {
  text: string;
  ai?: AiMode;
  kind?: "text" | "image" | "voice" | "sticker";
  transcript?: string;
  commands?: Command[];
};
type Expectation = {
  replyIncludes?: string[];
  replyExcludes?: string[];
  status?: string;
  statusNot?: string;
  noRequest?: boolean;
  escalate?: boolean;
  runDate?: string | null;
  settlement?: string | null;
  floor?: number | null;
  itemKind?: string;
  verificationContacted?: boolean;
  historyIncludes?: string[];
  historyExcludes?: string[];
  bothNotified?: boolean;
  singleParty?: boolean;
  capacityUsed?: number;
};
type Scenario = {
  id: string;
  phone: string;
  messages: ScenarioMessage[];
  burst?: boolean;
  seed?: "capacity" | "coordinated" | "one-coordinated";
  thenPurge?: boolean;
  expect: Expectation;
};

class RecordingPlanner extends FakePlanner {
  lastHistory = "";
  override async plan(ctx: Context) {
    this.lastHistory = ctx.history.map((entry) => entry.content).join("\n");
    return super.plan(ctx);
  }
}

const cfg = config({
  MEDIA_ROOT: "/tmp/haim-chaos-media",
  ADMIN_PHONE: "500000999",
  DATABASE_URL,
  DB_SCHEMA: "haim_core_test",
  BOT_MODE: "shadow",
  AI_ENABLED: false,
  INTEGRATION_DISPATCH: false,
  WAHA_SESSION: "HAIM_YAHAD",
});
const ai = new RecordingPlanner();
const channel = new FakeChannel();
let pool: ReturnType<typeof makePool>;
let store: Store;
let engine: Engine;
let storage: LocalMediaStorage;
let queue: Queue;
let app: FastifyInstance;
const seededPhones: string[] = [];

function party(role: Party["role"], phone: string): Party {
  return {
    role,
    phone,
    name: "בדיקה",
    settlement: "בית שאן",
    address: "רחוב הרצל 1",
    floor: 1,
    floor_note_shown: true,
    approved_at: monday.toISOString(),
    approved_by: phone,
    schedule_approved: true,
    schedule_approved_date: DATE,
    schedule_approved_at: monday.toISOString(),
  };
}

async function purge(phone: string): Promise<number> {
  return (await store.purgePhone(phone)).deletedRequests;
}

async function wipe(): Promise<void> {
  await pool.query(`
    DELETE FROM integration_outbox;
    DELETE FROM transport_capacity_approvals;
    DELETE FROM request_events;
    DELETE FROM request_verifications;
    DELETE FROM outbox;
    DELETE FROM request_media;
    DELETE FROM request_locations;
    DELETE FROM matches;
    DELETE FROM request_parties;
    DELETE FROM request_items;
    UPDATE conversations SET selected_request_id=NULL;
    DELETE FROM requests;
    DELETE FROM command_results;
    UPDATE messages SET media_id=NULL, turn_id=NULL;
    DELETE FROM media;
    DELETE FROM turn_messages;
    DELETE FROM conversation_turns;
    DELETE FROM messages;
    DELETE FROM conversation_resets;
    DELETE FROM conversations;
    DELETE FROM contact_identities;
    DELETE FROM searches;
    DELETE FROM contacts;
    UPDATE transport_runs SET capacity=10 WHERE status='open';
  `);
}

async function ensureRun(): Promise<void> {
  await pool.query(
    "INSERT INTO transport_runs(date,capacity) VALUES($1,10) ON CONFLICT(date) DO UPDATE SET capacity=10",
    [DATE],
  );
}

async function seedCoordinated(donor: string, receiver: string): Promise<void> {
  await ensureRun();
  seededPhones.push(donor, receiver);
  const item = asItem({ kind: "bed", description: "מיטה", quantity: 1 });
  item.free = true;
  item.working = true;
  item.needs_disassembly = false;
  await store.transaction(async (c) => {
    const created = await store.create(
      c,
      [item],
      [party("donor", donor), party("receiver", receiver)],
      "direct",
    );
    created.status = "coordinated";
    created.run_date = DATE;
    created.represents_both_parties = donor === receiver;
    created.verification_contacted = true;
    await store.save(c, created);
    await c.query(
      `UPDATE conversations SET selected_request_id=$2
        WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)`,
      [donor, created.id],
    );
  });
}

async function seedCapacity(phone: string): Promise<void> {
  await ensureRun();
  for (let i = 1; i <= 10; i++) {
    const filler = `5310000${String(i).padStart(2, "0")}`;
    await seedCoordinated(filler, filler);
  }
  const item = asItem({ kind: "bed", description: "מיטה", quantity: 1 });
  item.free = true;
  item.working = true;
  item.needs_disassembly = false;
  seededPhones.push(phone);
  await store.transaction(async (c) => {
    const created = await store.create(
      c,
      [item],
      [party("donor", phone), party("receiver", phone)],
      "direct",
    );
    created.represents_both_parties = true;
    created.verification_contacted = true;
    await store.save(c, created);
  });
}

async function ingest(phone: string, message: ScenarioMessage): Promise<string> {
  const kind = message.kind === "sticker" || message.kind === "image"
    ? "image"
    : message.kind === "voice"
      ? "voice"
      : "text";
  const captured = kind === "image"
    ? await storage.put(JPEG, "image")
    : kind === "voice"
      ? await storage.put(WAV, "voice")
      : undefined;
  const saved = await store.ingest(
    {
      external_id: randomUUID(),
      chat_id: `972${phone}@c.us`,
      kind,
      text: message.text,
      media_url: null,
      contacts: [],
      location: null,
    },
    "shadow",
    captured,
  );
  if (message.transcript)
    await pool.query("UPDATE messages SET transcript=$2 WHERE id=$1", [
      saved.id,
      message.transcript,
    ]);
  if (message.ai === "unclear") ai.understood.set(saved.id, false);
  if (message.ai === "next")
    ai.plans.set(saved.id, { commands: [{ type: "next" }], evidence: message.text.slice(0, 2000) });
  if (message.ai === "commands" && message.commands)
    ai.plans.set(saved.id, {
      commands: message.commands,
      evidence: message.text.slice(0, 2000),
    } satisfies Plan);
  ai.fail = message.ai === "fault";
  return saved.id;
}

async function loadScenarios(): Promise<Scenario[]> {
  const dir = join(process.cwd(), "tests/scenarios");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as Scenario | Scenario[];
    scenarios.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return scenarios;
}

before(async () => {
  await migrate(cfg);
  pool = makePool(cfg, log);
  queue = new Queue(cfg, log, true, { schedule: false, supervise: false });
  await queue.start(true);
  store = new Store(pool, queue, cfg);
  storage = new LocalMediaStorage(cfg);
  await storage.init();
  engine = new Engine(store, ai, channel, storage, log, () => monday);
  const runtime = new Runtime(cfg, log, { pool, planner: ai, channel, storage });
  runtime.ready = true;
  runtime.store = store;
  runtime.engine = engine;
  runtime.queue = queue;
  app = await makeHttp(cfg, runtime, null);
  await app.ready();
  await wipe();
  ai.phraseReplyText = "מעולה, ההובלה נקבעה, אושר, ונאסוף אתכם";
});

after(async () => {
  await app?.close();
  await queue?.stop();
  await pool?.end();
});

test("chaos conversation limits", async () => {
  const scenarios = await loadScenarios();
  assert.ok(scenarios.length >= 40, `expected at least 40 scenarios, got ${scenarios.length}`);
  const report: {
    id: string;
    phone: string;
    pass: boolean;
    detail: string;
  }[] = [];
  for (const scenario of scenarios) {
    const phone = canonicalPhone(scenario.phone);
    const problems: string[] = [];
    ai.fail = false;
    ai.lastHistory = "";
    seededPhones.length = 0;
    try {
      for (const customer of CUSTOMERS) await purge(customer);
      await purge(OTHER);
      if (scenario.seed === "capacity") await seedCapacity(phone);
      if (scenario.seed === "coordinated") await seedCoordinated(phone, OTHER);
      if (scenario.seed === "one-coordinated") await seedCoordinated(phone, OTHER);
      const messages = scenario.messages.map((message) =>
        scenario.id === "very-long"
          ? { ...message, text: "בלה ".repeat(400) }
          : message,
      );
      let lastId = "";
      if (scenario.burst) {
        const ids: string[] = [];
        for (const message of messages) ids.push(await ingest(phone, message));
        for (let n = 0; n < ids.length; n++) await engine.ingestNext();
        lastId = ids.at(-1)!;
        await engine.processNext(lastId);
      } else {
        for (const message of messages) {
          lastId = await ingest(phone, message);
          await engine.ingestNext();
          await engine.process(lastId, message.ai === "fault");
          ai.fail = false;
        }
      }
      if (scenario.thenPurge) {
        const response = await app.inject({
          method: "POST",
          url: "/admin/requests/cancel-phone",
          headers: {
            "x-admin-token": cfg.HAIM_ADMIN_TOKEN,
            "content-type": "application/json",
          },
          payload: { phone: scenario.phone, confirm: "בטל פניות" },
        });
        if (response.statusCode !== 200)
          problems.push(`admin cleanup HTTP ${response.statusCode} ${response.body}`);
        else if (!response.json().deletedRequests)
          problems.push("admin cleanup deleted nothing");
      }
      const expect = scenario.expect;
      const replyRow = await pool.query<{ reply: string | null; error_code: string | null }>(
        "SELECT reply,error_code FROM messages WHERE id=$1",
        [lastId],
      );
      const reply = replyRow.rows[0]?.reply ?? "";
      const requests = await pool.query<{
        status: string;
        run_date: string | null;
        verification_contacted: boolean;
        settlement: string | null;
        floor: number | null;
        kind: string | null;
      }>(
        `SELECT r.status, r.run_date::text, r.verification_contacted,
                p.settlement, p.floor, i.kind
           FROM requests r
           JOIN request_parties p ON p.request_id=r.id AND p.role='donor'
           JOIN contacts co ON co.id=p.contact_id
           LEFT JOIN request_items i ON i.request_id=r.id AND i.position=0
          WHERE co.phone=$1
          ORDER BY r.number DESC LIMIT 1`,
        [phone],
      );
      const latest = requests.rows[0];
      const mode = await pool.query<{ mode: string }>(
        `SELECT cv.mode FROM conversations cv
           JOIN contacts co ON co.id=cv.contact_id WHERE co.phone=$1`,
        [phone],
      );
      const outbox = await pool.query<{ phone: string }>(
        "SELECT DISTINCT phone FROM outbox WHERE message_id=$1",
        [lastId],
      );
      const used = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM requests WHERE run_date=$1 AND status IN ('coordinated','closed')",
        [DATE],
      );
      for (const phrase of FORBIDDEN)
        if (reply.includes(phrase)) problems.push(`forbidden claim ${phrase}`);
      for (const phrase of expect.replyIncludes ?? [])
        if (!reply.includes(phrase)) problems.push(`reply missing ${phrase}; got ${reply.slice(0, 180)}`);
      for (const phrase of expect.replyExcludes ?? [])
        if (reply.includes(phrase)) problems.push(`reply contains ${phrase}`);
      if (expect.noRequest && latest) problems.push(`unexpected request ${latest.status}`);
      if (expect.status && latest?.status !== expect.status)
        problems.push(`status ${latest?.status ?? "none"} != ${expect.status}`);
      if (expect.statusNot && latest?.status === expect.statusNot)
        problems.push(`status should not be ${expect.statusNot}`);
      if (expect.runDate !== undefined && (latest?.run_date ?? null) !== expect.runDate)
        problems.push(`run_date ${latest?.run_date ?? "none"}`);
      if (expect.settlement !== undefined && (latest?.settlement ?? null) !== expect.settlement)
        problems.push(`settlement ${latest?.settlement ?? "none"}`);
      if (expect.floor !== undefined && (latest?.floor ?? null) !== expect.floor)
        problems.push(`floor ${latest?.floor ?? "none"}`);
      if (expect.itemKind && latest?.kind !== expect.itemKind)
        problems.push(`item ${latest?.kind ?? "none"} != ${expect.itemKind}`);
      if (
        expect.verificationContacted !== undefined &&
        latest?.verification_contacted !== expect.verificationContacted
      )
        problems.push(`verification_contacted ${latest?.verification_contacted}`);
      if (expect.escalate) {
        const human = mode.rows[0]?.mode === "human" || latest?.status === "human";
        if (!human) problems.push(`not escalated; mode ${mode.rows[0]?.mode ?? "none"} reply ${reply.slice(0, 120)}`);
      }
      if (expect.bothNotified) {
        const phones = new Set(outbox.rows.map((row) => row.phone));
        if (!phones.has(phone) || !phones.has(OTHER))
          problems.push(`both parties not notified: ${[...phones].join(",")}`);
      }
      if (expect.singleParty) {
        const phones = outbox.rows.map((row) => row.phone);
        if (phones.some((item) => item !== phone))
          problems.push(`unexpected other-party notice ${phones.join(",")}`);
      }
      if (expect.capacityUsed !== undefined && used.rows[0]!.n !== expect.capacityUsed)
        problems.push(`capacity used ${used.rows[0]!.n}`);
      const history = ai.lastHistory;
      for (const phrase of expect.historyIncludes ?? [])
        if (!history.includes(phrase)) problems.push(`history missing ${phrase}`);
      for (const phrase of expect.historyExcludes ?? [])
        if (history.includes(phrase)) problems.push(`history still has ${phrase}`);
      if (!scenario.thenPurge && !replyRow.rows[0]) problems.push("message missing");
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    } finally {
      ai.fail = false;
      for (const extra of seededPhones) {
        try { await purge(extra); } catch { /* report the scenario error first */ }
      }
      for (const customer of CUSTOMERS) {
        try { await purge(customer); } catch { /* same */ }
      }
      try { await purge(OTHER); } catch { /* same */ }
    }
    report.push({
      id: scenario.id,
      phone: scenario.phone,
      pass: problems.length === 0,
      detail: problems.join(" | ") || "ok",
    });
  }
  await mkdir("/opt/cursor/artifacts", { recursive: true });
  await mkdir("artifacts/qa", { recursive: true });
  const body = JSON.stringify({ scenarios: report.length, failed: report.filter((row) => !row.pass), report }, null, 2);
  await writeFile("/opt/cursor/artifacts/chaos-report.json", body);
  await writeFile("artifacts/qa/chaos-report.json", body);
  const failed = report.filter((row) => !row.pass);
  assert.deepEqual(failed, []);
});
