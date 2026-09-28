# Explicit Schedule Approval Implementation Plan

> עדכון מדיניות 27/09/2026: ימי שלישי 16:00–20:00; מכסת ברירת מחדל 10; אישור מנהל נדרש לכל הובלה נוספת בנפרד. סעיפים היסטוריים שאוסרים שינוי יום/שעות/קיבולת הוחלפו בהחלטת הבעלים המאוחרת.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a Haim Yahad request from becoming coordinated until each party has explicitly approved the same exact proposed date.

**Architecture:** Keep role/participation approval, permission to contact the other party, and schedule-date approval as separate state. Persist one proposed date on the request and the exact approved date/time per party; only the transactional coordination path may copy the proposal into `run_date` after validating both approvals and capacity. The conversation flow proposes a date only after required facts are complete, and all pending/administrative views distinguish a proposal from a confirmed booking.

**Tech Stack:** TypeScript 7, Node.js 24, Zod 4, PostgreSQL, node-pg-migrate, `node:test`, Docker Compose integration tests, WAHA.

**Spec:** `docs/superpowers/specs/2026-09-25-explicit-schedule-approval-design.md`

## Global Constraints

- Act in live WhatsApp QA only with `0584152101` and `0536662043`.
- An approval of role/participation does not approve a schedule date.
- Contact consent does not approve role/participation or schedule date.
- `run_date` means a confirmed booking only; a proposal is never displayed as coordinated.
- Coordination requires both parties to approve the same exact proposed date and a successful transactional capacity check.
- A date change requires fresh explicit approval from both parties.
- Do not change service area, delivery day, capacity, item limits, permissions, or the unresolved 16:00–21:00 vs. 16:00–20:00 policy.
- Do not reinterpret legacy `schedule_approved=true` as proof of date-specific consent.
- Preserve existing workspace changes; do not reset, clean, or rewrite unrelated files/data.
- Outbound claims must distinguish queued, provider-accepted, delivered, and read.

## Review Focus

- Role-only “מאשר לקבל/למסור” must never coordinate; unit and integration tests pin this in Tasks 2 and 5.
- “כן” without a current date proposal must not approve any date; parser/context tests pin this in Task 2.
- A stale or different date approval must not count after a date changes; domain and persistence tests pin this in Tasks 1, 3, and 5.
- A full/closed run must not silently move a request to next Tuesday; worker/capacity tests pin this in Task 4.
- Cancellation followed by “שבוע הבא” must require a concrete proposed date and new consent; regression tests pin this in Task 4.

---

### Task 1: Add explicit proposal and per-party date-consent state

**Files:**
- Create: `db/migrations/018_explicit_schedule_approval.sql`
- Modify: `src/domain/types.ts`
- Modify: `src/infrastructure/store.ts`
- Modify: `tests/fixtures.ts`
- Test: `tests/unit.test.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- `Request.proposed_run_date: string | null` is the exact active proposal; `Request.run_date` remains the confirmed date.
- `Party.schedule_approved_date: string | null` and `Party.schedule_approved_at: string | null` record each party's consent.
- Keep the existing `schedule_approved` property as a compatibility-derived value: true only when the party's approved date equals the request's current proposal. It is not an independent authorization source.

- [ ] **Step 1: Add failing domain tests for date-bound readiness**

Add a fully populated two-party request fixture with valid items and role approvals. Assert that readiness is false when a proposal is missing, either party's approved date is null, or one approved date differs from the proposal; assert true only when both dates equal the proposal.

```ts
const request = sampleRequest();
request.proposed_run_date = "2026-09-29";
request.parties[0]!.schedule_approved_date = "2026-09-29";
request.parties[1]!.schedule_approved_date = null;
assert.equal(readyToCoordinate(request), false);
request.parties[1]!.schedule_approved_date = "2026-10-06";
assert.equal(readyToCoordinate(request), false);
request.parties[1]!.schedule_approved_date = "2026-09-29";
assert.equal(readyToCoordinate(request), true);
```

- [ ] **Step 2: Run the focused unit test and verify it fails for the missing date-bound model**

Run: `pnpm test`
Expected: TypeScript/test failure because the fixture/domain does not yet represent a proposed date and per-party approved date.

- [ ] **Step 3: Add the additive PostgreSQL migration**

Create `018_explicit_schedule_approval.sql` with an up migration equivalent to:

```sql
ALTER TABLE requests
  ADD COLUMN proposed_run_date date
  CHECK (proposed_run_date IS NULL OR extract(isodow FROM proposed_run_date) = 2);

