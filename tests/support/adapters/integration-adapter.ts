import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "../../../src/config.js";
import { migrate } from "../../../src/db/migrate.js";
import { makePool } from "../../../src/db/pool.js";
import { Engine } from "../../../src/application/engine.js";
import { Queue } from "../../../src/infrastructure/queue.js";
import { Store } from "../../../src/infrastructure/store.js";
import { LocalMediaStorage } from "../../../src/infrastructure/media.js";
import { config, FakeChannel, FakePlanner, log } from "../../fixtures.js";
import type { Mode } from "../../../src/domain/types.js";
import { planSchema, type Plan } from "../../../src/domain/types.js";

export type GoldenStep = { inbound: { text: string; fixture_image?: string; external_id?: string; action?: string }; planner?: Plan; expect: { reply_intent_any: string[] }; forbidden_effects: string[] };
export type GoldenScenario = {
  id: string;
  flow: string;
  difficulty: string;
  steps: GoldenStep[];
  forbidden_effects: string[];
  invariant_ids: string[];
  expected: Record<string, unknown>;
  completion_criteria: string[];
};

const fixturePlan = (commands: Plan["commands"], evidence: string): Plan => ({ commands, evidence });

function plannerFixture(scenario: GoldenScenario, index: number): Plan | undefined {
  const key = `${scenario.id}:${index}`;
  const selfTransfer = (description: string, pickupStreet: string, pickupFloor: number, destinationStreet: string, destinationFloor: number) =>
    fixturePlan([
      { type: "donate", items: [{ kind: "other", description, quantity: 1 }], counterparty_phone: "536662043", direct: true, free: true, working: true },
      { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: pickupStreet, floor: pickupFloor },
      { type: "details", request_number: null, role: "receiver", name: null, settlement: "בית שאן", address: destinationStreet, floor: destinationFloor },
    ], key);
  const directOpening: Record<string, Plan> = {
    "direct-clean-01:0": fixturePlan([{ type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 2 }], key),
    "direct-clean-05:0": fixturePlan([{ type: "donate", items: [{ kind: "bed", description: "מיטה זוגית", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 1 }], key),
    "direct-challenge-01:0": fixturePlan([{ type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 2 }], key),
    "direct-challenge-03:0": fixturePlan([{ type: "donate", items: [{ kind: "chairs", description: "כיסא", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 1 }], key),
    "direct-challenge-04:0": fixturePlan([{ type: "donate", items: [{ kind: "other", description: "שידה", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: "יוסי", settlement: "בית שאן", address: "רחוב שיכון א", floor: 2 }], key),
    "direct-challenge-05:0": fixturePlan([{ type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 2 }], key),
    "donate-challenge-04:0": fixturePlan([{ type: "donate", items: [{ kind: "chairs", description: "כיסא", quantity: 1 }], counterparty_phone: null, direct: false, free: true, working: true }], key),
    "request-clean-05:0": fixturePlan([{ type: "seek", kind: "wardrobe" }], key),
    "cross-05:0": fixturePlan([{ type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: "584152101", counterparty_name: "טל", direct: true, free: null, working: null }, { type: "details", request_number: null, role: "donor", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 1 }], key),
  };
  const directApproval: Record<string, Plan> = {
    "direct-clean-04:1": fixturePlan([{ type: "contact_counterparty", request_number: 1, contact: true }], key),
  };
  const receiverDetails: Record<string, Plan> = {
    "request-clean-01:1": fixturePlan([{ type: "seek", kind: "bed" }], key),
    "request-clean-02:1": fixturePlan([{ type: "seek", kind: "chairs" }], key),
    "request-clean-03:1": fixturePlan([{ type: "seek", kind: "other" }], key),
    "request-clean-04:1": fixturePlan([{ type: "seek", kind: "table" }], key),
    "request-clean-05:1": fixturePlan([{ type: "seek", kind: "wardrobe" }], key),
    "request-challenge-01:0": fixturePlan([{ type: "seek", kind: "bed" }], key),
    "request-challenge-01:1": fixturePlan([{ type: "seek", kind: "bed" }], key),
    "request-challenge-02:1": fixturePlan([{ type: "seek", kind: "chairs" }], key),
    "request-challenge-03:1": fixturePlan([{ type: "seek", kind: "table" }], key),
    "request-challenge-04:1": fixturePlan([{ type: "seek", kind: "other" }], key),
    "request-challenge-05:1": fixturePlan([{ type: "seek", kind: "other" }], key),
    "failure-03:1": fixturePlan([{ type: "seek", kind: "chairs" }], key),
    "failure-06:1": fixturePlan([{ type: "seek", kind: "other" }], key),
  };
  const crossTransition: Record<string, Plan> = {
    "cross-01:1": fixturePlan([{ type: "counterparty", request_number: 1, phone: "584152101", name: "טל" }], key),
    "cross-02:1": fixturePlan([{ type: "counterparty", request_number: 1, phone: "584152101", name: "טל" }], key),
    "cross-06:1": fixturePlan([{ type: "counterparty", request_number: 1, phone: "584152101", name: "טל" }], key),
  };
  const selfTransferFixtures: Record<string, Plan> = {
    "self-clean-02:0": selfTransfer("מיטה", "רחוב שיכון א", 3, "רחוב העלייה", 1),
    "self-challenge-01:0": selfTransfer("כיסא", "רחוב שיכון א", 3, "רחוב העלייה", 1),
    "self-challenge-02:0": selfTransfer("שולחן", "רחוב העלייה", 1, "רחוב העלייה", 2),
    "self-challenge-03:0": selfTransfer("שידה", "רחוב העלייה", 2, "רחוב העלייה", 4),
    "self-challenge-04:0": selfTransfer("שולחן", "רחוב שיכון א", 3, "רחוב העלייה", 1),
    "self-challenge-05:0": selfTransfer("מיטה", "רחוב העלייה", 1, "רחוב העלייה", 2),
    "failure-02:0": selfTransfer("שולחן", "רחוב העלייה", 1, "רחוב העלייה", 2),
    "failure-05:0": selfTransfer("מיטה", "רחוב שיכון א", 3, "רחוב העלייה", 1),
    "self-challenge-03:1": fixturePlan([{ type: "details", request_number: 1, role: "receiver", name: null, settlement: "בית שאן", address: "רחוב העלייה", floor: 3 }], key),
  };
  const plan = directOpening[key] ?? directApproval[key] ?? receiverDetails[key] ?? crossTransition[key] ?? selfTransferFixtures[key];
  return plan
    ? { ...plan, evidence: scenario.steps[index]?.inbound.text ?? plan.evidence }
    : undefined;
}

export class IntegrationAdapter {
  readonly cfg: Config;
  readonly pool: ReturnType<typeof makePool>;
  readonly queue: Queue;
  readonly planner = new FakePlanner();
  readonly channel = new FakeChannel();
  readonly storage: LocalMediaStorage;
  readonly engine: Engine;
  private scenarioRun = 0;

  private constructor(cfg: Config, pool: ReturnType<typeof makePool>, queue: Queue, storage: LocalMediaStorage) {
    this.cfg = cfg;
    this.pool = pool;
    this.queue = queue;
    this.storage = storage;
    this.engine = new Engine(new Store(pool, queue, cfg), this.planner, this.channel, storage, log, () => new Date("2026-09-29T10:00:00.000Z"));
  }

  static async open(): Promise<IntegrationAdapter> {
    if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL_required_for_golden");
    const cfg = config({ DB_SCHEMA: "haim_core_test", BOT_MODE: "simulation", WAHA_SESSION: "golden", MEDIA_ROOT: "/tmp/haim-golden-media" });
    await migrate(cfg);
    const pool = makePool(cfg, log);
    await pool.query(
      `INSERT INTO service_locations(name,aliases,decision,is_city)
       VALUES('בית שאן',ARRAY['בית שאן','בית-שאן'],'allowed',true)
       ON CONFLICT(name) DO UPDATE SET aliases=EXCLUDED.aliases,decision='allowed',is_city=true`,
    );
    // The golden adapter owns its disposable location fixture. Keep the
    // catalog deterministic even when the base migration contains only the
    // minimal seed used by the application tests.
    await pool.query(
      `INSERT INTO streets(dataset_id,name,normalized,aliases)
       SELECT id,'העלייה','העלייה',ARRAY['העלייה','רחוב העלייה','העליה','רחוב העליה']::text[]
       FROM location_datasets WHERE active=true
       ON CONFLICT(dataset_id,normalized) DO UPDATE SET aliases=EXCLUDED.aliases`,
    );
    await pool.query(
      `INSERT INTO streets(dataset_id,name,normalized,aliases)
       SELECT id,'שיכון א','שיכון א',ARRAY['שיכון א','שיכון א׳']::text[]
       FROM location_datasets WHERE active=true
       ON CONFLICT(dataset_id,normalized) DO UPDATE SET aliases=EXCLUDED.aliases`,
    );
    const queue = new Queue(cfg, log, true, { schedule: false, supervise: false });
    await queue.start(true);
    const storage = new LocalMediaStorage(cfg);
    await storage.init();
    return new IntegrationAdapter(cfg, pool, queue, storage);
  }

  async reset(): Promise<void> {
    this.scenarioRun += 1;
    this.cfg.WAHA_SESSION = `golden-${this.scenarioRun}`;
    const tables = await this.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=$1 AND table_type='BASE TABLE'
         AND table_name NOT IN (
           'pgmigrations','schema_migrations','service_locations',
           'location_datasets','streets','integrations','app_settings'
         )`,
      [this.cfg.DB_SCHEMA],
    );
    if (tables.rows.length) {
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const qualified = tables.rows.map((row) => `${quote(this.cfg.DB_SCHEMA)}.${quote(row.table_name)}`).join(",");
      await this.pool.query(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE`);
    }
    this.channel.sent.length = 0;
    this.planner.plans.clear();
    this.planner.calls = 0;
    await this.assertReferenceFixture();
  }

  private async assertReferenceFixture(): Promise<void> {
    const area = await this.pool.query<{ decision: string }>(
      "SELECT decision FROM service_locations WHERE name='בית שאן'",
    );
    const streets = await this.pool.query<{ normalized: string }>(
      "SELECT normalized FROM streets WHERE normalized = ANY($1::text[])",
      [["העלייה", "שיכון א"]],
    );
    if (area.rows[0]?.decision !== "allowed" || streets.rows.length < 2)
      throw new Error("golden_reference_fixture_missing_after_reset");
  }

  async step(scenario: GoldenScenario, step: GoldenStep, index: number) {
    // Keep the simulated actor distinct from the explicitly named receiver in
    // direct-handoff scenarios. Using the receiver as sender makes the domain
    // correctly classify the request as a same-person/borderline case and
    // masks the conversation contract we are trying to exercise.
    const phone = scenario.flow === "open_donation" ? "584152101" : "536662043";
    const externalId = step.inbound.external_id ?? `${scenario.id}:${index}:${randomUUID()}`;
    const image = step.inbound.fixture_image ? await readFile(step.inbound.fixture_image) : null;
    const captured = image ? await this.storage.put(image, "image") : undefined;
    const stored = await this.engine.s.ingest({
      external_id: externalId,
      chat_id: `972${phone}@c.us`,
      kind: image ? "image" : "text",
      text: step.inbound.text,
      media_url: null,
      contacts: [],
      location: null,
    }, "simulation" as Mode, captured);
    const declaredPlanner = step.planner ?? plannerFixture(scenario, index);
    if (declaredPlanner) {
      const plan = planSchema.parse(declaredPlanner);
      // Persist the structured fixture before the normal ingestion path can
      // process the message. The FakePlanner must never infer a Plan from
      // Hebrew text or race the engine's deterministic branch.
      await this.pool.query(
        "UPDATE messages SET ai_plan=$2,ai_metadata=$3 WHERE id=$1 AND processed_at IS NULL",
        [stored.id, JSON.stringify(plan), JSON.stringify({ provider: "golden_fixture", action_source: "golden_fixture" })],
      );
    }
    await this.engine.ingestNext();
    await this.engine.process(stored.id);
    return this.snapshot(stored.id, phone, index);
  }

  async snapshot(messageId: string, phone: string, step: number) {
    const message = (await this.pool.query(`SELECT id,reply,processed_at,error_code,media_state,media_id,ai_plan,ai_metadata FROM messages WHERE id=$1`, [messageId])).rows[0] ?? null;
    const result = (await this.pool.query<{ result: { intent?: string } | null }>("SELECT result FROM command_results WHERE message_id=$1", [messageId])).rows[0]?.result;
    const requestRows = await this.pool.query<{ id: string }>("SELECT id FROM requests ORDER BY number");
    const requests = [];
    for (const row of requestRows.rows) requests.push(await this.engine.s.request(row.id));
    const outbox = (await this.pool.query("SELECT id,phone,text,state,media_id,match_id,dedupe_key FROM outbox ORDER BY seq")).rows;
    const events = (await this.pool.query("SELECT event_type,request_id,data FROM request_events ORDER BY created_at")).rows;
    const searches = (await this.pool.query("SELECT c.phone, s.kind, s.state, s.updated_at FROM searches s JOIN contacts c ON c.id=s.contact_id ORDER BY c.phone")).rows;
    const counts = (await this.pool.query<{ requests: number; messages: number }>("SELECT (SELECT count(*)::int FROM requests) requests,(SELECT count(*)::int FROM messages) messages")).rows[0]!;
    const actualIntent = result?.intent ?? (message?.reply ? "other" : "no_reply");
    return { message, requests, outbox, events, searches, counts, actualIntent, phone, step };
  }

  async close(): Promise<void> {
    await this.queue.stop();
    await this.pool.end();
  }
}
