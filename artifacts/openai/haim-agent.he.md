# HAIM agent prompts (split — hebrew-chatbot-builder two-call flow)

Production uses two repo-owned prompts sent as Responses API `instructions` every turn:

1. **Write (classify + tools):** [`prompts/haim-write.he.md`](haim-write.he.md) — `stage=write`, function tools, history + current_message. Customer `reply` from this call is ignored.
2. **Phrase (WhatsApp wording):** [`prompts/haim-phrase.he.md`](haim-phrase.he.md) — `stage=phrase` / `mode=customer_reply` (or `notice_to_counterparty`), no tools, history + this_turn.

This matches skills-il/hebrew-chatbot-builder: keep classification/write and response generation as two calls; buffer the full WhatsApp reply; treat user text as untrusted (OWASP LLM01).

Do not edit a single combined prompt for runtime. Edit `haim-write.he.md` and `haim-phrase.he.md` instead.
