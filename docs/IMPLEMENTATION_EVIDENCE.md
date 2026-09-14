# Evidence — dependency plan

Updated after the latest clean Docker verification run.

| Task | Evidence | Status |
|---|---|---|
| T01 | Canonical scenario/spec fixture in `tests/spec/scenarios.json` plus `scripts/validate-spec.mjs` | validator passed for 4 canonical scenarios |
| T02 | Unit and integration regression coverage for the 12 probes | `scripts/audit-offline-probes.mjs` passed 12/12 named anchors; unit/integration regression suite passed |
| T03 | Disposable PostgreSQL 17 + pg-boss compose run; migrations twice; teardown | Two consecutive clean Docker verification runs passed; `.github/workflows/verification.yml` runs the same disposable check and always tears down |
| T04 | Managed action translation is explicit; unknown truthy actions are rejected; duplicate-plan integration coverage | complete |
| T05 | Domain/outbox side-effect claim guard; unsupported operational claims are recorded as `prompt_claim_rejected` | verified in 32 integration tests |
| T06 | `008_verification_state.sql` adds per-party verification states and conservative legacy backfill | migration and full integration suite pass; outbox receipt projection is covered by T12 |
| T07 | Direct/open-donation requirement gates: direct skips photo/condition/disassembly; open donation remains PHOTO-FIRST | covered by unit and integration regression cases |
| T08 | Explicit `clarify_duplicate` command prevents silent duplicate request creation | dedicated integration test passed |
| T09 | `conversation_turns` + `turn_messages` durably link a quiet-window burst before coalescing; 3-message order survives | dedicated integration test passed; 44-test suite green |
| T10 | Newer message supersedes an in-flight AI turn without an old outbox reply; audit event records successor | delayed-AI integration test passed |
| T11 | Startup recovery now requeues unresolved `contact_id IS NULL` messages into ingest before readiness | TypeScript/build verified; live startup not run |
| T12 | Versioned outbox delivery receipt projection plus monotonic admin receipt endpoint | acceptance/delivery/downgrade integration test passed |
| T13 | AI notice formatting is post-commit; outbox `format_state=pending` blocks send until formatting/fallback completes | integration test proves counterparty notice is `FORMATTED`, `ready`, and still pending channel delivery; full build and integration suite passed |
| T14 | Versioned `location_datasets`/`streets` tables with approved Beit Shean aliases and active-dataset lookup | official data.gov.il snapshot staged at 244 rows with checksum; disposable-DB integration test loaded it, resolved normalized `הרצל` and aliases, then rolled back; activation script remains explicit-approval gated |
| T15 | Request loader and status projection now retain role-specific coordinates and render authorized map links | build + integration suite passed; live WhatsApp retrieval not run |
| T16 | Authenticated media retrieval endpoint, checksum-preserving storage path, and explicit backup/restore drill | media retrieval integration assertion passed; disposable PostgreSQL backup/restore drill passed with checksum row verification |
| T17 | Status/admin path reads request data and verification-state projection without AI | exact `#פניות לחיים יחד` integration test passed read-only, returns every request, and makes no AI call; full production admin UX not opened |
| T18 | Admin edits remain table/field allowlisted with destructive confirmation and audit | auth/admin boundary test verifies legacy mapping fields are visible; integration test persists approved fields, rejects `closed_at`, and proves exact-confirmation clear-all; live mode hides and rejects clear-all |
| T19 | Integration outbox queue, startup recovery and idempotent adapter dispatcher added; no adapter enabled by default | durable enqueue integration test passed; build + integration suite passed; external adapter delivery intentionally not run |
| T20 | Sheets CSV staging validates headers, hashes and duplicates without writing business tables | mapping/schema validators and reconciliation dry-run pass 28 columns, required fields, phones, duplicate request numbers, media/location counts; business import remains a separate reviewed gate |
| T21 | Heartbeat now signals blocked queues, uncertain sends, overdue media and overdue notice formatting | build + integration suite passed |
| T22 | Live configuration gates, shadow/simulation isolation, secret-free logs/runbook and restore procedure documented | static/build evidence; secret rotation/restore drill still operator-gated |
| T23 | Paid remote prompt evaluator is opt-in (`RUN_PAID_AI_EVAL=true`) and isolated from DB/channel | offline evaluator contract validates 8 golden cases and forbidden-claim coverage; remote call not executed |
| T24 | Four-case shadow harness refuses live/remote targets and checks processed simulation outbox | four independent durable shadow coordination flows passed in integration; HTTP harness passed against local compose shadow and every outbox row was `simulation` |
| T25 | Release runbook defines allowlist, rollback, snapshot and no-live-default gates | verifier passed in shadow mode and correctly rejected live mode with missing operator/snapshot/allowlist/dependency/media/schema/location/prompt/Sheets gates; canary deliberately not run |

## Latest verification

- Docker image build: passed; TypeScript build and unit suite passed inside the image.
- Canonical scenario validator: 4/4 scenarios passed, including direct no-photo and open PHOTO-FIRST invariants.
- Offline probe audit: 12/12 named regression anchors passed; no external calls.
- Prompt wiring validator: planning and counterparty-notice formatting both use the configured OpenAI Responses managed prompt ID/version; no paid call was made.
- PostgreSQL integration suite: 44 tests, 44 passed, 0 failed after official snapshot activation/rollback coverage and clear-all guards.
- Repeatability: two consecutive clean PostgreSQL 17 Docker runs each passed 44/44 and removed their containers, network, and volume.
- Official location staging: 244 בית-שאן rows, 5 approved aliases, checksum `30c41e1a456964957e293589322d6d4462e1e174398ce2698fa931efea5a8a2a`; activation command refused without explicit operator approval.
- Local HTTP shadow E2E: 4/4 cases processed; 0 live sends; all observed outbox rows were `simulation`.
- Release gate verifier: non-live exit 0; live exit 1 with every required live gate reported missing, including location dataset, remote prompt evaluation, and Sheets reconciliation; verifier performs no deploy, migration, or send.
- Disposable restore drill: custom-format dump restored into a separate temporary database; checksum probe matched; containers and temporary dump removed afterward.
- Test database: disposable compose volume removed after the run.
- Production, browser, WAHA live send, and remote OpenAI call: not performed in this evidence run.

## Important boundary

T06 is an expand/dual-write step. The legacy boolean is retained for compatibility until receipt truth is completed in T12; it must not be interpreted as provider delivery.