ALTER TABLE request_parties
  ADD COLUMN schedule_approved_date date
    CHECK (schedule_approved_date IS NULL OR extract(isodow FROM schedule_approved_date) = 2),
  ADD COLUMN schedule_approved_at timestamptz;
```

Do not backfill approvals from `schedule_approved`; old booleans did not prove consent to a specific date. Do not alter existing coordinated requests. Provide a down migration that drops only these three new columns.

- [ ] **Step 4: Add the new fields to domain types and database load/save**

Extend `Request` and `Party` as defined above. Update `sampleRequest()` in `tests/fixtures.ts` with a valid fully-approved Tuesday proposal (`2026-09-15`) and matching party approval dates so existing readiness tests continue to represent a ready request; tests for missing/mismatched consent explicitly clear or change those values. Update `Store.request()` to select and format the three new fields. Update `Store.save()` to persist them in the existing optimistic-version transaction. Derive the compatibility `schedule_approved` value from equality with `proposed_run_date`; never infer a date from the old boolean.

- [ ] **Step 5: Verify round-trip and migration behavior in isolated integration tests**

Add an integration test that saves and reloads a proposal and two distinct per-party consent dates. Add an upgrade fixture with legacy `schedule_approved=true` but no dates and assert it remains unapproved for scheduling. Run: `pnpm test:integration` in the existing disposable PostgreSQL Compose environment. Expected: migration applies, data round-trips, and the legacy boolean alone cannot satisfy readiness.

- [ ] **Step 6: Run unit suite and commit this state-model slice**

Run: `pnpm test`
Expected: all unit tests pass. Commit only Task 1 files with message `feat: persist explicit schedule date approvals`.

### Task 2: Separate role approval from explicit schedule approval

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/application/rule-planner.ts`
- Modify: `src/application/commands.ts`
- Test: `tests/unit.test.ts`

**Interfaces:**
- Add command `{ type: "approve_schedule", request_number: number, date: string }`, with ISO `YYYY-MM-DD` date validation.
- `approve_self` changes only `approved_at` and `approved_by` for the current party.
- The planner may emit `approve_schedule` only when the latest assistant turn offered that exact `proposed_run_date` and the user's text explicitly confirms it.

- [ ] **Step 1: Add failing schema and command tests**

Import `Request` into `tests/unit.test.ts`, add the helper below, and test valid/invalid ISO dates, non-proposed date rejection, and the three conversational cases shown. For the role-only case, clear the donor's `approved_at` and `approved_by` before planning.

```ts
function contextForRequest(text: string, request: Request, history: Context["history"] = []): Context {
  const phone = request.parties[0]!.phone;
  const chat_id = `972${phone}@c.us`;
  return {
    conversation: { id: "test", phone, chat_id, mode: "bot", selected_request_id: request.id, version: 1, pending_counterparty_name: null },
    requests: [request], candidates: [], history,
    message: { id: "m", seq: "1", external_id: "e", trace_id: "t", mode: "simulation", chat_id, phone, kind: "text", text, contacts: [], location: null, media_url: null, media_id: null, media_state: "none", transcript: null, processed_at: null, ai_plan: null },
  };
}

const roleRequest = sampleRequest();
roleRequest.proposed_run_date = null;
roleRequest.parties[0]!.approved_at = null;
roleRequest.parties[0]!.approved_by = null;
for (const party of roleRequest.parties) party.schedule_approved_date = null;
assert.equal(rulePlan(contextForRequest("מאשר לקבל את השידה בפנייה 1", roleRequest))?.commands[0]?.type, "approve_self");

const scheduleRequest = sampleRequest();
scheduleRequest.proposed_run_date = "2026-09-29";
assert.notEqual(rulePlan(contextForRequest("כן", scheduleRequest))?.commands[0]?.type, "approve_schedule");
assert.deepEqual(rulePlan(contextForRequest("מאשר לתאריך 29/09/2026", scheduleRequest, [
  { role: "assistant", content: "המועד המוצע: 29/09/2026" },
]))?.commands[0], { type: "approve_schedule", request_number: 1, date: "2026-09-29" });
```

