import { IntegrationAdapter, type GoldenScenario } from "./adapters/integration-adapter.js";
import type { Role } from "../../src/domain/types.js";

type Snapshot = Awaited<ReturnType<IntegrationAdapter["snapshot"]>>;

function facts(snapshot: Snapshot) {
  return snapshot.requests.map((request) => ({
    id: request.id,
    number: request.number,
    status: request.status,
    origin: request.origin,
    run_date: request.run_date,
    proposed_run_date: request.proposed_run_date,
    represents_both_parties: request.represents_both_parties,
    parties: request.parties,
    items: request.items,
    photo_ids: request.photo_ids,
    locations: request.locations,
  }));
}

function requestFacts(snapshot: Snapshot) {
  return { counts: snapshot.counts, requests: facts(snapshot), searches: snapshot.searches, outbox: snapshot.outbox, events: snapshot.events, planner: snapshot.message?.ai_plan ?? null, actual_intent: snapshot.actualIntent, turn: snapshot.turn, turn_messages: snapshot.turnMessages, coalesced_messages: snapshot.coalescedMessages, media: snapshot.media };
}

function assertReply(scenario: GoldenScenario, step: number, snapshot: Snapshot, errors: string[]) {
  const expected = scenario.steps[step]!.expect.reply_intent_any;
  const actual = snapshot.actualIntent;
  if (!expected.includes(actual)) errors.push(`reply_intent: expected=${expected.join("|")} actual=${actual}`);
}

