# Master Progress

## 2026-10-04 admin clear-all UI fix

- source/deployment commit: `28007748ab5daab465ac4db3c978bca568456671`.
- root cause: visible admin clear-all handlers sent boolean `confirm: true`; the API requires the exact string `מחק הכל`, producing HTTP 400.
- regression: `npm run test:admin-clear-all-ui` passed `1/1`.
- container gates: build passed; core suite passed `64/64`.
- deployed image: `haim-bot-core:clear-all-2800774`; Swarm service `whatsapp_haim-bot-core` converged at `1/1` with start-first/rollback protection.
- post-deploy `/health` and `/ready`: HTTP 200.
- no live clear-all request was sent; no data was deleted by this fix.

## 2026-10-04 T25 canary qualification gate

- source commit: `084293b82aa1cb1c72947a9d5661fcef0d26835b`.
- `npm run test:t25-canary`: `6/6` PASS.
- `npm run check:t25-release`: PASS in default `shadow` mode; the gate performs no external side effects.
- allowlist is normalized and fail-closed to the two authorized test recipients only: `0584152101`, `0536662043`; bot identity `0543414386` is not a recipient.
- four flow classes are covered by the qualification contract: direct, open donation, self-transfer, open request.
- rollback contract preserves inbox/outbox/provider receipts/snapshot/evidence and forbids destructive deletion.
- candidate `haim-bot-core:t25-c72c831` deployed to `whatsapp_haim-bot-core` with `start-first` and automatic rollback to `haim-bot-core:t24-e599be5`.
- service converged at `1/1`; `/health` and `/ready` returned HTTP 200; `/ready` reported schema `haim_core`.
- no live canary flow or WhatsApp message was run; deployment health is not 4-flow or 8/8 qualification evidence.
- evidence: `artifacts/qa/t25-canary-verification.json`, `docs/qa/T25_CANARY_CUTOVER.md`.

## 2026-10-04 T24 publication, deployment, and post-deploy reset

- source commit: `616524f8f069454d1f24b000623bec8b9405d745`; evidence handoff: `e599be591f6c2670698690b66522f3923bc235a9`.
- GitHub: both commits pushed to `origin/qa-build`; local working tree was clean before deployment.
- deployed image: `haim-bot-core:t24-e599be5`; Swarm `whatsapp_haim-bot-core` converged at `1/1`; container health `healthy`; `/health` returned HTTP `200`.
- post-deploy reset was authorized as internal test-data cleanup. Snapshot: `/var/backups/haim-qa/haim-reset-20261004T1755Z.sql`, SHA-256 `14dc81f575c69ee2b194029e6076e5d6b3ed5cd8ef1f848133435cc141d86bf8`; media snapshot: `/var/backups/haim-qa/haim-reset-20261004T1755Z-media.tgz`, SHA-256 `15b81f08e538ebfab0c60b8801f43cf0256e4068e0f2208d75869166de6bdb33`.
- reset scope: `haim_core` operational records and the verified HAIM media volume only; migrations, location data, configuration, WAHA sessions, and other services were not deleted.
- reset proof: migrations `24`, requests/messages/conversations/contacts/outbox/integration_outbox/media/counter `0`, failed/retry jobs `0`, physical media files `0`; service remained healthy.
- next gate: authorized WAHA contract testing and live eight-conversation qualification. This deployment is not a claim that the live 8/8 batch has passed.

## 2026-10-04 T24 shadow qualification

- verdict: PASS for isolated shadow qualification; deployment remains limited to the already-authorized QA service and real WAHA qualification has not started.
- verification window: `2026-10-04T17:51:13Z` (completed before evidence publication).
- scenarios: `5/5` — direct handoff with separate donor/recipient conversations, open donation, self-transfer with distinct endpoints, general request, and committed-turn restart/idempotency recovery.
- canonical verification: unit `64/64`, integration `77/77`, T21/T22 `5/5`, AI contract `9/9`, regression registry `26/26`, Golden `52/52`, backup/restore drill PASS, T24 shadow `5/5`.
- evidence: `artifacts/qa/t24-shadow-verification.json`.
- next exact action: publish the verified T24 source/evidence commits, deploy the matching image to the QA service, then proceed to the authorized WAHA contract gate. No production or live external data was touched by this shadow run.