- [ ] **Step 2: Run the focused unit tests and verify failure**

Run: `pnpm test`
Expected: failures show the current role approval still sets schedule approval and the command schema has no date-bound command.

- [ ] **Step 3: Add strict date-approval command validation**

Extend `commandSchema` with `approve_schedule`; reject non-calendar dates and dates that do not equal the request's active proposal in command execution. Preserve current explicit role-approval rules for `approve_self`.

- [ ] **Step 4: Implement deterministic contextual parsing**

In `rule-planner.ts`, inspect the latest assistant content and current request proposal. Emit `approve_schedule` only for an explicit affirmative tied to the same date (including a normalized date format); generic “כן”, “מאשר לקבל”, or a date that differs from the proposal must result in a clarification/no approval. Keep the model from bypassing this check by validating the command again in `commands.ts`.

- [ ] **Step 5: Run focused tests and commit command separation**

Run: `pnpm test`
Expected: role approval does not set schedule state; only current-date contextual approval sets that party's date and timestamp. Commit Task 2 files with message `fix: separate role and schedule approval`.

### Task 3: Reorder the conversation and present a concrete date proposal

**Files:**
- Modify: `src/domain/policies.ts`
- Modify: `src/application/commands.ts`
- Modify: `src/application/engine.ts`
- Test: `tests/unit.test.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Add `Store.proposeScheduleDate(c, request, now): Promise<string | null>`; it uses the existing Tuesday policy and `earliest_run_date`, reads actual `transport_runs` capacity, and returns a candidate without setting `run_date`.
- `nextQuestion()` collects only missing facts/role approval before returning a date-specific schedule-consent prompt.

- [ ] **Step 1: Add failing policy tests for question order and exact proposal wording**

Create requests with missing address/name, missing role approval, and complete details. Assert the first two cases ask only for the missing detail/role, while the complete case includes the actual Hebrew date and current configured hours, labels it as proposed, and asks for explicit consent.

```ts
const request = sampleRequest();
request.proposed_run_date = "2026-09-29";
const q = nextQuestion(request, request.parties[0]!.phone);
assert.match(q.text, /29\/09\/2026/);
assert.match(q.text, /מוצע|לאישור/);
assert.doesNotMatch(q.text, /תואמה/);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm test`
Expected: current generic “נא לאשר את חלקך” wording and question order fail the new assertions.

- [ ] **Step 3: Implement the non-schedule readiness question order**

Update `nextQuestion()` so it asks for required item conditions, missing party facts, permitted contact verification, and own-role approval without implying a schedule approval. Once those are complete, ask for the active exact date. Do not repeat valid saved fields.

- [ ] **Step 4: Create and persist a proposal without booking it**

When a complete request is eligible for scheduling, choose and save `proposed_run_date`; keep `run_date=null` and the status non-coordinated. For each party, enqueue a date-consent prompt only through an already authorized party conversation. If contact authorization is absent, obtain consent first or escalate; do not send to an unapproved number.

- [ ] **Step 5: Add integration tests for proposal display and persistence**

Exercise one direct-handoff and one matched/general path. After all required fields are present, assert a proposal date is stored and shown, no confirmed `run_date` exists, and the other party is reached only through an authorized tester conversation/consent path. Run the focused integration suite in disposable PostgreSQL.

- [ ] **Step 6: Run unit and integration suites; commit proposal flow**

Run: `pnpm test` and `pnpm test:integration` in the disposable PostgreSQL environment. Expected: proposal is separate from confirmed booking and does not prompt for already saved data. Commit Task 3 files with message `feat: propose exact transport date for approval`.

### Task 4: Make coordination transactional and prevent silent date changes

**Files:**
- Modify: `src/domain/policies.ts`
- Modify: `src/infrastructure/store.ts`
- Modify: `src/application/engine.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/application/commands.ts`
- Test: `tests/unit.test.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- `Store.coordinate(c, request, now, adminSameDay)` may coordinate only `request.proposed_run_date` after both parties' date approvals match it; it must not recompute an unapproved date.
- Capacity response is one of `not_ready | same_day | full | coordinated`; any alternate date is a new proposal and requires fresh approvals.