function assertBusiness(scenario: GoldenScenario, snapshot: Snapshot, errors: string[]) {
  const expected = scenario.expected;
  const expectedRequestCount = typeof expected.request_count === "number"
    ? expected.request_count
    : scenario.flow === "open_request" ? 0 : 1;
  if (snapshot.requests.length !== expectedRequestCount)
    errors.push(`request_count: expected=${expectedRequestCount} actual=${snapshot.requests.length}`);
  if (scenario.flow === "open_request" && snapshot.searches.length !== 1)
    errors.push(`search_count: expected=1 actual=${snapshot.searches.length}`);
  if (snapshot.message && !snapshot.message.reply && snapshot.actualIntent !== "no_reply")
    errors.push("conversation_result_missing_reply");
  if (snapshot.message && snapshot.message.reply && !snapshot.outbox.some((row) => row.phone === snapshot.phone && row.dedupe_key?.startsWith("reply:")))
    errors.push("reply_missing_from_outbox");
  if (snapshot.events.length === 0)
    errors.push("business_event_missing");
  for (const request of snapshot.requests) {
    if (!request.items.length || request.items.some((item) => !item.description || item.quantity < 1)) errors.push("item_facts_incomplete");
    const roles = new Set(request.parties.map((party) => party.role));
    const requiredRoles: Role[] = scenario.flow === "direct_handoff" || scenario.flow === "self_transfer"
      ? ["donor", "receiver"]
      : scenario.flow === "open_donation" ? ["donor"] : [];
    if (requiredRoles.some((role) => !roles.has(role))) errors.push(`donor_receiver_roles_missing:${requiredRoles.join(",")}`);
    for (const party of request.parties) {
      if (party.address && (!party.settlement || party.floor === null || party.floor === undefined)) errors.push(`location_fact_incomplete:${party.role}`);
    }
  }
  for (const row of snapshot.outbox) {
    if (!row.dedupe_key || !row.text) errors.push("outbox_purpose_or_text_missing");
    if (row.dedupe_key?.startsWith("reply:") && row.phone !== snapshot.phone) errors.push("reply_wrong_recipient");
    if (row.state === "sent" && !row.provider_id) errors.push("sent_without_provider_id");
  }
  if (scenario.flow === "open_request") {
    if (snapshot.requests.some((request) => request.photo_ids.length > 0)) errors.push("requester_entered_donor_photo_flow");
  }
  if (expected.origin && snapshot.requests[0] && scenario.flow === "direct_handoff" && snapshot.requests[0].origin !== String(expected.origin))
    errors.push(`origin: expected=${expected.origin} actual=${snapshot.requests[0].origin}`);
  if (expected.represents_both_parties && snapshot.requests[0] && !snapshot.requests[0].represents_both_parties)
    errors.push("self_transfer_missing_same_person_state");
  if (scenario.flow === "self_transfer" && snapshot.requests[0]) {
    const [donor, receiver] = snapshot.requests[0].parties;
    if (donor?.address && receiver?.address && donor.address === receiver.address && donor.settlement === receiver.settlement && donor.floor === receiver.floor) errors.push("self_transfer_addresses_merged");
  }
  const step = scenario.steps[snapshot.step];
  if (step?.inbound.process_next) {
    if (!snapshot.message?.turn_id || snapshot.message.turn_generation === null || snapshot.message.turn_generation === undefined) errors.push("process_next_missing_turn_generation");
    if (snapshot.turnMessages < 1) errors.push("process_next_missing_turn_membership");
    if ((step.inbound.burst?.length ?? 1) > 1 && snapshot.coalescedMessages < 1) errors.push("process_next_burst_not_coalesced");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function classifyFailure(errors: any[]): "HARNESS_DEFECT" | "SCENARIO_CONTRACT_DEFECT" | "PRODUCT_DEFECT" {
  const text = JSON.stringify(errors);
  if (/timeout|missing_test_plan|reference_fixture|unsupported_forbidden_effect|TEST_DATABASE_URL/i.test(text)) return "HARNESS_DEFECT";
  if (/reply_intent|request_count|search_count|scenario_missing|unknown_semantic/i.test(text)) return "SCENARIO_CONTRACT_DEFECT";
  return "PRODUCT_DEFECT";
}

function assertForbidden(scenario: GoldenScenario, step: number, snapshot: Snapshot, previous: Snapshot | null, errors: string[]) {
  for (const effect of scenario.steps[step]!.forbidden_effects) {
    switch (effect) {
      case "duplicate_request":
        if (snapshot.requests.length > 1) errors.push(effect);
        break;
      case "donor_receiver_mix": {
        const request = snapshot.requests[0];
        if (request?.parties[0]?.phone && request.parties[1]?.phone && request.parties[0].phone === request.parties[1].phone && !request.represents_both_parties) errors.push(effect);
        break;
      }
      case "merge_addresses": {
        const request = snapshot.requests[0];
        if (request?.parties[0]?.address && request.parties[1]?.address && request.parties[0].address === request.parties[1].address && request.parties[0].settlement === request.parties[1].settlement && request.parties[0].floor === request.parties[1].floor) errors.push(effect);
        break;
      }
      case "lose_existing_fact": {
        if (previous) {
          const before = JSON.stringify(facts(previous));
          const after = JSON.stringify(facts(snapshot));
          if (before.includes("בית שאן") && !after.includes("בית שאן")) errors.push(effect);
        }
        break;
      }
      case "lose_pickup_facts": {
        if (previous && facts(previous).some((request) => request.parties.some((party) => party.address)) && !facts(snapshot).some((request) => request.parties.some((party) => party.address))) errors.push(effect);
        break;
      }
      case "ask_photo_in_direct_flow":
        if ((scenario.flow === "direct_handoff" || scenario.flow === "cross_flow") && snapshot.actualIntent === "ask_photo") errors.push(effect);
        break;
      case "ask_name_before_required_photo":
        if (scenario.flow === "open_donation" && step === 0 && snapshot.actualIntent === "ask_name") errors.push(effect);
        break;
      case "ask_name_before_photo":
        if (scenario.flow === "open_donation" && step === 0 && snapshot.actualIntent === "ask_name") errors.push(effect);
        break;
      case "ask_address_again":
        if (previous && snapshot.actualIntent === "ask_address" && facts(previous).some((request) => request.parties.some((party) => party.address))) errors.push(effect);
        break;
      case "external_send_before_consent":
        if (snapshot.outbox.some((row) => ["sent", "accepted", "delivered"].includes(row.state))) errors.push(effect);
        break;
      case "schedule_without_both_approvals":
        if (snapshot.requests.some((request) => request.run_date && !request.parties.every((party) => party.schedule_approved))) errors.push(effect);
        break;
      case "blind_retry_after_uncertain_send":
        if (new Set(snapshot.outbox.map((row) => row.dedupe_key).filter(Boolean)).size !== snapshot.outbox.filter((row) => row.dedupe_key).length) errors.push(effect);
        if (snapshot.outbox.some((row) => row.state === "uncertain" && row.provider_id)) errors.push(`${effect}:uncertain_row_has_provider_id`);
        break;
      case "donor_flow":
        if (scenario.flow === "open_request" && snapshot.actualIntent === "ask_photo") errors.push(effect);
        break;
      case "ask_pickup_again":
        if (scenario.flow === "self_transfer" && step > 0 && snapshot.actualIntent === "ask_address") errors.push(effect);
        break;
      case "stale_ai_plan_commit":
        if (snapshot.message?.error_code === "stale_plan" || (snapshot.message?.error_code === null && snapshot.message?.ai_plan && snapshot.events.some((event) => event.event_type === "stale_plan"))) errors.push(effect);
        break;
      case "wrong_party_notification":
        if (snapshot.outbox.some((row) => row.dedupe_key?.startsWith("reply:") && row.phone !== snapshot.phone)) errors.push(effect);
        if (snapshot.outbox.some((row) => row.phone === snapshot.phone && row.text.includes("נדרש טיפול אנושי") && row.dedupe_key?.startsWith("human-alert:"))) errors.push(effect);
        break;
      case "ask_photo":
        if (snapshot.actualIntent === "ask_photo") errors.push(effect);
        break;
      case "ask_address":
        if (snapshot.actualIntent === "ask_address") errors.push(effect);
        break;
      case "ask_name":
        if (snapshot.actualIntent === "ask_name") errors.push(effect);
        break;
      default:
        errors.push(`unsupported_forbidden_effect:${effect}`);
    }
  }
}

export async function runGoldenScenarios(
  scenarios: GoldenScenario[],
  onScenario?: (result: any, completed: any[]) => Promise<void> | void,
) {
  const adapter = await IntegrationAdapter.open();
  const results: any[] = [];
  try {
    for (const scenario of scenarios) {
      await adapter.reset();
      const steps: any[] = [];
      let previous: Snapshot | null = null;
      const scenarioErrors: any[] = [];
      const scenarioDeadline = Date.now() + Number(process.env.GOLDEN_SCENARIO_TIMEOUT_MS ?? 30000);
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        try {
          if (Date.now() >= scenarioDeadline) throw new Error(`scenario_timeout:${scenario.id}`);
          const snapshot = await withTimeout(adapter.step(scenario, step, index), Number(process.env.GOLDEN_STEP_TIMEOUT_MS ?? 10000), `step_timeout:${scenario.id}:${index + 1}`);
          const errors: string[] = [];
          assertReply(scenario, index, snapshot, errors);
          assertBusiness(scenario, snapshot, errors);
          assertForbidden(scenario, index, snapshot, previous, errors);
          steps.push({ step: index + 1, inbound: step.inbound, expected: step.expect, actual: requestFacts(snapshot), errors });
          if (errors.length) scenarioErrors.push({ step: index + 1, errors, inbound: step.inbound, expected: step.expect, actual: requestFacts(snapshot) });
          previous = snapshot;
        } catch (error) {
          const diagnostic = { step: index + 1, inbound: step.inbound, error: error instanceof Error ? error.message : String(error), actual: previous ? requestFacts(previous) : null };
          steps.push(diagnostic);
          scenarioErrors.push(diagnostic);
          break;
        }
      }
      const result = { id: scenario.id, title: `${scenario.flow}: ${scenario.id}`, flow: scenario.flow, difficulty: scenario.difficulty, invariant_ids: scenario.invariant_ids, status: scenarioErrors.length ? "failed" : "passed", failure_classification: scenarioErrors.length ? classifyFailure(scenarioErrors) : null, steps, errors: scenarioErrors };
      results.push(result);
      await onScenario?.(result, results);
    }
  } finally {
    await adapter.close();
  }
  return results;
}
