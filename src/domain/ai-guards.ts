/**
 * False-information guard. Customer WhatsApp wording is always AI-authored.
 * AI failure / outage must never send a code-authored customer line — silence
 * only (ops alert + human handoff). Claim-guard failures re-ask the phrase
 * model (guard_feedback / safe_mode), never substitute a canned Hebrew sentence.
 */

/**
 * @deprecated Never send to customers. Ops / localization legacy only.
 * AI down = silence, not this string.
 */
export const OUTAGE_REPLY =
  "יש תקלה זמנית במערכת. נחזור אליך בהקדם.";

/**
 * @deprecated Never send to customers. Legacy marker for tests / old call sites.
 * Claim failures must re-phrase via the AI, not this string.
 */
export const GUARD_FALLBACK_REPLY =
  "קיבלתי את ההודעה. נמשיך מהנקודה הבאה.";

/** @deprecated Use OUTAGE_REPLY. Kept as alias for older call sites. */
export const FAULT_REPLY = OUTAGE_REPLY;

/** @deprecated Unclear turns are now answered by the reply manager. */
export const CLARIFY_REPLY = GUARD_FALLBACK_REPLY;

const SELF_INTRO = /סוכן האוטומטי|בהרצה ניסיונית/;

export function conversationAlreadyIntroduced(
  history: { role: string; content: string }[],
): boolean {
  return history.some(
    (entry) => entry.role === "assistant" && SELF_INTRO.test(entry.content),
  );
}

export function isSelfIntroText(text: string): boolean {
  return SELF_INTRO.test(text);
}

export function stripRepeatedSelfIntro(
  text: string,
  history: { role: string; content: string }[],
  alreadyIntroduced = conversationAlreadyIntroduced(history),
): string {
  const raw = text.trim();
  if (!raw || !SELF_INTRO.test(raw) || !alreadyIntroduced) return raw;
  const paragraphs = raw.split(/\n\s*\n/);
  if (paragraphs.length > 1 && SELF_INTRO.test(paragraphs[0] ?? "")) {
    const rest = paragraphs.slice(1).join("\n\n").trim();
    if (rest) return rest;
  }
  // Only strip the intro banner itself. Do not let a "anything until .!?"
  // class eat the next sentence (e.g. "רשמתי ארון…") after ניסיונית.
  const stripped = raw
    .replace(
      /^(?:שלום[!.,]?\s*|היי[,!]?\s*)?(?:אני\s+)?הסוכן האוטומטי(?:\s+של\s+חיים\s+יחד)?(?:,)?\s*בהרצה ניסיונית\s*[.!?…]?\s*(?:[🙂😊]\s*)?/u,
      "",
    )
    .replace(
      /^(?:שלום[!.,]?\s*|היי[,!]?\s*)?(?:אני\s+)?הסוכן האוטומטי[\s\S]{0,80}?בהרצה ניסיונית\s*[.!?…]?\s*(?:[🙂😊]\s*)?/u,
      "",
    )
    .trim();
  return stripped || raw;
}

export interface ReplyClaims {
  saved: string[];
  contacted_counterparty: boolean;
  opened_request: number | null;
  schedule_date: string | null;
  cancelled: boolean;
  human_handoff: boolean;
}

export interface ClaimFacts {
  changedPaths: string[];
  openedRequestNumber: number | null;
  contactedCounterparty: boolean;
  /**
   * When true (default), a queued notice requires claims.contacted_counterparty.
   * Set false for follow-up correction/update notices: the model may focus on
   * item/address/schedule fixes without re-affirming first contact.
   */
  requireContactClaim?: boolean;
  scheduleDate: string | null;
  cancelled: boolean;
  humanHandoff: boolean;
  knownRequestNumbers: number[];
}

export function emptyClaims(): ReplyClaims {
  return {
    saved: [],
    contacted_counterparty: false,
    opened_request: null,
    schedule_date: null,
    cancelled: false,
    human_handoff: false,
  };
}

/** Path-shaped save claim: `table.column` or `table.column:role`. */
const SAVED_PATH = /^[a-z_]+\.[a-z_]+(?::(?:donor|receiver))?$/i;

export function isSavedPathClaim(value: string): boolean {
  return SAVED_PATH.test(value.trim());
}

