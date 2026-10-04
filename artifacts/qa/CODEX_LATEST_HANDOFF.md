# CODEX LATEST HANDOFF

phase: 4 / T18 safe-admin correction only
baseline_commit: 05bdd5ce61a27243a4b69623f3448380e59c7c71
source_commit: ebb404616e1389fc93b49620faa36851de6b6748
evidence_commit: pending (this file is committed in the evidence-only handoff)
branch: qa-build
push_success_before_handoff: pending
working_tree_before_handoff: clean

## Scope and implementation

- Capability is server-authorized by configured credentials only; `x-admin-capability` is ignored for authorization and forged escalation attempts are rejected.
- Read-only, normal, and destructive credentials are distinct capability identities; destructive operations require the destructive credential plus exact test-only confirmation and remain blocked in production/live mode.
- Every successful admin mutation covered by the named routes emits audit evidence containing operation, timestamp, actor, capability, target, and result.
- Generic database PATCH/DELETE mutation paths remain unavailable server-side; database inspection advertises no editable fields.
- Docker disposable verification now runs full integration, resets `haim`, `haim_core_test`, and `haim_core_test_jobs`, then runs regressions and Golden in Linux.
- No T19/T20 work, deployment, production access, live WAHA, live DB, or real messages.

## Gates

- `pnpm run build`: PASS
- `pnpm test`: PASS (63/63)
- Linux disposable integration: PASS (71/71; 0 failed; 0 cancelled)
- regressions: PASS (26/26; 12 probes)
- Golden: PASS (52/52; forbidden-effect detector 6/6)
- migrations: PASS on fresh disposable PostgreSQL schema
- foreign keys: PASS (0 failures; 41 FK constraints observed)
- schema checksums: PASS (21 checksum rows observed)
- `pnpm run check:spec`: PASS
- `pnpm run check:prompt-wiring`: PASS
- `git diff --check`: PASS (only existing LF/CRLF normalization warnings)
- secret scan: PASS; no credentials, runtime volumes, media, or secrets staged

## Evidence

- `artifacts/qa/t18-safe-admin-verification.json`
- `docs/qa/MASTER_PROGRESS.md`
- `src/application/admin-service.ts`
- `src/config.ts`
- `src/http.ts`
- `tests/integration.test.ts`
- `Dockerfile`

## Next action

Wait for the independent reviewer directive on PR #2. Do not start T19/T20.