## 2026-10-04 reset and deployment recovery

- verdict: PASS for the scoped HAIM reset and migration/deployment recovery; T24 shadow qualification is now complete as recorded above.
- scope: only `haim_core`, `haim_core_jobs`, and the verified `whatsapp_haim-bot-core_haim-yahad-media` Docker volume. The service, WAHA sessions, configuration, static location data, migration history, and other server applications were preserved.
- preserved server-only recovery snapshot: `haim-reset-20261004T170039Z.sql`, SHA-256 `7588534407c28ab1f5060ae003ebb75cc8c867fac6e83849d40bd84ff6062800`; it is not a repository artifact.
- post-reset proof: requests, messages, conversations, contacts, media records, Outbox, integration Outbox, conversation turns, and legacy queue jobs were zero; migrations/checksums were then advanced and verified at `24/24`.
- deployment correction: the earlier image had application code for migration 022 while the active schema ended at 021, producing an `ops` queue failure for a missing `last_attempt_at` column. Migration was applied from the service image, then candidate image `haim-bot-core:t24-611a108` was deployed and `/health` returned success.
- post-deploy proof: zero business rows/Outbox/media records, zero failed/retry queue jobs, and zero physical media files in the verified HAIM media volume.
- recovery regression: `611a108183feeb7966613d19f97d87196cfcac02` adds startup reconciliation for committed turns stranded as `processing`; the isolated Linux disposable suite passed, including regressions `26/26` and Golden `52/52`.
- next exact action: use the T24 evidence above as the deployment gate before beginning real WAHA contract checks.

## Current state

- mode: discovery / build completion
- phase: T24 shadow-qualification preparation
- active_work_state: clean reset completed; no live qualification conversation has started
- cycle_id: `qa-live-20260928t1321`
- active_scenario: `request-1`
- scenario_count: `6/8` in the external QA checkpoint before the transition reset; the operational DB is clean and must not be treated as evidence of an additional completed scenario
- candidate_git_sha: `616524f8f069454d1f24b000623bec8b9405d745` (`qa-build`)
- running_image: `haim-bot-core:t24-611a108`
- prompt_id/version: `pmpt_6a9d0c66737881938a0f60f5df9088cb0806a26699929a86` / `23` from `ENV.example`; live prompt availability/evaluation is not yet proven
- database: remote `haim_yahad`, schema `haim_core`; operational counts reconciled to zero after the 2026-10-04 verified clean reset; migrations/checksums `24/24`
- WAHA: `default`, `TAL_ZOLO`, and `HAIM_YAHAD` all reported `WORKING`; identities were verified as `972584152101@c.us`, `972536662043@c.us`, and `972543414386@c.us`

## Last completed milestone

- milestone: Phase 2 — permanent regression registry correction
- verdict: PASS
- evidence:
  - `docs/qa/continuous-qa-log.md` latest transition checkpoint records `self-2=PASS`, `scenario_count=6/8`, and the required clean reset.
  - Remote service inspection reported `1/1` replica and image `haim-bot-core:qa-self-address-floor-20260928`.
  - Remote DB inspection reported `requests=0`, `messages=0`, `outbox=0`, `conversations=0`, `turn_messages=0`, `request_events=0`, `request_counter=0`.
- No pending/uncertain Outbox row exists; the inspected WAHA history contains prior completed QA traffic but no new `request-1` opening matching the attempted send. Therefore no uncertain message is resent and request-1 remains the next live action.

### Phase 1 — canonical contract and invariants

