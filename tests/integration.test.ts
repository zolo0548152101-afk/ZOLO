import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "../src/db/migrate.js";
import { makePool } from "../src/db/pool.js";
import { Queue, QUEUES } from "../src/infrastructure/queue.js";
import { Store } from "../src/infrastructure/store.js";
import { LocalMediaStorage } from "../src/infrastructure/media.js";
import { DeliveryError } from "../src/infrastructure/waha.js";
import { Engine } from "../src/application/engine.js";
import { Runtime } from "../src/application/runtime.js";
import { IntegrationDeliveryError, type IntegrationAdapter } from "../src/application/integration-port.js";
import { makeHttp } from "../src/http.js";
import {
  OUTSIDE,
} from "../src/domain/policies.js";
import type { Command, Plan, Request } from "../src/domain/types.js";
import {
  config,
  log,
  JPEG,
  FakePlanner,
  FakeChannel,
  donate,
  details,
  facts,
  sampleRequest,
  monday,
} from "./fixtures.js";

/** Historical markers — code no longer emits these fixed sentences. */
const PHOTO_FIRST = "בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.";
const PHOTO_THANKS = "תודה, התמונה התקבלה.";
const HUMAN_REPLY = "העברתי את הפנייה לטיפול אנושי. נעדכן.";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable test database. The suite only uses haim_core_test.",
  );
const pglite = process.env.TEST_BACKEND === "pglite";
let cfg = config(),
  s: Store,
  q: Queue,
  engine: Engine,
  storage: LocalMediaStorage,
  pool: ReturnType<typeof makePool>,
  app: FastifyInstance,
  runtime: Runtime,
  root = "";
const ai = new FakePlanner(),
  channel = new FakeChannel();
