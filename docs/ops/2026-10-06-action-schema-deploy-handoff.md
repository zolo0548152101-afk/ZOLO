# HAIM action-schema deployment handoff — 2026-10-06

## What changed in the new two-prompt flow

- The action manager reads `prompts/haim-action.he.md` from the repository and sends it as the Responses API `instructions` field. It returns structured `commands` plus short `evidence`; application code validates each command against the existing domain schema before execution.
- The reply manager remains a separate hosted prompt. It receives the operation result and refreshed request state and returns the customer-facing reply. Its prompt ID/version remain in service configuration; this change does not replace or delete them.
- The webhook is received by Docker Swarm service `whatsapp_haim-bot-core` (container port 3000, session `HAIM_YAHAD`). The host `haim-bot.service` on port 3010 is a separate deployment target and is not the observed WAHA webhook receiver.

## Fix being deployed

The first live decode calls failed before the model could produce a plan. The Responses strict-schema endpoint rejected the action schema because the `donate` command had optional `counterparty_name` and `direct` properties. The wire schema now makes every property required and represents those two optional values as nullable; the application removes only those null optional values and then validates the normalized command against the unchanged domain schema. No database schema or business command semantics are changed.

## Deployment/checkpoint

- Source branch: `codex/haim-two-prompts`.
- Previous deployed source: `6303b968` (the current correction is to be committed and deployed after this handoff file is created).
- Deployment targets: host source/build/service and the Docker Swarm webhook service. Keep them on the same source SHA; update the Docker image used by the webhook service, not only systemd.
- Do not remove the server's untracked `dist.backup-*` directories; they are preserved deployment backups.
- The user's requested live validation is limited to a message from WAHA `default` / 0584152101 to the bot test number 0543414386. Verify the persisted message, AI command, and resulting request/item/party rows before claiming success.

## Verification status and remaining work at handoff

- TypeScript `tsc -p tsconfig.json --noEmit` passed locally after the schema change.
- The user explicitly requested not to run local test suites.
- GitHub Actions `verification` is red on both 8198dcb and 6303b96. The latest run lists multiple integration failures around fixture/count expectations and existing PHOTO-FIRST/rule-planner expectations; this is separate from the reproduced live OpenAI error. Do not report CI as green.
- Complete: commit/push, server build, update both deploy targets to the exact commit, check health/readiness, perform one scoped WAHA message, inspect its database effects, and append exact SHA/outcomes here.
