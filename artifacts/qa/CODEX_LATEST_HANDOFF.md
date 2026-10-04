# CODEX LATEST HANDOFF

work_unit: T25 canary qualification gate
candidate_git_sha: 084293b82aa1cb1c72947a9d5661fcef0d26835b
branch: qa-build
status: deployed_health_verified
deployed_image: haim-bot-core:t25-c72c831
service: whatsapp_haim-bot-core 1/1 healthy
rollback_target: haim-bot-core:t24-e599be5

## T25 result

- `npm run test:t25-canary`: `6/6` PASS.
- `npm run check:t25-release`: PASS in safe `shadow` mode.
- allowlist normalization accepts local/972 forms and rejects any identity outside `0584152101`, `0536662043`.
- four required flow classes are explicitly gated: direct, open donation, self-transfer, and open request.
- delivery/status/reconciliation evidence is required for every flow; any gap fails qualification.
- rollback preserves inbox/outbox/provider receipts/snapshot/evidence and performs no destructive deletion.
- T25 candidate was deployed with Swarm `start-first` and automatic rollback; the service converged at `1/1`.
- `/health` returned HTTP 200 and `/ready` returned HTTP 200 with schema `haim_core`.
- no live canary flow or WhatsApp message was run by this deployment step.
- evidence file: `artifacts/qa/t25-canary-verification.json`.

## T25 boundary

Live canary traffic remains a separate high-risk operational action requiring explicit release authorization and fresh evidence. This deployment verified service health only; it is not a claim that four live canary flows or 8/8 WhatsApp qualification passed.

work_unit: T24 shadow qualification
candidate_git_sha: 616524f8f069454d1f24b000623bec8b9405d745
branch: qa-build
status: deployed_and_reset_verified
deployed_image: haim-bot-core:t24-e599be5
service: whatsapp_haim-bot-core 1/1 healthy

## T24 result

- isolated scenarios: `5/5` PASS.
- direct handoff preserves separate donor/recipient identities.
- open donation stores donor facts without inventing a recipient.
- self-transfer stores distinct pickup and destination facts.
- general request creates a search without a phantom request.
- restart recovery leaves one committed request and one reply effect.
- canonical gates: unit `64/64`, integration `77/77`, T21/T22 `5/5`, AI contract `9/9`, regressions `26/26`, Golden `52/52`, backup/restore PASS.
- evidence file: `artifacts/qa/t24-shadow-verification.json` (handoff commit binds it to the source SHA).

## Post-deploy reset

- snapshot: `/var/backups/haim-qa/haim-reset-20261004T1755Z.sql` (SHA-256 `14dc81f575c69ee2b194029e6076e5d6b3ed5cd8ef1f848133435cc141d86bf8`)
- media snapshot: `/var/backups/haim-qa/haim-reset-20261004T1755Z-media.tgz` (SHA-256 `15b81f08e538ebfab0c60b8801f43cf0256e4068e0f2208d75869166de6bdb33`)
- post-reset: migrations `24`; operational counts and physical media files `0`; failed/retry jobs `0`.

## Completed recovery work

- The scoped HAIM clean reset completed with a server-only snapshot and a verified zero operational state.
- The deployed schema was corrected from migration 21 to 24; the missing integration-dispatcher column is present.
- Image `haim-bot-core:t24-611a108` is running and healthy.
- The physical HAIM media volume, business records, Outbox, integration Outbox, and failed/retrying queue jobs are empty.

## Evidence

- `docs/qa/MASTER_PROGRESS.md`
- server-only reset manifest `haim-reset-20261004T170039Z.json`
- server-only reset snapshot `haim-reset-20261004T170039Z.sql`

## Next action

The matching QA image is deployed and the post-deploy test-data reset is verified. Begin the separately authorized WAHA contract gate. No live 8/8 qualification batch has started.