- [ ] **Step 1: Add failing tests for unanimous same-date consent**

Assert no coordination for one approval, mismatched dates, no proposal, unapproved role, or a “yes” with no date context. Assert the request date remains unset and no final coordination Outbox row is created.

- [ ] **Step 2: Add a failing parallel-capacity regression**

In integration, create two requests competing for the final slot on the same proposed Tuesday. Approve both sides on both requests concurrently. Assert exactly one coordinates; the other remains pending and is offered a new exact proposal requiring fresh approvals.

- [ ] **Step 3: Make `readyToCoordinate()` date-specific**

Require two parties, all existing role/item/location rules, a non-null proposal, and both `schedule_approved_date` values exactly equal to `proposed_run_date`. Do not trust legacy boolean flags.

- [ ] **Step 4: Make `Store.coordinate()` lock and validate the approved date**

Inside its transaction, lock the request and `transport_runs` row for `proposed_run_date`, validate current capacity and area, and use that exact date. On success set `run_date=proposed_run_date`, clear the proposal, and set `status="coordinated"`. On full capacity do not silently select `nextTuesday(now)`; retain the request as pending and request a fresh, explicit proposal/approval cycle.

- [ ] **Step 5: Update worker waitlist and cancellation/reschedule paths**

Change `runtime.ts` so a capacity retry can only fulfill an already unanimously approved proposal date; it may not choose a later Tuesday. Change cancellation/reschedule so “שבוע הבא” triggers a concrete date proposal, clears prior date approvals, and waits for both new approvals. Do not treat a generic “כן” as a new schedule approval.

- [ ] **Step 6: Keep outbound notices idempotent and post-commit**

In `engine.ts` and `runtime.ts`, enqueue final coordination messages only after transactional commit with dedupe key `coordination:<request-id>:<confirmed-date>:<phone>`. Proposal messages use a distinct proposal/date key. Verify provider acceptance, delivery, and read remain separate states.

- [ ] **Step 7: Run concurrency, cancellation, and full unit/integration regression tests**

Run: `pnpm test`; then `pnpm test:integration` in disposable PostgreSQL with concurrency 1 for the suite and explicit parallel requests inside the test. Expected: no silent date shift, no duplicate notice, and no coordination without two same-date approvals. Commit Task 4 files with message `fix: require both parties to approve the same schedule`.

### Task 5: Update status surfaces, behavior contract, and test harness

**Files:**
- Modify: `src/domain/policies.ts`
- Modify: `src/http.ts` and admin UI source only if the existing API exposes schedule fields
- Modify: `docs/SYSTEM_AND_BOT_BEHAVIOR_HE_2026-09-25_V2.md`
- Modify: relevant fixtures/tests in `tests/unit.test.ts` and `tests/integration.test.ts`

**Interfaces:**
- Pending request summaries show `מועד מוצע — ממתין לאישור`; only confirmed `run_date` is labeled `תואמה`.
- Admin status exposes proposal and each party's date-consent state separately from role/contact consent.

- [ ] **Step 1: Add failing status-output assertions**

Assert pending status displays proposed date and per-party pending/approved state, while `run_date=null` never prints a confirmed delivery date. Assert coordinated status includes only the confirmed date.

- [ ] **Step 2: Update status rendering and admin serialization**

Expose proposal and date approvals with distinct field labels; do not reuse the contact-verification state or role `approved_at` label. If no admin field exists for these facts, keep the change in the established summary/API shape rather than adding an unrelated UI control.

- [ ] **Step 3: Update behavior documentation and regression scenario contract**

