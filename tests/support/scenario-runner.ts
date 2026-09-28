import { IntegrationAdapter, type GoldenScenario } from "./adapters/integration-adapter.js";

type Snapshot = Awaited<ReturnType<IntegrationAdapter["snapshot"]>>;
const askIntents = new Set(["ask_photo", "ask_name", "ask_address", "ask_schedule_approval", "ask_verification", "ask_details"]);

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
  return { counts: snapshot.counts, requests: facts(snapshot), searches: snapshot.searches, outbox: snapshot.outbox, events: snapshot.events, planner: snapshot.message?.ai_plan ?? null, actual_intent: snapshot.actualIntent };
}

function assertReply(scenario: GoldenScenario, step: number, snapshot: Snapshot, errors: string[]) {
  const expected = scenario.steps[step]!.expect.reply_intent_any;
  const actual = snapshot.actualIntent;
  const matches = expected.includes(actual) || (expected.includes("ask_details") && askIntents.has(actual));
  if (!matches) errors.push(`reply_intent: expected=${expected.join("|")} actual=${actual}`);
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
        break;
      case "donor_flow":
        if (scenario.flow === "open_request" && snapshot.actualIntent === "ask_photo") errors.push(effect);
        break;
      case "ask_pickup_again":
        if (scenario.flow === "self_transfer" && step > 0 && snapshot.actualIntent === "ask_address") errors.push(effect);
        break;
      case "stale_ai_plan_commit":
        if (snapshot.message?.error_code === "stale_plan") errors.push(effect);
        break;
      case "wrong_party_notification":
        if (snapshot.outbox.some((row) => row.phone === snapshot.phone && row.text.includes("נדרש טיפול אנושי"))) errors.push(effect);
        break;
      case "ask_photo":
      case "ask_address":
      case "ask_name":
      case "schedule_without_both_approvals":
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
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        try {
          const snapshot = await adapter.step(scenario, step, index);
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
      const result = { id: scenario.id, title: `${scenario.flow}: ${scenario.id}`, flow: scenario.flow, difficulty: scenario.difficulty, invariant_ids: scenario.invariant_ids, status: scenarioErrors.length ? "failed" : "passed", steps, errors: scenarioErrors };
      results.push(result);
      await onScenario?.(result, results);
    }
  } finally {
    await adapter.close();
  }
  return results;
}
