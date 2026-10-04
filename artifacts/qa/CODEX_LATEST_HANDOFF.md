# CODEX LATEST HANDOFF

phase: 4 / T21+T22 observability and hardening
baseline_commit: d1cda7959bf18df9e98b26a8b0971d27970c7f28
source_commit: 585757b5041c50d6666f371ae93930215aa37aa0
evidence_commit: pending (this file is committed in the evidence-only handoff)
branch: qa-build
push_success_before_handoff: true
working_tree_before_handoff: clean after source commit

## Scope

- T21 operational signal model and `/admin/metrics` surface for backlog, age, retry, terminal, stale-lease, FIFO, prompt and Sheets-import failure classes.
- Configurable test/operator SLO semantics with bounded diagnostics and documented actions.
- T22 fail-closed production/live admin-token validation, capability separation, rate/same-origin controls, recursive audit redaction, and secret-rotation simulation.
- Disposable-only PostgreSQL/media/configuration backup manifest and restore drill with checksum validation and explicit RPO/RTO test defaults.

## Gates

- build/typecheck: PASS
- unit: PASS (64/64)
- targeted T21/T22 tests: PASS (3/3)
- disposable PostgreSQL integration: PASS (76/76; 0 failed; 0 cancelled)
- regressions: PASS (26/26; 12 probes)
- Golden: PASS (52/52)
- spec: PASS (4 scenarios / 34 invariants); prompt wiring: PASS
- migrations/FK/checksum: PASS; FK failures 0
- backup/restore drill: PASS; PostgreSQL 15.19 disposable source/target, manifest with PostgreSQL/media/configuration checksums
- diff check: PASS; secret/privacy scan: PASS

## Evidence

- `artifacts/qa/t21-t22-verification.json`
- `docs/qa/T21_T22_OBSERVABILITY_HARDENING.md`
- `docs/qa/MASTER_PROGRESS.md`

## Safety and next action

- production_access: false
- server_access: false
- ssh_access: false
- easypanel_access: false
- live_waha_access: false
- live_db_access: false
- real_messages_sent: false
- real_external_integration_calls: false
- real_secret_rotation: false
- real_backup_storage_access: false
- deployment_performed: false
- pr2_merged: false
- t23_started: false

T21+T22 source and evidence are ready for independent review. Wait for the exact-SHA reviewer directive on PR #2. Do not start T23.
