import type { Party, Request } from "./types.js";
import { nextTuesday } from "./policies.js";

export function formatHebrewDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-");
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

export function partyAddressLine(
  party: Pick<Party, "settlement" | "address" | "floor">,
): string {
  const parts: string[] = [];
  if (party.settlement) parts.push(party.settlement);
  if (party.address) parts.push(party.address);
  if (party.floor === 0) parts.push("קרקע");
  else if (typeof party.floor === "number") parts.push(`קומה ${party.floor}`);
  return parts.join(", ");
}

function itemLine(request: Request): string {
  return request.items.map((item) => item.description).filter(Boolean).join(", ") || "פריט";
}

function deliveryDate(request: Request, now: Date): string {
  return request.run_date ?? request.proposed_run_date ?? nextTuesday(now).date;
}

function partyByPhone(request: Request, phone: string): Party | undefined {
  return request.parties.find((party) => party.phone === phone);
}

export function draftCounterpartyVerification(input: {
  request: Request;
  recipient: Party;
  now: Date;
}): string {
  const { request, recipient, now } = input;
  const initiator =
    request.parties.find((party) => party.role !== recipient.role) ?? null;
  const items = itemLine(request);
  const dateHe = formatHebrewDate(deliveryDate(request, now));
  const greeting = recipient.name ? `שלום ${recipient.name}` : "שלום";
  const other = initiator?.name
    ? initiator.name
    : recipient.role === "receiver"
      ? "המוסר"
      : "המקבל";
  const action =
    recipient.role === "receiver"
      ? `${other} רוצה למסור לך ${items}.`
      : `${other} רוצה לקבל ממך ${items}.`;
  const address = partyAddressLine(recipient);
  const confirm = address
    ? `רשמנו את הכתובת שלך: ${address}.\nנא לאשר שהכתובת נכונה ושהיום מתאים.`
    : "נא לאשר את הכתובת שלך ושהיום מתאים.";
  return `${greeting}, כאן חיים יחד.
${action}
יום ההובלה הוא שלישי ${dateHe}, בין 16:00–20:00. השעה המדויקת תלויה במסלול של אותו יום.
${confirm}`;
}

export function draftScheduleProposal(input: {
  request: Request;
  recipient: Party;
  date: string;
}): string {
  const name = input.recipient.name ? `שלום ${input.recipient.name}` : "שלום";
  const items = itemLine(input.request);
  return `${name}, כאן חיים יחד.
לגבי ${items} — המועד המוצע הוא יום שלישי ${formatHebrewDate(input.date)}, בין 16:00–20:00.
נא לאשר שיום ההובלה מתאים.`;
}

export function draftCoordinatedNotice(input: {
  request: Request;
  date: string;
}): string {
  return `ההובלה בפנייה ${input.request.number} תואמה ליום שלישי ${formatHebrewDate(input.date)}, בין 16:00–20:00. ביום ההובלה ניצור קשר לפני ההגעה.`;
}

export function looksLikeJsonNotice(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    /"kind"\s*:/.test(trimmed)
  );
}

/** Keep names, streets and the delivery date from the draft; refuse JSON. */
export function noticeKeepsRequiredFacts(draft: string, text: string): boolean {
  if (!text.trim() || looksLikeJsonNotice(text)) return false;
  const skip =
    /^(?:שלום|כאן|חיים|יחד|ההובלה|בין|רשמנו|אפשר|לאשר|שהכתובת|נכונה|שהיום|מתאים|רוצה|למסור|לקבל|ממך|לך|יום|שלישי|המוסר|המקבל|לגבי|המועד|המוצע|הוא|את|של|אותו|תלויה|במסלול)$/u;
  const tokens = [...new Set(draft.match(/[א-ת]{2,}|\d{1,2}\/\d{1,2}(?:\/\d{4})?/g) ?? [])];
  return tokens.filter((token) => !skip.test(token)).every((token) => text.includes(token));
}

export function resolveNoticeDraft(
  text: string,
  request: Request | null,
  recipientPhone: string,
  now: Date,
): string {
  if (!request) return text;
  const recipient = partyByPhone(request, recipientPhone);
  if (looksLikeJsonNotice(text)) {
    try {
      const parsed = JSON.parse(text) as { kind?: string; proposed_run_date?: string; run_date?: string };
      if (parsed.kind === "counterparty_verification" && recipient)
        return draftCounterpartyVerification({ request, recipient, now });
      if (parsed.kind === "schedule_proposal" && recipient && parsed.proposed_run_date)
        return draftScheduleProposal({
          request,
          recipient,
          date: parsed.proposed_run_date,
        });
      if (parsed.kind === "coordinated" && parsed.run_date)
        return draftCoordinatedNotice({ request, date: parsed.run_date });
    } catch {
      /* keep original */
    }
  }
  return text;
}
