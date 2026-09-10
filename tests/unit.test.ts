import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  GREETING,
  PHOTO_THANKS,
  OUTSIDE,
  quickReply,
  isStatus,
  canonicalPhone,
  nextTuesday,
  nextQuestion,
  itemError,
  readyToCoordinate,
  statusText,
} from "../src/domain/policies.js";
import { planSchema, commandSchema } from "../src/domain/types.js";
import { parseWebhook, verifyHmac } from "../src/infrastructure/webhook.js";
import {
  LocalMediaStorage,
  allowedMediaUrl,
  downloadMedia,
} from "../src/infrastructure/media.js";
import { WahaChannel, DeliveryError } from "../src/infrastructure/waha.js";
import { config, JPEG, sampleRequest, donate } from "./fixtures.js";

test("שלום bypasses AI, information and donation only on request", () => {
  assert.equal(quickReply("שלום"), GREETING);
  assert.equal(quickReply("יש לי מיטה למסירה"), null);
  assert.match(quickReply("אשמח לעזרה בסוכה") ?? "", /docs.google.com\/forms/);
  assert.match(quickReply("איך אפשר לתרום כסף?") ?? "", /pe4ch/);
  assert.match(quickReply("מי הקים את התוכנית?") ?? "", /נועם גומעה/);
});
test("all required status phrasings are read only intents", () => {
  for (const s of [
    "מה מצב התיאום?",
    "מה הסטטוס?",
    "מה קורה עם ההובלה?",
    "מתי ההובלה?",
  ])
    assert.equal(isStatus(s), true, s);
  assert.equal(isStatus("יש לי מיטה חדשה למסירה"), false);
});
test("canonical phones reject LID and malformed identities", () => {
  for (const p of [
    "0501111111",
    "+972501111111",
    "972501111111@c.us",
    "00972501111111",
  ])
    assert.equal(canonicalPhone(p), "501111111");
  for (const p of ["12345@lid", "123", "phone:501111111", "972050111111100"])
    assert.throws(() => canonicalPhone(p));
});
test("donor without receiver can continue without photo", () => {
  const r = sampleRequest();
  r.parties = r.parties.slice(0, 1);
  r.photo_ids = [];
  assert.match(nextQuestion(r, r.parties[0]!.phone).text, /נא לאשר|יישוב|כתובת|מקבל/);
});
test("direct recipient does not require a photo to coordinate", () => {
  const r = sampleRequest();
  r.photo_ids = [];
  assert.equal(readyToCoordinate(r), true);
});
test("מחולה בכניסה enough and never mentions floor, including supplied floor", () => {
  const r = sampleRequest();
  assert.equal(readyToCoordinate(r), true);
  r.parties[0]!.name = null;
  const q = nextQuestion(r, r.parties[0]!.phone);
  assert.doesNotMatch(q.text, /קומה|קומות|רחוב|מספר בית/);
  assert.equal(q.floorNote, false);
});
test("Beit Shean floor note shown at most once; never asks באיזו קומה", () => {
  const r = sampleRequest(),
    p = r.parties[0]!;
  p.settlement = "בית שאן";
  p.address = null;
  assert.match(nextQuestion(r, p.phone).text, /בבניין עם קומות — לציין קומה/);
  p.floor_note_shown = true;
  assert.doesNotMatch(nextQuestion(r, p.phone).text, /קומה|קומות/);
});
test("when a Beit Shean donor supplied a name, ask only for the missing address", () => {
  const r = sampleRequest(),
    p = r.parties[0]!;
  p.settlement = "בית שאן";
  p.name = "ישראל";
  p.address = null;
  const q = nextQuestion(r, p.phone);
  assert.match(q.text, /חסרה רק הכתובת/);
  assert.doesNotMatch(q.text, /שם וכתובת/);
});
test("wardrobe rejection occurs after photo; only small whole wardrobe allowed", () => {
  const r = sampleRequest(),
    i = r.items[0]!;
  i.kind = "wardrobe";
  i.needs_disassembly = true;
  assert.equal(itemError(r.items, false), null);
  assert.match(itemError(r.items, true) ?? "", /אין אצלנו פירוק/);
  i.needs_disassembly = false;
  i.wardrobe_small_whole = true;
  assert.equal(readyToCoordinate(r), true);
});
test("fridge has no disassembly question; receiver never asked about disassembly", () => {
  const r = sampleRequest();
  r.items[0]!.needs_disassembly = null;
  r.parties[0]!.address = null;
  assert.doesNotMatch(nextQuestion(r, r.parties[0]!.phone).text, /פירוק/);
  assert.doesNotMatch(nextQuestion(r, r.parties[1]!.phone).text, /פירוק/);
});
test("two-item limit, table and chairs is one, free and usable are mandatory", () => {
  const r = sampleRequest();
  r.items[0]!.quantity = 3;
  assert.match(itemError(r.items, true) ?? "", /שני פריטים/);
  r.items[0]!.kind = "table_set";
  r.items[0]!.quantity = 1;
  assert.equal(itemError(r.items, true), null);
  r.items[0]!.free = false;
  assert.match(itemError(r.items, true) ?? "", /בחינם/);
  r.items[0]!.free = true;
  r.items[0]!.working = false;
  assert.match(itemError(r.items, true) ?? "", /100%/);
});
test("oven subtype mandatory; no inferred readiness from photos", () => {
  const r = sampleRequest();
  r.items[0]!.kind = "oven";
  assert.equal(readyToCoordinate(r), false);
  r.items[0]!.oven_type = "built_in";
  assert.equal(readyToCoordinate(r), true);
  r.items[0]!.working = null;
  assert.equal(readyToCoordinate(r), false);
});
test("each party approves their own identity", () => {
  const r = sampleRequest();
  r.parties[1]!.approved_by = r.parties[0]!.phone;
  assert.equal(readyToCoordinate(r), false);
  r.parties[1]!.approved_by = r.parties[1]!.phone;
  assert.equal(readyToCoordinate(r), true);
});
test("Tuesday window uses Jerusalem timezone and 20:00 cutoff", () => {
  assert.deepEqual(nextTuesday(new Date("2026-09-15T12:00:00Z")), {
    date: "2026-09-15",
    sameDay: true,
  });
  assert.deepEqual(nextTuesday(new Date("2026-09-15T17:00:00Z")), {
    date: "2026-09-22",
    sameDay: false,
  });
  assert.deepEqual(nextTuesday(new Date("2026-09-14T09:00:00Z")), {
    date: "2026-09-15",
    sameDay: false,
  });
});
test("coordinated status includes complete details and every active request", () => {
  const r = sampleRequest();
  r.status = "coordinated";
  r.run_date = "2026-09-15";
  const s = statusText([r, { ...r, number: 2 }]);
  for (const value of [
    "פנייה 1",
    "פנייה 2",
    "מקרר",
    "501111111",
    "502222222",
    "איסוף",
    "יעד",
    "2026-09-15",
    "16:00–20:00",
    "לפני ההגעה",
  ])
    assert.ok(s.includes(value));
});
test("tools cannot write status, SQL, actor identity, arbitrary fields or duplicate commands", () => {
  assert.equal(
    commandSchema.safeParse({
      type: "approve_self",
      request_number: 1,
      approved_by: "someone",
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: "sql", query: "delete from requests" })
      .success,
    false,
  );
  assert.equal(
    planSchema.safeParse({ commands: [donate(), donate()], evidence: "מסירה" })
      .success,
    false,
  );
  assert.equal(
    planSchema.safeParse({
      commands: [{ type: "status" }, donate()],
      evidence: "מסירה",
    }).success,
    false,
  );
});
test("WAHA official SHA-512 HMAC fixture, changed bytes rejected", () => {
  const b = Buffer.from(
    '{"event":"message","session":"default","engine":"WEBJS"}',
  );
  const signature =
    "208f8a55dde9e05519e898b10b89bf0d0b3b0fdf11fdbf09b6b90476301b98d8097c462b2b17a6ce93b6b47a136cf2e78a33a63f6752c2c1631777076153fa89";
  assert.equal(verifyHmac(b, "my-secret-key", signature), true);
  assert.equal(
    verifyHmac(
      Buffer.concat([b, Buffer.from(" ")]),
      "my-secret-key",
      signature,
    ),
    false,
  );
  assert.equal(
    verifyHmac(
      b,
      "my-secret-key",
      createHmac("sha256", "my-secret-key").update(b).digest("hex"),
    ),
    false,
  );
});
test("groups, status, newsletter, outbound and other sessions ignored; malformed rejected", () => {
  const data = {
    event: "message",
    session: "HAIM_YAHAD",
    payload: { id: "a", from: "972501111111@c.us", body: "hello" },
  };
  for (const from of ["123@g.us", "status@broadcast", "123@newsletter"])
    assert.equal(
      parseWebhook(
        { ...data, payload: { ...data.payload, from } },
        "HAIM_YAHAD",
      ),
      null,
    );
  assert.equal(parseWebhook({ ...data, session: "other" }, "HAIM_YAHAD"), null);
  assert.equal(
    parseWebhook(
      { ...data, payload: { ...data.payload, fromMe: true } },
      "HAIM_YAHAD",
    ),
    null,
  );
  assert.throws(() =>
    parseWebhook(
      { ...data, payload: { from: "972501111111@c.us" } },
      "HAIM_YAHAD",
    ),
  );
});