- verdict: PASS
- changed files: `tests/spec/domain-invariants.json`, `tests/spec/scenarios.json`, `tests/spec/invariants.test.mjs`, `scripts/validate-spec.mjs`, `docs/qa/CANONICAL_BEHAVIOR_CONTRACT.md`
- evidence: 34 stable invariant IDs; all 4 declarative scenarios reference known IDs; historical confirmed failures are mapped to invariants; validator and unit suite are green.
- unresolved: permanent defect records and one executable regression record per historical failure are deferred to Phase 2 as required by the plan.

### Phase 2 — permanent regression registry

- verdict: PASS
- correction scope: reopened after independent review; no live WAHA message, live reset, deployment, or live checkpoint mutation was performed.
- changed files: `tests/spec/regression-catalog.json`, `tests/spec/regression-catalog.test.mjs`, `scripts/test-regressions.mjs`, `Dockerfile`, `compose.test.yml`, `.github/workflows/verification.yml`, `artifacts/qa/regression-report.json`, `artifacts/qa/phase-2-verification-20260928.json`
- final regression count: 24 evidence-based records, all `status=covered`, all with stable suite/test identifiers or an executable command reference. The catalog maps all 12 offline probe IDs and separately records materially different journal defects.
- historical defects mapped: unapproved schedule; recipient-fact attribution; direct photo gate; donation PHOTO-FIRST fact loss; self-transfer address/floor loss; direct opening fact loss; unrelated admin `yes`; unauthorized counterparty facts; seeker/donor route confusion; uncertain WAHA no-resend; managed prompt wiring; contact-card identity bounds; explicit `אני זולו` extraction; `אליי`/`אוספים`/`מביאים` aliases; `suppliedPhone()` alias authorization; textual `לא` escalation truthiness; WAHA media persistence/`__x_id`; open donation to direct conversion; managed direct reply reintroducing photo; natural schedule approval; exact cross-chat proposal approval; duplicate open donation; capacity-ten approval; direct-flow no-repeat fact retention.
- executable gate: `pnpm run test:regressions` now compiles tests, executes the complete unit suite (63/63) and integration suite (68/68) on a fresh disposable PostgreSQL database, parses machine-readable TAP results, fails on missing/unexecuted/failed references, runs command references, and writes a per-regression JSON report. The Docker verification target invokes this gate directly.
- gate result: PASS — `REG-001` through `REG-024`; report at `artifacts/qa/regression-report.json`.
- CI: `.github/workflows/verification.yml` now executes the regression gate through `compose.test.yml` and uploads the machine-readable report; no duplicate standalone integration run was added.
- fresh verification evidence: `artifacts/qa/phase-2-verification-20260928.json` records SHA, dirty-state identifier, timestamp, build, unit/integration counts, spec/probe/prompt/regression results, disposable DB identity, and confirmation that live QA was untouched.
- remaining uncovered regression: none identified in the confirmed QA journal after reconciliation. Offline probe audit remains static index validation; behavioral proof is now supplied by the executable unit/integration gate.

## Baseline inventory

- unit test declarations: 63
- integration test declarations: 68
- SQL migrations: 21
- declarative scenarios: 4
- offline probes: 12 (static anchor audit; not behavioral execution)
- CI workflow: `.github/workflows/verification.yml`; Docker disposable PostgreSQL gate plus spec/probe/prompt-wiring audits
- package manager: `pnpm` is available; `npm` is not on the Windows PATH, so the plan's literal `npm` commands were run through the repository-equivalent `pnpm` commands instead

## Test command matrix

