import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
test("donor image persists checksum and request link; neutral acknowledgement only", async () => {
  const p = phone(),
    r = await donation(p),
    m = await message(p, "", undefined, true),
    after = await s.request(r.id);
  assert.equal(m.row.reply, PHOTO_THANKS);
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
  assert.equal((await outputs(b.id))[0]!.text, PHOTO_THANKS);
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
    m = await enqueue(p, "יש לי מיטה למסירה", [donate()]),
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
  const second = await enqueue(phone(), "יש לי מיטה למסירה");
  ai.plans.set(second.id, forged);
  await engine.process(second.id, true);
  assert.equal(
    (await outputs(second.id)).some((o) => o.phone === cfg.ADMIN_PHONE),
    true,
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
