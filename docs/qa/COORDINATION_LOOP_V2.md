# Persistent Coordination Loop v2

The persistent coordination channel is GitHub repository `zolo0548152101-afk/ZOLO`, branch `qa-build`, PR #2, and Issue #1.

After each authorized work unit:

1. Run the required gates and update `MASTER_PROGRESS.md` plus machine-readable evidence.
2. Inspect staged paths for secrets, credentials, WAHA sessions, database volumes, runtime media, and `.env` values.
3. Commit and push `qa-build`.
4. Post `READY_FOR_REVIEW` to PR #2 with the exact full pushed SHA.
5. Open the designated ChatGPT coordination conversation and send exactly one `CODEX_READY_FOR_REVIEW` message for that SHA.
6. Start `scripts/qa-review-watcher.ps1` with that exact full SHA. This is a persistent local orchestrator, not a one-shot printer: it owns a single-instance lock, persists the current SHA/comment/status, invokes `codex exec` on a matching directive, verifies convergence and required CI, then returns to polling.

The orchestrator polls PR #2 approximately every 60–90 seconds and accepts only a new top-level comment whose first line is `REVIEW_PASS`, `REVIEW_CHANGES_REQUIRED`, or `REVIEW_BLOCKED`, and whose `reviewed_sha` exactly equals the submitted SHA. It ignores READY comments, old comments, duplicate comments, and directives for another SHA. A matching changes-required directive resumes only the requested work; a matching pass authorizes only its explicitly named next work unit; a matching blocked directive stops product work.

The orchestrator state records `last_submitted_sha`, `last_processed_review_comment_id`, `current_phase`, `current_work_unit`, and `current_status`. It detects the `codex` CLI before starting, uses non-interactive `codex exec` for a matching directive, and performs a post-run `git status`/HEAD-vs-origin convergence check plus exact-SHA verification CI when the directive requires it. `-DryRun -Once -FixtureCommentsPath` provides a harmless executable self-test and does not invoke Codex. `-Once` is also useful for diagnostics; normal operation keeps the process alive after each Codex run. The orchestrator never deploys, sends WAHA messages, changes the live DB, or exposes secrets.

The single-instance lock is released by process exit, and the state file is runtime-only and must not be committed.
