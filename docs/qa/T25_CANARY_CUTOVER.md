# T25 — Canary allowlist and staged cutover

T25 defines a fail-closed release qualification boundary. The repository
defaults to `BOT_MODE=shadow`; the default gate performs no deployment, WAHA
send, database mutation, or external side effect.

## Live gate

Live canary traffic requires all of the following: explicit operator approval,
a named pre-release DB/media snapshot, exactly the two authorized test
identities (`0584152101` and `0536662043`), verified WAHA/API dependencies,
the `haim_core` schema, confirmed media storage, an activated versioned
location dataset, passing pinned-prompt evidence, and a QA data-scope record.
The bot identity `0543414386` is not a recipient allowlist entry.

Run `npm run check:t25-release` for the side-effect-free default check. The
gate normalizes local and `972` phone forms before exact allowlist comparison.

## Qualification and pause gates

The four required canary flow classes are direct handoff, open donation,
self-transfer, and open request. Each must have inbound, outbound, delivery,
status, and zero-gap reconciliation evidence. A missing proof fails the gate.
Traffic pauses between stages; expansion requires fresh evidence and explicit
operator approval.

## Rollback

On a failed canary, stop new sends/workers, preserve inbox/outbox/provider
receipts and the pre-release snapshot, and route traffic back to the previous
verified revision. Rollback does not delete data. The current implementation
and tests are shadow-only; no live canary was run by this work unit.
