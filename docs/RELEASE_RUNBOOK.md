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

Run `node scripts/release-gate.mjs` before any deployment. Production, WAHA live sends, allowlist changes, remote OpenAI paid evaluation, and canary traffic require explicit operator approval. The repository defaults remain shadow/simulation. A live gate must include `APPROVE_LIVE_RELEASE=YES`, `RELEASE_SNAPSHOT_ID`, a non-empty `LIVE_ALLOWLIST`, verified dependencies, a confirmed media volume, the reviewed checksum-backed location dataset, and a passing pinned-prompt remote golden evaluation.

For a release that imports or reconciles legacy Sheets data, also provide a reviewed `SHEETS_RECONCILIATION_ID`. For the user-approved QA-only disposable Haim Yahad application database, with **no legacy Sheets import**, set `RELEASE_DATA_SOURCE_MODE=qa_no_legacy_import`, `QA_DISPOSABLE_DB_VERIFIED=YES`, and `QA_DATA_SCOPE_EVIDENCE_ID` to the ID of a recorded read-only verification of the target database, its operational data scope, and absence of a legacy import in this release. In this QA mode, `LIVE_ALLOWLIST` must contain exactly `0584152101` and `0536662043` (local format with or without the leading zero, or `972` format). This mode does not waive any other live gate. Never invent a reconciliation or evidence ID; when legacy import is in scope, the QA exception is not applicable. A passing gate is authorization evidence for a release step, not proof that a version was deployed.
