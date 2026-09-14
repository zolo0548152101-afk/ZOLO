# Release and recovery gates

## Local evidence

1. Run `docker compose -f compose.test.yml build tests`.
2. Start a fresh PostgreSQL volume and run `npm run test:integration` in the test container.
3. Confirm the database volume is removed after the run.
4. Run `git diff --check` and retain `docs/IMPLEMENTATION_EVIDENCE.md`.

## Media recovery

Use `scripts/backup-restore-drill.mjs` only against an explicitly named restore database and with `DRILL_CONFIRM=YES`. Verify media checksums and that a missing object produces a visible failure, not a fabricated success.

## Sheets migration

Run `node scripts/sheets-stage.mjs export.csv` first. Setting `STAGE_TO_DATABASE=true` with `TEST_DATABASE_URL` only creates staging rows. No business table is changed until a separately reviewed mapping/apply migration exists.

## Live gate

Run `node scripts/release-gate.mjs` before any deployment. Production, WAHA live sends, allowlist changes, remote OpenAI paid evaluation, and canary traffic require explicit operator approval. The repository defaults remain shadow/simulation. A live gate must include `APPROVE_LIVE_RELEASE=YES`, `RELEASE_SNAPSHOT_ID`, a non-empty `LIVE_ALLOWLIST`, verified dependencies, a confirmed media volume, the reviewed checksum-backed location dataset, a passing pinned-prompt remote golden evaluation, and a reviewed Sheets reconciliation ID.