| Command | Result | Evidence / note |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | PASS | lockfile-resolved dependencies; no source changes required |
| `pnpm run build` | PASS | TypeScript build completed |
| `pnpm test` | PASS | 63/63 unit tests |
| `pnpm run check:spec` | PASS | 4 scenarios validated |
| `pnpm run check:probes` | PASS | 12 static probes found; no external calls |
| `pnpm run check:prompt-wiring` | PASS | 2 Responses calls use managed prompt ID/version |
| `git diff --check` | PASS with existing LF/CRLF warnings | no whitespace errors |
| `docker compose -f compose.test.yml up --build --abort-on-container-exit --exit-code-from tests` | PASS | disposable PostgreSQL integration suite 68/68 |
| `docker compose -f compose.test.yml down -v --remove-orphans` | PASS | disposable containers, network, and volume removed |
| `npm ci --ignore-scripts` | NOT RUN | `npm` is not available on the host PATH; equivalent pnpm install was used |
| remote OpenAI managed-prompt evaluation | NOT RUN | requires configured remote evaluation authorization/evidence; prompt wiring only is proven |

## Contradictions and reconciliation

1. The Master Plan's orientation counts are stale: the repository currently has 63 unit declarations and 68 integration declarations, not the approximate 62/69 listed in the plan. Current executable counts above are authoritative.
2. The offline-probe audit is static anchor validation, as the plan warns; it is not a behavioral regression suite.
3. The deployed image is an older QA image than the current dirty working tree. It is operationally healthy, but it is not yet an immutable release candidate for qualification.
4. `docs/qa/MASTER_PROGRESS.md` did not exist before Phase 0 and was created by this phase.
5. The latest QA journal contains historical checkpoints from stopped/aborted cycles. The current operational truth was reconciled against the remote DB, Outbox, deployment, and WAHA state before proceeding.

## Defects / blockers

- `BLOCKER-TOOLING`: npm is unavailable on the local Windows PATH. This does not block the equivalent pnpm and Docker gates, but a literal npm reproduction is unavailable.
- `BLOCKER-QUALIFICATION`: no frozen release manifest, pinned remote AI evaluation evidence, targeted WAHA contract evidence, or final-candidate 8/8 qualification exists yet.
- `ACTIVE-LIVE-WORK`: request-1 is the next live scenario in the existing cycle. No new message may be sent until the next execution explicitly starts it under the QA lock; the attempted timed-out send was reconciled against DB and WAHA and was not resent.

## Next exact action

1. Phase 3 is closed. Do not start Phase 4 without the separate authorization and release-candidate decision required by the Master Plan.
2. Preserve the active `request-1` checkpoint; do not reset or resend the timed-out attempt unless a later authorized live phase explicitly resumes execution under the Runbook.

### Phase 3 — Golden Conversation Scenario Runner (closed)

- verdict: PASS
- catalog: 52 scenarios, 26 clean and 26 challenging; `direct_handoff`, `open_donation`, `self_transfer`, `open_request`, `cross_flow`, and `failure_recovery` coverage.
- verification: unit 63/63, integration 69/69, regressions 26/26, Golden 52/52, and `--resume` 52/52. Evidence: `artifacts/qa/phase-3-verification-20260928.json`, `artifacts/qa/golden-report.json`, and `artifacts/qa/golden-run-state.json`.
- harness corrections: reset/reference fixtures, structured planner injection, real-path structured intent, canonical open-request search contract, four-layer assertions, enum validation, forbidden-effect detectors, persistent resume state, and detailed diagnostics.
- product defects fixed and covered permanently: PHOTO-FIRST retains supplied donor facts; known direct recipients accept implicit donation wording without the generic donation question.
- failure classification: no remaining failures; `HARNESS_DEFECT`, `SCENARIO_CONTRACT_DEFECT`, and `PRODUCT_DEFECT` queues are empty in the final evidence.
- safety: no WAHA calls, no live DB reset, no deployment, and no live checkpoint mutation were performed for Phase 3. Phase 4 was not started.

### Phase 3 exit criteria

