/** Fixed customer text when the decoder cannot understand the message. */
export const CLARIFY_REPLY =
  "לא הבנתי את הכוונה. אפשר לכתוב את זה שוב?";

/** Fixed customer text when the model/API fails. Does not count as unclear. */
export const FAULT_REPLY =
  "יש תקלה זמנית במערכת. נחזור אליך בהקדם.";

const CLAIM_RE =
  /(?:נשמר|אושר|פנינו|נשלח|תואם|שלחתי|פניתי|נשלחה|בוצע|בוצעה|תואמה|התיאום הושלם)/u;

/** True when phrased text claims an operational outcome. */
export function claimsOperationalOutcome(text: string): boolean {
  return CLAIM_RE.test(text);
}

/**
 * Prefer the phrased reply only when it does not invent a save/send/approval.
 * If the claim is already present in the canonical DB-backed sentence, allow it.
 */
export function applyClaimGuard(
  canonical: string,
  phrased: string | null | undefined,
  proven: boolean,
): { text: string; rejected: boolean } {
  const candidate = (phrased ?? "").trim();
  if (!candidate) return { text: canonical, rejected: false };
  const invents =
    claimsOperationalOutcome(candidate) &&
    !claimsOperationalOutcome(canonical) &&
    !proven;
  if (invents) return { text: canonical, rejected: true };
  return { text: candidate, rejected: false };
}
