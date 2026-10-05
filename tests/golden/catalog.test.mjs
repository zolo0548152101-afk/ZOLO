import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const blueprints = JSON.parse(await readFile(resolve(root, "tests/golden/scenarios.json"), "utf8"));
const contracts = JSON.parse(await readFile(resolve(root, "tests/golden/contracts.json"), "utf8"));
const invariants = new Set(JSON.parse(await readFile(resolve(root, "tests/spec/domain-invariants.json"), "utf8")).map((x) => x.id));
const supportedEffects = new Set(["duplicate_request","donor_receiver_mix","merge_addresses","lose_existing_fact","lose_pickup_facts","ask_photo_in_direct_flow","ask_name_before_required_photo","ask_name_before_photo","ask_address_again","external_send_before_consent","schedule_without_both_approvals","stale_ai_plan_commit","blind_retry_after_uncertain_send","wrong_party_notification","donor_flow","ask_pickup_again","ask_photo","ask_address","ask_name"]);
const semanticIntents = new Set(["ask_photo","ask_name","ask_address","ask_verification","ask_schedule_approval","acknowledge","coordinated","clarification","human_escalation","no_reply","other","ask_details"]);
const scenarios = blueprints.flatMap((blueprint) => {
  const contract = contracts[blueprint.flow];
  if (!contract) throw new Error(`missing_flow_contract:${blueprint.flow}`);
  return blueprint.variants.map((variant) => ({
    ...variant,
    title: variant.title ?? `${contract.title}: ${variant.id}`,
    flow: blueprint.flow,
    invariant_ids: variant.invariant_ids ?? blueprint.invariant_ids,
    expected: variant.expected ?? contract.expected,
    completion_criteria: variant.completion_criteria ?? contract.completion_criteria,
  }));
});
const ids = new Set();
if (scenarios.length < 40 || scenarios.length > 60) throw new Error(`golden_scenario_count_out_of_range:${scenarios.length}`);
const coreFlows = ["direct_handoff", "open_donation", "self_transfer", "open_request"];
for (const flow of coreFlows) {
  const variants = scenarios.filter((scenario) => scenario.flow === flow);
  if (!variants.length) throw new Error(`missing_core_flow:${flow}`);
  if (!variants.some((scenario) => scenario.difficulty === "clean")) throw new Error(`missing_clean_variant:${flow}`);
  if (!variants.some((scenario) => scenario.difficulty === "challenging")) throw new Error(`missing_challenging_variant:${flow}`);
}
if (!scenarios.some((scenario) => scenario.flow === "cross_flow")) throw new Error("missing_cross_flow_scenarios");
if (!scenarios.some((scenario) => scenario.flow === "failure_recovery")) throw new Error("missing_failure_recovery_scenarios");
for (const scenario of scenarios) {
  if (ids.has(scenario.id)) throw new Error(`duplicate_scenario_id:${scenario.id}`);
  ids.add(scenario.id);
  if (!scenario.title || !Array.isArray(scenario.steps) || scenario.steps.length < 2) throw new Error(`scenario_must_be_multi_turn:${scenario.id}`);
  if (!Array.isArray(scenario.invariant_ids) || scenario.invariant_ids.some((id) => !invariants.has(id))) throw new Error(`scenario_unknown_invariant:${scenario.id}`);
  if (!scenario.expected || !Array.isArray(scenario.completion_criteria) || !scenario.completion_criteria.length) throw new Error(`scenario_missing_business_contract:${scenario.id}`);
  for (const step of scenario.steps) {
    if (!step.inbound || typeof step.inbound.text !== "string") throw new Error(`scenario_missing_inbound:${scenario.id}`);
    if (!step.expect?.reply_intent_any?.length) throw new Error(`scenario_missing_reply_expectation:${scenario.id}`);
    for (const intent of step.expect.reply_intent_any) if (!semanticIntents.has(intent)) throw new Error(`unknown_semantic_intent:${scenario.id}:${intent}`);
    if (!Array.isArray(step.forbidden_effects)) throw new Error(`scenario_missing_forbidden_effects:${scenario.id}`);
    for (const effect of step.forbidden_effects) if (!supportedEffects.has(effect)) throw new Error(`unsupported_forbidden_effect:${scenario.id}:${effect}`);
    const fixture = step.inbound.fixture_image;
    if (fixture && !existsSync(resolve(root, fixture))) throw new Error(`missing_fixture:${scenario.id}:${fixture}`);
  }
}
console.log(JSON.stringify({ ok: true, scenarios: scenarios.length, flows: [...new Set(scenarios.map((x) => x.flow))], clean: scenarios.filter((x) => x.difficulty === "clean").length, challenging: scenarios.filter((x) => x.difficulty === "challenging").length }));