- [x] Golden catalog reconciled to 52 scenarios and canonical contracts.
- [x] All 52 scenarios pass with strict conversation, DB/business, effects, and forbidden-effect checks.
- [x] Reference data is reseeded/verified after every disposable reset.
- [x] Structured planner fixtures and structured intent observability are used; no Hebrew parsing occurs in FakePlanner.
- [x] Persistent state and compatible `pnpm run test:golden -- --resume` are verified.
- [x] New permanent regression records REG-025 and REG-026 pass in the disposable regression gate.
- [x] Evidence and diagnostics are persisted; live systems remain untouched.

### Boundary

Phase 3 is closed. Phase 4 has not started and must not be started without the separate authorization and release-candidate decision required by the Master Plan.

### Phase 3.1 — Golden Harness Hardening (review-ready)

- verdict: correction required by independent review is complete; Phase 4 not started.
- authorized scope: strict exact reply-intent matching, executable forbidden detectors for `ask_photo`/`ask_address`/`ask_name`, stronger stale-plan/wrong-party/uncertain-send checks, business/DB assertions, bounded scenario and step timeouts, and real `processNext()` burst/coalescing coverage.
- gates from the disposable run: unit 63/63, integration 69/69, regressions 26/26, Golden 52/52. The Golden catalog remains 52 scenarios (26 clean, 26 challenging) and the resume state remains compatible.
- important contract correction: donor-only/open-donation scenarios require a donor fact; direct handoff and self-transfer require donor and receiver facts. The harness does not reintroduce the previous `ask_details` wildcard.
- environment safety: disposable PostgreSQL and `FakeChannel` only; no live WAHA, live DB reset, deployment, or Phase 4 work.
- evidence: `artifacts/qa/phase-3.1-verification-20260928.json`, `artifacts/qa/golden-report.json`, `artifacts/qa/golden-run-state.json`, and `artifacts/qa/regression-report.json`.
- correction: track `tests/fixtures/qa-synthetic-bed-20260928.png` so the Golden suite is self-contained in GitHub Actions; remove the duplicate dead `schedule_without_both_approvals` switch case. CI must pass on the new pushed SHA before Phase 3.1 is resubmitted.
- correction verification: commit `46c39cd01b11ddc0120bde6e6d31ad4bb5e102a4` passed GitHub verification workflow run `36460098253`; fixture SHA-256 is `A3111C75088F63E9B329B7EF37402AB992C958602BE4702BFA1B60FFE4CF3C4A`.
- coordination: `scripts/qa-review-watcher.ps1` and `docs/qa/COORDINATION_LOOP_V2.md` implement the reusable reviewer-wait protocol without live-system access.
- coordination-loop correction: the watcher is now a real persistent orchestrator that detects `codex --version`, invokes non-interactive `codex exec` only for an exact-SHA new directive, persists state, enforces a single-instance lock, verifies post-run Git convergence/CI, and remains alive. Self-test: `QA_REVIEW_ORCHESTRATOR_SELFTEST PASS`.
- latest Phase 3.1 correction verification: executable forbidden-effect detector suite passes `6/6`, covering prohibited and safe states for `stale_ai_plan_commit`, `wrong_party_notification`, and `blind_retry_after_uncertain_send`; `direct-clean-01` step 2 proves stored location facts remain present and the reply contract is verification-only with no `ask_address_again`. Full disposable gates: unit `63/63`, integration `69/69`, regressions `26/26`, Golden `52/52`, resume `52/52`. Evidence: `artifacts/qa/phase-3.1-verification-20260928.json`, `artifacts/qa/golden-report.json`, and `artifacts/qa/regression-report.json`.

### Persistent GitHub checkpoint rule

- The persistent source of truth for build-completion and QA work is GitHub branch `qa-build` in `zolo0548152101-afk/ZOLO`.
- At every phase boundary, before independent review: run the required gates, update this file and machine-readable evidence, inspect staged content for secrets/runtime-only data, commit the exact verified state, and push `qa-build`.
- Never push `.env` values, API keys/tokens, WAHA authentication or session data, `node_modules`, database/runtime volumes, downloaded media, or credentials.
- A push is not a deployment. Deployment remains separately authorized only by the applicable phase.
- Do not begin the next phase until the verified phase commit is present on `origin/qa-build`.

