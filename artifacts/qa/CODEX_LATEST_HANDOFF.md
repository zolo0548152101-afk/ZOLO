# CODEX LATEST HANDOFF

work_unit: T23 remote prompt evaluation
verified_source_sha: ede77a05c1976f66a2b9560a5fc4b07b3886e896
branch: qa-build
status: remote_eval_pass_deployment_blocked

## Evidence

- `artifacts/qa/t23-remote-prompt-eval.json`: PASS, 8/8 cases, 0 forbidden operational claims.
- `docs/qa/MASTER_PROGRESS.md`

## Verified gates

- prompt-eval contract: PASS (9/9)
- prompt-eval config: PASS (8 cases)
- build/typecheck: PASS
- unit: PASS (64/64)
- spec, probes, and prompt wiring: PASS
- remote managed prompt: PASS (8/8); every response included a provider ID

## Safety and blocking deployment condition

- evaluation mode was synthetic only; database, WAHA, channel adapter, and real messages: false.
- a service deployment was attempted only after image build. Swarm rolled it back automatically because the active production `HAIM_ADMIN_TOKEN` is length 4 and the T22 production policy rejects it.
- the rollback image `haim-bot-core:qa-self-address-floor-20260928` is healthy at `/health` (200); persistent media and runtime integrations were not altered.
- next action requires explicit approval to rotate the server-side admin token to a strong secret (stored only in the service configuration and never printed), then repeat the bounded deployment preflight.
