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
import { makeHttp } from "../src/http.js";
import {
  PHOTO_FIRST,
  PHOTO_THANKS,
  OUTSIDE,
  HUMAN_REPLY,
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
  root = "";
const ai = new FakePlanner(),
  channel = new FakeChannel();
let counter = 0;
const phone = () => String(530000000 + ++counter);
before(async () => {
  root = await mkdtemp(join(tmpdir(), "haim-integration-"));
  cfg = config({ MEDIA_ROOT: root });
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
  const runtime = new Runtime(cfg, log, {
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
  await s.transaction(async (c) => {
    await s.request(r.id, c, true);
    await s.save(c, r);
  });
  return r;
}

test("migrations are idempotent; legacy schema untouched; relational constraints reject invalid data", async () => {
  await pool.query("CREATE SCHEMA IF NOT EXISTS haim");
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
test("donor bed without receiver PHOTO FIRST; prohibited early details never stored", async () => {
  const p = phone(),
    m = await message(p, "יש לי מיטה למסירה, שמי בדיקה במחולה בכניסה", [
      donate(),
      details({ name: "בדיקה", settlement: "מחולה", address: "בכניסה" }),
    ]);
  const r = (await s.active(p))[0]!;
  assert.equal(m.row.reply, PHOTO_FIRST);
  assert.equal(r.parties[0]!.name, null);
  assert.equal(r.parties[0]!.settlement, null);
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
  await message(receiver, "מאשר שוב", [
    { type: "approve_self", request_number: r.number },
  ]);
  const second = await s.request(r.id);
  assert.equal(
    first.parties.find((p) => p.role === "receiver")!.approved_at,
    second.parties.find((p) => p.role === "receiver")!.approved_at,
  );
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
test("cancellation notifies the other party and supports final close", async () => {
  const r = await readyRequest(),
    donor = r.parties.find((p) => p.role === "donor")!.phone,
    receiver = r.parties.find((p) => p.role === "receiver")!.phone;
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
test("receiver cannot alter donor item facts; attempted forbidden change escalates durably", async () => {
  const r = await readyRequest(),
    receiver = r.parties[1]!.phone;
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
  let result = await message(p, "אני רוצה למסור מיטה");
  assert.equal(result.row.reply, PHOTO_FIRST);
  assert.equal(ai.calls, calls);
});
test("repeated donation does not silently open a duplicate request", async () => {
  const p = phone();
  await message(p, "יש לי מיטה למסירה");
  const repeated = await message(p, "יש לי מיטה למסירה");
  assert.match(repeated.row.reply ?? "", /כבר קיימת פנייה/);
  assert.equal((await s.active(p)).length, 1);
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
  assert.equal(
    await s.transaction((c) =>
      s.coordinate(c, x, new Date("2026-09-29T08:00:00Z")),
    ),
    "same_day",
  );
});
test("20 coordinated arrangements are split 10 per week and the 21st waits for capacity", async () => {
  await pool.query(
    "INSERT INTO transport_runs(date,capacity) VALUES ($1,10),($2,10) ON CONFLICT(date) DO UPDATE SET capacity=10",
    ["2026-10-13", "2026-10-20"],
  );
  const traces: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await readyRequest();
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
  assert.equal(
    await s.transaction((c) => s.coordinate(c, waiting, new Date("2026-10-12T08:00:00Z"))),
    "full",
  );
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
test("admin edits only the approved legacy request fields and persists them", async () => {
  const r = await readyRequest();
  const response = await app.inject({
    method: "PATCH",
    url: `/admin/database/requests/${r.id}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: {
      changes: { preferred_time: "אחר הצהריים", represents_both_parties: true },
    },
  });
  assert.equal(response.statusCode, 200);
  const updated = await s.request(r.id);
  assert.equal(updated.preferred_time, "אחר הצהריים");
  assert.equal(updated.represents_both_parties, true);
  const forbidden = await app.inject({
    method: "PATCH",
    url: `/admin/database/requests/${r.id}`,
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { changes: { closed_at: new Date().toISOString() } },
  });
  assert.equal(forbidden.statusCode, 400);
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
  const forged: Plan = {
    commands: [donate(), donate()],
    evidence: "יש לי מיטה למסירה",
  };
  const secondText = "אני רוצה למסור פריט מיוחד";
  const second = await enqueue(phone(), secondText);
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
      date = "2026-10-06",
      when = new Date("2026-10-05T08:00:00Z");
    await pool.query("INSERT INTO transport_runs(date,capacity) VALUES($1,1)", [
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
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { confirm: "מחק הכל עכשיו" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(Number((await pool.query("SELECT count(*) FROM messages")).rows[0].count), before);
  const cleared = await app.inject({
    method: "POST",
    url: "/admin/database/clear-all",
    headers: { "x-admin-token": cfg.HAIM_ADMIN_TOKEN },
    payload: { confirm: "מחק הכל" },
  });
  assert.equal(cleared.statusCode, 200);
  assert.ok(Number(cleared.json<{ deleted: { messages: number } }>().deleted.messages) >= before);
  assert.equal((await pool.query("SELECT count(*) FROM messages")).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM contacts")).rows[0].count, "0");
  assert.equal(Number((await pool.query("SELECT value FROM request_counter WHERE id=true")).rows[0].value), 0);
  assert.equal((await pool.query("SELECT count(*) FROM location_datasets")).rows[0].count, "1");
});