### Phase 4 — T18 Safe Admin Boundary

- status: correction complete; independent review requested; T19/T20 not started.
- baseline commit: `05bdd5ce61a27243a4b69623f3448380e59c7c71`.
- source commit: `1a42e23c0784845c651419c2e5e9b42997a7cc08`.
- implementation: capability is derived only from server-configured credentials (`HAIM_ADMIN_TOKEN`, optional distinct read-only/destructive tokens); the caller-controlled `x-admin-capability` header cannot escalate. All successful named admin mutations now emit complete operation/timestamp/actor/capability/target/result audit records. Generic database PATCH/DELETE remains unavailable server-side. The disposable Docker verification stage now runs full integration, resets all disposable application and pg-boss schemas, then runs regressions and Golden.
- focused verification: PASS — unit `64/64`; duplicate non-empty capability credentials fail closed, and the full Linux integration run includes complete audit-contract assertions for normal and destructive mutations.
- full disposable Linux integration: PASS — `71 passed, 0 failed, 0 cancelled`.
- regression gate: PASS — `26/26`, `12` probes.
- Golden gate: PASS — `52/52` scenarios; forbidden-effect detector `6/6`.
- other gates: build, spec, prompt-wiring, migration/FK/checksum, diff check, and secret scan PASS.
- evidence: `artifacts/qa/t18-safe-admin-verification.json`.
- safety: no deployment, production access, live WAHA, live DB, or real messages; T19/T20 not started.

### Phase 4 — T19 Integration Outbox Dispatcher

- status: correction complete; independent review requested; T20 not started.
- authorized baseline commit: `42858e597656fcc452d0a66ca09f52bb1ea7af9b`.
- source commit: `570d97af357e1c284b81a456b681315194346afa`.
- implementation: durable `pending`/`active`/`delivered`/`dead_letter` state machine; stale-active lease recovery plus periodic due-pending recovery; bounded retry with retryable/terminal/ambiguous classification; stable idempotency keys; atomic claim and per-integration ordering; versioned event envelope with delivery keys; enabled-only enqueue; adapter boundary with timeout signal; same-transaction normal-admin terminal replay scheduling; bounded metrics/details and operations stuck/dead-letter signal.
- verification: build PASS; unit `64/64`; disposable PostgreSQL integration `76/76`; regressions `26/26` with `12` probes; Golden `52/52`; spec, prompt wiring, migration, FK/checksum, diff and secret gates PASS.
- evidence: `artifacts/qa/t19-integration-dispatcher-verification.json`.
- safety: no deployment, production/server/SSH/EasyPanel access, live WAHA/DB, real messages, or external integration calls; T20 not started.

### Phase 4 — T20 Legacy Sheets Import and Reconciliation

- status: correction implemented, canonical gates passed, and independent review requested; T21+ not started.
- authorized baseline: `8d4b8e0dcc83e52ee3f1f6cd94452b9a8e1e6fe6`.
- correction scope: actual business-row reconciliation (not counts only), Tuesday/missing-timestamp/destination-identity validation, required quantity and description bounds, consistent supplied-run FK preflight, separate contact/party lineage, importer-owned-contact rollback, truthful dry-run-to-apply metadata, fail-closed apply reconciliation, and a 30-row executable case matrix.
- verification: unit `64/64`; disposable PostgreSQL integration `76/76`; T20 importer `30/30` exact original acceptance requirements plus additional assertions; regressions `26/26`; Golden `52/52`; typecheck, migration/FK/checksum, mapping, diff and secret gates PASS.
- source commit: `43d16978ac09ede1ad0db5ea5581d668c8d8c21b`.
- migrations: `db/migrations/023_sheets_import_lifecycle.sql` SHA-256 `7c2a06d94f8ed5549247609f53a778c0e214f2b5f9be7da22adbeca7a584fce1`; `db/migrations/024_sheets_import_apply_metadata.sql` SHA-256 `f9d732fc9a328be92919242f895939780a675634143f2d992a295c7ec5725d88`; foreign-key failures `0`.
- evidence: `artifacts/qa/t20-sheets-import-verification.json` (bound to the exact correction source SHA); `docs/qa/T20_SHEETS_IMPORT.md`; the exact original 1–30 acceptance matrix is included in the evidence artifact, with additional low-level assertions kept separately.
- safety: no Google/API access, no server/SSH/EasyPanel, no live WAHA/DB, no external calls, no deployment, no real messages, no PR merge; T21+ not started.

