# CODEX LATEST HANDOFF

phase: 4 / T19 integration outbox dispatcher
baseline_commit: 42858e597656fcc452d0a66ca09f52bb1ea7af9b
source_commit: 570d97af357e1c284b81a456b681315194346afa
evidence_commit: pending (this file is committed in the evidence-only handoff)
branch: qa-build
push_success_before_handoff: pending
working_tree_before_handoff: clean

## Scope

- Durable integration outbox state machine: pending, active, delivered, dead_letter.
- Bounded retry with retryable, terminal, retry-exhausted, and ambiguous delivery classes.
- Stable idempotency key, atomic claim, duplicate-safe dispatch, per-integration event ordering, stale-active recovery, and periodic due-pending recovery without restart.
- Versioned event envelope and adapter boundary with AbortSignal; no provider or live external call.
- Enabled-only enqueue, terminal-only normal-admin replay with reason/audit and same-transaction queue scheduling, and bounded metrics/operations visibility.

## Gates

- build: PASS
- unit: PASS (64/64)
- disposable PostgreSQL integration: PASS (76/76; 0 failed; 0 cancelled)
- regressions: PASS (26/26; 12 probes)
- Golden: PASS (52/52)
- spec: PASS
- prompt wiring: PASS
- migrations/FK/checksum: PASS; FK failures 0
- diff check: PASS
- secret scan: PASS

## Evidence

- `artifacts/qa/t19-integration-dispatcher-verification.json`
- `docs/qa/CODEX_EXECUTION_POLICY.md`
- `docs/qa/MASTER_PROGRESS.md`
- `src/application/integration-port.ts`
- `src/application/runtime.ts`
- `src/infrastructure/store.ts`
- `src/http.ts`
- `db/migrations/022_integration_dispatcher.sql`
- `tests/integration.test.ts`

## Safety and next action

- production_access: false
- server_access: false
- ssh_access: false
- easypanel_access: false
- live_waha_access: false
- live_db_access: false
- real_messages_sent: false
- real_external_integration_calls: false
- deployment_performed: false
- pr2_merged: false
- t20_started: false

Wait for the exact-SHA independent reviewer directive on PR #2. Do not start T20.