Document the three separate consents, exact-date requirement, capacity retry behavior, and unresolved hours conflict. Add the live reproduction as a required regression: “מאשר לקבל” must not create `coordinated` or set `run_date`.

- [ ] **Step 4: Run all local validation gates**

Run `pnpm check`, `pnpm test:integration` in isolated PostgreSQL, `pnpm check:spec`, `pnpm check:probes`, `pnpm check:ai-eval`, `pnpm check:prompt-wiring`, and `git diff --check`. Expected: all relevant gates pass; no changes to business hours or service-area rules.

- [ ] **Step 5: Commit documentation/status changes**

Commit only Task 5 files with message `docs: clarify separate schedule consent and proposal state`.

### Task 6: Release, reset the QA-only live data, and prove the original failure is fixed

**Files:**
- Modify only release artifacts required by `docs/RELEASE_RUNBOOK.md`
- Test live only against `0584152101` and `0536662043`

**Interfaces:**
- Use the existing release gate, snapshot, QA lock, allowlist, rollback, WAHA identity verification, and PostgreSQL read-only evidence process. Do not widen recipients.

- [ ] **Step 1: Reacquire/verify the QA lock and capture a fresh pre-release snapshot**

Verify there is exactly one lock owner and no overlapping worker. Snapshot database and media before migration/deployment; record hashes. Preserve the currently false-coordinated QA request evidence from `qa-snapshot-20260925T1141-unapproved-date`.

- [ ] **Step 2: Review pending/uncertain WAHA sends before reset**

Read the eight existing provider IDs for Outbox seq `1827–1834`; do not resend them. Confirm each is final/accepted or otherwise resolve uncertain delivery before any reset.

- [ ] **Step 3: Run the existing release gate and deploy with rollback enabled**

Run the repository release procedure without bypassing any unmet prerequisite. Apply migration, build/tag, and deploy start-first with automatic rollback. If a required gate fails, stop and preserve the active system; do not perform `clear-all` or live retest.

- [ ] **Step 4: Verify server identity, health, schema, and deployed behavior**

Verify WAHA session-to-number mappings, bot number, `/health`, `/ready`, active image digest, migration version, and runtime command handler. Confirm the prompt/model cannot override domain validation.

- [ ] **Step 5: Perform the QA-only clean reset after the fresh snapshot**

Using the authorized runbook clear-all, remove only the operational QA data in the isolated test scope, verify zero requests/messages/media/events/outbox/counter and completed/settled jobs, and confirm no production/real records or credentials were touched.

- [ ] **Step 6: Run one live two-party reproduction**

Use one direct handoff between the two allowlisted numbers. Have one side approve its role, complete its details, and authorize contact as required; have the other side answer `מאשר לקבל את השידה בפנייה 1`. Verify by read-only DB that the request remains non-coordinated, `run_date` is null, and no final coordination message exists. Then send an exact-date proposal; confirm only one party's date approval still leaves the request pending; get the other party to approve the identical date and verify exactly one atomic coordination plus correctly addressed Outbox messages.

- [ ] **Step 7: Verify live transcript, database, and side effects; close or retain checkpoint**

Audit each turn for repeated questions and lost fields. Record provider IDs, DB request/party/item/event rows and delivery states. Do not claim delivered/read without WAHA ACK evidence. If all assertions pass, mark only this retest passed; do not claim the full eight-scenario cycle passed. Preserve checkpoint for the next cycle.

## Self-review checklist

- Spec coverage: role approval, date-specific consent, explicit proposal, proposal-vs-booking display, matching both approvals, capacity races, cancellation/reschedule, idempotent notices, old-state migration, release safety, and live retest each map to Tasks 1–6.
- Placeholder scan: no TODO/TBD steps; every implementation/test step names files, command, or an explicit assertion.
- Type consistency: plan uses `Request.proposed_run_date`, `Party.schedule_approved_date`, `Party.schedule_approved_at`, and command `approve_schedule(request_number, date)` consistently.
- Review Focus coverage: all five listed cases are exercised by Tasks 2–5.
- Scope: one vertical feature across the existing command/domain/persistence/scheduler path; no independent subsystem or business-policy decision is bundled.