/**
 * Verify structured claims against this-turn facts. Does not rewrite text.
 * Returns rejected claim keys; empty means the reply is allowed.
 *
 * Only path-shaped `saved` entries are enforced. Free-text labels are a
 * prompt-schema miss (ignored) — they must not nuke an otherwise valid reply.
 */
export function verifyClaims(
  claims: ReplyClaims,
  facts: ClaimFacts,
): { ok: boolean; rejected: string[] } {
  const rejected: string[] = [];
  const allowed = new Set(facts.changedPaths);
  for (const path of claims.saved) {
    const trimmed = path.trim();
    if (!isSavedPathClaim(trimmed)) continue;
    if (
      !allowed.has(trimmed) &&
      !allowed.has(trimmed.replace(/^requests\[\d+\]\./, ""))
    )
      rejected.push(`saved:${trimmed}`);
  }
  if (claims.contacted_counterparty && !facts.contactedCounterparty)
    rejected.push("contacted_counterparty");
  // Underclaim: a primary contact notice was queued but the model denied it.
  // Correction/update notices set contactedCounterparty without requiring the
  // customer reply to re-claim first contact (conv#10 Friday+sofa turn).
  if (
    !claims.contacted_counterparty &&
    facts.contactedCounterparty &&
    facts.requireContactClaim !== false
  )
    rejected.push("contacted_counterparty:underclaim");
  if (
    claims.opened_request !== null &&
    claims.opened_request !== facts.openedRequestNumber
  )
    rejected.push("opened_request");
  if (
    claims.schedule_date !== null &&
    claims.schedule_date !== facts.scheduleDate
  )
    rejected.push("schedule_date");
  if (claims.cancelled && !facts.cancelled) rejected.push("cancelled");
  if (claims.human_handoff && !facts.humanHandoff) rejected.push("human_handoff");

  // Cheap text-independent checks already covered by claims. Request numbers
  // mentioned only via opened_request claim above.
  void facts.knownRequestNumbers;

  return { ok: rejected.length === 0, rejected };
}

/**
 * True when the reply falsely denies that a verification/notice message was
 * queued or sent, even though this turn queued one or more notices.
 */
export function replyDeniesQueuedNotice(
  reply: string,
  noticesQueued: number,
): boolean {
  if (noticesQueued <= 0) return false;
  return /(?:לא\s+(?:יצאה|נשלח(?:ה)?|שלח(?:נו|תי)?|פנ(?:ה|ינו))|כרגע\s+לא\s+יצאה|עדיין\s+לא\s+(?:יצאה|נשלח)|לא\s+יצאה\s+אלי[וה]\s+הודע|בלי\s+(?:לשלוח|לפנות)|did\s+not\s+(?:send|contact)|no\s+(?:verification\s+)?(?:message|notice)\s+(?:was\s+)?sent)/iu.test(
    reply,
  );
}

/** True when the reply uses a save verb but no claimable path was written. */
export function replyClaimsSaveWithoutWrites(
  reply: string,
  changedPaths: string[],
): boolean {
  if (!/(?:נשמר|רשמתי|שמרתי|עדכנתי|רשמנו|עדכנו)/u.test(reply)) return false;
  return !changedPaths.some(
    (path) =>
      path.startsWith("request_items.") ||
      path.startsWith("request_parties.") ||
      path.startsWith("requests.") ||
      path.startsWith("searches.") ||
      path.startsWith("conversations."),
  );
}

/**
 * Legacy marker-based guard kept only as a last-resort when the model returns
 * no claims object. Prefer verifyClaims. On reject the caller must re-ask the
 * phrase model — not send GUARD_FALLBACK_REPLY to the customer.
 */
export function applyClaimGuard(
  _canonical: string,
  phrased: string | null | undefined,
  _proven: boolean,
  changedFields: { table: string; column: string }[] = [],
): { text: string; rejected: boolean } {
  const candidate = (phrased ?? "").trim();
  if (!candidate) return { text: "", rejected: true };
  const saveClaim =
    /(?:נשמר|רשמתי|שמרתי|עדכנתי|רשמנו|עדכנו|קיבלתי)/u.test(candidate);
  if (saveClaim && changedFields.length === 0)
    return { text: candidate, rejected: true };
  return { text: candidate, rejected: false };
}

/** @deprecated Probe replies are owned by the reply manager. */
export function probeReply(_text: string): string {
  return GUARD_FALLBACK_REPLY;
}
