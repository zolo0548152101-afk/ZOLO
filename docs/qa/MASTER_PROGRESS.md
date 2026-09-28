# Master Progress

## Current state

- mode: discovery / build completion
- phase: 3 (closed; stopped at Phase 4 boundary)
- active_work_state: scenario (reconciled; no live request-1 message is present in DB or the inspected WAHA history)
- cycle_id: `qa-live-20260928t1321`
- active_scenario: `request-1`
- scenario_count: `6/8` in the external QA checkpoint before the transition reset; the operational DB is clean and must not be treated as evidence of an additional completed scenario
- candidate_git_sha: `c8d243784a2c2a6b7d590a8039b3f0722754ee79` (`main`, 17 commits ahead of `origin/main`); working tree contains preserved user changes
- running_image: `haim-bot-core:qa-self-address-floor-20260928`
- prompt_id/version: `pmpt_6a9d0c66737881938a0f60f5df9088cb0806a26699929a86` / `23` from `ENV.example`; live prompt availability/evaluation is not yet proven
- database: remote `haim_yahad`, schema `haim_core`; operational counts reconciled to zero after the last verified clean reset
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