### Phase 4 — T21/T22 Observability and Hardening

- status: review corrections complete; source and evidence-only handoff pushed; independent review requested.
- authorized baseline: `d1cda7959bf18df9e98b26a8b0971d27970c7f28`.
- verified source commit: `560ab5a82db838344002cbef3abbca06f63a33aa`.
- T21: `/admin/metrics` now exposes bounded operational signals for inbox/outbox backlog and age, uncertain/retrying/dead-letter delivery, stale leases, FIFO blockers, prompt failures, and Sheets review-required batches. SLO defaults and operator actions are documented as configurable test/operator defaults.
- T22: production/live admin token strength is fail-closed; capability tokens remain distinct; admin audit fields are recursively redacted; mutation rate/same-origin controls remain enforced; rotation overlap is simulation-only; backup drill requires disposable local targets and verifies PostgreSQL/media/configuration manifest components.
- review corrections: backup media is seeded at and resolved through the exact database storage key with checksum/size verification; source/target database identity is normalized by host, port, and database before restore; diagnostic redaction covers authorization Bearer, standalone Bearer, and key/value forms.
- verification: build/typecheck PASS; unit `64/64`; targeted T21/T22 `5/5`; disposable PostgreSQL integration `76/76`; Sheets importer `30/30`; regressions `26/26` and probes `12/12`; Golden `52/52`; migration/FK/checksum and secret/privacy gates PASS; backup/restore drill PASS with isolated disposable PostgreSQL 17.11 source/target, normalized distinct database identity, exact storage-key media resolution with checksum/size verification, target-side HAIM state/media/config verification, and RPO 60/RTO 30 test defaults. GitHub verification runs `37206883702` and `37206881161` passed on the exact source SHA.
- evidence: `artifacts/qa/t21-t22-verification.json`; `docs/qa/T21_T22_OBSERVABILITY_HARDENING.md`; evidence-only handoff follows source commit.
- safety: no deployment, production/server/SSH/EasyPanel access, live WAHA/DB, real messages, real secret rotation, real backup storage, Google API/real Sheet, or T23+ work.

### Phase 5 — T23 Remote Prompt Evaluation

- status: remote evaluation PASS; service deployment blocked pending explicit admin-token rotation.
- verified source: `ede77a05c1976f66a2b9560a5fc4b07b3886e896`.
- remote prompt: version `23`; 8/8 synthetic Hebrew/multi-message/notice cases passed; all provider response IDs were present; forbidden operational claims `0`.
- safety: the evaluator forced `NODE_ENV=test`, `BOT_MODE=simulation`, and `DB_SCHEMA=haim_core_sim`; it did not access the HAIM database, WAHA, or any channel adapter.
- deployment evidence: the service update automatically rolled back because its existing `HAIM_ADMIN_TOKEN` has length `4` and the T22 production validation rejects it. The rollback image `haim-bot-core:qa-self-address-floor-20260928` is healthy (`/health` 200). No persistent data or WAHA configuration changed.
- evidence: `artifacts/qa/t23-remote-prompt-eval.json`.
