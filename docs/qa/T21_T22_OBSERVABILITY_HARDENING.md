# T21/T22 — Observability and hardening

This work unit is repository/disposable-test only. It does not deploy, access
live WAHA/PostgreSQL, or deliver alerts externally.

## Operational contract

`GET /admin/metrics` exposes bounded signals for inbox/outbox backlog and age,
uncertain and retrying delivery, dead letters, stale leases, FIFO blockers,
prompt failures, failed or review-required Sheets imports, retrying
integrations, and stale active integrations. Warning and critical transitions
are driven by configurable `SloThresholds`; defaults are test/operator defaults.

Diagnostic context is bounded and never exposes credentials, tokens, private
media, or raw provider errors. Integration `last_error` values are sanitized
before entering the admin metrics response.

## Admin hardening

- Production/live `HAIM_ADMIN_TOKEN` and every configured optional capability
  token must be strong; empty optional capability tokens disable that capability.
- Capability tokens remain distinct; callers cannot self-promote with
  `x-admin-capability`.
- Mutations remain same-origin and rate bounded.
- Audit records recursively redact token/secret/password/authorization/cookie/
  API-key/private-key/credential fields.
- Secret rotation is an overlap simulation only; no real secret is rotated.

## Disposable backup/restore drill

The canonical Docker verification stage runs the drill in isolated disposable
source and target databases. It requires `DRILL_CONFIRM=YES`,
`DISPOSABLE_RESTORE=YES`, an explicit disposable database name, the fixed
`application_name`, and local/PostgreSQL-only targets. It rejects live/core
identifiers and missing proof of disposability.

The drill seeds and verifies contacts, request/parties/item, message/media and
request-media linkage, integration/event/outbox state, Sheets import batch and
lineage, media bytes/metadata, and configuration metadata. It dumps the source,
restores into a clean disposable target, verifies target-side state and exact
media/config checksums, and prints `restored:true` only after those checks pass.

Test-only defaults are RPO 60 minutes and RTO 30 minutes; these are not
production commitments.

## Verification evidence

The exact source SHA and gate results are recorded in
`artifacts/qa/t21-t22-verification.json` in the evidence-only handoff commit.
The canonical Docker run includes targeted T21/T22 tests, PostgreSQL
integration, Sheets importer tests, migration/FK checks, the disposable drill,
regressions, and Golden scenarios.
