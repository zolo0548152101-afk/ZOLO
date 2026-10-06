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
  explicitApproval,
  directHandoffIntent,
  namedOutsideSettlement,
  customerCancelIntent,
  mentionedAllowedSettlement,
} from "../src/domain/policies.js";
import { rulePlan } from "../src/application/rule-planner.js";
import { Commands } from "../src/application/commands.js";
import type { Store } from "../src/infrastructure/store.js";
import type { Command, Context } from "../src/domain/types.js";
import { planSchema, commandSchema } from "../src/domain/types.js";
import { readConfig } from "../src/config.js";
import { parseWebhook, verifyHmac } from "../src/infrastructure/webhook.js";
import {
  LocalMediaStorage,
  allowedMediaUrl,
  downloadMedia,
} from "../src/infrastructure/media.js";
import { WahaChannel, DeliveryError } from "../src/infrastructure/waha.js";
import { managedNeedsHuman } from "../src/infrastructure/ai.js";
import { config, JPEG, sampleRequest, donate } from "./fixtures.js";

test("negative managed human-escalation text does not request escalation", () => {
  assert.equal(
    managedNeedsHuman({ needs_human: false }, { "נדרש טיפול אנושי": "לא" }),
    false,
  );
  assert.equal(
    managedNeedsHuman({ needs_human: false }, { "נדרש טיפול אנושי": "כן" }),
    true,
  );
});

