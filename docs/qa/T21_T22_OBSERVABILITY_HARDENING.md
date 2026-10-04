# T21/T22 — Observability and hardening

This work unit is repository/disposable-test only. It does not deploy, access
live WAHA/PostgreSQL, or deliver alerts externally.

## Operational signals

`GET /admin/metrics` returns `observability` with bounded machine-readable
signals. The default values below are test/operator defaults, not production
commitments; they are configurable in the signal builder before an operational
deployment:

| Signal | Warning | Critical | Operator action |
| --- | ---: | ---: | --- |
| inbox/outbox count | 10 | 50 | inspect worker/provider queue |
| inbox/outbox oldest age | 5 min | 15 min | inspect oldest item and worker |
| uncertain delivery | 1 | 1 | resolve provider evidence before retry |
| retrying delivery | 1 | 5 | inspect bounded retry cause |
| dead-letter integration | 1 | 5 | review terminal failure before replay |
| stale lease / FIFO blocker / prompt failure / Sheets review | 1 | 5 | follow the corresponding runbook action |

Signal context is bounded to 512 bytes and contains counts/ages only. It never
contains message text, tokens, credentials, or private media.

## Hardening contract

- Production/live `HAIM_ADMIN_TOKEN` must be a non-repeating 32-character secret.
- Configured capability tokens must remain distinct; callers cannot self-promote
  with `x-admin-capability`.
- Admin mutation requests remain same-origin and rate bounded (20 per route/IP/
  token per 60 seconds). Read-only routes do not consume mutation budget.
- Admin audit records recursively redact token/secret/password/authorization/
  cookie/API-key/private-key/credential fields.
- Secret rotation is an overlap simulation only: both secrets must be strong and
  different; no real secret is rotated by tests.

## Backup and restore drill

The disposable drill requires `DRILL_CONFIRM=YES` and
`DISPOSABLE_RESTORE=YES`, rejects non-local database hosts, and requires a
media root plus configuration file. It runs `pg_dump`, `pg_restore`, and a
restore listing, then emits `backup-manifest.json` containing PostgreSQL,
media-manifest, and configuration checksums. Missing components, invalid
checksums, invalid paths, or non-positive sizes fail closed.

Test defaults are RPO 60 minutes and RTO 30 minutes for the disposable drill
only. They are not production SLO/RPO/RTO commitments. Restore ordering is:
PostgreSQL schema/data, media objects, configuration metadata, then checksum and
business-invariant validation.
