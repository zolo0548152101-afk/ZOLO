# CODEX Execution Policy — HAIM / ZOLO

This file is the persistent execution policy for Codex work on the HAIM / ZOLO repository.

Repository: `zolo0548152101-afk/ZOLO`
Working branch: `qa-build`
Review surface: PR #2

The purpose of this file is to keep permanent process and safety rules in one place. Individual PR directives should describe only the active work unit, its baseline, requirements, tests, and terminal response.

## 1. Instruction precedence

When instructions differ, use this order:

1. An explicit current owner instruction.
2. The latest applicable reviewer/work-unit directive in PR #2.
3. This file.
4. Repository plans/runbooks/docs.
5. Older PR comments.

A `REVIEW_PASS` closes the reviewed work unit. It does not by itself authorize the next work unit, deployment, live-system access, infrastructure discovery, or PR merge.

Never infer authorization from an older phase, from repository state, or from the fact that a previous task passed.

## 2. Work-unit lifecycle

The normal flow is:

```
Reviewer/owner directive
        ↓
Codex Implementer — single session/agent
        ↓
implementation + targeted tests
        ↓
canonical final gates
        ↓
commit + push qa-build
        ↓
Txx_READY_FOR_REVIEW
        ↓
STOP
        ↓
separate independent review session
        ↓
REVIEW_PASS or REVIEW_CHANGES_REQUIRED
```

If review returns `REVIEW_CHANGES_REQUIRED`:
- fix only the requested findings unless a tightly related defect must be corrected for correctness;
- rerun the required verification;
- commit/push;
- publish the same work unit's `Txx_READY_FOR_REVIEW`;
- stop again.

Do not begin the next work unit until a new explicit directive authorizes it.

## 3. Single-agent execution

For implementation work:

- single agent only;
- no subagents;
- no reviewer subagent;
- no parallel agents;
- no `spawn_agent`;
- no delegated coding/review agent;
- no automatic model switching;
- no automatic escalation to a stronger model;
- no automatic whole-work-unit retry.

Independent review is a separate Codex run/session, not a child agent of the implementer.

If a task cannot be completed safely in the current session, report the blocker and stop.

## 4. Git and baseline safety

Every work unit must name an authorized baseline SHA.

Before editing:

1. run `git status --porcelain`;
2. if the worktree is unexpectedly dirty, stop and report; do not reset, stash, discard, overwrite, or delete unknown work;
3. fetch the remote;
4. fast-forward `qa-build` only;
5. verify the exact authorized baseline SHA.

If the actual repository state differs from the authorized baseline in an unexpected way, stop and report instead of guessing.

Do not rewrite history, force-push, reset shared work, or merge PR #2 unless explicitly authorized.

At completion:
- inspect the complete diff;
- run `git diff --check`;
- verify no secrets/runtime-only data/unrelated changes;
- commit the verified state;
- push `qa-build`;
- report the exact resulting SHA.

## 5. Scope discipline

Work only inside the currently authorized work unit.

Do not silently:
- start the next T-number;
- perform unrelated refactors;
- add infrastructure work to a code task;
- turn a read-only task into a mutation task;
- deploy because tests passed;
- perform live verification because local/CI verification passed.

If a newly discovered defect is outside scope and is not required to safely complete the current work unit, record it under remaining known items and stop/continue according to the active directive.

## 6. Verification discipline

Use targeted tests while developing. Avoid repeatedly running expensive full suites after every edit.

Before a work unit is submitted for independent review, run the canonical gates required by that directive and record actual observed results, not historical counts.

Where applicable, canonical verification includes:
- build/typecheck;
- unit tests;
- disposable PostgreSQL integration;
- regression suite;
- Golden suite;
- Golden resume when required by the work unit;
- spec validation;
- prompt wiring;
- migration/schema checks;
- `git diff --check`.

CI is evidence, but do not claim a gate passed unless its actual relevant command/result was observed.

Tests must not use production data or live services unless a separate explicit live-system work unit authorizes it.

## 7. Reporting

PR #2 is the primary reviewer communication surface.

At every terminal state post a complete PR #2 comment with one of the exact applicable markers, for example:
- `Txx_READY_FOR_REVIEW`
- `Txx_BLOCKED_...`
- `REVIEW_PASS`
- `REVIEW_CHANGES_REQUIRED`

When repository edits are already authorized, also replace:

`artifacts/qa/CODEX_LATEST_HANDOFF.md`

with the latest substantive handoff.

The handoff should include:
- timestamp;
- work unit;
- status;
- baseline SHA;
- resulting/current SHA;
- branch;
- changed files;
- exact tests/commands and observed results;
- blockers/errors;
- safety confirmations;
- next reviewer action requested.

If blocked before repository edits are permitted because of unsafe local state/baseline mismatch, report to PR #2 only and leave the worktree untouched.