test("שלום bypasses AI, information and donation only on request", () => {
  assert.equal(quickReply("שלום"), GREETING);
  assert.match(GREETING, /ימי שלישי בין השעות 16:00–20:00/);
  assert.match(GREETING, /עד 10 הובלות בכל יום שלישי/);
  assert.match(GREETING, /שם מלא/);
  assert.match(GREETING, /תמונה ושם של החפץ/);
  assert.match(GREETING, /עד 2 רהיטים/);
  assert.match(GREETING, /בית שאן ובעמק הקרוב/);
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
    "מה מצב הפנייה?",
    "זה כבר מתואם?",
  ])
    assert.equal(isStatus(s), true, s);
  assert.equal(isStatus("יש לי מיטה חדשה למסירה"), false);
});
test("approval accepts a clear consent after a self-introduction", () => {
  assert.equal(explicitApproval("אני טל, המקבלת. מאשרת את הפרטים."), true);
  assert.equal(explicitApproval("אני טל, המקבלת."), false);
});
test("recipient approval keeps location facts supplied in the same message", () => {
  const request = sampleRequest();
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.name = "טל";
  receiver.settlement = null;
  receiver.address = null;
  receiver.floor = null;
  receiver.approved_at = null;
  receiver.approved_by = null;
  const context: Context = {
    conversation: { id: "c-recipient-approval-facts", phone: receiver.phone, chat_id: "972536662043@c.us", mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [request],
    candidates: [],
    message: { id: "m-recipient-approval-facts", seq: "1", external_id: "e-recipient-approval-facts", trace_id: "t-recipient-approval-facts", mode: "live", chat_id: "972536662043@c.us", phone: receiver.phone, kind: "text", text: "כן, אני טל ומאשרת לקבל את המיטה. אני גרה בבית שאן ברחוב הגפן 6 קומה 2.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands ?? [];
  assert.equal(commands[0]?.type, "approve_self");
  const location = commands.find((command) => command.type === "details");
  assert.equal(location?.type, "details");
  if (location?.type === "details") {
    assert.equal(location.request_number, request.number);
    assert.equal(location.role, "receiver");
    assert.equal(location.name, null);
    assert.equal(location.settlement, "בית שאן");
    assert.equal(location.address, "רחוב הגפן 6");
    assert.equal(location.floor, 2);
  }
});
test("approval targets the sole open request still needing this party even when an older open request is selected", () => {
  const stale = sampleRequest();
  stale.id = "stale-open-request";
  stale.number = 5;
  stale.status = "collecting";
  stale.verification_contacted = true;
  const staleReceiver = stale.parties.find((party) => party.role === "receiver")!;
  staleReceiver.approved_at = "2026-10-05T12:00:00.000Z";
  staleReceiver.approved_by = staleReceiver.phone;

  const fresh = sampleRequest();
  fresh.id = "fresh-open-request";
  fresh.number = 6;
  fresh.status = "collecting";
  fresh.verification_contacted = true;
  fresh.items[0]!.kind = "sofa";
  fresh.items[0]!.description = "ספה";
  fresh.items[0]!.needs_disassembly = true;
  const freshReceiver = fresh.parties.find((party) => party.role === "receiver")!;
  freshReceiver.name = "טל";
  freshReceiver.approved_at = null;
  freshReceiver.approved_by = null;

  const context: Context = {
    conversation: {
      id: "c-stale-selected",
      phone: freshReceiver.phone,
      chat_id: "972536662043@c.us",
      mode: "bot",
      selected_request_id: stale.id,
      version: 4,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [stale, fresh],
    candidates: [],
    message: {
      id: "m-stale-selected",
      seq: "1",
      external_id: "e-stale-selected",
      trace_id: "t-stale-selected",
      mode: "live",
      chat_id: "972536662043@c.us",
      phone: freshReceiver.phone,
      kind: "text",
      text: "כן אני טל ומאשרת לקבל את הספה",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [
      {
        role: "assistant",
        content:
          "שלום טל,\n\nפנייה 6: ספה. המוסר ביקש שנפנה אליך כדי לאמת את הפרטים.\n\nנא לאשר שאתה מאשר את קבלת",
      },
    ],
  };
  const commands = rulePlan(context)?.commands ?? [];
  assert.equal(commands[0]?.type, "approve_self");
  assert.equal(
    commands[0] && "request_number" in commands[0]
      ? commands[0].request_number
      : null,
    fresh.number,
  );
});
test("מאשר את המועד is schedule approval, not a disassembly yes", () => {
  const r = sampleRequest();
  r.status = "collecting";
  r.proposed_run_date = null;
  r.items[0]!.kind = "sofa";
  r.items[0]!.working = true;
  r.items[0]!.needs_disassembly = null;
  const donor = r.parties.find((party) => party.role === "donor")!;
  donor.approved_at = "2026-10-05T12:00:00.000Z";
  donor.approved_by = donor.phone;
  const ctx = {
    conversation: {
      id: "conversation-disassembly-trap",
      phone: donor.phone,
      chat_id: `${donor.phone}@c.us`,
      mode: "bot",
      selected_request_id: r.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [r],
    candidates: [],
    message: { text: "מאשר את המועד", transcript: null, contacts: [] },
    history: [{ role: "assistant", content: "הפרטים נשמרו. נעדכן." }],
  } as unknown as Context;
  const plan = rulePlan(ctx);
  assert.ok(!plan?.commands.some((command) => command.type === "item_facts"));
});
test("date approval is a separate command and must match the current proposal prompt", () => {
  const r = sampleRequest();
  r.status = "awaiting_approval";
  r.proposed_run_date = "2026-09-29";
  for (const p of r.parties) {
    p.schedule_approved = false;
    p.schedule_approved_date = null;
    p.schedule_approved_at = null;
  }
  const ctx = {
    conversation: {
      id: "conversation-1",
      phone: r.parties[0]!.phone,
      chat_id: `${r.parties[0]!.phone}@c.us`,
      mode: "bot",
      selected_request_id: r.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [r],
    candidates: [],
    message: { text: "מאשר את התאריך 29/09/2026", transcript: null, contacts: [] },
    history: [{ role: "assistant", content: "הצעתי ליום שלישי 29/09/2026, 16:00–20:00. נא לאשר את המועד." }],
  } as unknown as Context;
  assert.deepEqual(rulePlan(ctx)?.commands, [
    { type: "approve_schedule", request_number: r.number, date: "2026-09-29" },
  ]);

  ctx.message.text = "מאשר את התאריך 06/10/2026";
  assert.deepEqual(rulePlan(ctx)?.commands, [
    { type: "approve_schedule", request_number: r.number, date: "2026-10-06" },
  ]);
  assert.equal(r.run_date, null, "a proposal must never populate confirmed run_date");
});
test("explicit approval of the exact shared proposal works without a same-chat proposal turn", () => {
  const r = sampleRequest();
  r.status = "awaiting_approval";
  r.proposed_run_date = "2026-09-29";
  const ctx = {
    conversation: {
      id: "conversation-donor",
      phone: r.parties[0]!.phone,
      chat_id: `${r.parties[0]!.phone}@c.us`,
      mode: "bot",
      selected_request_id: r.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [r],
    candidates: [],
    message: { text: "מאשר את המועד 29/09/2026", transcript: null, contacts: [] },
    history: [{ role: "assistant", content: "נפנה לצד השני עכשיו לצורך אימות. הפרטים נשמרו." }],
  } as unknown as Context;

  assert.deepEqual(rulePlan(ctx)?.commands, [
    { type: "approve_schedule", request_number: r.number, date: "2026-09-29" },
  ]);
});
test("recipient can approve the proposed date after the recipient-specific prompt", async () => {
  const request = sampleRequest();
  request.status = "awaiting_approval";
  request.proposed_run_date = "2026-09-29";
  request.run_date = null;
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.schedule_approved = false;
  receiver.schedule_approved_date = null;
  receiver.schedule_approved_at = null;
  const store = { request: async () => request } as unknown as Store;
  const ctx = {
    conversation: {
      id: "conversation-1",
      phone: receiver.phone,
      chat_id: `${receiver.phone}@c.us`,
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [request],
    candidates: [],
    message: { text: "כן, המועד 29/09/2026 מתאים לי", transcript: null, contacts: [] },
    history: [{
      role: "assistant",
      content: "היי טל, הוצע מועד ההובלה ליום שלישי, 29/09/2026, בין 16:00–20:00. נא לאשר במפורש שהמועד מתאים.",
    }],
  } as unknown as Context;
  const commands = new Commands(store, () => new Date("2026-09-28T07:29:32.000Z"));
  await commands.apply(null as never, ctx, {
    type: "approve_schedule",
    request_number: request.number,
    date: "2026-09-29",
  });
  assert.equal(receiver.schedule_approved, true);
  assert.equal(receiver.schedule_approved_date, "2026-09-29");
});
test("a party may approve the exact active proposal when the proposal was sent in the other chat", async () => {
  const request = sampleRequest();
  request.status = "awaiting_approval";
  request.proposed_run_date = "2026-09-29";
  request.run_date = null;
  const donor = request.parties.find((party) => party.role === "donor")!;
  donor.schedule_approved = false;
  donor.schedule_approved_date = null;
  donor.schedule_approved_at = null;
  const store = { request: async () => request } as unknown as Store;
  const ctx = {
    conversation: {
      id: "conversation-donor",
      phone: donor.phone,
      chat_id: `${donor.phone}@c.us`,
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [request],
    candidates: [],
    message: { text: "מאשר את המועד 29/09/2026", transcript: null, contacts: [] },
    history: [{ role: "assistant", content: "נפנה לצד השני עכשיו לצורך אימות. הפרטים נשמרו." }],
  } as unknown as Context;
  const commands = new Commands(store, () => new Date("2026-09-28T07:29:32.000Z"));

  await commands.apply(null as never, ctx, {
    type: "approve_schedule",
    request_number: request.number,
    date: "2026-09-29",
  });

  assert.equal(donor.schedule_approved, true);
  assert.equal(donor.schedule_approved_date, "2026-09-29");
  assert.equal(request.run_date, null, "one party's approval must not coordinate the request");
});
test("role approval records participation only and cannot approve a proposed date", async () => {
  const request = sampleRequest();
  request.parties[0]!.approved_at = null;
  request.parties[0]!.approved_by = null;
  request.parties[0]!.schedule_approved = false;
  request.parties[0]!.schedule_approved_date = null;
  request.parties[0]!.schedule_approved_at = null;
  const store = { request: async () => request } as unknown as Store;
  const ctx = {
    conversation: {
      id: "conversation-1",
      phone: request.parties[0]!.phone,
      chat_id: `${request.parties[0]!.phone}@c.us`,
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [request],
    candidates: [],
    message: { text: "מאשר לקבל", transcript: null, contacts: [] },
    history: [],
  } as unknown as Context;
  const commands = new Commands(store, () => new Date("2026-09-01T12:00:00.000Z"));
  await commands.apply(null as never, ctx, { type: "approve_self", request_number: request.number });
  assert.equal(request.parties[0]!.approved_by, request.parties[0]!.phone);
  assert.equal(request.parties[0]!.schedule_approved, false);
  assert.equal(request.parties[0]!.schedule_approved_date, null);
  assert.equal(readyToCoordinate(request), false);
  assert.equal(request.run_date, null);
});
test("an open donation that may help someone is not a direct handoff", () => {
  assert.equal(directHandoffIntent("יש לי כיסא למסירה, אולי יעזור למישהו."), false);
  assert.equal(directHandoffIntent("יש לי כיסא למסור למישהו ספציפי."), true);
  assert.equal(directHandoffIntent("שלום, יש לי ספה תקינה למסירה לטל 0536662043"), true);
  assert.equal(directHandoffIntent("יש לי מיטה למסירה"), false);
});
test("למסירה לטל stores the recipient name on the direct request", () => {
  const text = "שלום, יש לי ספה תקינה למסירה לטל 0536662043";
  const context = {
    conversation: {
      id: "c-sofa-named",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: null,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [],
    candidates: [],
    message: {
      id: "m-sofa-named",
      seq: "1",
      external_id: "e-sofa-named",
      trace_id: "t-sofa-named",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context;
  const command = rulePlan(context)?.commands[0];
  assert.equal(command?.type, "donate");
  if (command?.type === "donate") {
    assert.equal(command.direct, true);
    assert.equal(command.counterparty_phone, "536662043");
    assert.equal(command.counterparty_name, "טל");
  }
});
test("schedule approval phrasing is never stored as a person name", () => {
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "awaiting_approval";
  direct.verification_contacted = true;
  direct.proposed_run_date = "2026-10-06";
  direct.parties[0]!.role = "receiver";
  direct.parties[0]!.phone = "536662043";
  direct.parties[0]!.name = null;
  direct.parties[0]!.settlement = "בית שאן";
  direct.parties[0]!.address = "רחוב העלייה 8";
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "536662043";
  direct.parties[1]!.role = "donor";
  direct.parties[1]!.phone = "584152101";
  direct.parties[1]!.name = "ישראל";
  direct.parties[1]!.settlement = "בית שאן";
  direct.parties[1]!.address = "רחוב העלייה 5";
  const context = {
    conversation: {
      id: "c-bad-name",
      phone: "536662043",
      chat_id: "972536662043@c.us",
      mode: "bot",
      selected_request_id: direct.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [direct],
    candidates: [],
    message: {
      id: "m-bad-name",
      seq: "1",
      external_id: "e-bad-name",
      trace_id: "t-bad-name",
      mode: "live",
      chat_id: "972536662043@c.us",
      phone: "536662043",
      kind: "text",
      text: "מאשרת את המועד",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [
      {
        role: "assistant",
        content: "הוצע מועד ההובלה ליום שלישי 06/10/2026, בין 16:00–20:00. נא לאשר את המועד במפורש.",
      },
    ],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  assert.equal(
    commands.some((command) => command.type === "details" && command.name === "מאשרת את המועד"),
    false,
  );
});
test("a lamp direct handoff opens a new request even when a bed donation is already open", () => {
  const text =
    "בדיקת העברה חיה: יש לי מנורה שולחנית תקינה למסירה ישירות לטל 0536662043. אני מבית שאן, האיסוף מרחוב העלייה 5 קומה 2. אין לי תמונה כרגע.";
  const openBed = sampleRequest();
  openBed.origin = "donation";
  openBed.status = "collecting";
  openBed.items[0]!.kind = "bed";
  openBed.items[0]!.description = "מיטה";
  openBed.items[0]!.working = null;
  openBed.parties = openBed.parties.filter((party) => party.role === "donor");
  openBed.parties[0]!.phone = "584152101";
  openBed.parties[0]!.settlement = "בית שאן";
  openBed.parties[0]!.address = "רחוב הגפן 1";
  openBed.parties[0]!.floor = 1;
  const context = {
    conversation: {
      id: "c-lamp-direct",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: openBed.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [openBed],
    candidates: [],
    message: {
      id: "m-lamp-direct",
      seq: "1",
      external_id: "e-lamp-direct",
      trace_id: "t-lamp-direct",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const donate = commands.find((command) => command.type === "donate");
  assert.equal(donate?.type, "donate");
  if (donate?.type === "donate") {
    assert.equal(donate.direct, true);
    assert.equal(donate.items[0]?.kind, "other");
    assert.equal(donate.items[0]?.description, "מנורה");
    assert.equal(donate.counterparty_phone, "536662043");
  }
  const details = commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.role, "donor");
    assert.equal(details.settlement, "בית שאן");
    assert.equal(details.address, "רחוב העלייה 5");
    assert.equal(details.floor, 2);
  }
});
test("destination address wording is stored on the receiver in a direct handoff", () => {
  const text = "טל כהן, כתובת היעד בית שאן רחוב שיכון א 8 קומה 1. מאשר לפנות אליה לאימות.";
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "collecting";
  direct.items[0]!.kind = "other";
  direct.items[0]!.description = "מנורה";
  direct.items[0]!.working = true;
  direct.verification_contacted = false;
  direct.parties[0]!.role = "donor";
  direct.parties[0]!.phone = "584152101";
  direct.parties[0]!.settlement = "בית שאן";
  direct.parties[0]!.address = "רחוב העלייה 5";
  direct.parties[0]!.floor = 2;
  // Donors are auto-approved when a direct handoff opens.
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "584152101";
  direct.parties[0]!.schedule_approved = false;
  direct.parties[0]!.schedule_approved_date = null;
  direct.parties[0]!.schedule_approved_at = null;
  direct.parties[1]!.role = "receiver";
  direct.parties[1]!.phone = "536662043";
  direct.parties[1]!.settlement = null;
  direct.parties[1]!.address = null;
  direct.parties[1]!.floor = null;
  direct.parties[1]!.approved_at = null;
  direct.parties[1]!.approved_by = null;
  direct.parties[1]!.schedule_approved = false;
  direct.parties[1]!.schedule_approved_date = null;
  direct.parties[1]!.schedule_approved_at = null;
  const context = {
    conversation: {
      id: "c-dest",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: direct.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [direct],
    candidates: [],
    message: {
      id: "m-dest",
      seq: "2",
      external_id: "e-dest",
      trace_id: "t-dest",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [
      {
        role: "assistant",
        content: "האם תרצה שנפנה למקבל לצורך אימות הפרטים?",
      },
    ],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const details = commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.role, "receiver");
    assert.equal(details.settlement, "בית שאן");
    assert.equal(details.address, "רחוב שיכון א 8");
    assert.equal(details.floor, 1);
  }
  assert.equal(
    commands.some(
      (command) => command.type === "contact_counterparty" && command.contact === true,
    ),
    true,
  );
});
test("a lamp is not treated as a duplicate of another other-item like a dresser", () => {
  const openDresser = sampleRequest();
  openDresser.origin = "direct";
  openDresser.status = "collecting";
  openDresser.items[0]!.kind = "other";
  openDresser.items[0]!.description = "שידה";
  openDresser.parties = openDresser.parties.filter((party) => party.role === "donor");
  openDresser.parties[0]!.phone = "584152101";
  const context = {
    conversation: {
      id: "c-other-dup",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: openDresser.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [openDresser],
    candidates: [],
    message: {
      id: "m-other-dup",
      seq: "1",
      external_id: "e-other-dup",
      trace_id: "t-other-dup",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text: "אני רוצה למסור מנורה תקינה לטל 0536662043",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  assert.equal(commands.some((command) => command.type === "clarify_duplicate"), false);
  const donate = commands.find((command) => command.type === "donate");
  assert.equal(donate?.type, "donate");
  if (donate?.type === "donate") assert.equal(donate.items[0]?.description, "מנורה");
});
test("איסוף and מסירה in one consent message store both pickup and destination", () => {
  const text =
    "איסוף בית שאן רחוב העלייה 5 קומה 2, מסירה בית שאן רחוב העלייה 8 קומה 1, מאשר ליצור קשר";
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "collecting";
  direct.items[0]!.kind = "other";
  direct.items[0]!.description = "מנורה";
  direct.verification_contacted = false;
  direct.parties[0]!.role = "donor";
  direct.parties[0]!.phone = "584152101";
  direct.parties[0]!.settlement = null;
  direct.parties[0]!.address = null;
  direct.parties[0]!.floor = null;
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "584152101";
  direct.parties[1]!.role = "receiver";
  direct.parties[1]!.phone = "536662043";
  direct.parties[1]!.settlement = null;
  direct.parties[1]!.address = null;
  direct.parties[1]!.floor = null;
  const context = {
    conversation: {
      id: "c-pickup-dropoff",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: direct.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [direct],
    candidates: [],
    message: {
      id: "m-pickup-dropoff",
      seq: "1",
      external_id: "e-pickup-dropoff",
      trace_id: "t-pickup-dropoff",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const donor = commands.find((command) => command.type === "details" && command.role === "donor");
  const receiver = commands.find((command) => command.type === "details" && command.role === "receiver");
  assert.equal(donor?.type, "details");
  assert.equal(receiver?.type, "details");
  if (donor?.type === "details") {
    assert.equal(donor.address, "רחוב העלייה 5");
    assert.equal(donor.floor, 2);
  }
  if (receiver?.type === "details") {
    assert.equal(receiver.address, "רחוב העלייה 8");
    assert.equal(receiver.floor, 1);
  }
  assert.equal(
    commands.some((command) => command.type === "contact_counterparty" && command.contact === true),
    true,
  );
});
test("bare איסוף/מסירה without רחוב or comma still stores both endpoints and consent", () => {
  const text = "איסוף העלייה 5 דירה 2 מסירה העלייה 8 דירה 1 מאשר ליצור קשר";
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "collecting";
  direct.items[0]!.kind = "other";
  direct.items[0]!.description = "מנורה";
  direct.verification_contacted = false;
  direct.parties[0]!.role = "donor";
  direct.parties[0]!.phone = "584152101";
  direct.parties[0]!.settlement = null;
  direct.parties[0]!.address = null;
  direct.parties[0]!.floor = null;
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "584152101";
  direct.parties[1]!.role = "receiver";
  direct.parties[1]!.phone = "536662043";
  direct.parties[1]!.name = "טל";
  direct.parties[1]!.settlement = null;
  direct.parties[1]!.address = null;
  direct.parties[1]!.floor = null;
  const context = {
    conversation: {
      id: "c-bare-pickup-dropoff",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: direct.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [direct],
    candidates: [],
    message: {
      id: "m-bare-pickup-dropoff",
      seq: "1",
      external_id: "e-bare-pickup-dropoff",
      trace_id: "t-bare-pickup-dropoff",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [
      {
        role: "assistant",
        content: "האם תרצה שנפנה למקבל לצורך אימות הפרטים?",
      },
    ],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const donor = commands.find((command) => command.type === "details" && command.role === "donor");
  const receiver = commands.find((command) => command.type === "details" && command.role === "receiver");
  assert.equal(donor?.type, "details");
  assert.equal(receiver?.type, "details");
  if (donor?.type === "details") {
    assert.equal(donor.settlement, "בית שאן");
    assert.equal(donor.address, "רחוב העלייה 5");
    assert.equal(donor.floor, null, "דירה is not a floor");
  }
  if (receiver?.type === "details") {
    assert.equal(receiver.settlement, "בית שאן");
    assert.equal(receiver.address, "רחוב העלייה 8");
    assert.equal(receiver.floor, null, "דירה is not a floor");
  }
  assert.equal(
    commands.some((command) => command.type === "contact_counterparty" && command.contact === true),
    true,
  );
});
test("השם שלי extracts only the personal name", () => {
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "collecting";
  direct.verification_contacted = true;
  direct.parties[0]!.role = "donor";
  direct.parties[0]!.phone = "584152101";
  direct.parties[0]!.name = null;
  direct.parties[0]!.settlement = "בית שאן";
  direct.parties[0]!.address = "רחוב העלייה 5";
  direct.parties[0]!.floor = 2;
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "584152101";
  direct.parties[1]!.role = "receiver";
  direct.parties[1]!.phone = "536662043";
  direct.parties[1]!.name = "טל";
  direct.parties[1]!.settlement = "בית שאן";
  direct.parties[1]!.address = "רחוב העלייה 8";
  const context = {
    conversation: {
      id: "c-donor-name",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: direct.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [direct],
    candidates: [],
    message: {
      id: "m-donor-name",
      seq: "1",
      external_id: "e-donor-name",
      trace_id: "t-donor-name",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text: "השם שלי ישראל",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [{ role: "assistant", content: "תודה. חסר רק השם." }],
  } as Context;
  const command = rulePlan(context)?.commands[0];
  assert.equal(command?.type, "details");
  if (command?.type === "details") assert.equal(command.name, "ישראל");
});
test("direct handoff does not require disassembly and preserves explicit broken fact", () => {
  const r = sampleRequest();
  r.origin = "direct";
  r.items[0]!.needs_disassembly = null;
  assert.equal(readyToCoordinate(r), true);
  const ctx = {
    message: {
      text: "אני רוצה למסור מיטה שבורה לטל",
      transcript: null,
      contacts: [],
      location: null,
    },
  } as never;
  const p = rulePlan(ctx);
  assert.equal(p?.commands[0]?.type, "donate");
  if (p?.commands[0]?.type === "donate") assert.equal(p.commands[0].working, false);
});
test("direct handoff with a comma after the recipient keeps the supplied pickup location", () => {
  const text = "אהלן, יש לי שידה למסור לטל, נראה לי 0536662043. היא בבית שאן ברחוב העלייה 7, קומה 2.";
  const context = {
    conversation: { id: "c", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972584152101@c.us", phone: "584152101", kind: "text", text, contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const location = commands.find((command) => command.type === "details");
  assert.equal(location?.type, "details");
  if (location?.type === "details") {
    assert.equal(location.role, "donor");
    assert.equal(location.settlement, "בית שאן");
    assert.equal(location.address, "רחוב העלייה 7");
    assert.equal(location.floor, 2);
  }
});
test("direct handoff opening stores donor pickup facts and name without a photo", () => {
  const text = "יש לי מיטה למסור לטל 0536662043 — אני יוסי מבית שאן, האיסוף משאול המלך 10 קומה 1. אין לי תמונה כרגע.";
  const context = {
    conversation: { id: "c", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m-direct-pickup-opening", seq: "1", external_id: "e-direct-pickup-opening", trace_id: "t-direct-pickup-opening", mode: "live", chat_id: "972584152101@c.us", phone: "584152101", kind: "text", text, contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  const details = commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.role, "donor");
    assert.equal(details.name, "יוסי");
    assert.equal(details.settlement, "בית שאן");
    assert.equal(details.address, "רחוב שאול המלך 10");
    assert.equal(details.floor, 1);
  }
});
test("direct handoff by phone after a correction keeps donor name and pickup facts", () => {
  const text = "רגע, תיקון: יש לי שידה קטנה למסירה ישירות למספר 0584152101. אני טל מבית שאן, האיסוף מרחוב הגפן 6 קומה 2. אין לי תמונה.";
  const context = {
    conversation: { id: "c-direct-phone-correction", phone: "536662043", chat_id: "972536662043@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m-direct-phone-correction", seq: "1", external_id: "e-direct-phone-correction", trace_id: "t-direct-phone-correction", mode: "live", chat_id: "972536662043@c.us", phone: "536662043", kind: "text", text, contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  } as Context;
  const commands = rulePlan(context)?.commands ?? [];
  assert.equal(commands.filter((command) => command.type === "donate").length, 1);
  const details = commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.role, "donor");
    assert.equal(details.name, "טל");
    assert.equal(details.settlement, "בית שאן");
    assert.equal(details.address, "רחוב הגפן 6");
    assert.equal(details.floor, 2);
  }
});
test("name introduction answer stores the extracted name, not the label text", () => {
  const request = sampleRequest(), donor = request.parties.find((party) => party.role === "donor")!;
  donor.name = null;
  donor.settlement = "בית שאן";
  donor.address = "רחוב העלייה 7";
  const context: Context = {
    conversation: { id: "c", phone: donor.phone, chat_id: "972584152101@c.us", mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null },
    requests: [request],
    candidates: [],
    message: { id: "m-name", seq: "1", external_id: "e-name", trace_id: "t-name", mode: "simulation", chat_id: "972584152101@c.us", phone: donor.phone, kind: "text", text: "השם הוא זולו.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const details = rulePlan(context)?.commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") assert.equal(details.name, "זולו");
});
test("natural אני name introduction stores only the person's name", () => {
  const request = sampleRequest(), donor = request.parties.find((party) => party.role === "donor")!;
  donor.name = null;
  donor.settlement = "בית שאן";
  donor.address = "רחוב העלייה 7";
  const context: Context = {
    conversation: { id: "c", phone: donor.phone, chat_id: "972584152101@c.us", mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null },
    requests: [request],
    candidates: [],
    message: { id: "m-name-natural", seq: "1", external_id: "e-name-natural", trace_id: "t-name-natural", mode: "simulation", chat_id: "972584152101@c.us", phone: donor.phone, kind: "text", text: "אני יוסי", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const details = rulePlan(context)?.commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") assert.equal(details.name, "יוסי");
});
test("direct pickup reply extracts street and name from the first location answer", () => {
  const request = sampleRequest(),
    donor = request.parties.find((party) => party.role === "donor")!;
  donor.name = null;
  donor.settlement = null;
  donor.address = null;
  donor.floor = null;
  const context: Context = {
    conversation: { id: "c", phone: donor.phone, chat_id: "972584152101@c.us", mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null },
    requests: [request],
    candidates: [],
    message: { id: "m-pickup-context", seq: "1", external_id: "e-pickup-context", trace_id: "t-pickup-context", mode: "simulation", chat_id: "972584152101@c.us", phone: donor.phone, kind: "text", text: "לגבי האיסוף: בית שאן, שאול המלך 10, קומה 1. אני יוסי.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const details = rulePlan(context)?.commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.role, "donor");
    assert.equal(details.name, "יוסי");
    assert.equal(details.settlement, "בית שאן");
    assert.equal(details.address, "רחוב שאול המלך 10");
    assert.equal(details.floor, 1);
  }
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
  p.floor = null;
  assert.match(nextQuestion(r, p.phone).text, /בבניין עם קומות — לציין קומה/);
  p.floor_note_shown = true;
  assert.doesNotMatch(nextQuestion(r, p.phone).text, /קומה|קומות/);
});
test("Beit Shean does not remind someone to provide a floor already stored", () => {
  const r = sampleRequest(),
    p = r.parties[0]!;
  p.settlement = "בית שאן";
  p.name = null;
  p.address = "רחוב העלייה 7";
  p.floor = 2;
  const q = nextQuestion(r, p.phone);
  assert.equal(q.text, "תודה. חסר רק השם.");
  assert.equal(q.floorNote, false);
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
test("address plus floor never becomes a receiver name or repeats the settlement", () => {
  const request = sampleRequest();
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.name = "טל";
  receiver.settlement = "בית שאן";
  receiver.address = "רחוב העלייה 30";
  receiver.floor = null;
  const context: Context = {
    conversation: {
      id: "c",
      phone: receiver.phone,
      chat_id: "972502222222@c.us",
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
    },
    requests: [request],
    candidates: [],
    message: {
      id: "m-floor",
      seq: "3",
      external_id: "e-floor",
      trace_id: "t-floor",
      mode: "simulation",
      chat_id: "972502222222@c.us",
      phone: receiver.phone,
      kind: "text",
      text: "בית שאן, רחוב המלך 5, קומה 2.",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  };
  const command = rulePlan(context)?.commands[0];
  assert.deepEqual(command, {
    type: "details",
    request_number: request.number,
    role: "receiver",
    name: null,
    settlement: null,
    address: "רחוב המלך 5",
    floor: 2,
  });
});
test("receiver's first settlement message persists a supplied floor", () => {
  const request = sampleRequest();
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.name = null;
  receiver.settlement = null;
  receiver.address = null;
  receiver.floor = null;
  const context: Context = {
    conversation: {
      id: "c",
      phone: receiver.phone,
      chat_id: "972502222222@c.us",
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
    },
    requests: [request],
    candidates: [],
    message: {
      id: "m-first-location",
      seq: "4",
      external_id: "e-first-location",
      trace_id: "t-first-location",
      mode: "simulation",
      chat_id: "972502222222@c.us",
      phone: receiver.phone,
      kind: "text",
      text: "בית שאן, רחוב המלך 5, קומה 1.",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  };
  const command = rulePlan(context)?.commands[0];
  assert.deepEqual(command, {
    type: "details",
    request_number: request.number,
    role: "receiver",
    name: null,
    settlement: "בית שאן",
    address: "רחוב המלך 5",
    floor: 1,
  });
});
test("deterministic flow turns a donation sentence into a request without AI", () => {
  const r = sampleRequest();
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה למסור מיטה", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const result = rulePlan(context);
  assert.equal(result?.commands[0]?.type, "donate");
  assert.equal((result?.commands[0] as Extract<typeof result.commands[number], { type: "donate" }>).items[0]?.kind, "bed");
  assert.equal(r.items[0]?.kind, "fridge");
});
test("a bookcase donation in an allowed town is an item, not a recipient named למסור", () => {
  const context: Context = {
    conversation: { id: "c-library", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [],
    candidates: [],
    message: { id: "m-library", seq: "1", external_id: "e-library", trace_id: "t-library", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "שלום למסור ספרייה בבית שאן", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands ?? [];
  const donation = commands.find((command) => command.type === "donate");
  const details = commands.find((command) => command.type === "details");
  assert.equal(donation?.type, "donate");
  if (donation?.type === "donate") {
    assert.equal(donation.direct, false);
    assert.equal(donation.counterparty_name, null);
    assert.equal(donation.items[0]?.description, "ספרייה");
  }
  assert.equal(details?.type === "details" ? details.settlement : null, "בית שאן");
  assert.equal(namedOutsideSettlement("שלום, אני רוצה למסור כיסא בנצרת"), "נצרת");
});
test("general donation preserves opening pickup facts and an explicit condition", () => {
  const context: Context = {
    conversation: { id: "c", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972584152101@c.us", phone: "584152101", kind: "text", text: "יש לי מיטה זוגית תקינה למסירה בחינם בבית שאן, רחוב הגפן 6 קומה 2 עם מעלית. שולחת תמונה.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands ?? [];
  const donation = commands.find((command) => command.type === "donate");
  const details = commands.find((command) => command.type === "details");
  assert.equal(donation?.type === "donate" ? donation.working : null, true);
  assert.deepEqual(details, {
    type: "details",
    request_number: null,
    role: "donor",
    name: null,
    settlement: "בית שאן",
    address: "רחוב הגפן 6",
    floor: 2,
  });
});
test("deterministic donation extracts a named recipient", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה למסור מיטה למקבל 0528888888", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const command = rulePlan(context)?.commands[0];
  assert.equal(command?.type, "donate");
  assert.equal(
    (command as Extract<Command, { type: "donate" }>).counterparty_phone,
    "528888888",
  );
});
test("deterministic donation extracts a recipient written directly after ל", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה למסור מיטה ל0529990002", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const command = rulePlan(context)?.commands[0];
  assert.equal(command?.type, "donate");
  assert.equal(
    (command as Extract<Command, { type: "donate" }>).counterparty_phone,
    "529990002",
  );
});
test("general request wording with למסירה remains a seek intent", () => {
  const context: Context = {
    conversation: { id: "c", phone: "536662043", chat_id: "972536662043@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972536662043@c.us", phone: "536662043", kind: "text", text: "צריך כיסא דחוף לבית שאן, לא משנה לי שכונה, רק שיהיה למסירה ולא קנייה.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const command = rulePlan(context)?.commands[0];
  assert.equal(command?.type, "seek");
  if (command?.type === "seek") assert.equal(command.kind, "chairs");
});
test("self transfer extracts pickup and destination independently from one message", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני מעביר לעצמי שולחן מבית שאן רחוב שאול המלך 5 לבית שאן רחוב העלייה 28, קומה 2. מתי אפשר?", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands;
  assert.equal(commands?.[0]?.type, "donate");
  assert.equal(commands?.[1]?.type, "details");
  assert.equal(commands?.[2]?.type, "details");
  const pickup = commands?.[1];
  const destination = commands?.[2];
  assert.equal(pickup?.type === "details" ? pickup.role : null, "donor");
  assert.equal(pickup?.type === "details" ? pickup.name : null, null);
  assert.equal(pickup?.type === "details" ? pickup.settlement : null, "בית שאן");
  assert.equal(pickup?.type === "details" ? pickup.address : null, "רחוב שאול המלך 5");
  assert.equal(destination?.type === "details" ? destination.role : null, "receiver");
  assert.equal(destination?.type === "details" ? destination.settlement : null, "בית שאן");
  assert.equal(destination?.type === "details" ? destination.address : null, "רחוב העלייה 28");
  assert.equal(destination?.type === "details" ? destination.floor : null, 2);
});
test("self transfer preserves an explicitly supplied name from the opening turn", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני זולו, צריך להעביר לעצמי שולחן מבית שאן, רחוב שאול המלך 5 קומה 1, לבית שאן רחוב העלייה 28 קומה 2. פריט אחד, בחינם, שמיש ותקין. מתי אפשר?", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands;
  const donor = commands?.find((command) => command.type === "details" && command.role === "donor");
  const receiver = commands?.find((command) => command.type === "details" && command.role === "receiver");
  assert.equal(donor?.type === "details" ? donor.name : null, "זולו");
  assert.equal(receiver?.type === "details" ? receiver.name : null, "זולו");
  assert.equal(donor?.type === "details" ? donor.address : null, "רחוב שאול המלך 5");
  assert.equal(donor?.type === "details" ? donor.floor : null, 1);
  assert.equal(receiver?.type === "details" ? receiver.address : null, "רחוב העלייה 28");
  assert.equal(receiver?.type === "details" ? receiver.floor : null, 2);
});
test("self transfer recognizes להעביר אליי with pickup and destination phrased as אוספים ומביאים", () => {
  const context: Context = {
    conversation: { id: "c", phone: "536662043", chat_id: "972536662043@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972536662043@c.us", phone: "536662043", kind: "text", text: "היי, אני טליה וישלי כיסא אחד להעביר אליי. אוספים מבית שאן רחוב הגלבוע 9 קומה 3, ומביאים לבית שאן שכונת שיכון א׳ קומה 1. בחינם ותקין, שלישי הבא מתאים לי.", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands;
  const donation = commands?.find((command) => command.type === "donate");
  const donor = commands?.find((command) => command.type === "details" && command.role === "donor");
  const receiver = commands?.find((command) => command.type === "details" && command.role === "receiver");
  assert.equal(donation?.type === "donate" ? donation.direct : null, true);
  assert.equal(donor?.type === "details" ? donor.name : null, "טליה");
  assert.equal(donor?.type === "details" ? donor.address : null, "רחוב הגלבוע 9");
  assert.equal(donor?.type === "details" ? donor.floor : null, 3);
  assert.equal(receiver?.type === "details" ? receiver.address : null, "שכונת שיכון א׳");
  assert.equal(receiver?.type === "details" ? receiver.floor : null, 1);
});
test("self transfer inherits settlement only when destination omits it", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "רוצה להעביר לעצמי שידה משיכון א בבית שאן לרחוב הגלבוע 7, שתי כתובות שונות", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const commands = rulePlan(context)?.commands;
  assert.equal(commands?.[1]?.type, "details");
  const pickup = commands?.[1];
  const destination = commands?.[2];
  assert.equal(pickup?.type === "details" ? pickup.address : null, "שיכון א");
  assert.equal(destination?.type === "details" ? destination.address : null, "רחוב הגלבוע 7");
  assert.equal(destination?.type === "details" ? destination.settlement : null, "בית שאן");
});
test("direct handoff assigns an address after the named recipient phone to the receiver", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "יש לי שידה למסור לטל 0528888888, בבית שאן רחוב העלייה 7 קומה 2", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const details = rulePlan(context)?.commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  assert.equal(details?.type === "details" ? details.role : null, "receiver");
  assert.equal(details?.type === "details" ? details.settlement : null, "בית שאן");
  assert.equal(details?.type === "details" ? details.address : null, "רחוב העלייה 7");
  assert.equal(details?.type === "details" ? details.floor : null, 2);
});
test("direct handoff without a phone skips condition checks and asks before contact", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה להעביר מיטה למישהו שרון", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const command = rulePlan(context)?.commands[0] as Extract<Command, { type: "donate" }>;
  assert.equal(command.direct, true);
  assert.equal(command.working, true);
  const r = sampleRequest();
  r.parties = r.parties.slice(0, 1);
  r.origin = "direct";
  r.verification_contacted = false;
  assert.match(nextQuestion(r, r.parties[0]!.phone).text, /נפנה למקבל לצורך אימות/);
  assert.doesNotMatch(nextQuestion(r, r.parties[0]!.phone).text, /תקין ושמיש|תמונה/);
});
test("named recipient who wants the item bypasses the photo gate", () => {
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null },
    requests: [],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה למסור מיטה לטל היא רוצה לקבל אותה", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const command = rulePlan(context)?.commands[0] as Extract<Command, { type: "donate" }>;
  assert.equal(command.type, "donate");
  assert.equal(command.direct, true);
  assert.equal(command.working, true);
});
test("partial recipient name followed by a VCard asks one confirmation question", () => {
  const request = sampleRequest();
  request.origin = "donation";
  request.photo_ids = [];
  request.parties = request.parties.slice(0, 1);
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [request], candidates: [],
    message: { id: "m", seq: "2", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "BEGIN:VCARD\nFN:טל זולו\nTEL;waid=972536662043:+972 53-666-2043\nEND:VCARD", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [{ role: "user", content: "למסור לט" }],
  };
  const candidate = rulePlan(context)?.commands[0];
  assert.equal(candidate?.type, "counterparty_candidate");
  assert.equal((candidate as Extract<Command, { type: "counterparty_candidate" }>).phone, "536662043");
  assert.equal((candidate as Extract<Command, { type: "counterparty_candidate" }>).name, "טל זולו");
  context.message.text = "כן";
  context.conversation.pending_counterparty_phone = "536662043";
  context.conversation.pending_counterparty_name = "טל זולו";
  const confirmation = rulePlan(context)?.commands[0];
  assert.deepEqual(confirmation, { type: "confirm_counterparty", request_number: request.number, accept: true });
});
test("an explicit new donation is not confused with an older open request", () => {
  const older = sampleRequest();
  const context: Context = {
    conversation: { id: "c", phone: "501111111", chat_id: "972501111111@c.us", mode: "bot", selected_request_id: older.id, version: 1, pending_counterparty_name: null },
    requests: [older],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id: "972501111111@c.us", phone: "501111111", kind: "text", text: "אני רוצה למסור מיטה", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const result = rulePlan(context);
  assert.equal(result?.commands[0]?.type, "donate");
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
test("coordination requires each party to approve the same proposed Tuesday", () => {
  const r = sampleRequest();
  r.proposed_run_date = "2026-09-29";
  for (const p of r.parties) {
    p.schedule_approved = true;
    p.schedule_approved_date = null;
    p.schedule_approved_at = null;
  }
  assert.equal(readyToCoordinate(r), false, "legacy boolean flags are not date consent");
  assert.equal(readyToCoordinate(r), false);
  r.parties[0]!.schedule_approved = true;
  r.parties[0]!.schedule_approved_date = "2026-09-29";
  assert.equal(r.parties[0]!.schedule_approved_at, null);
  assert.equal(readyToCoordinate(r), false);
  r.parties[1]!.schedule_approved = true;
  r.parties[1]!.schedule_approved_date = "2026-10-06";
  assert.equal(readyToCoordinate(r), false);
  r.parties[1]!.schedule_approved_date = "2026-09-29";
  assert.equal(readyToCoordinate(r), true);
});
test("Tuesday window uses Jerusalem timezone and closes at 20:00", () => {
  assert.deepEqual(nextTuesday(new Date("2026-09-15T12:00:00Z")), {
    date: "2026-09-15",
    sameDay: true,
  });
  assert.deepEqual(nextTuesday(new Date("2026-09-15T16:59:00Z")), {
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
test("a proposed date is clearly pending and never presented as coordinated", () => {
  const r = sampleRequest();
  r.status = "awaiting_approval";
  r.run_date = null;
  r.proposed_run_date = "2026-09-29";
  r.parties[0]!.schedule_approved_date = "2026-09-29";
  r.parties[1]!.schedule_approved_date = null;
  const summary = statusText([r]);
  assert.match(summary, /מועד מוצע — ממתין לאישור/);
  assert.match(summary, /מוסר: אישר\/ה · מקבל: ממתין\/ה/);
  assert.match(summary, /תאריך הובלה שאושר:|מועד מוצע/);
  assert.doesNotMatch(summary, /מצב: תואמה/);
  assert.doesNotMatch(summary, /תאריך הובלה שאושר: 2026-09-29/);
});
test("transport capacity configuration cannot exceed ten", () => {
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://test/test",
        DB_SCHEMA: "haim_core_test",
        BOT_MODE: "shadow",
        AI_ENABLED: "false",
        WAHA_WEBHOOK_HMAC_KEY: "test-only-hmac-key-not-a-secret-000000",
        HAIM_ADMIN_TOKEN: "test-only-admin-key-not-a-secret-00000",
        TRANSPORT_CAPACITY: "11",
      }),
    /TRANSPORT_CAPACITY/,
  );
});
test("admin capability credentials must be distinct", () => {
  const base = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgres://test/test",
    DB_SCHEMA: "haim_core_test" as const,
    BOT_MODE: "shadow" as const,
    AI_ENABLED: "false",
    WAHA_WEBHOOK_HMAC_KEY: "test-only-hmac-key-not-a-secret-000000",
    HAIM_ADMIN_TOKEN: "normal-admin-token",
  };
  assert.throws(
    () => readConfig({ ...base, HAIM_ADMIN_DESTRUCTIVE_TOKEN: base.HAIM_ADMIN_TOKEN }),
    /admin_capability_credentials_must_be_distinct/,
  );
  assert.throws(
    () => readConfig({ ...base, HAIM_ADMIN_READONLY_TOKEN: base.HAIM_ADMIN_TOKEN }),
    /admin_capability_credentials_must_be_distinct/,
  );
  assert.throws(
    () => readConfig({
      ...base,
      HAIM_ADMIN_READONLY_TOKEN: "read-only-token",
      HAIM_ADMIN_DESTRUCTIVE_TOKEN: "read-only-token",
    }),
    /admin_capability_credentials_must_be_distinct/,
  );
});
test("coordinated status adds a map-ordered transport recommendation", () => {
  const a = sampleRequest();
  a.status = "coordinated";
  a.run_date = "2026-09-15";
  a.locations = [
    { role: "donor", latitude: 32.5, longitude: 35.5, captured_at: "" },
    { role: "receiver", latitude: 32.6, longitude: 35.6, captured_at: "" },
  ];
  const b = { ...a, number: 2, locations: [
    { role: "donor" as const, latitude: 32.4, longitude: 35.4, captured_at: "" },
    { role: "receiver" as const, latitude: 32.7, longitude: 35.7, captured_at: "" },
  ] };
  const text = statusText([a, b]);
  assert.match(text, /המלצת סדר הובלות לפי המפה/);
  assert.match(text, /https:\/\/www\.waze\.com\/ul\?ll=/);
  assert.doesNotMatch(text, /google\.com\/maps/);
  assert.ok(text.indexOf("1. פנייה 2") < text.indexOf("2. פנייה 1"));
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

test("contact card accepts WhatsApp grouped TEL fields", () => {
  const m = parseWebhook(
    {
      event: "message",
      session: "HAIM_YAHAD",
      payload: {
        id: "grouped-card",
        from: "972501111111@c.us",
        body:
          "BEGIN:VCARD\nVERSION:3.0\nFN:אא טל\nitem1.TEL;waid=972536662043:+972 53-666-2043\nEND:VCARD",
      },
    },
    "HAIM_YAHAD",
  );
  assert.equal(m?.kind, "contact");
  assert.equal(m?.text, "[כרטיס איש קשר]");
  assert.deepEqual(m?.contacts, [
    { phone: "536662043", name: "אא טל" },
  ]);
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
test("a following phone answers the named handoff", () => {
  const opening = rulePlan({
    conversation: { id: "c", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [],
    candidates: [],
    message: { text: "אני רוצה להעביר לטל שולחן", transcript: null, contacts: [] },
    history: [],
  } as unknown as Context);
  const donate = opening?.commands[0];
  assert.equal(donate?.type, "donate");
  if (donate?.type === "donate") {
    assert.equal(donate.direct, true);
    assert.equal(donate.counterparty_phone, null);
    assert.equal(donate.counterparty_name, "טל");
  }
  const request = sampleRequest();
  request.origin = "direct";
  request.verification_contacted = false;
  request.parties = request.parties.filter((party) => party.role === "donor");
  request.parties[0]!.phone = "584152101";
  const followUp = rulePlan({
    conversation: { id: "c", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: request.id, version: 2, pending_counterparty_name: "טל", pending_counterparty_phone: null },
    requests: [request],
    candidates: [],
    message: { text: "0536662043", transcript: null, contacts: [] },
    history: [{ role: "assistant", content: "האם תרצה שנפנה למקבל לצורך אימות הפרטים? אם כן, נא לשלוח מספר טלפון או כרטיס איש קשר." }],
  } as unknown as Context);
  assert.deepEqual(followUp?.commands, [
    { type: "counterparty", request_number: request.number, phone: "536662043", name: "טל" },
  ]);
});
test("split handoff messages keep the name until the item arrives", () => {
  const named = rulePlan({
    conversation: { id: "c-split", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [],
    candidates: [],
    message: { text: "רוצה למסור לטל", transcript: null, contacts: [] },
    history: [],
  } as unknown as Context);
  assert.deepEqual(named?.commands, [{ type: "next" }]);
  const item = rulePlan({
    conversation: { id: "c-split", phone: "584152101", chat_id: "972584152101@c.us", mode: "bot", selected_request_id: null, version: 2, pending_counterparty_name: "טל", pending_counterparty_phone: null },
    requests: [],
    candidates: [],
    message: { text: "מיטה", transcript: null, contacts: [] },
    history: [
      { role: "user", content: "רוצה למסור לטל" },
      { role: "assistant", content: "רשמתי שמדובר במסירה לטל. מה הפריט שברצונך למסור?" },
    ],
  } as unknown as Context);
  const donate = item?.commands[0];
  assert.equal(donate?.type, "donate");
  if (donate?.type === "donate") {
    assert.equal(donate.direct, true);
    assert.equal(donate.counterparty_name, "טל");
    assert.equal(donate.items[0]?.kind, "bed");
  }
});
test("city before street keeps settlement for outside-area rejection", () => {
  const request = sampleRequest();
  request.origin = "direct";
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.approved_at = new Date().toISOString();
  receiver.settlement = null;
  receiver.address = null;
  const context: Context = {
    conversation: { id: "c-tiberias-street", phone: receiver.phone, chat_id: `${receiver.phone}@c.us`, mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [request],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "live", chat_id: `${receiver.phone}@c.us`, phone: receiver.phone, kind: "text", text: "טבריה, רחוב הגליל 10, קומה 1", contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [],
  };
  const details = rulePlan(context)?.commands.find((command) => command.type === "details");
  assert.equal(details?.type, "details");
  if (details?.type === "details") {
    assert.equal(details.settlement, "טבריה");
    assert.equal(details.address, "רחוב הגליל 10");
    assert.equal(details.floor, 1);
  }
});
test("רחוב אילת is a street and bare אילת asks instead of rejecting", async () => {
  const request = sampleRequest();
  request.origin = "direct";
  request.verification_contacted = false;
  const donor = request.parties.find((party) => party.role === "donor")!;
  donor.settlement = null;
  donor.address = null;
  donor.floor = null;
  const context = (text: string): Context => ({
    conversation: { id: "c", phone: donor.phone, chat_id: `${donor.phone}@c.us`, mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null, pending_counterparty_phone: null },
    requests: [request],
    candidates: [],
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "live", chat_id: `${donor.phone}@c.us`, phone: donor.phone, kind: "text", text, contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
    history: [{ role: "assistant", content: "האם תרצה שנפנה למקבל לצורך אימות הפרטים?" }],
  });
  const street = rulePlan(context("רחוב אילת"))?.commands[0];
  assert.equal(street?.type, "details");
  if (street?.type === "details") {
    assert.equal(street.address, "רחוב אילת");
    assert.equal(street.settlement, null);
  }
  const ambiguous = rulePlan(context("זה מאילת"));
  assert.deepEqual(ambiguous?.commands, [{ type: "next" }]);
  const store = {
    request: async () => request,
    region: async () => { throw new Error("region must not run"); },
  } as unknown as Store;
  const outcome = await new Commands(store, () => new Date("2026-10-05T12:00:00.000Z")).apply(
    null as never,
    context("זה מאילת"),
    { type: "next" },
  );
  assert.equal(request.status, "collecting");
  assert.match(outcome.reply ?? "", /רחוב אילת/);
  assert.doesNotMatch(outcome.reply ?? "", /לא נוכל לסייע/);
});
test("required response constants preserved exactly", () => {
  assert.equal(PHOTO_THANKS, "תודה, התמונה התקבלה.");
  assert.ok(OUTSIDE.endsWith("לא נוכל לסייע בהובלה הזו."));
});

test("claim-guard drops invented save/approval claims", async () => {
  const { applyClaimGuard, CLARIFY_REPLY, FAULT_REPLY } = await import(
    "../src/domain/ai-guards.js"
  );
  assert.equal(
    applyClaimGuard("נא לאשר את המועד.", "תודה, האישור נשמר.", false).text,
    "נא לאשר את המועד.",
  );
  assert.equal(
    applyClaimGuard("נא לאשר את המועד.", "תודה, האישור נשמר.", false).rejected,
    true,
  );
  assert.equal(
    applyClaimGuard("הפרטים נשמרו. נעדכן.", "הפרטים נשמרו אצלנו.", true).rejected,
    false,
  );
  assert.equal(
    applyClaimGuard(
      "הפרטים נשמרו. נעדכן.",
      "מעולה, ההובלה נקבעה, אושר, ונאסוף אתכם",
      true,
    ).rejected,
    true,
  );
  assert.match(CLARIFY_REPLY, /כתוב את זה שוב/);
  assert.match(FAULT_REPLY, /תקלה/);
});

test("named outside towns reject in code, including English, and negation does not", () => {
  assert.equal(namedOutsideSettlement("אני בטבריה"), "טבריה");
  assert.equal(namedOutsideSettlement("I live in Tiberias"), "טבריה");
  assert.equal(namedOutsideSettlement("Tel Aviv please"), "תל אביב");
  assert.equal(namedOutsideSettlement("לא בטבריה, אני בבית שאן"), null);
  assert.equal(namedOutsideSettlement("רחוב אילת 4"), null);
  assert.equal(mentionedAllowedSettlement("ליד בית שאן"), null);
  assert.equal(mentionedAllowedSettlement("אני בבית שאן"), "בית שאן");
  assert.equal(mentionedAllowedSettlement("in Beit Shean"), "בית שאן");
  assert.equal(customerCancelIntent("תבטלו בבקשה"), true);
  assert.equal(customerCancelIntent("לא רלוונטי יותר"), true);
});

test("rules understand microwave, English donate, last floor, and cancel", () => {
  const phone = "536662043";
  const base = {
    conversation: {
      id: "c",
      phone,
      chat_id: `${phone}@c.us`,
      mode: "bot" as const,
      selected_request_id: null,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [],
    candidates: [],
    history: [],
  };
  const planFor = (text: string) =>
    rulePlan({
      ...base,
      message: {
        id: "m",
        seq: "1",
        external_id: "e",
        trace_id: "t",
        mode: "shadow",
        chat_id: `${phone}@c.us`,
        phone,
        kind: "text",
        text,
        contacts: [],
        location: null,
        media_url: null,
        media_id: null,
        media_state: "none",
        transcript: null,
        processed_at: null,
        ai_plan: null,
      },
    } as unknown as Context);
  const microwave = planFor("שלום אני בבית שאן רוצה למסור מיקרוגל");
  assert.equal(microwave?.commands[0]?.type, "donate");
  if (microwave?.commands[0]?.type === "donate")
    assert.equal(microwave.commands[0].items[0]?.description, "מיקרוגל");
  const english = planFor("Hi I want to donate a fridge in Beit Shean");
  assert.equal(english?.commands[0]?.type, "donate");
  if (english?.commands[0]?.type === "donate")
    assert.equal(english.commands[0].items[0]?.kind, "fridge");
  const request = sampleRequest();
  request.status = "collecting";
  const donor = request.parties.find((party) => party.role === "donor")!;
  donor.phone = phone;
  donor.settlement = "בית שאן";
  donor.address = "רחוב הרצל 3";
  const floorPlan = rulePlan({
    ...base,
    conversation: { ...base.conversation, selected_request_id: request.id },
    requests: [request],
    message: {
      id: "m2",
      seq: "2",
      external_id: "e2",
      trace_id: "t",
      mode: "shadow",
      chat_id: `${phone}@c.us`,
      phone,
      kind: "text",
      text: "קומה 3 בעצם קומה 5",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
  } as unknown as Context);
  const floorCommand = floorPlan?.commands.find((command) => command.type === "details");
  assert.equal(floorCommand?.type, "details");
  if (floorCommand?.type === "details") assert.equal(floorCommand.floor, 5);
  const cancel = rulePlan({
    ...base,
    conversation: { ...base.conversation, selected_request_id: request.id },
    requests: [{ ...request, status: "coordinated" }],
    message: {
      id: "m3",
      seq: "3",
      external_id: "e3",
      trace_id: "t",
      mode: "shadow",
      chat_id: `${phone}@c.us`,
      phone,
      kind: "text",
      text: "לבטל",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
  } as unknown as Context);
  assert.deepEqual(cancel?.commands[0], {
    type: "cancel",
    request_number: request.number,
    choice: "final",
  });
});

test("probeReply asks concrete follow-ups instead of generic unclear", async () => {
  const { probeReply } = await import("../src/domain/ai-guards.js");
  assert.match(probeReply("אני רוצה"), /למסור פריט או לקבל/);
  assert.match(probeReply("אני רוצה למסור"), /למי תרצה למסור/);
  assert.match(probeReply("אני רוצה למסור לטל"), /איזה פריט/);
  assert.match(probeReply("אני רוצה למסור לטל מנורה"), /כתוב את זה שוב/);
});

test("translate maps explicit approve_self and refuses unclear", async () => {
  const { translate } = await import("../src/infrastructure/ai.js");
  const request = sampleRequest();
  request.status = "collecting";
  request.verification_contacted = true;
  const receiver = request.parties.find((party) => party.role === "receiver")!;
  receiver.approved_at = null;
  const ctx = {
    conversation: {
      id: "c-translate",
      phone: receiver.phone,
      chat_id: "972536662043@c.us",
      mode: "bot",
      selected_request_id: request.id,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [request],
    candidates: [],
    message: {
      id: "m-translate",
      seq: "1",
      external_id: "e",
      trace_id: "t",
      mode: "live",
      chat_id: "972536662043@c.us",
      phone: receiver.phone,
      kind: "text",
      text: "כן אני טל ומאשרת לקבל את הספה",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context;
  const ok = translate(
    {
      understood: true,
      commands: [{ type: "approve_self", request_number: request.number }],
      evidence: "כן אני טל ומאשרת לקבל את הספה",
    },
    ctx,
    "כן אני טל ומאשרת לקבל את הספה",
  );
  assert.equal(ok.understood, true);
  assert.equal(ok.plan.commands[0]?.type, "approve_self");
  const schedule = translate(
    {
      understood: true,
      commands: [
        {
          type: "approve_schedule",
          request_number: request.number,
          date: "2026-10-06",
        },
      ],
      evidence: "מאשר את המועד 06/10/2026",
    },
    ctx,
    "מאשר את המועד 06/10/2026",
  );
  assert.equal(schedule.plan.commands[0]?.type, "approve_schedule");
  assert.equal(
    schedule.plan.commands.some((command) => command.type === "item_facts"),
    false,
  );
  const unclear = translate(
    { understood: false, commands: [], evidence: "" },
    ctx,
    "asdf",
  );
  assert.equal(unclear.understood, false);
});

test("דירה without קומה does not set floor", () => {
  const text = "איסוף העלייה 5 דירה 2 מסירה העלייה 8 דירה 1 מאשר ליצור קשר";
  const direct = sampleRequest();
  direct.origin = "direct";
  direct.status = "collecting";
  direct.verification_contacted = false;
  direct.parties[0]!.phone = "584152101";
  direct.parties[0]!.settlement = null;
  direct.parties[0]!.address = null;
  direct.parties[0]!.floor = null;
  direct.parties[0]!.approved_at = "2026-10-05T15:00:00.000Z";
  direct.parties[0]!.approved_by = "584152101";
  direct.parties[1]!.phone = "536662043";
  direct.parties[1]!.settlement = null;
  direct.parties[1]!.address = null;
  direct.parties[1]!.floor = null;
  const commands =
    rulePlan({
      conversation: {
        id: "c-apt",
        phone: "584152101",
        chat_id: "972584152101@c.us",
        mode: "bot",
        selected_request_id: direct.id,
        version: 1,
        pending_counterparty_name: null,
        pending_counterparty_phone: null,
      },
      requests: [direct],
      candidates: [],
      message: { text, transcript: null, contacts: [] },
      history: [
        {
          role: "assistant",
          content: "האם תרצה שנפנה למקבל לצורך אימות הפרטים?",
        },
      ],
    } as unknown as Context)?.commands ?? [];
  for (const command of commands) {
    if (command.type === "details") assert.equal(command.floor, null);
  }
});

test("AI details-only without open request does not override rulePlan opening", async () => {
  const { selectDecodePlan } = await import("../src/infrastructure/ai.js");
  const emptyCtx = {
    conversation: { phone: "584152101" },
    requests: [],
    candidates: [],
    message: { text: "יש לי מנורה למסירה ישירות לטל 0536662043" },
    history: [],
  } as unknown as Context;
  const aiDetailsOnly = {
    understood: true,
    plan: {
      commands: [
        {
          type: "details" as const,
          request_number: null,
          role: "donor" as const,
          name: null,
          settlement: "בית שאן",
          address: null,
          floor: null,
        },
      ],
      evidence: "מנורה",
    },
  };
  const rules = rulePlan({
    ...emptyCtx,
    conversation: {
      id: "c",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: null,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    message: {
      id: "m",
      seq: "1",
      external_id: "e",
      trace_id: "t",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text: "יש לי מנורה שולחנית תקינה למסירה ישירות לטל 0536662043. אני מבית שאן.",
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
  } as Context);
  assert.ok(rules?.commands.some((command) => command.type === "donate"));
  const selected = selectDecodePlan(aiDetailsOnly, rules, emptyCtx);
  assert.equal(selected.useAi, false);
  assert.equal(selected.plan.commands[0]?.type, "donate");
});

test("self-transfer rulePlan does not invent receiver name עצמי", () => {
  const text =
    "אני רוצה להעביר לעצמי שולחן מבית שאן רחוב העלייה קומה 1 לבית שאן רחוב העלייה קומה 2";
  const plan = rulePlan({
    conversation: {
      id: "c-self",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: null,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [],
    candidates: [],
    message: {
      id: "m-self",
      seq: "1",
      external_id: "e-self",
      trace_id: "t-self",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context);
  const donate = plan?.commands.find((command) => command.type === "donate");
  assert.equal(donate?.type, "donate");
  if (donate?.type === "donate") {
    assert.equal(donate.counterparty_phone, "584152101");
    assert.equal(donate.counterparty_name ?? null, null);
    assert.equal(donate.direct, true);
  }
});

test("seeker opening uses seek and not donate", () => {
  const text = "אני מחפש לקבל מיטה זוגית בבית שאן";
  const plan = rulePlan({
    conversation: {
      id: "c-seek",
      phone: "584152101",
      chat_id: "972584152101@c.us",
      mode: "bot",
      selected_request_id: null,
      version: 1,
      pending_counterparty_name: null,
      pending_counterparty_phone: null,
    },
    requests: [],
    candidates: [],
    message: {
      id: "m-seek",
      seq: "1",
      external_id: "e-seek",
      trace_id: "t-seek",
      mode: "live",
      chat_id: "972584152101@c.us",
      phone: "584152101",
      kind: "text",
      text,
      contacts: [],
      location: null,
      media_url: null,
      media_id: null,
      media_state: "none",
      transcript: null,
      processed_at: null,
      ai_plan: null,
    },
    history: [],
  } as Context);
  assert.equal(plan?.commands[0]?.type, "seek");
});
