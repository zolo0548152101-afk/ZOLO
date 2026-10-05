/** Fixed customer text when the decoder cannot understand the message. */
export const CLARIFY_REPLY =
  "לא הבנתי את הכוונה. אפשר לכתוב את זה שוב?";

/** Fixed customer text when the model/API fails. Does not count as unclear. */
export const FAULT_REPLY =
  "יש תקלה זמנית במערכת. נחזור אליך בהקדם.";

/**
 * Prefer a concrete probe over the generic clarify. Used when the model
 * marks the turn unclear but the text still hints at a direction.
 */
export function probeReply(text: string): string {
  const t = text.replace(/\s+/gu, " ").trim();
  if (!t) return CLARIFY_REPLY;
  const hasPhone = /\d{8,10}/.test(t);
  const hasPerson =
    hasPhone ||
    /(?:^|\s)ל(?!מסור|קבל|תת|העביר)(?:טל|מישהו|חבר|חברה|אמא|אבא|סבתא|סבא|[א-ת]{2,})(?:\s|$)/u.test(
      t,
    );
  const wantsDonate = /(?:רוצה\s+)?(?:למסור|לתת|להעביר)|מסירה/u.test(t);
  const wantsReceive = /(?:רוצה\s+)?(?:לקבל|מבקש|צריך)|קבלה/u.test(t);
  const hasItem =
    /מיטה|ספה|שידה|מנורה|שולחן|כיסא|מקרר|מכונת|תנור|ארון|פריט|רהיט/u.test(t);
  if (wantsDonate && !hasPerson)
    return "למי תרצה למסור? אפשר לכתוב שם או מספר טלפון.";
  if (wantsDonate && hasPerson && !hasItem)
    return "איזה פריט תרצה למסור?";
  if (wantsReceive && !hasItem && !hasPerson)
    return "מה תרצה לקבל, ומאיפה או ממי?";
  if (wantsReceive && !hasItem) return "איזה פריט תרצה לקבל?";
  if (/^(?:אני\s+)?רוצה[.!?]*$/u.test(t) || /^(?:היי|שלום|הי)[.!?]*$/u.test(t))
    return "מה תרצה לעשות — למסור פריט או לקבל פריט?";
  return CLARIFY_REPLY;
}

const CLAIM_MARKERS = [
  "התיאום הושלם",
  "נשלחה",
  "תואמה",
  "בוצעה",
  "נקבעה",
  "מאושר",
  "נשמר",
  "אושר",
  "פנינו",
  "נשלח",
  "תואם",
  "שלחתי",
  "פניתי",
  "בוצע",
  "נקבע",
  "נאסוף",
  "נבוא",
  "ניקח",
];

function markersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const marker of CLAIM_MARKERS) if (text.includes(marker)) found.add(marker);
  return found;
}

/** True when phrased text claims an operational outcome. */
export function claimsOperationalOutcome(text: string): boolean {
  return markersIn(text).size > 0;
}

/**
 * Prefer the phrased reply only when it does not invent a save/send/approval.
 * If the claim is already present in the canonical DB-backed sentence, allow it.
 */
export function applyClaimGuard(
  canonical: string,
  phrased: string | null | undefined,
  _proven: boolean,
): { text: string; rejected: boolean } {
  const candidate = (phrased ?? "").trim();
  if (!candidate) return { text: canonical, rejected: false };
  const canonicalMarkers = markersIn(canonical);
  const extra = [...markersIn(candidate)].filter(
    (marker) => !canonicalMarkers.has(marker),
  );
  // Each claim token must already be in the committed sentence.
  // A proven operational result does not license extra claims.
  if (extra.length) return { text: canonical, rejected: true };
  return { text: candidate, rejected: false };
}
