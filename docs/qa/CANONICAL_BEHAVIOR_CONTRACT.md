# Canonical Haim Yahad Behavior Contract

This document is the human-readable companion to the machine-readable catalog in
`tests/spec/domain-invariants.json`. The catalog IDs are stable references for
tests, regression records, golden conversations, and release evidence.

## Source hierarchy

1. `docs/SYSTEM_AND_BOT_BEHAVIOR_HE_2026-09-25_V2.md` defines business behavior and
   QA semantics.
2. `docs/CONTINUOUS_QA_RUNBOOK_HE.md` defines the eight live scenario slots and
   operational boundaries.
3. `tests/spec/domain-invariants.json` gives each enforceable rule a stable ID.
4. Code and tests are implementation/evidence; a contradiction must be recorded
   and resolved before release qualification.

## Invariant groups

### Conversation identity and state

`CONV-001`–`CONV-005` cover inbox deduplication, canonical/LID identity,
ordering, stale-plan protection, and human-mode retention.

### Request identity and party separation

`REQ-001`–`REQ-003` cover logical request identity and coexistence. `PARTY-001`–
`PARTY-004` cover donor/receiver separation, self-transfer state, and role
authorization.

### Fact retention

`FACT-001`–`FACT-005` cover city, address, floor, name, item, quantity, media,
counterparty identity, and explicit approvals. A known fact must not be asked
again unless there is a real contradiction, ambiguity, or justified confirmation.

### Business flows

- Direct handoff: `FLOW-DIRECT-001`–`FLOW-DIRECT-002`.
- Open donation: `FLOW-DONATE-001`–`FLOW-DONATE-002`.
- Self-transfer: `FLOW-SELF-001`–`FLOW-SELF-002`.
- Open request: `FLOW-REQUEST-001`–`FLOW-REQUEST-002`.

### Scheduling, capacity, and external effects

`SCHED-001`–`SCHED-005` cover date-specific approvals, invalidation, concurrency,
admin approval, and cancellation. `OUTBOX-001`–`OUTBOX-004` cover atomic Outbox
creation, uncertain-send safety, provider-state semantics, and retry idempotency.

## Scenario mapping

Every declarative scenario in `tests/spec/scenarios.json` must list one or more
`invariant_ids`. `scripts/validate-spec.mjs` rejects missing or unknown IDs, so a
scenario cannot silently rely on prose-only expectations.

## Historical failure mapping

- Lost pickup facts before the open-donation photo gate → `FACT-001`, `FACT-002`,
  `FACT-003`, `FLOW-DONATE-001`.
- Repeated schedule approval after the other chat supplied the shared proposal →
  `FACT-005`, `SCHED-001`, `PARTY-004`.
- Self-transfer floor text stored inside the address field → `PARTY-003`,
  `FACT-002`, `FLOW-SELF-001`.
- Uncertain provider result treated as safe to resend → `OUTBOX-002`,
  `OUTBOX-003`, `OUTBOX-004`.
- Donor/receiver or request duplication after a new turn → `REQ-001`, `REQ-003`,
  `PARTY-001`, `PARTY-002`, `CONV-004`.

## Release interpretation

Passing a validator proves catalog/spec consistency only. It does not prove live
WhatsApp delivery, remote prompt quality, or release readiness. Those require the
evidence gates defined by the Master Plan.