Do not wait for the user to manually relay Codex output to the reviewer.

## 8. Secrets and sensitive data

Never commit, print into evidence, or publish in PR comments:
- API keys;
- admin tokens;
- WAHA credentials/session secrets;
- database passwords;
- private SSH keys;
- cookies/auth headers;
- production environment files;
- runtime media/private user data.

Use placeholders/test-only values in fixtures.

Logs and evidence must redact credentials and sensitive headers.

## 9. Live-system boundary

Unless the active work unit explicitly authorizes otherwise, do not access or mutate:
- production;
- live HAIM database;
- live WAHA;
- real WhatsApp recipients;
- Ubuntu server;
- SSH;
- deployment infrastructure;
- firewall;
- DNS;
- external production integrations.

A successful build/test/review does not authorize live access or deployment.

## 10. EasyPanel and HAIM infrastructure policy

EasyPanel is not part of HAIM development, testing, deployment, or operations.

EasyPanel is reserved for the owner's unrelated personal services.

Intended future HAIM model:

```
GitHub
  ↓
verification / CI
  ↓
verified revision or versioned Docker image
  ↓
direct Ubuntu server management
  ↓
Docker Compose stack
  ↓
one explicit systemd lifecycle service
  ↓
HAIM
```

This policy does not authorize migration, takeover, deployment, restart, server discovery, or removal from EasyPanel.

### Read-only discovery first

Before any future HAIM infrastructure migration/change, a separate work unit must explicitly authorize read-only discovery.

Discovery must identify:
- Ubuntu host identity;
- exact HAIM project path;
- currently deployed HAIM revision/version;
- HAIM containers and images;
- Compose project/files;
- systemd units;
- HAIM networks;
- HAIM volumes;
- HAIM database service/database/schema;
- persistent media/storage paths;
- whether EasyPanel creates, labels, owns, configures, restarts, or otherwise manages HAIM resources;
- unrelated server resources that must remain out of scope.

During read-only discovery do not:
- stop/restart/recreate services;
- deploy;
- edit configuration;
- change environment variables;
- run migrations;
- modify Compose/systemd;
- remove containers/images/volumes/networks;
- reset or modify databases;
- modify firewall rules;
- run Docker prune commands;
- change EasyPanel configuration.

### Single lifecycle owner

HAIM must have exactly one lifecycle manager.

If HAIM is currently managed by EasyPanel:
- stop after discovery;
- do not detach it;
- do not replace/recreate it with Compose;
- do not disable EasyPanel management;
- do not create a competing systemd/Compose lifecycle;
- report ownership and propose a migration plan.

Migration requires separate explicit owner authorization.

After an approved migration:
- Docker Compose is the single HAIM stack definition;
- one dedicated systemd service may control that Compose lifecycle;
- GitHub is the source of truth for revisions;
- deployments use verified revisions/images;
- persistent data is preserved;
- every deployment has a documented rollback target;
- HAIM resources are clearly namespaced away from unrelated services;
- ad-hoc `docker run` is not the permanent deployment model.

## 11. Deployment policy

No code-review, policy, or implementation task implicitly authorizes deployment.

A deployment requires its own explicit work unit.

Before any future mutating server operation, positively identify:
- target service/container;
- image/revision;
- Compose project;
- volumes;
- database/schema;
- expected effect;
- rollback path.

If ownership is ambiguous, stop and report.

Never modify unrelated containers, networks, volumes, databases, systemd services, EasyPanel applications, or firewall configuration.

A future deployment must:
1. use a revision that passed required verification;
2. identify the currently deployed revision first;
3. preserve persistent data;
4. have a rollback target;
5. verify health after deployment;
6. avoid destructive database operations unless explicitly authorized;
7. avoid live WAHA/session changes unless explicitly authorized.

## 12. Review role

The implementer must not review itself through a spawned agent.

Independent review should use a fresh session and inspect:
- exact baseline and resulting SHA;
- diff;
- requirements;
- test/evidence results;
- CI where relevant;
- safety/scope adherence.

Reviewer output is:
- `REVIEW_PASS`, or
- `REVIEW_CHANGES_REQUIRED`.

The reviewer should not start the next implementation work unit unless it also posts a separate explicit directive.

## 13. Default stop conditions

Stop and report instead of improvising when:
- working tree contains unexplained changes;
- baseline does not match;
- ownership of a server/container/volume/database is ambiguous;
- an instruction would require production/live access not explicitly authorized;
- a destructive action is not explicitly authorized;
- required credentials/configuration are unavailable;
- a real external side effect would be needed for a task defined as disposable/offline;
- a requested action conflicts with this policy and no newer explicit owner directive supersedes it.

The governing principle is: verified progress, explicit authorization, one work unit at a time, one lifecycle owner per live service, and no hidden side effects.
