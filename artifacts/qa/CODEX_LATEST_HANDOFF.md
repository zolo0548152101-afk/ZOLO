# CODEX LATEST HANDOFF

phase: 4 / T20 legacy Sheets import and reconciliation
baseline_commit: 8d4b8e0dcc83e52ee3f1f6cd94452b9a8e1e6fe6
source_commit: dd9aae0ed91aa8e3341f179c077c763c9926ab4c
evidence_commit: pending (this file is committed in the evidence-only handoff)
branch: qa-build
push_success_before_handoff: pending
working_tree_before_handoff: clean after source commit

## Scope

- Canonical parser for the exact 28-column legacy export with quote-aware CSV, CRLF/LF, deterministic source/row SHA-256 hashes, strict phones, booleans, integers, dates, statuses, locations and item mapping.
- Field-level loss review for legacy notes, bot status, human-treatment flag and WhatsApp media references; media is preserved as a reference only and never fetched.
- Disposable PostgreSQL staging lifecycle: `staged`, `validated`, `apply_ready`, `applied`, `failed`, `review_required`, `rolled_back`.
- Apply maps requests, donor/receiver parties, items, approved locations, events and lineage; reruns are idempotent and reconciliation is explicit.
- Rollback removes only import-created entities, preserves pre-existing contacts and is idempotent. Apply/rollback require the disposable database guard.

## Gates

- build/typecheck: PASS
- unit: PASS (64/64)
- disposable PostgreSQL integration: PASS (76/76; 0 failed; 0 cancelled)
- T20 importer/negative tests: PASS (30/30; dry-run, review block, apply, idempotency, lineage, reconciliation, rollback)
- regressions: PASS (26/26; 12 probes)
- Golden: PASS (52/52)
- spec, prompt wiring, probes, locations, legacy mapping: PASS
- migrations/FK/checksum: PASS; FK failures 0; migration SHA-256 `7c2a06d94f8ed5549247609f53a778c0e214f2b5f9be7da22adbeca7a584fce1`
- diff check: PASS
- secret scan: PASS

## Evidence

- `artifacts/qa/t20-sheets-import-verification.json`
- `docs/qa/T20_SHEETS_IMPORT.md`
- `db/migrations/023_sheets_import_lifecycle.sql`
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
- deployment_performed: false
- pr2_merged: false
- t21_started: false

T20 source and evidence are ready for independent review. Wait for the exact-SHA reviewer directive on PR #2. Do not start T21.