test("message.any is accepted and fromMe remains ignored", () => {
  const payload = {
    event: "message.any",
    session: "HAIM_YAHAD",
    payload: {
      id: "any-event-1",
      from: "972584152101@c.us",
      fromMe: false,
      body: "בדיקת message.any",
    },
  };
  assert.equal(parseWebhook(payload, "HAIM_YAHAD")?.text, "בדיקת message.any");
  assert.equal(
    parseWebhook(
      { ...payload, payload: { ...payload.payload, fromMe: true } },
      "HAIM_YAHAD",
    ),
    null,
  );
});
test("contact card supplies name/phone; location is optional and bounded", () => {
  const m = parseWebhook(
    {
      event: "message",
      session: "HAIM_YAHAD",
      payload: {
        id: "card",
        from: "972501111111@c.us",
        vCards: ["BEGIN:VCARD\nFN:בדיקה\nTEL;CELL:+972502222222\nEND:VCARD"],
      },
    },
    "HAIM_YAHAD",
  );
  assert.deepEqual(m?.contacts, [{ phone: "502222222", name: "בדיקה" }]);
});
test("@lid resolution uses configured session API and does not treat LID as phone", async () => {
  let path = "";
  const mock: typeof fetch = async (input) => {
    path = String(input);
    return new Response(JSON.stringify({ pn: "972501111111@c.us" }), {
      status: 200,
    });
  };
  assert.equal(
    await new WahaChannel(config(), mock).resolve("777@lid"),
    "501111111",
  );
  assert.match(path, /\/api\/HAIM_YAHAD\/lids\/777$/);
});
test("WAHA send explicit invalid chat falls back; timeout and 5xx do not resend", async () => {
  const routes: string[] = [];
  const channel = new WahaChannel(config(), async (_input, options) => {
    const b = JSON.parse(String(options?.body)) as { chatId: string };
    routes.push(b.chatId);
    return routes.length === 1
      ? new Response("invalid chat", { status: 400 })
      : new Response('{"id":"sent"}');
  });
  assert.equal(
    await channel.send({
      phone: "501111111",
      chat_id: "777@lid",
      text: "שלום",
    }),
    "sent",
  );
  assert.deepEqual(routes, ["777@lid", "972501111111@c.us"]);
  let calls = 0;
  const bad = new WahaChannel(config(), async () => {
    calls++;
    throw new Error("timeout");
  });
  await assert.rejects(
    bad.send({ phone: "501111111", chat_id: "777@lid", text: "x" }),
    (e: unknown) => e instanceof DeliveryError && e.certainty === "unknown",
  );
  assert.equal(calls, 1);
});
test("media is checksummed and durable; traversal and symlink paths rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "haim-unit-")),
    c = config({ MEDIA_ROOT: root }),
    store = new LocalMediaStorage(c);
  await store.init();
  try {
    const result = await store.put(JPEG, "image");
    assert.deepEqual(await store.get(result.key), JPEG);
    await assert.rejects(store.get("../../etc/passwd"));
    await assert.rejects(
      store.put(Buffer.from("not really an image"), "image"),
    );
    // Creating symbolic links requires Developer Mode or elevated privileges
    // on Windows. The production image runs on Linux, where this branch is
    // exercised as part of the normal suite.
    if (process.platform === "win32") return;
    const fake = "a".repeat(64) + ".jpg";
    await writeFile(join(root, "target"), JPEG);
    await symlink(join(root, "target"), join(root, c.DB_SCHEMA, fake));
    await assert.rejects(store.get(fake));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("media SSRF, redirects and oversized downloads are blocked", async () => {
  const c = config({ MEDIA_MAX_BYTES: 1024 });
  assert.throws(() =>
    allowedMediaUrl("http://169.254.169.254/latest/meta-data", c),
  );
  assert.throws(() => allowedMediaUrl(c.WAHA_BASE_URL + "/api/sessions", c));
  const data = Buffer.alloc(2048);
  await assert.rejects(
    downloadMedia(
      c.WAHA_BASE_URL + "/api/files/a.jpg",
      c,
      async () => new Response(data),
    ),
  );
});
test("required response constants preserved exactly", () => {
  assert.equal(PHOTO_THANKS, "תודה, התמונה התקבלה.");
  assert.ok(OUTSIDE.endsWith("לא נוכל לסייע בהובלה הזו."));
});