let counter = 0;
const phone = () => String(530000000 + ++counter);
before(async () => {
  root = await mkdtemp(join(tmpdir(), "haim-integration-"));
  cfg = config({ MEDIA_ROOT: root, HAIM_ADMIN_DESTRUCTIVE_TOKEN: "test-destructive-token", INTEGRATION_DISPATCH: true });
  await migrate(cfg);
  pool = makePool(cfg, log);
  const guard = await pool.query<{ n: number }>(
    "SELECT count(*)::int n FROM messages",
  );
  if (guard.rows[0]!.n > 0)
    throw new Error(
      "Test schema is not empty. Use a fresh disposable database; this suite does not erase data.",
    );
  q = new Queue(cfg, log, true, {
    ...(pglite ? { backend: "pglite" as const, useListenNotify: false } : {}),
    schedule: false,
    supervise: false,
  });
  await q.start(true);
  // PGlite multiplexes one backend; warm metadata outside application transactions.
  if (pglite) for (const name of QUEUES) await q.boss.fetch(name);
  s = new Store(pool, q, cfg);
  storage = new LocalMediaStorage(cfg);
  await storage.init();
  engine = new Engine(s, ai, channel, storage, log, () => monday);
  runtime = new Runtime(cfg, log, {
    pool,
    planner: ai,
    channel,
    storage,
  });
  runtime.ready = true;
  runtime.store = s;
  runtime.engine = engine;
  runtime.queue = q;
  app = await makeHttp(cfg, runtime, null);
  await app.ready();
});
after(async () => {
  await app?.close();
  await q?.stop();
  await pool?.end();
  if (root) await rm(root, { recursive: true, force: true });
});
async function enqueue(
  p: string,
  text: string,
  commands?: Command[],
  image = false,
  externalId = randomUUID(),
  chat?: string,
) {
  const saved = image ? await storage.put(JPEG, "image") : undefined;
  const m = await s.ingest(
    {
      external_id: externalId,
      chat_id: chat ?? `972${p}@c.us`,
      kind: image ? "image" : "text",
      text,
      media_url: null,
      contacts: [],
      location: null,
    },
    "shadow",
    saved,
  );
  if (commands) ai.plans.set(m.id, { commands, evidence: text.slice(0, 2000) });
  await engine.ingestNext();
  return m;
}
async function message(
  p: string,
  text: string,
  commands?: Command[],
  image = false,
) {
  const m = await enqueue(p, text, commands, image);
  await engine.process(m.id);
  return {
    ...m,
    message: await s.message(m.id),
    row: (
      await pool.query<{ reply: string | null }>(
        "SELECT reply FROM messages WHERE id=$1",
        [m.id],
      )
    ).rows[0]!,
  };
}
async function outputs(id: string) {
  return (
    await pool.query<{
      id: string;
      phone: string;
      text: string;
      state: string;
      media_id: string | null;
      match_id: string | null;
    }>(
      "SELECT id,phone,text,state,media_id,match_id FROM outbox WHERE message_id=$1 ORDER BY seq",
      [id],
    )
  ).rows;
}
async function flush(p: string) {
  const rows = await pool.query<{ id: string }>(
    "SELECT id FROM outbox WHERE phone=$1 AND state='pending' ORDER BY seq",
    [p],
  );
  for (const r of rows.rows) await engine.send(r.id);
}
async function donation(
  p: string,
  kind: Request["items"][number]["kind"] = "bed",
  label = "מיטה",
) {
  await message(p, `יש לי ${label} למסירה`, [donate(label, kind)]);
  return (await s.active(p))[0]!;
}
test("direct handoff with a known recipient accepts implicit donation wording", async () => {
  const donor = phone(), receiver = phone(), cmd = donate("מיטה זוגית", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  cmd.direct = true;
  const result = await message(donor, `מיטה זוגית לטל ${receiver}, איסוף מבית שאן רחוב העלייה קומה 1`, [cmd]);
  assert.doesNotMatch(result.row.reply ?? "", /ברצונך למסור/);
  assert.equal((await s.active(donor)).length, 1);
});
test("direct phone opening persists all donor facts from one corrected message", async () => {
  const donor = "536662043";
  const opening = "רגע, תיקון: יש לי שידה קטנה למסירה ישירות למספר 0584152101. אני טל מבית שאן, האיסוף מרחוב הגפן 6 קומה 2. אין לי תמונה.";
  await message(donor, opening);
  const active = await s.active(donor);
  assert.equal(active.length, 1);
  const request = active[0]!;
  assert.equal(request.origin, "direct");
  assert.equal(request.items.length, 1);
  assert.equal(request.items[0]!.description, "שידה");
  const giver = request.parties.find((party) => party.role === "donor")!;
  const recipient = request.parties.find((party) => party.role === "receiver")!;
  assert.equal(giver.name, "טל");
  assert.equal(giver.settlement, "בית שאן");
  assert.equal(giver.address, "רחוב הגפן 6");
  assert.equal(giver.floor, 2);
  assert.equal(recipient.phone, "584152101");
  assert.equal(
    (await pool.query("SELECT 1 FROM request_media WHERE request_id=$1", [request.id])).rowCount,
    0,
  );
  // The default QA recipient is also the fixture's admin phone; close this
  // isolated request so later admin-flow tests cannot inherit it as active state.
  await pool.query("UPDATE requests SET status='closed' WHERE id=$1", [request.id]);
});
async function readyRequest(p = phone(), receiver = phone()) {
  let r = await donation(p, "fridge", "מקרר");
  await message(p, "", undefined, true);
  r = await s.request(r.id);
  const sample = sampleRequest();
  r.items = sample.items;
  r.parties = sample.parties.map((x) => ({
    ...x,
    phone: x.role === "donor" ? p : receiver,
    approved_by: x.role === "donor" ? p : receiver,
  }));
  r.origin = "direct";
  r.verification_contacted = true;
  r.proposed_run_date = r.proposed_run_date ?? "2026-09-15";
  r.run_date = null;
  await s.transaction(async (c) => {
    await s.prepareTransportRun(c, r.proposed_run_date!);
    await c.query(
      "INSERT INTO request_verifications(request_id,role,state,consented_at) VALUES($1,'receiver','consented',clock_timestamp()) ON CONFLICT(request_id,role) DO UPDATE SET state='consented',consented_at=clock_timestamp()",
      [r.id],
    );
    await s.request(r.id, c, true);
    await s.save(c, r);
  });
  return r;
}
async function setProposedDate(r: Request, date: string) {
  r.run_date = null;
  r.proposed_run_date = date;
  r.status = "awaiting_approval";
  for (const p of r.parties) {
    p.schedule_approved = true;
    p.schedule_approved_date = date;
    p.schedule_approved_at = new Date().toISOString();
  }
  await s.transaction(async (c) => {
    await s.prepareTransportRun(c, date);
    const locked = await s.request(r.id, c, true);
    locked.run_date = null;
    locked.proposed_run_date = date;
    locked.status = r.status;
    locked.parties = r.parties;
    await s.save(c, locked);
    r.version = locked.version;
  });
}

test("migrations are idempotent; legacy schema untouched; relational constraints reject invalid data", async () => {
  await pool.query("CREATE SCHEMA IF NOT EXISTS haim");
  await pool.query("DROP TABLE IF EXISTS haim.v5_test_legacy_marker");
  await pool.query("CREATE TABLE haim.v5_test_legacy_marker(id integer)");
  await pool.query("INSERT INTO haim.v5_test_legacy_marker VALUES(42)");
  await migrate(cfg);
  assert.equal(
    (
      await pool.query<{ id: number }>(
        "SELECT id FROM haim.v5_test_legacy_marker",
      )
    ).rows[0]!.id,
    42,
  );
  await assert.rejects(
    pool.query("INSERT INTO contacts(phone) VALUES('0500000000')"),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO transport_runs(date,capacity) VALUES('2026-09-16',1)",
    ),
  );
});
test("שלום: no request, no AI, exactly one shadow reply and zero channel sends", async () => {
  const p = phone(),
    calls = ai.calls,
    m = await message(p, "שלום");
  assert.equal(ai.calls, calls);
  assert.equal((await s.active(p)).length, 0);
  const out = await outputs(m.id);
  assert.equal(out.length, 1);
  await engine.send(out[0]!.id);
  assert.equal(channel.sent.length, 0);
  assert.equal((await outputs(m.id))[0]!.state, "shadow");
});
test("donor bed without receiver PHOTO FIRST; opening facts retained before photo", async () => {
  const p = phone(),
    m = await message(p, "יש לי מיטה למסירה, שמי בדיקה במחולה בכניסה", [
      donate(),
      details({ name: "בדיקה", settlement: "מחולה", address: "בכניסה" }),
    ]);
  const r = (await s.active(p))[0]!;
  assert.equal(m.row.reply, PHOTO_FIRST);
  // PHOTO-FIRST is the next customer ask; facts from the opening message are
  // still persisted so they are not re-asked after the image arrives.
  assert.equal(r.parties[0]!.name, "בדיקה");
  assert.equal(r.parties[0]!.settlement, "מחולה");
  assert.equal(r.parties[0]!.address, "בכניסה");
  assert.equal(r.parties[0]!.approved_by, p);
  assert.equal(r.items[0]!.working, null);
});
test("donor image persists checksum and request link; acknowledgement continues safely", async () => {
  const p = phone(),
    r = await donation(p),
    m = await message(p, "", undefined, true),
    after = await s.request(r.id);
  assert.ok(m.row.reply?.startsWith(PHOTO_THANKS));
  assert.equal(after.photo_ids.length, 1);
  const media = (
    await pool.query<{
      storage_key: string;
      checksum: string;
      size_bytes: string;
    }>("SELECT storage_key,checksum,size_bytes FROM media WHERE id=$1", [
      after.photo_ids[0],
    ])
  ).rows[0]!;
  assert.equal(media.checksum.length, 64);
  assert.deepEqual(await storage.get(media.storage_key), JPEG);
  const retrieved = await app.inject({
    method: "GET",
    url: `/admin/media/${after.photo_ids[0]}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
  });
  assert.equal(retrieved.statusCode, 200);
  assert.deepEqual(retrieved.rawPayload, JPEG);
});
test("מחולה בכניסה accepted; supplied floor ignored and stored as ground", async () => {
  const p = phone(),
    r = await donation(p);
  await message(p, "", undefined, true);
  const m = await message(p, "שמי בדיקה, מחולה, בכניסה, קומה 4", [
    details({
      name: "בדיקה",
      settlement: "מחולה",
      address: "בכניסה",
      floor: 4,
    }),
  ]);
  const updated = await s.request(r.id);
  assert.equal(updated.parties[0]!.address, "בכניסה");
  assert.equal(updated.parties[0]!.floor, 0);
  assert.doesNotMatch(m.row.reply ?? "", /קומה|קומות|רחוב/);
});
test("active location dataset resolves approved Beit Shean street aliases", async () => {
  assert.deepEqual(await s.region(pool, "שיכון א"), {
    name: "שיכון א",
    decision: "allowed",
  });
  assert.deepEqual(await s.region(pool, "רחוב העליה"), {
    name: "רחוב העלייה",
    decision: "allowed",
  });
});
test("settlement and street in one message persist both fields", async () => {
  const p = phone();
  const r = await donation(p, "bed", "מיטה");
  const result = await message(p, "בית שאן, רחוב העליה", [
    details({ request_number: r.number, role: "donor", settlement: "בית שאן", address: "רחוב העליה" }),
  ]);
  assert.doesNotMatch(result.row.reply ?? "", /נא לציין שם וכתובת/);
  const saved = await s.request(r.id);
  assert.equal(saved.parties.find((x) => x.role === "donor")?.settlement, "בית שאן");
  assert.equal(saved.parties.find((x) => x.role === "donor")?.address, "רחוב העליה");
});
test("official Beit Shean snapshot stages and resolves a normalized street before rollback", async () => {
  const csv = await readFile("tests/fixtures/beit-shean-streets-official.csv", "utf8");
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.shift(), "name,settlement,aliases");
  const rows = lines.map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","בית שאן","((?:[^"]|"")*)"$/);
    assert.ok(match, `invalid staged street row: ${line}`);
    return {
      name: match![1]!.replaceAll('""', '"'),
      aliases: match![2]!.replaceAll('""', '"').split("|").filter(Boolean),
    };
  });
  assert.equal(rows.length, 244);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    await client.query(
      "INSERT INTO location_datasets(id,version,source,checksum,active) VALUES($1,$2,$3,$4,false)",
      [id, `test-official-${id}`, "fixture:data.gov.il", "fixture-checksum"],
    );
    for (const row of rows)
      await client.query(
        "INSERT INTO streets(dataset_id,name,normalized,aliases) VALUES($1,$2,$3,$4)",
        [id, row.name, row.name.normalize("NFKC").replace(/[־–—-]/g, " ").replace(/\s+/g, " ").trim(), row.aliases],
      );
    await client.query("UPDATE location_datasets SET active=false WHERE active=true");
    await client.query("UPDATE location_datasets SET active=true WHERE id=$1", [id]);
    assert.deepEqual(await s.region(client, "הרצל"), { name: "הרצל", decision: "allowed" });
    assert.deepEqual(await s.region(client, "רחוב העליה"), { name: "רחוב העלייה", decision: "allowed" });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
test("clear outside endpoint stops, including mixed AI escalation plan; no admin alert", async () => {
  const p = phone(),
    r = await donation(p);
  await message(p, "", undefined, true);
  const m = await message(p, "צריך להגיע לחיפה", [
    { type: "escalate", request_number: null, reason: "borderline_area" },
    details({ settlement: "חיפה" }),
  ]);
  assert.equal(m.row.reply, OUTSIDE);
  assert.equal((await s.request(r.id)).status, "rejected");
  assert.equal(
    (await outputs(m.id)).filter((o) => o.phone === cfg.ADMIN_PHONE).length,
    0,
  );
});
test("a party can correct an outside-area rejection without losing the direct request facts", async () => {
  const donor = phone(), receiver = phone(), cmd = donate("מיטה", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  cmd.direct = true;
  await message(donor, `יש לי מיטה למסירה לטל ${receiver}`, [cmd]);
  const request = (await s.active(donor))[0]!;
  await message(receiver, "כן", [
    { type: "approve_self", request_number: request.number },
  ]);
  await message(donor, "יוסי, בית שאן, רחוב המלך 5, קומה 2", [
    details({
      request_number: request.number,
      role: "donor",
      name: "יוסי",
      settlement: "בית שאן",
      address: "רחוב המלך 5",
      floor: 2,
    }),
  ]);
  await message(receiver, "טבריה, רחוב הגליל 10, קומה 1", [
    details({
      request_number: request.number,
      role: "receiver",
      settlement: "טבריה",
      address: "רחוב הגליל 10",
      floor: 1,
    }),
  ]);
  assert.equal((await s.request(request.id)).status, "rejected");

  const corrected = await message(
    receiver,
    "טעיתי, אני בבית שאן, רחוב שאול המלך 10, קומה 1",
  );
  const saved = await s.request(request.id);
  const receiverParty = saved.parties.find((party) => party.role === "receiver")!;
  assert.notEqual(saved.status, "rejected");
  assert.equal(receiverParty.settlement, "בית שאן");
  assert.equal(receiverParty.address, "רחוב שאול המלך 10");
  assert.equal(receiverParty.floor, 1);
  assert.equal(saved.items[0]!.description, "מיטה");
  assert.doesNotMatch(corrected.row.reply ?? "", /איזה רהיט|איזה פריט|מה מעבירים/);
});
test("unknown/borderline settlement escalates instead of falsely classifying outside", async () => {
  const p = phone();
  await donation(p);
  await message(p, "", undefined, true);
  const m = await message(p, "ליישוב לא ברור", [
    details({ settlement: "יישוב לא ברור" }),
  ]);
  assert.equal(m.row.reply, HUMAN_REPLY);
  assert.equal(
    (await outputs(m.id)).some((o) => o.phone === cfg.ADMIN_PHONE),
    true,
  );
});
test("wardrobe disassembly rejected after image; old ready state cannot survive rejection", async () => {
  const p = phone(),
    r = await donation(p, "wardrobe", "ארון");
  await message(p, "", undefined, true);
  const m = await message(p, "הארון צריך פירוק", [
    facts({ needs_disassembly: true }),
  ]);
  assert.match(m.row.reply ?? "", /אין אצלנו פירוק/);
  assert.equal((await s.request(r.id)).status, "rejected");
});
test("small wardrobe transportable whole is accepted after photo", async () => {
  const p = phone(),
    r = await donation(p, "wardrobe", "ארון");
  await message(p, "", undefined, true);
  await message(p, "הארון קטן ועובר שלם ללא פירוק, חינם ותקין", [
    facts({
      wardrobe_small_whole: true,
      needs_disassembly: false,
      free: true,
      working: true,
    }),
  ]);
  const updated = await s.request(r.id);
  assert.equal(updated.items[0]!.wardrobe_small_whole, true);
  assert.notEqual(updated.status, "rejected");
});
test("fridge suppresses disassembly; more than two items create no request", async () => {
  const p = phone(),
    r = await donation(p, "fridge", "מקרר");
  await message(p, "", undefined, true);
  const m = await message(p, "המקרר בחינם ותקין", [
    facts({ free: true, working: true }),
  ]);
  assert.doesNotMatch(m.row.reply ?? "", /פירוק/);
  assert.equal((await s.request(r.id)).items[0]!.needs_disassembly, false);
  const other = phone(),
    cmd = donate();
  if (cmd.type !== "donate") throw new Error();
  cmd.items[0]!.quantity = 3;
  const rejected = await message(other, "יש לי 3 מיטות למסירה", [cmd]);
  assert.match(rejected.row.reply ?? "", /שני פריטים/);
  assert.equal((await s.active(other)).length, 0);
});
test("requester seeks fridge before details; no matches means no request/details collected", async () => {
  const p = phone(),
    m = await message(p, "מחפש מדיח", [{ type: "seek", kind: "dishwasher" }]);
  assert.equal((await s.active(p)).length, 0);
  assert.match(m.row.reply ?? "", /לא נמצא פריט מתאים/);
});
test("requester asking for an item למסירה is not routed to the donor photo flow", async () => {
  const p = phone(),
    m = await message(
      p,
      "צריך כיסא דחוף לבית שאן, לא משנה לי שכונה, רק שיהיה למסירה ולא קנייה.",
    );
  assert.equal((await s.active(p)).length, 0);
  assert.match(m.row.reply ?? "", /לא נמצא פריט מתאים/);
  assert.doesNotMatch(m.row.reply ?? "", /תמונה/);
});
test("match with image: image delivered before interest/receiver details and exclusive claim", async () => {
  const donor = phone(),
    receiver = phone(),
    r = await donation(donor, "freezer", "מקפיא");
  await message(donor, "", undefined, true);
  const found = await message(receiver, "מחפש מקפיא", [
    { type: "seek", kind: "freezer" },
  ]);
  const out = (await outputs(found.id)).find((o) => o.phone === receiver)!;
  assert.ok(out.media_id);
  assert.equal((await s.active(receiver)).length, 0);
  const premature = await message(receiver, "מעוניין", [
    { type: "interest", request_number: r.number },
  ]);
  assert.match(premature.row.reply ?? "", /קודם נציג/);
  await flush(receiver);
  await message(receiver, "מעוניין במקפיא", [
    { type: "interest", request_number: r.number },
  ]);
  assert.equal((await s.active(receiver))[0]!.id, r.id);
  assert.equal(
    (await s.request(r.id)).parties.find((p) => p.role === "receiver")!
      .approved_at,
    null,
  );
});
test("match without photo requests it from donor; multiple waiting receivers survive", async () => {
  const donor = phone(),
    a = phone(),
    b = phone(),
    r = await donation(donor, "dryer", "מייבש");
  const ma = await message(a, "מחפש מייבש", [{ type: "seek", kind: "dryer" }]);
  await message(b, "מחפש מייבש", [{ type: "seek", kind: "dryer" }]);
  assert.match(ma.row.reply ?? "", /נבקש מהמוסר תמונה/);
  assert.equal((await s.active(a)).length, 0);
  const count = await pool.query<{ n: number }>(
    "SELECT count(*)::int n FROM matches WHERE request_id=$1 AND state='waiting_photo'",
    [r.id],
  );
  assert.equal(count.rows[0]!.n, 2);
  const photo = await message(donor, "", undefined, true);
  const out = await outputs(photo.id);
  assert.equal(out.filter((o) => o.media_id).length, 2);
});
test("donor and receiver approvals are separate and repeat approval preserves timestamp", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("מקרר", "fridge");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  await message(donor, `יש לי מקרר למסירה למקבל ${receiver}`, [cmd]);
  const r = (await s.active(donor))[0]!;
  assert.ok(r.parties.find((p) => p.role === "donor")!.approved_at);
  assert.equal(r.parties.find((p) => p.role === "receiver")!.approved_at, null);
  await message(receiver, "מאשר את הקבלה", [
    { type: "approve_self", request_number: r.number },
  ]);
  const first = await s.request(r.id);
  assert.equal(first.parties.find((p) => p.role === "receiver")!.approved_at !== null, true);
  assert.equal(first.parties.find((p) => p.role === "receiver")!.schedule_approved, false);
  await message(receiver, "מאשר שוב", [
    { type: "approve_self", request_number: r.number },
  ]);
  const second = await s.request(r.id);
  assert.equal(
    first.parties.find((p) => p.role === "receiver")!.approved_at,
    second.parties.find((p) => p.role === "receiver")!.approved_at,
  );
});
test("both parties must explicitly approve the same proposed Tuesday before coordination", async () => {
  const donor = phone(), receiver = phone(), r = await readyRequest(donor, receiver);
  r.status = "awaiting_approval";
  r.run_date = null;
  r.proposed_run_date = "2026-09-15";
  for (const p of r.parties) {
    p.schedule_approved = false;
    p.schedule_approved_date = null;
    p.schedule_approved_at = null;
  }
  await s.transaction(async (c) => {
    const locked = await s.request(r.id, c, true);
    locked.status = r.status;
    locked.run_date = null;
    locked.proposed_run_date = r.proposed_run_date;
    locked.parties = r.parties;
    await s.save(c, locked);
  });

  const receiverPrompt = await message(receiver, "הצג את הפנייה", [
    { type: "select", request_number: r.number },
  ]);
  assert.match(receiverPrompt.row.reply ?? "", /יום שלישי 15\/09\/2026/);
  assert.match(receiverPrompt.row.reply ?? "", /נא לאשר את המועד/);
  await message(receiver, "מאשר את התאריך 15/09/2026");
  let stored = await s.request(r.id);
  assert.equal(stored.status, "awaiting_approval");
  assert.equal(stored.parties.find((p) => p.role === "receiver")!.schedule_approved_date, "2026-09-15");
  assert.equal(stored.parties.find((p) => p.role === "donor")!.schedule_approved_date, null);
  assert.equal(stored.run_date, null);

  const donorPrompt = await message(donor, "הצג את הפנייה", [
    { type: "select", request_number: r.number },
  ]);
  assert.match(donorPrompt.row.reply ?? "", /יום שלישי 15\/09\/2026/);
  await message(donor, "מאשר את התאריך 15/09/2026");
  stored = await s.request(r.id);
  assert.equal(stored.status, "coordinated");
  assert.equal(stored.proposed_run_date, null);
  assert.equal(stored.run_date, "2026-09-15");
  assert.ok(stored.parties.every((p) => p.schedule_approved_date === stored.run_date));
});
test("natural schedule approval accepts a database timestamp and preserves the other party approval", async () => {
  const donor = phone(), receiver = phone(), r = await readyRequest(donor, receiver);
  await pool.query(
    "UPDATE requests SET status='awaiting_approval', proposed_run_date=$2::timestamptz, run_date=NULL WHERE id=$1",
    [r.id, "2026-09-29T00:00:00.000Z"],
  );
  await pool.query(
    "UPDATE request_parties SET schedule_approved=true, schedule_approved_date=$2::timestamptz, schedule_approved_at=clock_timestamp() WHERE request_id=$1 AND role='receiver'",
    [r.id, "2026-09-29T00:00:00.000Z"],
  );
  const prompt = await message(donor, "מה מצב פנייה 1?", [
    { type: "select", request_number: r.number },
  ]);
  assert.match(prompt.row.reply ?? "", /נדרש עדיין אישור|נא לאשר את המועד/);
  const approved = await message(donor, "מאשר את המועד 29\/09\/2026");
  const saved = await s.request(r.id);
  assert.equal(saved.parties.find((p) => p.role === "donor")!.schedule_approved, true);
  assert.equal(saved.parties.find((p) => p.role === "receiver")!.schedule_approved, true);
  assert.notEqual(saved.status, "rejected");
  assert.doesNotMatch(approved.row.reply ?? "", /פירוק|תקין ושמיש/);
});
test("explicit shared-date approval from the other party chat coordinates without repeating the proposal", async () => {
  const donor = phone(), receiver = phone(), r = await readyRequest(donor, receiver);
  r.status = "awaiting_approval";
  r.run_date = null;
  r.proposed_run_date = "2026-09-29";
  const receiverParty = r.parties.find((party) => party.role === "receiver")!;
  receiverParty.schedule_approved = true;
  receiverParty.schedule_approved_date = "2026-09-29";
  receiverParty.schedule_approved_at = new Date().toISOString();
  const donorParty = r.parties.find((party) => party.role === "donor")!;
  donorParty.schedule_approved = false;
  donorParty.schedule_approved_date = null;
  donorParty.schedule_approved_at = null;
  await s.transaction(async (c) => {
    await s.prepareTransportRun(c, "2026-09-29");
    const locked = await s.request(r.id, c, true);
    locked.status = r.status;
    locked.run_date = null;
    locked.proposed_run_date = r.proposed_run_date;
    locked.parties = r.parties;
    await s.save(c, locked);
  });

  const approved = await message(donor, "מאשר את המועד 29/09/2026");
  const saved = await s.request(r.id);

  assert.equal(saved.status, "coordinated");
  assert.equal(saved.run_date, "2026-09-29");
  assert.ok(saved.parties.every((party) => party.schedule_approved_date === "2026-09-29"));
  assert.doesNotMatch(approved.row.reply ?? "", /נא לאשר את המועד/);
});
test("direct donation skips the generic condition question", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("מיטה", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  const result = await message(donor, `יש לי מיטה למסירה למקבל ${receiver}`, [cmd]);
  assert.doesNotMatch(result.row.reply ?? "", /תקין ושמיש/);
  assert.match(result.row.reply ?? "", /אימות/);
  const r = (await s.active(donor))[0]!;
  assert.equal(r.items[0]!.working, true);
});

test("natural direct wording with a phone after the recipient skips photo and condition", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("מיטה", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  const result = await message(donor, `יש לי מיטה למסירה ישירות לטל ${receiver}`, [cmd]);
  assert.doesNotMatch(result.row.reply ?? "", /תמונה|תקין ושמיש/);
  const r = (await s.active(donor))[0]!;
  assert.equal(r.origin, "direct");
  assert.equal(r.parties.find((p) => p.role === "receiver")!.phone, receiver);
});

test("natural direct wording preserves the named recipient with the phone", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("מיטה", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  cmd.counterparty_name = "טל";
  const result = await message(
    donor,
    `שלום, אני רוצה למסור את המיטה לטל ${receiver} בבית שאן, רחוב המלך 5 קומה 2`,
    [cmd],
  );
  assert.match(result.row.reply ?? "", /אימות/);
  const r = (await s.active(donor))[0]!;
  assert.equal(r.parties.find((p) => p.role === "receiver")!.name, "טל");
});

test("direct recipient verification repeats supplied destination details and asks only for approval", async () => {
  const donor = phone(), receiver = phone();
  await message(
    donor,
    `שלום, אני רוצה למסור את המיטה לטל ${receiver} בבית שאן, רחוב המלך 5 קומה 2. המיטה בחינם, שלמה ושמישה.`,
  );
  const request = (await s.active(donor))[0]!;
  const receiverParty = request.parties.find((party) => party.role === "receiver")!;
  assert.equal(receiverParty.name, "טל");
  assert.equal(receiverParty.settlement, "בית שאן");
  assert.equal(receiverParty.address, "רחוב המלך 5");
  assert.equal(receiverParty.floor, 2);

  const contacted = await message(donor, "כן, תפנו לטל לצורך אימות הפרטים", [{
    type: "contact_counterparty",
    request_number: request.number,
    contact: true,
  }]);
  const notice = (await outputs(contacted.id)).find((row) => row.phone === receiver)?.text ?? "";
  assert.doesNotMatch(notice, /"kind"\s*:/);
  assert.match(notice, /טל/);
  assert.match(notice, /מיטה/);
  assert.match(notice, /בית שאן/);
  assert.match(notice, /רחוב המלך 5/);
  assert.match(notice, /קומה 2/);
  assert.match(notice, /שלישי/);
  assert.match(notice, /16:00–20:00/);
  assert.match(notice, /נא לאשר שהכתובת נכונה ושהיום מתאים/);

  const confirmed = await message(receiver, "כן, אני טל ומאשר לקבל את המיטה");
  assert.doesNotMatch(confirmed.row.reply ?? "", /לאיזה יישוב|כתובת/);
  assert.ok((await s.request(request.id)).parties.find((party) => party.role === "receiver")!.approved_at);
});

test("donor cannot overwrite receiver destination after the direct request creation message", async () => {
  const donor = phone(), receiver = phone();
  await message(
    donor,
    `אני רוצה למסור את המיטה לטל ${receiver} בבית שאן, רחוב המלך 5 קומה 2`,
  );
  const request = (await s.active(donor))[0]!;
  await message(donor, "תיקון: טל בכלל גרה בעפולה ברחוב אחר 99", [{
    type: "details",
    request_number: request.number,
    role: "receiver",
    name: null,
    settlement: "עפולה",
    address: "רחוב אחר 99",
    floor: 9,
  }]);
  const unchangedReceiver = (await s.request(request.id)).parties.find((party) => party.role === "receiver")!;
  assert.equal(unchangedReceiver.settlement, "בית שאן");
  assert.match(unchangedReceiver.address ?? "", /רחוב המלך 5/);
  assert.equal(unchangedReceiver.floor, 2);
});

test("donor can fill missing receiver destination together with contact consent", async () => {
  const donor = phone(), receiver = phone();
  await message(
    donor,
    `בדיקת יעד: יש לי מנורה שולחנית תקינה למסירה ישירות לטל ${receiver}. אני מבית שאן, האיסוף מרחוב העלייה 5 קומה 2. אין לי תמונה כרגע.`,
  );
  const request = (await s.active(donor))[0]!;
  assert.equal(request.origin, "direct");
  assert.equal(request.items[0]?.description, "מנורה");
  const before = request.parties.find((party) => party.role === "receiver")!;
  assert.equal(before.settlement, null);
  assert.equal(before.address, null);

  const contacted = await message(
    donor,
    "טל כהן, כתובת היעד בית שאן רחוב המלך 8 קומה 1. מאשר לפנות אליה לאימות.",
    [
      {
        type: "details",
        request_number: request.number,
        role: "receiver",
        name: null,
        settlement: "בית שאן",
        address: "רחוב המלך 8",
        floor: 1,
      },
      {
        type: "contact_counterparty",
        request_number: request.number,
        contact: true,
      },
    ],
  );
  assert.doesNotMatch(contacted.row.reply ?? "", /טיפול אנושי/);
  assert.match(contacted.row.reply ?? "", /נפנה לצד השני|אשלח|אימות/);
  const after = (await s.request(request.id)).parties.find((party) => party.role === "receiver")!;
  assert.equal(after.settlement, "בית שאן");
  assert.match(after.address ?? "", /רחוב המלך 8/);
  assert.equal(after.floor, 1);
  assert.equal((await s.request(request.id)).verification_contacted, true);
  const notice = (await outputs(contacted.id)).find((row) => row.phone === receiver)?.text ?? "";
  assert.match(notice, /מנורה/);
  assert.match(notice, /בית שאן/);
  assert.match(notice, /רחוב המלך 8/);
});

test("a contact candidate can convert an open donation before the photo gate", async () => {
  const donor = phone(), receiver = phone(), cmd = donate("מיטה", "bed");
  const started = await message(donor, "רוצה למסור מיטה", [cmd]);
  assert.match(started.row.reply ?? "", /תמונה/);
  const request = (await s.active(donor))[0]!;

  const candidate = await message(donor, `זה איש הקשר של טל ${receiver}`, [{
    type: "counterparty_candidate",
    request_number: request.number,
    phone: receiver,
    name: "טל",
  }]);
  assert.match(candidate.row.reply ?? "", /האם התכוונת למסור/);
  assert.doesNotMatch(candidate.row.reply ?? "", /שלחו כאן תמונה/);

  const confirmed = await message(donor, "כן", [{
    type: "confirm_counterparty",
    request_number: request.number,
    accept: true,
  }]);
  assert.doesNotMatch(confirmed.row.reply ?? "", /תמונה/);
  assert.equal((await s.request(request.id)).origin, "direct");
});

test("a plain admin yes remains part of the active conversation when no capacity approval is pending", async () => {
  const receiver = phone(), cmd = donate("שידה", "other");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  cmd.direct = true;
  await message(cfg.ADMIN_PHONE, `יש לי שידה למסור לטל ${receiver}`, [cmd]);
  const request = (await s.active(cfg.ADMIN_PHONE))[0]!;

  const result = await message(cfg.ADMIN_PHONE, "כן", [{
    type: "contact_counterparty",
    request_number: request.number,
    contact: true,
  }]);
  assert.doesNotMatch(result.row.reply ?? "", /בקשת הגדלת מכסה/);
  assert.match(result.row.reply ?? "", /נפנה לצד השני|כבר בוצעה/);
});
test("direct handoff keeps supplied pickup and extracts a later labeled donor name", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("שידה", "other");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  cmd.direct = true;
  const started = await message(
    donor,
    `יש לי שידה למסירה לטל ${receiver}. היא בבית שאן ברחוב העלייה 7 קומה 2`,
    [cmd],
  );
  assert.ok(started.row.reply);
  let request = (await s.active(donor))[0]!;
  assert.ok(request, "direct handoff must open a request");
  await message(
    donor,
    "בית שאן, רחוב העלייה 7, קומה 2",
    [details({
      request_number: request.number,
      role: "donor",
      settlement: "בית שאן",
      address: "רחוב העלייה 7",
    })],
  );
  request = (await s.active(donor))[0]!;
  let donorParty = request.parties.find((party) => party.role === "donor")!;
  assert.equal(donorParty.settlement, "בית שאן");
  assert.equal(donorParty.address, "רחוב העלייה 7");

  await message(donor, "השם הוא זולו.");
  request = (await s.active(donor))[0]!;
  donorParty = request.parties.find((party) => party.role === "donor")!;
  assert.equal(donorParty.name, "זולו");
});
test("cancellation notifies the other party and supports final close", async () => {
  const r = await readyRequest(),
    donor = r.parties.find((p) => p.role === "donor")!.phone!,
    receiver = r.parties.find((p) => p.role === "receiver")!.phone!;
  const asked = await message(donor, "אני מבטל את התיאום", [
    { type: "cancel", request_number: r.number, choice: "ask" },
  ]);
  assert.equal((await s.request(r.id)).status, "cancel_pending");
  assert.ok((await outputs(asked.id)).some((o) => o.phone === receiver && /בוטל/.test(o.text)));
  await message(donor, "ביטול סופי", [
    { type: "cancel", request_number: r.number, choice: "final" },
  ]);
  assert.equal((await s.request(r.id)).status, "cancelled");
});
test("adding a named recipient later also skips the condition question", async () => {
  const donor = phone(),
    receiver = phone();
  await message(donor, "יש לי מיטה למסירה", [donate()]);
  const r = (await s.active(donor))[0]!;
  const result = await message(donor, `המקבל הוא ${receiver}`, [
    { type: "counterparty", request_number: r.number, phone: receiver, name: null },
  ]);
  assert.doesNotMatch(result.row.reply ?? "", /תקין ושמיש/);
  assert.match(result.row.reply ?? "", /אימות/);
  assert.equal((await s.request(r.id)).items[0]!.working, true);
});
test("counterparty notice is formatted after commit before it becomes sendable", async () => {
  const donor = phone(),
    receiver = phone(),
    cmd = donate("מיטה", "bed");
  if (cmd.type !== "donate") throw new Error();
  cmd.counterparty_phone = receiver;
  const oldPrefix = ai.phraseNoticePrefix;
  ai.phraseNoticePrefix = "FORMATTED: ";
  try {
    await message(donor, `יש לי מיטה למסירה למקבל ${receiver}`, [cmd]);
    const request = (await s.active(donor))[0]!;
    const result = await message(donor, "כן, תפנו אליו לצורך אימות", [
      { type: "contact_counterparty", request_number: request.number, contact: true },
    ]);
    const row = await pool.query<{ text: string; format_state: string; state: string }>(
      "SELECT text,format_state,state FROM outbox WHERE message_id=$1 AND phone=$2 ORDER BY seq DESC LIMIT 1",
      [result.id, receiver],
    );
    assert.equal(row.rows[0]!.format_state, "ready");
    assert.equal(row.rows[0]!.state, "pending");
    assert.match(row.rows[0]!.text, /^FORMATTED:/);
  } finally {
    ai.phraseNoticePrefix = oldPrefix;
  }
});
test("five independent donation and receive route passes remain isolated", async () => {
  for (let i = 0; i < 5; i++) {
    const donor = phone();
    const created = await donation(donor, "bed", `מיטה ${i + 1}`);
    assert.equal(created.origin, "donation");
    assert.equal(created.status, "collecting");
    const receiver = phone();
    const received = await message(receiver, "מחפש מקרר", [
      { type: "seek", kind: "fridge" },
    ]);
    assert.equal((await s.active(receiver)).length, 0);
    assert.ok(received.message.processed_at);
  }
});
test("four canonical flows pass five isolated simulations each", async () => {
  for (let i = 0; i < 5; i++) {
    const directDonor = phone(),
      directReceiver = phone(),
      direct = await message(
        directDonor,
        `מוסר מיטה ישירות למקבל ${directReceiver}`,
        [{
          type: "donate",
          items: [{ kind: "bed", description: `מיטה ישירה ${i + 1}`, quantity: 1 }],
          counterparty_phone: directReceiver,
          direct: true,
          free: true,
          working: null,
        }],
      );
    assert.match(direct.row.reply ?? "", /אימות/);
    assert.doesNotMatch(direct.row.reply ?? "", /תמונה|תקין ושמיש/);
    assert.equal((await s.active(directDonor))[0]!.origin, "direct");

    const open = await message(phone(), `מוסר שולחן ${i + 1}`, [donate(`שולחן ${i + 1}`, "table")]);
    assert.equal(open.row.reply, PHOTO_FIRST);

    const self = phone(),
      selfResult = await message(self, `מעביר לעצמי ארון ${i + 1}`, [
        {
          type: "donate",
          items: [{ kind: "wardrobe", description: `ארון עצמי ${i + 1}`, quantity: 1 }],
          counterparty_phone: self,
          direct: true,
          free: true,
          working: true,
        },
    ]);
    assert.doesNotMatch(selfResult.row.reply ?? "", /תמונה|תקין ושמיש/);
    const selfRequest = (await s.active(self))[0]!;
    assert.equal(selfRequest.origin, "direct");
    assert.ok(selfRequest.parties.some((party) => party.phone === self));

    const requester = phone(),
      requestResult = await message(requester, `מבקש כיסא ${i + 1}`, [
        { type: "seek", kind: "chairs" },
      ]);
    assert.ok(requestResult.message.processed_at);
    assert.equal((await s.active(requester)).length, 0);
    assert.doesNotMatch(requestResult.row.reply ?? "", /תמונה|תקין ושמיש/);
  }
});

test("self transfer persists distinct pickup and destination from the opening message", async () => {
  const p = phone();
  const beforeCalls = ai.calls;
  const result = await message(
    p,
    "אני מעביר לעצמי שולחן מבית שאן רחוב שאול המלך 5 לבית שאן רחוב העלייה 28, קומה 2. מתי אפשר?",
  );
  const request = (await s.active(p))[0]!;
  const donor = request.parties.find((party) => party.role === "donor")!;
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  assert.equal(request.origin, "direct");
  assert.equal(request.represents_both_parties, true);
  assert.equal(donor.phone, p);
  assert.equal(receiver.phone, p);
  assert.equal(donor.settlement, "בית שאן");
  assert.equal(receiver.settlement, "בית שאן");
  assert.match(donor.address ?? "", /שאול המלך 5/);
  assert.match(receiver.address ?? "", /העלייה 28/);
  assert.equal(donor.floor, null);
  assert.equal(receiver.floor, 2);
  assert.doesNotMatch(result.row.reply ?? "", /באיזה יישוב|באיזו עיר/u);
  assert.equal(ai.calls, beforeCalls);
});

test("self transfer to אליי treats the sender as both parties without requiring a phone in the text", async () => {
  const p = phone();
  const result = await message(
    p,
    "היי, אני טליה וישלי כיסא אחד להעביר אליי. אוספים מבית שאן רחוב הגלבוע 9 קומה 3, ומביאים לבית שאן שכונת שיכון א׳ קומה 1. בחינם ותקין, שלישי הבא מתאים לי.",
  );
  const request = (await s.active(p))[0]!;
  const donor = request.parties.find((party) => party.role === "donor")!;
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  assert.doesNotMatch(result.row.reply ?? "", /טיפול אנושי/);
  assert.equal(request.origin, "direct");
  assert.equal(request.represents_both_parties, true);
  assert.equal(donor.phone, p);
  assert.equal(receiver.phone, p);
  assert.equal(donor.name, "טליה");
  assert.equal(receiver.name, "טליה");
  assert.match(donor.address ?? "", /הגלבוע 9/);
  assert.equal(donor.floor, 3);
  assert.match(receiver.address ?? "", /שיכון א׳/);
  assert.equal(receiver.floor, 1);
});

test("receiver cannot alter donor item facts; attempted forbidden change escalates durably", async () => {
  const r = await readyRequest(),
    receiver = r.parties[1]!.phone!;
  const m = await message(receiver, "המקרר בחינם ותקין", [
    facts({ request_number: r.number, working: true }),
  ]);
  assert.equal(m.row.reply, HUMAN_REPLY);
  assert.equal((await s.request(r.id)).version, r.version);
  assert.equal(
    (await outputs(m.id)).some((o) => o.phone === cfg.ADMIN_PHONE),
    true,
  );
});
test("duplicate webhook has one durable inbox and one business effect; completion retry is harmless", async () => {
  const p = phone(),
    body = {
      event: "message",
      session: cfg.WAHA_SESSION,
      payload: { id: randomUUID(), from: `972${p}@c.us`, body: "שלום" },
    };
  const raw = JSON.stringify(body),
    headers = {
      "content-type": "application/json",
      "x-webhook-hmac": createHmac("sha512", cfg.WAHA_WEBHOOK_HMAC_KEY)
        .update(raw)
        .digest("hex"),
    };
  const a = await app.inject({
      method: "POST",
      url: "/webhooks/waha",
      payload: raw,
      headers,
    }),
    b = await app.inject({
      method: "POST",
      url: "/webhooks/waha",
      payload: raw,
      headers,
    });
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202);
  const first = a.json<{ id: string }>(),
    second = b.json<{ id: string; duplicate: boolean }>();
  assert.equal(first.id, second.id);
  assert.equal(second.duplicate, true);
  await engine.ingestNext();
  await engine.process(first.id);
  await engine.process(first.id);
  assert.equal((await outputs(first.id)).length, 1);
});
test("outbox receipt projection is monotonic and distinguishes acceptance from delivery", async () => {
  const m = await message(phone(), "שלום"),
    out = (await outputs(m.id))[0]!;
  const headers = { "x-admin-token": cfg.HAIM_ADMIN_TOKEN };
  const accepted = await app.inject({
    method: "POST",
    url: `/admin/outbox/${out.id}/receipt`,
    headers,
    payload: { state: "accepted", provider_id: "provider-1" },
  });
  assert.equal(accepted.statusCode, 200);
  const delivered = await app.inject({
    method: "POST",
    url: `/admin/outbox/${out.id}/receipt`,
    headers,
    payload: { state: "delivered", provider_id: "provider-1" },
  });
  assert.equal(delivered.statusCode, 200);
  const row = await pool.query<{ delivery_state: string; provider_id: string }>(
    "SELECT delivery_state,provider_id FROM outbox WHERE id=$1",
    [out.id],
  );
  assert.equal(row.rows[0]!.delivery_state, "delivered");
  assert.equal(row.rows[0]!.provider_id, "provider-1");
  const downgrade = await app.inject({
    method: "POST",
    url: `/admin/outbox/${out.id}/receipt`,
    headers,
    payload: { state: "accepted", provider_id: "provider-2" },
  });
  assert.equal(downgrade.statusCode, 200);
  assert.equal(
    (await pool.query<{ delivery_state: string; provider_id: string }>(
      "SELECT delivery_state,provider_id FROM outbox WHERE id=$1",
      [out.id],
    )).rows[0]!.delivery_state,
    "delivered",
  );
});
test("integration events are enqueued durably with an idempotency row", async () => {
  const name = `test-integration-${counter}`;
  await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,true)", [name]);
  const trace = randomUUID();
  await s.transaction(async (c) => {
    await s.event(c, { trace_id: trace }, "test", "fixture_event", { ok: true });
  });
  const row = await pool.query<{ id: string; state: string }>(
    "SELECT io.id,io.state FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2",
    [trace, name],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!.state, "pending");
  const jobs = await q.boss.fetch("integration");
  const job = jobs.find((x) => (x.data as { id: string }).id === row.rows[0]!.id);
  assert.ok(job);
  await q.boss.complete("integration", job.id);
  await pool.query("DELETE FROM integration_outbox WHERE id=$1", [row.rows[0]!.id]);
  await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
});
test("integration dispatcher is durable, ordered, bounded, and replayable", async () => {
  const name = `dispatcher-${counter}`;
  await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,true)", [name]);
  const delivered: string[] = [];
  let mode: "success" | "retry" | "terminal" = "success";
  const adapter: IntegrationAdapter = {
    name,
    async deliver(event, options) {
      assert.equal(event.schemaVersion, 1);
      assert.equal((event as unknown as { deliveryKey: string }).deliveryKey, options.idempotencyKey);
      assert.match(options.idempotencyKey, new RegExp(`^integration:${name}:`));
      if (mode === "retry") throw new IntegrationDeliveryError("temporary_adapter_failure", true);
      if (mode === "terminal") throw new IntegrationDeliveryError("permanent_adapter_failure", false);
      delivered.push(options.idempotencyKey);
    },
  };
  const dispatcher = new Runtime(cfg, log, { pool, integrationAdapters: new Map([[name, adapter]]) });
  const emit = async (type: string) => {
    const trace = randomUUID();
    await s.transaction((c) => s.event(c, { trace_id: trace }, "test", type, { fixture: true }));
    return (await pool.query<{ id: string; idempotency_key: string }>(
      "SELECT io.id,io.idempotency_key FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2",
      [trace, name],
    )).rows[0]!;
  };
  const first = await emit("dispatcher_first");
  await dispatcher.deliverIntegration(first.id);
  await dispatcher.deliverIntegration(first.id);
  assert.deepEqual(delivered, [first.idempotency_key]);
  assert.equal((await pool.query("SELECT state FROM integration_outbox WHERE id=$1", [first.id])).rows[0]!.state, "delivered");

  mode = "retry";
  const retry = await emit("dispatcher_retry");
  for (const job of await q.boss.fetch("integration"))
    if ((job.data as { id: string }).id === retry.id) await q.boss.complete("integration", job.id);
  await assert.rejects(dispatcher.deliverIntegration(retry.id), /temporary_adapter_failure/);
  const retryRow = await pool.query<{ state: string; attempts: number; last_error: string }>("SELECT state,attempts,last_error FROM integration_outbox WHERE id=$1", [retry.id]);
  assert.deepEqual(retryRow.rows[0], { state: "pending", attempts: 1, last_error: "temporary_adapter_failure" });
  await pool.query("UPDATE integration_outbox SET next_attempt_at=NULL WHERE id=$1", [retry.id]);
  mode = "success";
  await dispatcher.deliverIntegration(retry.id);
  assert.equal(delivered.filter((x) => x === retry.idempotency_key).length, 1);

  mode = "retry";
  const exhausted = await emit("dispatcher_exhausted");
  for (let attempt = 0; attempt < 3; attempt++) {
    await pool.query("UPDATE integration_outbox SET next_attempt_at=NULL WHERE id=$1", [exhausted.id]);
    try { await dispatcher.deliverIntegration(exhausted.id); } catch { /* bounded retry is expected */ }
  }
  const dead = await pool.query<{ state: string; attempts: number; error_class: string }>("SELECT state,attempts,error_class FROM integration_outbox WHERE id=$1", [exhausted.id]);
  assert.deepEqual(dead.rows[0], { state: "dead_letter", attempts: 3, error_class: "retry_exhausted" });
  await pool.query("UPDATE integration_outbox SET state='delivered',delivered_at=clock_timestamp() WHERE id=$1", [exhausted.id]);

  mode = "success";
  const later = await emit("dispatcher_later");
  const blocked = await emit("dispatcher_blocked");
  await pool.query("UPDATE integration_outbox SET state='pending',next_attempt_at=NULL WHERE id=$1", [later.id]);
  await dispatcher.deliverIntegration(later.id);
  assert.equal(delivered.at(-1), later.idempotency_key);
  await dispatcher.deliverIntegration(blocked.id);
  assert.equal(delivered.at(-1), blocked.idempotency_key);

  await pool.query("UPDATE integration_outbox SET state='dead_letter',error_class='terminal',terminal_at=clock_timestamp() WHERE id=$1", [retry.id]);
  const readonlyReplay = await app.inject({
    method: "POST",
    url: `/admin/integrations/${retry.id}/replay`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_READONLY_TOKEN },
    payload: { reason: "read only must not replay" },
  });
  assert.equal(readonlyReplay.statusCode, 401);
  const replay = await app.inject({
    method: "POST",
    url: `/admin/integrations/${retry.id}/replay`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { reason: "T19 durable replay test" },
  });
  assert.equal(replay.statusCode, 200);
  const replayRow = await pool.query<{ state: string; idempotency_key: string; attempts: number }>("SELECT state,idempotency_key,attempts FROM integration_outbox WHERE id=$1", [retry.id]);
  assert.deepEqual(replayRow.rows[0], { state: "pending", idempotency_key: retry.idempotency_key, attempts: 0 });
  const replayJobs = await q.boss.fetch("integration");
  assert.ok(replayJobs.some((job) => (job.data as { id: string }).id === retry.id));
  await pool.query("UPDATE integration_outbox SET last_error=$2 WHERE id=$1", [retry.id, "authorization: Bearer top-secret; Bearer naked-secret; token=private-value"]);
  const metrics = await app.inject({ method: "GET", url: "/admin/metrics", headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN } });
  assert.equal(metrics.statusCode, 200);
  const metricsBody = metrics.json() as { integrations: Array<Record<string, unknown>>; integration_details: Array<Record<string, unknown>>; observability: { status: string; signals: Array<{ code: string; context_json: string }> } };
  assert.ok(metricsBody.integrations.some((row) => row.integration === name && "pending_count" in row && "oldest_pending_age_seconds" in row && "dead_letter_count" in row));
  assert.ok(metricsBody.integration_details.some((row) => row.integration === name && "last_error" in row && "attempts" in row));
  assert.ok(metricsBody.integration_details.every((row) => !String(row.last_error ?? "").includes("top-secret")));
  assert.ok(metricsBody.integration_details.every((row) => !String(row.last_error ?? "").includes("naked-secret")));
  assert.ok(metricsBody.integration_details.every((row) => !String(row.last_error ?? "").includes("private-value")));
  assert.ok(["healthy", "warning", "critical"].includes(metricsBody.observability.status));
  assert.ok(metricsBody.observability.signals.every((signal) => signal.context_json.length <= 512));
  const audit = await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM request_events WHERE event_type='integration_delivery_replayed' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.rows[0]!.data.operation, "replay_integration_delivery");
  assert.equal(audit.rows[0]!.data.result, "success");
  await pool.query("UPDATE integration_outbox SET state='delivered',delivered_at=clock_timestamp() WHERE id=$1", [retry.id]);
  const deliveredReplay = await app.inject({
    method: "POST",
    url: `/admin/integrations/${retry.id}/replay`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { reason: "delivered must not replay" },
  });
  assert.equal(deliveredReplay.statusCode, 409);
  await pool.query("DELETE FROM integration_outbox WHERE integration=$1", [name]);
  await pool.query("DELETE FROM request_events WHERE event_type LIKE 'dispatcher_%' OR event_type='integration_delivery_replayed'");
  await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
});
test("disabled integrations are never dispatched", async () => {
  const name = `disabled-${counter}`;
  await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,false)", [name]);
  const trace = randomUUID();
  await s.transaction((c) => s.event(c, { trace_id: trace }, "test", "disabled_dispatch", {}));
  const row = await pool.query("SELECT 1 FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2", [trace, name]);
  assert.equal(row.rowCount, 0);
  await pool.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE trace_id=$1)", [trace]);
  await pool.query("DELETE FROM request_events WHERE trace_id=$1", [trace]);
  await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
});
test("missing adapters, unsupported schemas, and ambiguous delivery are terminal", async () => {
  const cases = [
    { suffix: "missing", adapters: new Map<string, IntegrationAdapter>() },
    { suffix: "schema", adapters: new Map<string, IntegrationAdapter>() },
    {
      suffix: "ambiguous",
      adapters: new Map<string, IntegrationAdapter>(),
    },
  ];
  for (const item of cases) {
    const name = `terminal-${item.suffix}-${counter}`;
    await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,true)", [name]);
    const trace = randomUUID();
    await s.transaction((c) => s.event(c, { trace_id: trace }, "test", `terminal_${item.suffix}`, {}));
    const row = (await pool.query<{ id: string; event_id: string }>("SELECT io.id,io.event_id::text FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2", [trace, name])).rows[0]!;
    if (item.suffix === "schema")
      await pool.query("UPDATE request_events SET data=jsonb_set(data,'{schema_version}','99') WHERE id=$1", [row.event_id]);
    if (item.suffix === "ambiguous")
      item.adapters = new Map([[name, { name, async deliver() { throw new IntegrationDeliveryError("ambiguous_provider_result", true, true); } }]]);
    const dispatcher = new Runtime(cfg, log, { pool, integrationAdapters: item.adapters });
    await dispatcher.deliverIntegration(row.id);
    const result = (await pool.query<{ state: string; error_class: string | null }>("SELECT state,error_class FROM integration_outbox WHERE id=$1", [row.id])).rows[0]!;
    assert.equal(result.state, "dead_letter");
    assert.equal(result.error_class, item.suffix === "ambiguous" ? "ambiguous" : "terminal");
    await pool.query("DELETE FROM integration_outbox WHERE id=$1", [row.id]);
    await pool.query("DELETE FROM request_events WHERE trace_id=$1", [trace]);
    await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
  }
});
test("concurrent delivery claims one row and one external effect", async () => {
  const name = `concurrent-${counter}`;
  let calls = 0;
  await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,true)", [name]);
  const trace = randomUUID();
  await s.transaction((c) => s.event(c, { trace_id: trace }, "test", "concurrent_dispatch", {}));
  const row = (await pool.query<{ id: string }>("SELECT io.id FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2", [trace, name])).rows[0]!;
  const dispatcher = new Runtime(cfg, log, { pool, integrationAdapters: new Map([[name, { name, async deliver() { calls++; await delay(50); } }]]) });
  await Promise.all([dispatcher.deliverIntegration(row.id), dispatcher.deliverIntegration(row.id)]);
  assert.equal(calls, 1);
  assert.equal((await pool.query("SELECT state FROM integration_outbox WHERE id=$1", [row.id])).rows[0]!.state, "delivered");
  await pool.query("DELETE FROM integration_outbox WHERE id=$1", [row.id]);
  await pool.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE trace_id=$1)", [trace]);
  await pool.query("DELETE FROM request_events WHERE trace_id=$1", [trace]);
  await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
});
test("recovery requeues due rows, stale active rows, and predecessor-unblocked rows", async () => {
  const name = `recovery-${counter}`;
  await pool.query("INSERT INTO integrations(name,enabled) VALUES($1,true)", [name]);
  const delivered: string[] = [];
  const adapter: IntegrationAdapter = { name, async deliver(_event, options) { delivered.push(options.idempotencyKey); } };
  const dispatcher = new Runtime(cfg, log, { pool, integrationAdapters: new Map([[name, adapter]]) });
  const scheduled: string[] = [];
  dispatcher.queue = { send: async (_client: unknown, _queue: unknown, data: { id: string }) => { scheduled.push(data.id); return "job"; } } as unknown as Queue;
  dispatcher.store = s;
  const emit = async (type: string) => {
    const trace = randomUUID();
    await s.transaction((c) => s.event(c, { trace_id: trace }, "test", type, {}));
    return (await pool.query<{ id: string; idempotency_key: string }>("SELECT io.id,io.idempotency_key FROM integration_outbox io JOIN request_events e ON e.id=io.event_id WHERE e.trace_id=$1 AND io.integration=$2", [trace, name])).rows[0]!;
  };
  const stale = await emit("recovery_stale");
  await pool.query("UPDATE integration_outbox SET state='active',last_attempt_at=clock_timestamp()-interval '61 seconds' WHERE id=$1", [stale.id]);
  await dispatcher.recoverIntegrationQueue();
  assert.equal((await pool.query("SELECT state FROM integration_outbox WHERE id=$1", [stale.id])).rows[0]!.state, "pending");
  assert.ok(scheduled.includes(stale.id));
  await pool.query("UPDATE integration_outbox SET state='delivered',delivered_at=clock_timestamp() WHERE id=$1", [stale.id]);

  const predecessor = await emit("recovery_predecessor");
  const successor = await emit("recovery_successor");
  await dispatcher.deliverIntegration(successor.id);
  assert.equal(delivered.includes(successor.idempotency_key), false);
  await dispatcher.deliverIntegration(predecessor.id);
  scheduled.length = 0;
  await dispatcher.recoverIntegrationQueue();
  assert.ok(scheduled.includes(successor.id));
  await dispatcher.deliverIntegration(successor.id);

  const future = await emit("recovery_future");
  await pool.query("UPDATE integration_outbox SET next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE id=$1", [future.id]);
  scheduled.length = 0;
  await dispatcher.recoverIntegrationQueue();
  assert.equal(scheduled.includes(future.id), false);
  await pool.query("UPDATE integration_outbox SET next_attempt_at=NULL WHERE id=$1", [future.id]);
  await dispatcher.recoverIntegrationQueue();
  assert.ok(scheduled.includes(future.id));
  await pool.query("DELETE FROM integration_outbox WHERE integration=$1", [name]);
  await pool.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE event_type LIKE 'recovery_%')");
  await pool.query("DELETE FROM request_events WHERE event_type LIKE 'recovery_%'");
  await pool.query("DELETE FROM integrations WHERE name=$1", [name]);
});
test("two quick messages preserve receipt order even when processing is invoked backwards", async () => {
  const p = phone(),
    a = await enqueue(p, "יש לי מיטה למסירה", [donate()]),
    b = await enqueue(p, "", undefined, true);
  await assert.rejects(engine.process(b.id), /earlier_message_pending/);
  await engine.process(a.id);
  await engine.process(b.id);
  const r = (await s.active(p))[0]!;
  assert.equal(r.photo_ids.length, 1);
  assert.equal((await outputs(a.id))[0]!.text, PHOTO_FIRST);
  assert.ok((await outputs(b.id))[0]!.text.startsWith(PHOTO_THANKS));
});
test("quiet-window admission durably links every message in one turn", async () => {
  const p = phone(),
    a = await enqueue(p, "יש לי מקרר למסירה"),
    b = await enqueue(p, "הוא עובד"),
    c = await enqueue(p, "בבית שאן");
  await engine.processNext(a.id);
  const linked = await pool.query<{
    turn_id: string;
    message_id: string;
    position: number;
    turn_status: string;
  }>(
    `SELECT m.turn_id,m.id AS message_id,tm.position,t.status AS turn_status
       FROM messages m
       JOIN turn_messages tm ON tm.message_id=m.id
       JOIN conversation_turns t ON t.id=tm.turn_id
      WHERE m.id=ANY($1::uuid[]) ORDER BY tm.position`,
    [[a.id, b.id, c.id]],
  );
  assert.equal(linked.rows.length, 3);
  assert.deepEqual(linked.rows.map((r) => r.message_id), [a.id, b.id, c.id]);
  assert.equal(new Set(linked.rows.map((r) => r.turn_id)).size, 1);
  assert.equal(linked.rows[0]!.turn_status, "completed");
  const remaining = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM messages WHERE id=ANY($1::uuid[]) AND processed_at IS NULL",
    [[a.id, b.id, c.id]],
  );
  assert.equal(remaining.rows[0]!.n, 0);
});
test("startup recovery completes a stranded processing turn after all of its messages were committed", async () => {
  const message = await enqueue(phone(), "יש לי מקרר למסירה");
  await engine.processNext(message.id);
  await pool.query(
    `UPDATE conversation_turns
        SET status='processing',completed_at=NULL
      WHERE id=(SELECT turn_id FROM messages WHERE id=$1)`,
    [message.id],
  );
  const recovering = new Runtime(cfg, log, { pool, planner: ai, channel, storage });
  await recovering.reconcileCompletedTurns();
  const turn = await pool.query<{ status: string; completed_at: Date | null }>(
    "SELECT status,completed_at FROM conversation_turns WHERE id=(SELECT turn_id FROM messages WHERE id=$1)",
    [message.id],
  );
  assert.equal(turn.rows[0]!.status, "completed");
  assert.ok(turn.rows[0]!.completed_at);
});
test("a newer message supersedes an in-flight AI turn without an old reply", async () => {
  const p = phone(),
    first = await enqueue(p, "פריט מיוחד למסירה", [donate()]);
  ai.planDelayMs = 80;
  try {
    const running = engine.process(first.id);
    await delay(10);
    const second = await enqueue(p, "פריט חדש למסירה", [donate("כיסא", "chairs")]);
    await running;
    const old = await pool.query<{ error_code: string | null }>(
      "SELECT error_code FROM messages WHERE id=$1",
      [first.id],
    );
    assert.match(old.rows[0]!.error_code ?? "", /^superseded_by:/);
    assert.equal((await outputs(first.id)).length, 0);
    const superseded = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM request_events WHERE message_id=$1 AND event_type='turn_superseded'",
      [first.id],
    );
    assert.equal(superseded.rows[0]!.n, 1);
    await engine.process(second.id);
    assert.equal((await s.active(p)).length, 1);
  } finally {
    ai.planDelayMs = 0;
  }
});
test("core donation starts with PHOTO-FIRST without calling the AI planner", async () => {
  const p = phone(),
    calls = ai.calls;
  let result = await message(p, "אני רוצה למסור מיטה בבית שאן רחוב העלייה קומה 2");
  assert.equal(result.row.reply, PHOTO_FIRST);
  assert.equal(ai.calls, calls);
  const intent = await pool.query<{ intent: string }>(
    "SELECT result->>'intent' AS intent FROM command_results WHERE message_id=$1",
    [result.id],
  );
  assert.equal(intent.rows[0]!.intent, "ask_photo");
  const saved = (await s.active(p))[0]!;
  const donor = saved.parties.find((party) => party.role === "donor")!;
  assert.equal(donor.settlement, "בית שאן");
  assert.equal(donor.address, "רחוב העלייה");
  assert.equal(donor.floor, 2);
});
test("repeated donation does not silently open a duplicate request", async () => {
  const p = phone();
  await message(p, "יש לי מיטה למסירה");
  const repeated = await message(p, "יש לי מיטה למסירה");
  assert.match(repeated.row.reply ?? "", /כבר קיימת פנייה/);
  assert.equal((await s.active(p)).length, 1);
});
test("an existing open donation can be redirected to a named recipient", async () => {
  const p = phone();
  await message(p, "אני רוצה למסור מיטה");
  const redirected = await message(p, "אני רוצה למסור את המיטה לטל");
  assert.doesNotMatch(redirected.row.reply ?? "", /כבר קיימת פנייה/);
  assert.match(redirected.row.reply ?? "", /מספר הטלפון|כרטיס איש קשר/);
  const conversation = await pool.query<{ pending_counterparty_name: string | null }>(
    "SELECT pending_counterparty_name FROM conversations cv JOIN contacts c ON c.id=cv.contact_id WHERE c.phone=$1",
    [p],
  );
  assert.equal(conversation.rows[0]!.pending_counterparty_name, "טל");
  assert.equal((await s.active(p)).length, 1);
});
test("AI donate.direct on an open donation skips photo and converts origin", async () => {
  const p = phone();
  const receiver = phone();
  await message(p, "יש לי שולחן למסירה", [donate("שולחן", "table")]);
  assert.equal((await s.active(p))[0]!.origin, "donation");
  const named = await message(p, "אני רוצה למסור למישו ספציפי לטל", [
    {
      type: "donate",
      items: [{ kind: "table", description: "שולחן", quantity: 1 }],
      counterparty_phone: null,
      counterparty_name: "טל",
      direct: true,
      free: true,
      working: true,
    },
  ]);
  assert.doesNotMatch(named.row.reply ?? "", /תמונה/);
  assert.match(named.row.reply ?? "", /מספר הטלפון|כרטיס איש קשר/);
  assert.equal((await s.active(p))[0]!.origin, "direct");
  const linked = await message(p, "כרטיס איש קשר", [
    {
      type: "donate",
      items: [{ kind: "table", description: "שולחן", quantity: 1 }],
      counterparty_phone: receiver,
      counterparty_name: "טל זולו",
      direct: true,
      free: true,
      working: true,
    },
  ]);
  assert.doesNotMatch(linked.row.reply ?? "", /תמונה/);
  assert.equal((await s.active(p)).length, 1);
  const saved = (await s.active(p))[0]!;
  assert.equal(saved.origin, "direct");
  assert.equal(saved.parties.find((party) => party.role === "receiver")?.phone, receiver);
  assert.equal(saved.parties.find((party) => party.role === "receiver")?.name, "טל זולו");
  const again = await message(p, "לטל זולו שוב", [
    {
      type: "donate",
      items: [{ kind: "table", description: "שולחן", quantity: 1 }],
      counterparty_phone: receiver,
      counterparty_name: "טל זולו",
      direct: true,
      free: true,
      working: true,
    },
  ]);
  assert.doesNotMatch(again.row.reply ?? "", /תמונה/);
  assert.match(again.row.reply ?? "", /כבר רשומים|נפנה/);
  assert.equal((await s.active(p)).length, 1);
});

test("donate with a renamed recipient plus vCard updates the open request instead of opening a twin", async () => {
  const donor = phone(),
    receiver = phone();
  await message(donor, "אני רוצה למסור מיטה למשה", [
    {
      type: "donate",
      items: [{ kind: "bed", description: "מיטה", quantity: 1 }],
      counterparty_phone: null,
      counterparty_name: "משה",
      direct: true,
      free: true,
      working: true,
    },
  ]);
  const opened = (await s.active(donor))[0]!;
  await message(donor, "בעצם לדוד", [
    { type: "counterparty", request_number: opened.number, phone: null, name: "דוד" },
  ]);
  await message(
    donor,
    "בית שאן, רחוב רבי מאיר לשדרות הארבעה, קומה 0. קוראים לי ישראל",
    [
      details({
        request_number: opened.number,
        role: "donor",
        name: "ישראל",
        settlement: "בית שאן",
        address: "רחוב רבי מאיר",
        floor: 0,
      }),
      details({
        request_number: opened.number,
        role: "receiver",
        settlement: "בית שאן",
        address: "שדרות הארבעה ליד ויקטורי",
        floor: 0,
      }),
    ],
  );
  await message(donor, "בעצם קוראים לו טל, דבר איתו", [
    { type: "counterparty", request_number: opened.number, phone: null, name: "טל" },
    { type: "contact_counterparty", request_number: opened.number, contact: true },
  ]);
  const afterConsent = await s.request(opened.id);
  assert.equal(afterConsent.verification_contacted, false);
  assert.equal((await s.active(donor)).length, 1);

  const card = await message(
    donor,
    `בעצם קוראים לו טל אני שולח לך את המספר שלו דבר איתו`,
    [
      {
        type: "donate",
        items: [{ kind: "bed", description: "מיטה", quantity: 1 }],
        counterparty_phone: receiver,
        counterparty_name: "טל זולו",
        direct: true,
        free: true,
        working: true,
      },
      {
        type: "counterparty",
        request_number: opened.number,
        phone: receiver,
        name: "טל זולו",
      },
      { type: "contact_counterparty", request_number: opened.number, contact: true },
    ],
  );
  assert.equal((await s.active(donor)).length, 1);
  const saved = (await s.active(donor))[0]!;
  assert.equal(saved.id, opened.id);
  assert.equal(saved.parties.find((party) => party.role === "receiver")?.phone, receiver);
  assert.equal(saved.parties.find((party) => party.role === "receiver")?.name, "טל זולו");
  assert.match(saved.parties.find((party) => party.role === "receiver")?.address ?? "", /שדרות הארבעה/);
  assert.equal(saved.verification_contacted, true);
  const notice = (await outputs(card.id)).find((row) => row.phone === receiver)?.text ?? "";
  assert.match(notice, /טל/);
  assert.match(notice, /מיטה/);
});
test("AI donate with only counterparty_name converts open donation without direct flag", async () => {
  const p = phone();
  await message(p, "יש לי כיסא למסירה", [donate("כיסא", "chairs")]);
  const named = await message(p, "למסור לדינה", [
    {
      type: "donate",
      items: [{ kind: "chairs", description: "כיסא", quantity: 1 }],
      counterparty_phone: null,
      counterparty_name: "דינה",
      direct: false,
      free: true,
      working: null,
    },
  ]);
  assert.doesNotMatch(named.row.reply ?? "", /תמונה/);
  assert.equal((await s.active(p))[0]!.origin, "direct");
  const conversation = await pool.query<{ pending_counterparty_name: string | null }>(
    "SELECT pending_counterparty_name FROM conversations cv JOIN contacts c ON c.id=cv.contact_id WHERE c.phone=$1",
    [p],
  );
  assert.equal(conversation.rows[0]!.pending_counterparty_name, "דינה");
});
test("receiver details wait for the counterparty created by the same AI plan", async () => {
  const donor = phone(), receiver = phone();
  const initial = await message(donor, "אני רוצה למסור מיטה");
  const request = (await s.active(donor))[0]!;
  assert.equal(initial.row.reply, PHOTO_FIRST);
  ai.managedReply = "קיבלתי, אבל לפני שנמשיך נא לשלוח תמונה של המיטה.";
  let linked;
  try {
    linked = await message(
      donor,
      `טל כהן ${receiver}`,
      [
        details({
          request_number: request.number,
          role: "receiver",
          name: "טל כהן",
        }),
        { type: "counterparty", request_number: request.number, phone: receiver, name: "טל כהן" },
      ],
    );
  } finally {
    ai.managedReply = "";
  }
  const processing = await pool.query<{ error_code: string | null }>(
    "SELECT error_code FROM messages WHERE id=$1",
    [linked.id],
  );
  assert.equal(processing.rows[0]!.error_code, null);
  assert.doesNotMatch(linked.row.reply ?? "", /תמונה/);
  const saved = await s.request(request.id);
  const recipient = saved.parties.find((party) => party.role === "receiver");
  assert.equal(saved.origin, "direct");
  assert.equal(recipient?.phone, receiver);
  assert.equal(recipient?.name, "טל כהן");
});
test("duplicate clarification reloads the latest request and preserves the other party approval", async () => {
  const donor = phone(), receiver = phone(), r = await readyRequest(donor, receiver);
  await pool.query(
    "UPDATE request_parties SET approved_at=clock_timestamp(), approved_by=contact_id, schedule_approved=true, schedule_approved_date=(SELECT proposed_run_date FROM requests WHERE id=$1), schedule_approved_at=clock_timestamp() WHERE request_id=$1 AND role='receiver'",
    [r.id],
  );
  await message(donor, "יש לי שוב את אותו מקרר", [
    { type: "clarify_duplicate", request_number: r.number },
  ]);
  const row = await pool.query<{ approved_at: string | null }>(
    "SELECT approved_at FROM request_parties WHERE request_id=$1 AND role='receiver'",
    [r.id],
  );
  assert.ok(row.rows[0]!.approved_at);
});
test("atomic business commit rolls back if enqueue fails, then retries without duplicate request", async () => {
  const p = phone(),
    m = await enqueue(p, "יש לי מיטה למסירה", [donate()]);
  const original = q.send.bind(q);
  q.send = async (client, name, data, key) => {
    if (name === "send") throw new Error("simulated_queue_failure");
    return original(client, name, data, key);
  };
  try {
    await assert.rejects(engine.process(m.id));
  } finally {
    q.send = original;
  }
  assert.equal((await s.active(p)).length, 0);
  assert.equal((await s.message(m.id)).processed_at, null);
  await engine.process(m.id);
  await engine.process(m.id);
  assert.equal((await s.active(p)).length, 1);
  assert.equal((await outputs(m.id)).length, 1);
});
test("pg-boss retries retain FIFO blocker and release it only after predecessor completes", async () => {
  const name = "retry_contract";
  await q.boss.createQueue(name, {
    policy: "key_strict_fifo",
    retryLimit: 2,
    retryDelay: 0,
  });
  const first = await q.boss.send(name, { v: 1 }, { singletonKey: "a" }),
    second = await q.boss.send(name, { v: 2 }, { singletonKey: "a" });
  assert.ok(first && second);
  const claimed = await q.boss.fetch(name);
  assert.equal(claimed[0]?.id, first);
  await q.boss.fail(name, first);
  const retried = await q.boss.fetch(name, { ignoreStartAfter: true });
  assert.equal(retried[0]?.id, first);
  await q.boss.complete(name, first);
  const successor = await q.boss.fetch(name);
  assert.equal(successor[0]?.id, second);
  await q.boss.complete(name, second);
});
test("ambiguous WAHA failure is never blindly resent; shadow work never flushes into live", async () => {
  const liveStore = new Store(pool, q, { ...cfg, BOT_MODE: "live" }),
    liveEngine = new Engine(liveStore, ai, channel, storage, log, () => monday),
    p = phone();
  const m = await liveStore.ingest(
    {
      external_id: randomUUID(),
      chat_id: `972${p}@c.us`,
      kind: "text",
      text: "שלום",
      media_url: null,
      contacts: [],
      location: null,
    },
    "live",
  );
  await liveEngine.ingestNext();
  await liveEngine.process(m.id);
  const out = (await outputs(m.id))[0]!;
  channel.error = new DeliveryError("timeout", "unknown");
  const before = channel.sent.length;
  await assert.rejects(liveEngine.send(out.id));
  await assert.rejects(liveEngine.send(out.id));
  assert.equal(channel.sent.length, before + 1);
  assert.equal((await outputs(m.id))[0]!.state, "uncertain");
  channel.error = null;
  const shadow = await message(phone(), "שלום"),
    pending = (await outputs(shadow.id))[0]!;
  await liveEngine.send(pending.id);
  assert.equal((await outputs(shadow.id))[0]!.state, "shadow");
  assert.equal(channel.sent.length, before + 1);
});
test("human escalation includes required context; follow-up does not resume the bot", async () => {
  const p = phone(),
    r = await donation(p),
    m = await message(p, "צריך מנוף", [
      { type: "escalate", request_number: r.number, reason: "unusual_access" },
    ]);
  const alert = (await outputs(m.id)).find((o) => o.phone === cfg.ADMIN_PHONE)!;
  for (const part of [
    `${r.number}`,
    p,
    "מיטה",
    "מסלול",
    "unusual_access",
    "צריך מנוף",
    "תשובת הבוט",
    "לחזור ללקוח",
  ])
    assert.ok(alert.text.includes(part));
  const calls = ai.calls,
    followup = await message(p, "יש עדכון?");
  assert.equal(ai.calls, calls);
  assert.equal(
    (await outputs(followup.id)).some((o) => o.phone === p),
    false,
  );
});
test("status is read only; multiple active requests; coordinated request plus new request", async () => {
  const p = phone(),
    r = await readyRequest(p);
  await s.transaction(async (c) => {
    assert.equal(await s.coordinate(c, r, monday), "coordinated");
    await s.save(c, r);
  });
  const old = await s.request(r.id);
  await message(p, "יש לי מיטה חדשה למסירה", [donate()]);
  const active = await s.active(p);
  assert.equal(active.length, 2);
  assert.equal((await s.request(r.id)).version, old.version);
  const versions = active.map((r) => r.version),
    status = await message(p, "מה הסטטוס?");
  for (const x of active)
    assert.ok(status.row.reply?.includes(`פנייה ${x.number}`));
  assert.deepEqual(
    (await s.active(p)).map((r) => r.version),
    versions,
  );
});
test("admin #פניות לחיים יחד lists every request read-only without AI", async () => {
  const first = await donation(phone(), "fridge", "מקרר");
  const second = await donation(phone(), "bed", "מיטה");
  const before = await pool.query<{ id: string; version: number; status: string }>(
    "SELECT id,version,status FROM requests WHERE id=ANY($1::uuid[]) ORDER BY number",
    [[first.id, second.id]],
  );
  const calls = ai.calls;
  const result = await message(cfg.ADMIN_PHONE, "#פניות לחיים יחד");
  assert.equal(ai.calls, calls);
  assert.match(result.row.reply ?? "", new RegExp(`פנייה ${first.number}`));
  assert.match(result.row.reply ?? "", new RegExp(`פנייה ${second.number}`));
  const after = await pool.query<{ id: string; version: number; status: string }>(
    "SELECT id,version,status FROM requests WHERE id=ANY($1::uuid[]) ORDER BY number",
    [[first.id, second.id]],
  );
  assert.deepEqual(after.rows, before.rows);
});
test("Tuesday capacity is enforced and same-day requires explicit admin approval", async () => {
  const a = await readyRequest(),
    b = await readyRequest();
  const date = "2026-09-22";
  await setProposedDate(a, date);
  await setProposedDate(b, date);
  await pool.query(
    "INSERT INTO transport_runs(date,capacity) VALUES($1,1) ON CONFLICT(date) DO UPDATE SET capacity=1",
    [date],
  );
  const runNow = new Date("2026-09-21T08:00:00Z");
  const first = await s.transaction(async (c) => {
    await s.request(a.id, c, true);
    const result = await s.coordinate(c, a, runNow);
    await s.save(c, a);
    return result;
  });
  const second = await s.transaction(async (c) => {
    await s.request(b.id, c, true);
    const result = await s.coordinate(c, b, runNow);
    await s.save(c, b);
    return result;
  });
  assert.equal(first, "coordinated");
  assert.equal(second, "full");
  const x = await readyRequest();
  await setProposedDate(x, "2026-09-29");
  assert.equal(
    await s.transaction((c) =>
      s.coordinate(c, x, new Date("2026-09-29T08:00:00Z")),
    ),
    "same_day",
  );
});
test("admin can explicitly extend a Tuesday run beyond the default capacity of ten", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/admin/transport-runs/2026-11-03/capacity",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { capacity: 11, reason: "QA explicit admin extension" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await pool.query<{ capacity: number }>(
    "SELECT capacity FROM transport_runs WHERE date='2026-11-03'",
  )).rows[0]?.capacity, 11);
});
test("only the configured admin can approve one extra transport on WhatsApp", async () => {
  await pool.query("INSERT INTO transport_runs(date,capacity) VALUES('2026-10-27',10) ON CONFLICT(date) DO UPDATE SET capacity=10");
  await pool.query("INSERT INTO transport_capacity_approvals(run_date,requested_capacity) VALUES('2026-10-27',11)");
  const adminReply = await message(cfg.ADMIN_PHONE, "כן 2026-10-27");
  assert.match(adminReply.row.reply ?? "", /אישרת הובלה נוספת אחת/);
  assert.equal((await pool.query<{ capacity: number }>("SELECT capacity FROM transport_runs WHERE date='2026-10-27'")).rows[0]?.capacity, 11);
  await pool.query("INSERT INTO transport_runs(date,capacity) VALUES('2026-11-10',10) ON CONFLICT(date) DO UPDATE SET capacity=10");
  await pool.query("INSERT INTO transport_capacity_approvals(run_date,requested_capacity) VALUES('2026-11-10',11)");
  const adminNo = await message(cfg.ADMIN_PHONE, "לא 2026-11-10");
  assert.match(adminNo.row.reply ?? "", /לא אוסיף הובלה/);
  assert.equal((await pool.query<{ capacity: number }>("SELECT capacity FROM transport_runs WHERE date='2026-11-10'")).rows[0]?.capacity, 10);
  assert.equal((await pool.query<{ status: string }>("SELECT status FROM transport_capacity_approvals WHERE run_date='2026-11-10'")).rows[0]?.status, "denied");
  const other = await message(phone(), "כן 2026-10-27");
  assert.equal((await pool.query<{ capacity: number }>("SELECT capacity FROM transport_runs WHERE date='2026-10-27'")).rows[0]?.capacity, 11);
  assert.match(other.row.reply ?? "", /רק המנהל המורשה/, "non-admin must not receive the privileged approval result");
});
test("coordinated arrangements stop at ten and request admin approval before another proposal", async () => {
  await pool.query(
    "INSERT INTO transport_runs(date,capacity) VALUES ($1,10),($2,10) ON CONFLICT(date) DO UPDATE SET capacity=10",
    ["2026-10-13", "2026-10-20"],
  );
  const traces: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await readyRequest();
    await setProposedDate(r, i < 10 ? "2026-10-13" : "2026-10-20");
    const runNow = new Date(i < 10 ? "2026-10-12T08:00:00Z" : "2026-10-19T08:00:00Z");
    const result = await s.transaction(async (c) => {
      const locked = await s.request(r.id, c, true);
      const outcome = await s.coordinate(c, locked, runNow);
      await s.save(c, locked);
      await s.event(c, { trace_id: randomUUID() }, "test", "coordinated", { date: locked.run_date }, locked.id);
      return outcome;
    });
    assert.equal(result, "coordinated");
    const evidence = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM request_events WHERE request_id=$1 AND event_type='coordinated'",
      [r.id],
    );
    assert.equal(evidence.rows[0]!.n, 1);
    const state = await pool.query<{ status: string }>(
      "SELECT status FROM requests WHERE id=$1",
      [r.id],
    );
    assert.equal(state.rows[0]!.status, "coordinated");
    traces.push(r.id);
  }
  assert.equal(new Set(traces).size, 20);
  const counts = await pool.query<{ run_date: string; n: number }>(
    "SELECT run_date::text, count(*)::int AS n FROM requests WHERE id=ANY($1::uuid[]) GROUP BY run_date ORDER BY run_date",
    [traces],
  );
  assert.deepEqual(counts.rows, [
    { run_date: "2026-10-13", n: 10 },
    { run_date: "2026-10-20", n: 10 },
  ]);
  const waiting = await readyRequest();
  await setProposedDate(waiting, "2026-10-13");
  assert.equal(
    await s.transaction((c) => s.coordinate(c, waiting, new Date("2026-10-12T08:00:00Z"))),
    "full",
  );
  const pending = await pool.query<{ requested_capacity: number; status: string }>(
    "SELECT requested_capacity,status FROM transport_capacity_approvals WHERE run_date='2026-10-13'",
  );
  assert.deepEqual(pending.rows, [{ requested_capacity: 11, status: "pending" }]);
  const adminAsk = await pool.query<{ phone: string; text: string }>(
    "SELECT phone,text FROM outbox WHERE dedupe_key LIKE 'capacity-approval:%' AND text LIKE '%2026-10-13%'",
  );
  assert.equal(adminAsk.rows.length, 1);
  assert.equal(adminAsk.rows[0]?.phone, cfg.ADMIN_PHONE);
  assert.match(adminAsk.rows[0]?.text ?? "", /כן 2026-10-13 או לא 2026-10-13/);
  assert.equal((await s.request(waiting.id)).run_date, null);

  // Approval is one slot at a time. Once slot 11 is approved and consumed,
  // slot 12 must trigger a fresh approval instead of being coordinated.
  const firstApproval = await s.transaction((c) =>
    s.resolveCapacityApproval(c, "2026-10-13", true, cfg.ADMIN_PHONE),
  );
  assert.equal(firstApproval, "approved");
  const run = await pool.query<{ capacity: number }>(
    "SELECT capacity FROM transport_runs WHERE date='2026-10-13'",
  );
  assert.equal(run.rows[0]?.capacity, 11);
  const slotEleven = await s.transaction(async (c) => {
    const locked = await s.request(waiting.id, c, true);
    const outcome = await s.coordinate(c, locked, new Date("2026-10-12T08:00:00Z"));
    await s.save(c, locked);
    return outcome;
  });
  assert.equal(slotEleven, "coordinated");
  const slotTwelve = await readyRequest();
  await setProposedDate(slotTwelve, "2026-10-13");
  const secondAsk = await s.transaction(async (c) => {
    const locked = await s.request(slotTwelve.id, c, true);
    const outcome = await s.coordinate(c, locked, new Date("2026-10-12T08:00:00Z"));
    await s.save(c, locked);
    return outcome;
  });
  assert.equal(secondAsk, "full");
  assert.equal((await s.request(slotTwelve.id)).run_date, null);
  const nextApproval = await pool.query<{ requested_capacity: number; status: string }>(
    "SELECT requested_capacity,status FROM transport_capacity_approvals WHERE run_date='2026-10-13' ORDER BY requested_capacity",
  );
  assert.deepEqual(nextApproval.rows, [
    { requested_capacity: 11, status: "approved" },
    { requested_capacity: 12, status: "pending" },
  ]);
  const asks = await pool.query<{ text: string }>(
    "SELECT text FROM outbox WHERE dedupe_key LIKE 'capacity-approval:%' AND phone=$1 AND text LIKE '%2026-10-13%' ORDER BY created_at",
    [cfg.ADMIN_PHONE],
  );
  assert.equal(asks.rows.length, 2);
  assert.match(asks.rows[1]?.text ?? "", /מכסה 12/);
});
test("group, malformed webhook and admin authentication boundaries", async () => {
  const payload = JSON.stringify({
      event: "message",
      session: cfg.WAHA_SESSION,
      payload: { id: randomUUID(), from: "777@g.us", body: "x" },
    }),
    h = {
      "content-type": "application/json",
      "x-webhook-hmac": createHmac("sha512", cfg.WAHA_WEBHOOK_HMAC_KEY)
        .update(payload)
        .digest("hex"),
    };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/webhooks/waha",
        payload,
        headers: h,
      })
    ).json<{ ignored: boolean }>().ignored,
    true,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/webhooks/waha",
        payload: "{}",
        headers: {
          "content-type": "application/json",
          "x-webhook-hmac": createHmac("sha512", cfg.WAHA_WEBHOOK_HMAC_KEY)
            .update("{}")
            .digest("hex"),
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/admin/requests" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/admin/requests",
        headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
      })
    ).statusCode,
    200,
  );
  const dbView = await app.inject({
    method: "GET",
    url: "/admin/database?table=requests&limit=1",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
  });
  assert.equal(dbView.statusCode, 200);
  assert.deepEqual(
    dbView.json<{ columns: string[] }>().columns.filter((x) =>
      ["preferred_time", "represents_both_parties", "closed_at"].includes(x),
    ),
    ["preferred_time", "represents_both_parties", "closed_at"],
  );
});
test("admin database is read-only and exposes only named mutation operations", async () => {
  const r = await readyRequest();
  const view = await app.inject({
    method: "GET",
    url: "/admin/database?table=requests&limit=1",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
  });
  assert.equal(view.statusCode, 200);
  assert.deepEqual(view.json<{ editable_fields: string[] }>().editable_fields, []);
  const readOnlyApp = await makeHttp(
    { ...cfg, HAIM_ADMIN_READONLY_TOKEN: "test-read-only-token" },
    runtime,
    null,
  );
  await readOnlyApp.ready();
  const readOnlyMutation = await readOnlyApp.inject({
    method: "PATCH",
    url: `/admin/database/requests/${r.id}`,
    headers: {
      "x-admin-token": "test-read-only-token",
      "x-admin-capability": "read-only",
    },
    payload: {
      changes: { preferred_time: "16:30", represents_both_parties: true },
    },
  });
  assert.equal(readOnlyMutation.statusCode, 403);
  await readOnlyApp.close();
  const genericUpdate = await app.inject({
    method: "PATCH",
    url: `/admin/database/requests/${r.id}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { changes: { preferred_time: "16:30" } },
  });
  assert.equal(genericUpdate.statusCode, 404);
  const genericDelete = await app.inject({
    method: "DELETE",
    url: `/admin/database/requests/${r.id}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
  });
  assert.equal(genericDelete.statusCode, 404);
  const namedMutation = await app.inject({
    method: "POST",
    url: `/admin/conversations/${encodeURIComponent(r.parties[0]!.phone!)}/resume`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { reason: "T18 named operation" },
  });
  assert.equal(namedMutation.statusCode, 200);
  const audit = await pool.query<{ data: any }>(
    "SELECT data FROM request_events WHERE event_type='conversation_resumed' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(audit.rows[0]?.data?.operation, "resume_conversation");
  assert.equal(audit.rows[0]?.data?.actor, "admin-http");
  assert.equal(audit.rows[0]?.data?.capability, "normal");
  assert.equal(audit.rows[0]?.data?.target, `phone:${r.parties[0]!.phone}`);
  assert.equal(audit.rows[0]?.data?.result, "success");
  assert.ok(Number.isFinite(Date.parse(audit.rows[0]?.data?.timestamp)));
});
test("admin mutations reject cross-origin requests and are rate bounded", async () => {
  const r = await readyRequest();
  const csrf = await app.inject({
    method: "POST",
    url: `/admin/requests/${r.number}/resume`,
    headers: {
      "x-admin-token": cfg.HAIM_ADMIN_TOKEN,
      origin: "https://evil.example",
    },
    payload: { reason: "cross-origin", expected_version: r.version },
  });
  assert.equal(csrf.statusCode, 403);
  for (let i = 0; i < 21; i++) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/requests/999999/resume",
      headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
      payload: { reason: "rate test", expected_version: 1 },
    });
    if (i < 20) assert.equal(response.statusCode, 404);
    else assert.equal(response.statusCode, 429);
  }
});
test("destructive admin operations require test-only capability and explicit confirmation", async () => {
  const r = await readyRequest();
  const m = await enqueue(phone(), "שלום");
  assert.ok((await s.message(m.id)).id);
  const before = Number((await pool.query("SELECT count(*) FROM messages")).rows[0].count);
  const wrongCapability = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { confirm: true },
  });
  assert.equal(wrongCapability.statusCode, 403);
  assert.equal(Number((await pool.query("SELECT count(*) FROM messages")).rows[0].count), before);
  const forgedEscalation = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: {
      "x-admin-token": cfg.HAIM_ADMIN_TOKEN,
      "x-admin-capability": "destructive",
    },
    payload: { confirm: "מחק הכל" },
  });
  assert.equal(forgedEscalation.statusCode, 403);
  const readOnlyApp = await makeHttp(
    { ...cfg, HAIM_ADMIN_READONLY_TOKEN: "test-read-only-token" },
    runtime,
    null,
  );
  await readOnlyApp.ready();
  const readOnlyEscalation = await readOnlyApp.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: {
      "x-admin-token": "test-read-only-token",
      "x-admin-capability": "destructive",
    },
    payload: { confirm: "מחק הכל" },
  });
  assert.equal(readOnlyEscalation.statusCode, 403);
  await readOnlyApp.close();
  const wrongConfirmation = await app.inject({
    method: "PATCH",
    url: `/admin/database/requests/${r.id}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { changes: { closed_at: new Date().toISOString() } },
  });
  assert.equal(wrongConfirmation.statusCode, 404);
  const cleared = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: {
      "x-admin-token": cfg.HAIM_ADMIN_DESTRUCTIVE_TOKEN,
      "x-admin-capability": "destructive",
    },
    payload: { confirm: "מחק הכל" },
  });
  assert.equal(cleared.statusCode, 200);
  assert.ok(Number(cleared.json<{ deleted: { messages: number } }>().deleted.messages) >= before);
  const event = await pool.query<{ data: any }>(
    "SELECT data FROM request_events WHERE event_type='admin_test_data_cleared' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(event.rows[0]?.data?.operation, "clear_test_data");
  assert.equal(event.rows[0]?.data?.actor, "admin-http");
  assert.equal(event.rows[0]?.data?.capability, "destructive");
  assert.equal(event.rows[0]?.data?.target, "test_database");
  assert.equal(event.rows[0]?.data?.result, "success");
  assert.ok(Number.isFinite(Date.parse(event.rows[0]?.data?.timestamp)));
});
test("@lid and canonical chat resolve into one contact and ordered conversation", async () => {
  const p = phone();
  channel.lidPhone = p;
  const a = await enqueue(
      p,
      "שלום",
      undefined,
      false,
      randomUUID(),
      "77777@lid",
    ),
    b = await enqueue(p, "היי");
  assert.equal((await s.message(a.id)).phone, (await s.message(b.id)).phone);
  await engine.process(a.id);
  await engine.process(b.id);
  const ids = await pool.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM messages WHERE id=ANY($1)",
    [[a.id, b.id]],
  );
  assert.equal(new Set(ids.rows.map((r) => r.conversation_id)).size, 1);
});
test("OpenAI timeout retries once then durable human escalation, never invented success", async () => {
  const p = phone(),
    m = await enqueue(p, "טקסט לא מזוהה");
  ai.fail = true;
  try {
    await assert.rejects(engine.process(m.id, false), /openai_retry/);
    await engine.process(m.id, true);
    await engine.process(m.id, true);
  } finally {
    ai.fail = false;
  }
  assert.equal(
    (await outputs(m.id)).filter((o) => o.phone === cfg.ADMIN_PHONE).length,
    1,
  );
  assert.ok((await s.message(m.id)).processed_at);
  assert.equal((await s.active(p)).length, 0);
});
test("duplicate OpenAI/tool execution uses one persisted plan and one command result", async () => {
  const p = phone(),
    m = await enqueue(p, "אני רוצה למסור פריט מיוחד", [donate()]),
    before = ai.calls;
  await engine.process(m.id);
  await engine.process(m.id);
  assert.equal(ai.calls, before + 1);
  const rows = await pool.query<{ n: number }>(
    "SELECT count(*)::int n FROM command_results WHERE message_id=$1",
    [m.id],
  );
  assert.equal(rows.rows[0]!.n, 1);
  assert.equal((await s.active(p)).length, 1);
  // Ungrounded forged evidence must escalate to admin rather than execute.
  const forged: Plan = {
    commands: [donate(), donate()],
    evidence: "יש לי מיטה למסירה",
  };
  const second = await enqueue(phone(), "אני רוצה למסור פריט מיוחד");
  ai.plans.set(second.id, forged);
  await engine.process(second.id, true);
  assert.equal(
    (await outputs(second.id)).some((o) => o.phone === cfg.ADMIN_PHONE),
    true,
  );
  assert.equal(
    (await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM command_results WHERE message_id=$1",
      [second.id],
    )).rows[0]!.n,
    1,
  );
});
test(
  "native PostgreSQL: concurrent Tuesday booking transactions cannot oversubscribe",
  { skip: pglite },
  async () => {
    const a = await readyRequest(),
      b = await readyRequest(),
      date = "2026-12-01",
      when = new Date("2026-11-30T08:00:00Z");
    await setProposedDate(a, date);
    await setProposedDate(b, date);
    await pool.query("INSERT INTO transport_runs(date,capacity) VALUES($1,1) ON CONFLICT(date) DO UPDATE SET capacity=1", [
      date,
    ]);
    const results = await Promise.all(
      [a, b].map((r) =>
        s.transaction(async (c) => {
          await s.request(r.id, c, true);
          const outcome = await s.coordinate(c, r, when);
          await delay(30);
          await s.save(c, r);
          return outcome;
        }),
      ),
    );
    assert.deepEqual(results.sort(), ["coordinated", "full"]);
  },
);
test(
  "native PostgreSQL: SIGKILL worker lease recovers and successor stays blocked",
  { skip: pglite, timeout: 20000 },
  async () => {
    const name = "crash_recovery";
    await q.boss.createQueue(name, {
      policy: "key_strict_fifo",
      expireInSeconds: 1,
      retryLimit: 2,
      retryDelay: 0,
    });
    const first = await q.boss.send(name, { v: 1 }, { singletonKey: "crash" });
    await q.boss.send(name, { v: 2 }, { singletonKey: "crash" });
    const code = `import {PgBoss} from 'pg-boss';const b=new PgBoss({connectionString:process.env.TEST_DATABASE_URL,schema:'haim_core_test_jobs',migrate:false,schedule:false,supervise:false});await b.start();const [j]=await b.fetch('crash_recovery');console.log(j.id);setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", (b) => {
        if (!String(b).includes(first!)) reject(new Error("wrong claimed job"));
        else resolve();
      });
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await delay(1300);
    await q.boss.supervise(name);
    const recovered = await q.boss.fetch(name, { ignoreStartAfter: true });
    assert.equal(recovered[0]?.id, first);
    await q.boss.complete(name, first!);
  },
);
test("admin clear-all requires the exact destructive confirmation and resets test data only", async () => {
  const m = await enqueue(phone(), "שלום");
  assert.ok((await s.message(m.id)).id);
  const before = Number((await pool.query("SELECT count(*) FROM messages")).rows[0].count);
  assert.ok(before > 0);
  const wrong = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_DESTRUCTIVE_TOKEN, "x-admin-capability": "destructive" },
    payload: { confirm: "לא" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(Number((await pool.query("SELECT count(*) FROM messages")).rows[0].count), before);
  const cleared = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_DESTRUCTIVE_TOKEN, "x-admin-capability": "destructive" },
    payload: { confirm: "מחק הכל" },
  });
  assert.equal(cleared.statusCode, 200);
  assert.ok(Number(cleared.json<{ deleted: { messages: number } }>().deleted.messages) >= before);
  assert.equal((await pool.query("SELECT count(*) FROM messages")).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM contacts")).rows[0].count, "0");
  assert.equal(Number((await pool.query("SELECT value FROM request_counter WHERE id=true")).rows[0].value), 0);
  assert.equal((await pool.query("SELECT count(*) FROM location_datasets")).rows[0].count, "1");
});
