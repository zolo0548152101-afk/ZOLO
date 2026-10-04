import test from "node:test";
import assert from "node:assert/strict";
import { IntegrationAdapter } from "./support/adapters/integration-adapter.js";

const donor = "0584152101";
const recipient = "0536662043";
const donorCanonical = "584152101";
const recipientCanonical = "536662043";

async function directScenario(adapter: IntegrationAdapter, id: string) {
  const scenario = {
    id, flow: "direct_handoff", difficulty: "clean",
    steps: [{
      inbound: { text: "אני מוסר מיטה לטל", actor_phone: donor, contacts: [{ phone: recipientCanonical, name: "טל" }] },
      planner: { commands: [
        { type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: recipient, counterparty_name: "טל", direct: true, free: true, working: true },
        { type: "details", request_number: null, role: "donor", name: "זולו", settlement: "בית שאן", address: "רחוב העלייה 1", floor: 2 },
      ], evidence: id },
      expect: { reply_intent_any: ["ask_verification", "ask_approval", "other"] }, forbidden_effects: [],
    }],
    expected: { request_count: 1, origin: "direct" }, invariant_ids: [], completion_criteria: ["one request", "separate parties"],
  } as any;
  return adapter.step(scenario, scenario.steps[0], 0);
}

test("T24 direct coordination keeps donor and recipient in separate conversations", async () => {
  const adapter = await IntegrationAdapter.open();
  try {
    await adapter.reset();
    const snapshot = await directScenario(adapter, "t24-direct-coordination-01");
    assert.equal(snapshot.requests.length, 1);
    const request = snapshot.requests[0]!;
    assert.equal(request.origin, "direct");
    assert.equal(request.parties.find((party) => party.role === "donor")?.phone, donorCanonical);
    assert.equal(request.parties.find((party) => party.role === "receiver")?.phone, recipientCanonical);
  } finally { await adapter.close(); }
});

test("T24 open donation keeps donor facts and does not invent a recipient", async () => {
  const adapter = await IntegrationAdapter.open();
  try {
    await adapter.reset();
    const scenario = {
      id: "t24-open-donation-01", flow: "open_donation", difficulty: "clean",
      steps: [{
        inbound: { text: "יש לי מיטה למסירה מבית שאן רחוב העלייה קומה 2", actor_phone: donor },
        planner: { commands: [
          { type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: null, direct: false, free: true, working: true },
          { type: "details", request_number: null, role: "donor", name: "זולו", settlement: "בית שאן", address: "רחוב העלייה", floor: 2 },
        ], evidence: "t24-open-donation-01" },
        expect: { reply_intent_any: ["ask_photo", "other"] }, forbidden_effects: [],
      }], expected: { request_count: 1, origin: "donation" }, invariant_ids: [], completion_criteria: ["one request", "donor facts"],
    } as any;
    const snapshot = await adapter.step(scenario, scenario.steps[0], 0);
    assert.equal(snapshot.requests.length, 1);
    const request = snapshot.requests[0]!;
    assert.equal(request.origin, "donation");
    assert.equal(request.parties.length, 1);
    assert.equal(request.parties[0]?.phone, donorCanonical);
    assert.equal(request.parties[0]?.address, "רחוב העלייה");
    assert.equal(request.parties[0]?.floor, 2);
  } finally { await adapter.close(); }
});

test("T24 self transfer stores distinct pickup and destination facts", async () => {
  const adapter = await IntegrationAdapter.open();
  try {
    await adapter.reset();
    const scenario = {
      id: "t24-self-transfer-01", flow: "self_transfer", difficulty: "clean",
      steps: [{
        inbound: { text: "אני רוצה להעביר לעצמי מיטה מבית שאן רחוב שיכון א קומה 3 לרחוב העלייה קומה 1", actor_phone: recipient },
        planner: { commands: [
          { type: "donate", items: [{ kind: "bed", description: "מיטה", quantity: 1 }], counterparty_phone: recipient, direct: true, free: true, working: true },
          { type: "details", request_number: null, role: "donor", name: "טל", settlement: "בית שאן", address: "רחוב שיכון א", floor: 3 },
          { type: "details", request_number: null, role: "receiver", name: "טל", settlement: "בית שאן", address: "רחוב העלייה", floor: 1 },
        ], evidence: "t24-self-transfer-01" },
        expect: { reply_intent_any: ["ask_approval", "other"] }, forbidden_effects: [],
      }], expected: { request_count: 1, origin: "direct" }, invariant_ids: [], completion_criteria: ["one request", "two party roles"],
    } as any;
    const snapshot = await adapter.step(scenario, scenario.steps[0], 0);
    assert.equal(snapshot.requests.length, 1);
    const request = snapshot.requests[0]!;
    assert.equal(request.origin, "direct");
    assert.equal(request.represents_both_parties, true);
    assert.equal(request.parties.filter((party) => party.phone === recipientCanonical).length, 2);
    assert.equal(request.parties.find((party) => party.role === "donor")?.address, "רחוב שיכון א");
    assert.equal(request.parties.find((party) => party.role === "receiver")?.address, "רחוב העלייה");
  } finally { await adapter.close(); }
});

test("T24 general request creates a search without a phantom request", async () => {
  const adapter = await IntegrationAdapter.open();
  try {
    await adapter.reset();
    const scenario = {
      id: "t24-general-request-01", flow: "general_request", difficulty: "clean",
      steps: [{
        inbound: { text: "אני מבקש מיטה לבית שאן", actor_phone: recipient },
        planner: { commands: [{ type: "seek", kind: "bed" }], evidence: "t24-general-request-01" },
        expect: { reply_intent_any: ["no_match", "other"] }, forbidden_effects: [],
      }], expected: { request_count: 0, search_count: 1 }, invariant_ids: [], completion_criteria: ["one search", "no request"],
    } as any;
    const snapshot = await adapter.step(scenario, scenario.steps[0], 0);
    assert.equal(snapshot.requests.length, 0);
    assert.equal(snapshot.searches.length, 1);
    assert.equal(snapshot.searches[0]?.phone, recipientCanonical);
    assert.equal(snapshot.searches[0]?.kind, "bed");
  } finally { await adapter.close(); }
});

test("T24 committed turn remains idempotent after adapter restart", async () => {
  const first = await IntegrationAdapter.open();
  await first.reset();
  const snapshot = await directScenario(first, "t24-restart-01");
  const messageId = snapshot.message!.id;
  await first.close();
  const second = await IntegrationAdapter.open();
  try {
    const afterRestart = await second.snapshot(messageId, donorCanonical, 0);
    assert.equal(afterRestart.requests.length, 1);
    assert.equal(Boolean(afterRestart.message?.processed_at), true);
    assert.equal(afterRestart.outbox.filter((entry: any) => entry.dedupe_key?.startsWith("reply:")).length, 1);
  } finally {
    await second.reset();
    await second.close();
  }
});
