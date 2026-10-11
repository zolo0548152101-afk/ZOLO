# HAIM action-schema deployment handoff — 2026-10-06

## New two-prompt flow

- Action manager: `prompts/haim-action.he.md` is loaded from the repository and sent as Responses API `instructions`. It returns structured `commands` and short `evidence`; each command is validated by the existing domain schema before execution.
- Reply manager: remains a separate hosted prompt. It receives operation results and refreshed state and produces customer-facing text. Its configured prompt ID/version were not replaced or deleted.
- The observed WAHA webhook target is Docker Swarm service `whatsapp_haim-bot-core` (container port 3000, session `HAIM_YAHAD`). `haim-bot.service` on port 3010 is a separate host deployment target.

## Fix made

Live decode calls failed before the model could produce a plan: Responses strict structured output rejected the `donate` schema's optional `counterparty_name` and `direct` fields. The API-facing schema now makes every property required and represents those two optional fields as nullable. The application removes only null values for those optional fields, then validates the command against the unchanged domain schema. No database schema or business command semantics changed.

## Deployment

- Branch: `codex/haim-two-prompts`.
- Source commit: `59c65d6547884e50a05ad1e4272af69098eedd65` (`fix: make action output schema Responses-compatible`), pushed to `origin`.
- Deployment used the existing SSH path to the Ubuntu host, not the EasyPanel UI. The checkout at `/etc/easypanel/projects/whatsapp/haim-bot-core/code` fast-forwarded to the commit and `npm run build` succeeded. `haim-bot.service` was restarted and is active.
- The Swarm image was built as `haim-bot-core:59c65d6` from the previous deployed image, overlaying the newly built `/app/dist` and `/app/prompts`. `whatsapp_haim-bot-core` converged and reports the full source SHA in `GIT_SHA`.
- Both deployment targets are on the same source SHA. Docker `/health` and `/ready`, and host `/health` and `/ready`, all returned HTTP 200.
- Leave untracked server directories `dist.backup-*` untouched; they are deployment backups.

## Live verification

- Used only the authorized test path: WAHA session `default` (0584152101) to bot test number 0543414386. Reset that contact's conversation memory first; no request or other data was deleted.
- WAHA accepted `אני רוצה למסור מיטה לטל` with provider ID `3EB068A9A1B837FE5D6E8E`.
- PostgreSQL then showed the inbound message processed with no error, an AI `donate` command for one bed (`direct=true`, counterparty `טל`), and request #1 (`collecting`, `direct`) with its bed item persisted.
- The reply asked for Tal's phone/contact to continue verification. This proves action decode, command execution, and request/item persistence on the live webhook path; it does not independently validate the reply-manager prompt or real delivery to another person.
- No other contacts were messaged. No API key or admin token was changed.

## Verification and remaining work

- Local `tsc -p tsconfig.json --noEmit` passed; remote `npm run build` passed.
- Per user instruction, local test suites were not run.
- GitHub Actions verification remains red on commit `59c65d6` (run `37456935263`): nine integration assertions fail, covering flow/PHOTO-FIRST expectations, conversation ordering, fixture/count expectations, and persisted-plan behavior. Do not report CI as green; these failures need separate investigation.
- Next: address the CI integration failures in a separate scoped correction and, if requested, separately exercise the hosted reply-manager prompt. The live action decode/DB persistence fix is deployed and verified.
