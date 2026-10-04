# CODEX LATEST HANDOFF

phase: 4 / T21+T22 observability and hardening
baseline_commit: d1cda7959bf18df9e98b26a8b0971d27970c7f28
source_commit: 616cde7a4d523929deb17fd96758e2d6270dd324
evidence_commit: this evidence-only handoff commit
branch: qa-build
ci_source_sha: 616cde7a4d523929deb17fd96758e2d6270dd324
ci_verification_runs: 37204416130, 37204413644 (success)

## Scope

- T21 configurable observability signals include failed imports, retrying and
  stale-active integrations, and configurable warning/critical transitions.
- `/admin/metrics` sanitizes integration diagnostics before exposure.
- T22 production/live validation requires strong optional capability tokens too;
  empty optional tokens disable their capability and distinctness remains
  enforced.
- The disposable backup/restore drill proves target-side HAIM state, import
  lineage, integration/outbox state, media bytes/metadata, and configuration;
  it rejects non-disposable targets and runs against fresh isolated source and
  target databases.

## Gates

- build/typecheck: PASS
- unit: PASS (64/64)
- targeted T21/T22: PASS (4/4)
- disposable PostgreSQL integration: PASS (76/76)
- Sheets importer: PASS (30/30)
- regressions: PASS (26/26; 12 probes)
- Golden: PASS (52/52)
- migrations/FK/checksum: PASS; FK failures 0
- backup/restore: PASS; `restored:true`, `target_verified:true`
- CI on exact source SHA: PASS (runs 37204416130, 37204413644)
- diff check and secret/privacy scan: PASS

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
- deployment_performed: false
- t23_started: false

T21+T22 corrections are ready for independent review. Do not start T23.
