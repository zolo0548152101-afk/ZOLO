/**
 * False-information guard and the only two fixed customer lines the code may
 * emit (OpenAI unreachable / guard failed twice). Everything else is AI text.
 */

/** Neutral line when OpenAI is unreachable after retries. */
export const OUTAGE_REPLY =
  "יש תקלה זמנית במערכת. נחזור אליך בהקדם.";

/** Neutral line when the claims guard rejects twice. */
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
  const stripped = raw
    .replace(
      /^(?:שלום[!.,]?\s*|היי[,!]?\s*)?(?:אני\s+)?הסוכן האוטומטי[\s\S]*?בהרצה ניסיונית[^.!?\n]*[.!?…]?\s*(?:[🙂😊]\s*)?/u,
      "",
    )
    .replace(
      /^(?:שלום[!.,]?\s*|היי[,!]?\s*)?(?:אני\s+)?הסוכן האוטומטי[\s\S]*?בהרצה ניסיונית[.!?…]?\s*/u,
      "",
    )
    .replace(/^[\s\S]*?בהרצה ניסיונית[^\n]*\n+/u, "")
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
 * Legacy marker-based guard kept only as a last-resort when the model returns
 * no claims object. Prefer verifyClaims. Never invents wording — on reject the
 * caller re-asks the model or uses GUARD_FALLBACK_REPLY.
 */
export function applyClaimGuard(
  _canonical: string,
  phrased: string | null | undefined,
  _proven: boolean,
  changedFields: { table: string; column: string }[] = [],
): { text: string; rejected: boolean } {
  const candidate = (phrased ?? "").trim();
  if (!candidate) return { text: GUARD_FALLBACK_REPLY, rejected: true };
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
