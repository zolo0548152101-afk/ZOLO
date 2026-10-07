import {
  AppError,
  type PhotoStatus,
  type Request,
  type Item,
  type Party,
  type Plan,
  type Role,
} from "./types.js";
export const SERVICE_TOWNS =
  "בית שאן, מסילות, ירדנה, בית אלפא, טירת צבי, שדה אליהו, כפר רופין ומחולה";
export const OUTSIDE =
  `אנחנו פועלים רק ב${SERVICE_TOWNS}. לא נוכל לסייע בהובלה הזו.`;
/** Uncertain / borderline settlement: keep collecting; team checks distance. */
export const DISTANCE_REVIEW_REPLY =
  "נברר אם המרחק מתאים ונחזור אליך.";
/** Bot cannot answer a question: park for team, keep collecting. */
export const CHECK_LATER_REPLY = "אבדוק ואחזור אליך עם תשובה.";
export const PHOTO_THANKS = "תודה, התמונה התקבלה.";
/** Legacy fixed line — prefer SOFT_PHOTO_ASK + summarizeTurnChanges for new replies. */
export const PHOTO_FIRST = "בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.";
/** Soft photo nudge: optional, never blocks the next missing detail. */
export const SOFT_PHOTO_ASK =
  "אם יש תמונה של הפריט — אפשר לשלוח עכשיו; אם אין, נמשיך בפרטים.";
/** Persisted request.photo_status values (Hebrew, match DB CHECK). */
export const PHOTO_STATUS = {
  NOT_ASKED: "לא בוקשה",
  ASKED: "בוקשה",
  NO_PHOTO: "אין תמונה",
  RECEIVED: "התקבלה",
} as const satisfies Record<string, PhotoStatus>;
/** Same-day pickup is not a promise. Deliveries stay on the Tuesday window. */
export const SAME_DAY_WINDOW =
  "אי אפשר לאסוף היום. ההובלות רק ביום שלישי בין 16:00 ל־20:00.";
export function sameDayDemand(text: string): boolean {
  return /(?:^|[^א-ת])היום(?=$|[^א-ת])/u.test(norm(text));
}
/** Customer declined or deferred a photo — continue to the next missing field. */
export function photoDeclined(text: string): boolean {
  const t = norm(text);
  return (
    /אין(?:\s+לי)?\s+תמונה|בלי\s+תמונה|לא\s+(?:אשלח|שולח|יש)\s+תמונה|תמונה\s+אין|כרגע\s+אין(?:\s+לי)?(?:\s+תמונה)?|אין\s+כרגע/.test(
      t,
    ) || /no\s+photo|don'?t\s+have\s+(?:a\s+)?photo/i.test(text)
  );
}
/** After a one-time ask, any non-photo reply closes the photo gate. */
export function photoStatusSkipsGate(status: PhotoStatus | undefined): boolean {
  return (
    status === PHOTO_STATUS.ASKED ||
    status === PHOTO_STATUS.NO_PHOTO ||
    status === PHOTO_STATUS.RECEIVED
  );
}
/**
 * True when the customer already understands the product path
 * (donate / receive / item / contact) — no self-intro needed.
 */
export function customerIntentClear(text: string): boolean {
  const t = norm(text).replace(/\s+/gu, " ").trim();
  if (!t) return false;
  if (
    /^(?:שלום|היי|הי|בוקר טוב|ערב טוב|צחרים טובים|צהריים טובים)[.!?]*$/u.test(t)
  )
    return false;
  if (
    /(?:למסור|לתרום|להעביר|לקבל|מבקש|צריך|מסירה|תרומה|מוסר|מקבל)/u.test(t)
  )
    return true;
  if (
    /מיטה|(?:^|[^\u05D0-\u05EA])מטה(?=[^\u05D0-\u05EA]|$)|ספה|שידה|מנורה|שולחן|כיסא|מקרר|מכונת|תנור|ארון|פריט|רהיט/u.test(
      t,
    )
  )
    return true;
  if (/כרטיס איש קשר|BEGIN:VCARD/i.test(text)) return true;
  if (/\d{8,10}/.test(t) && /(?:ל|עבור|אל)/u.test(t)) return true;
  return false;
}
export function displayPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local =
    digits.length === 12 && digits.startsWith("972")
      ? digits.slice(3)
      : digits.length === 10 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  if (local.length === 9 && local.startsWith("5"))
    return `0${local.slice(0, 2)}-${local.slice(2)}`;
  return phone;
}
/**
 * Ack only fields that were written this turn (from before→after).
 * Values come from `after` (DB state after the write) — never invented.
 * Returns null when nothing new was persisted.
 */
export function summarizeTurnChanges(
  before: Request | null | undefined,
  after: Request | null | undefined,
): string | null {
  if (!after) return null;
  const beforeItems = before?.items ?? [];
  const afterItems = after.items ?? [];
  const itemsNew =
    afterItems.length > 0 &&
    (beforeItems.length === 0 ||
      afterItems.some(
        (item, i) =>
          item.description && item.description !== beforeItems[i]?.description,
      ));
  const itemText = itemsNew
    ? afterItems
        .map((i) => i.description?.trim())
        .filter((x): x is string => Boolean(x))
        .join(" ו")
    : "";

  const beforeReceiver = before?.parties?.find((p) => p.role === "receiver");
  const afterReceiver = after.parties.find((p) => p.role === "receiver");
  const receiverNew = Boolean(afterReceiver && !beforeReceiver);
  const receiverNameNew =
    receiverNew ||
    Boolean(
      afterReceiver?.name && afterReceiver.name !== (beforeReceiver?.name ?? null),
    );
  const receiverPhoneNew =
    receiverNew ||
    Boolean(
      afterReceiver?.phone &&
        afterReceiver.phone !== (beforeReceiver?.phone ?? null),
    );
  const beforeOwn = before?.parties?.find((p) => p.phone === after.parties.find((x) => x.role === "donor")?.phone);
  const afterDonor = after.parties.find((p) => p.role === "donor");
  const beforeDonor = before?.parties?.find((p) => p.role === "donor");
  const settlementNew = Boolean(
    afterDonor?.settlement &&
      afterDonor.settlement !== (beforeDonor?.settlement ?? null),
  );
  const addressNew = Boolean(
    afterDonor?.address && afterDonor.address !== (beforeDonor?.address ?? null),
  );
  const nameNew = Boolean(
    afterDonor?.name && afterDonor.name !== (beforeDonor?.name ?? null),
  );
  const floorNew = Boolean(
    afterDonor &&
      afterDonor.floor !== null &&
      afterDonor.floor !== (beforeDonor?.floor ?? null),
  );

  // Nothing newly written this turn.
  if (
    !itemText &&
    !receiverNameNew &&
    !receiverPhoneNew &&
    !settlementNew &&
    !addressNew &&
    !nameNew &&
    !floorNew
  )
    return null;

  // Fresh handoff write: item and/or receiver captured together.
  if (itemText || receiverNameNew || receiverPhoneNew) {
    const name = receiverNameNew ? afterReceiver?.name : null;
    const phone = receiverPhoneNew ? afterReceiver?.phone : null;
    if (itemText && name && phone)
      return `מעולה, רשמתי שאתה רוצה למסור ${itemText} ל${name} (${displayPhone(phone)})`;
    if (itemText && name)
      return `מעולה, רשמתי שאתה רוצה למסור ${itemText} ל${name}`;
    if (itemText && phone)
      return `מעולה, רשמתי שאתה רוצה למסור ${itemText} למספר ${displayPhone(phone)}`;
    if (itemText) return `מעולה, רשמתי שאתה רוצה למסור ${itemText}`;
    if (name && phone)
      return `מעולה, רשמתי מסירה ל${name} (${displayPhone(phone)})`;
    if (name) return `מעולה, רשמתי מסירה ל${name}`;
  }

  // Later turns: only the field that just changed.
  if (settlementNew && afterDonor?.settlement)
    return `מעולה, רשמתי ${afterDonor.settlement}`;
  if (addressNew && afterDonor?.address) {
    const place = [afterDonor.address, afterDonor.settlement]
      .filter(Boolean)
      .join(" ");
    return `מעולה, רשמתי ${place}`;
  }
  if (floorNew && afterDonor && afterDonor.floor !== null)
    return afterDonor.floor === 0
      ? "מעולה, רשמתי קומת קרקע"
      : `מעולה, רשמתי קומה ${afterDonor.floor}`;
  if (nameNew && afterDonor?.name) return `מעולה, רשמתי את השם ${afterDonor.name}`;
  void beforeOwn;
  return null;
}

/** When nothing new was written — never resend the identical previous question. */
export function noProgressReply(
  r: Request,
  phone: string,
  customerText: string,
  previousBot: string,
): string {
  const q = nextQuestion(r, phone);
  const p = ownParty(r, phone);
  const t = norm(customerText);
  const alreadyStored =
    Boolean(p.settlement && t.includes(norm(p.settlement))) ||
    Boolean(p.address && t.includes(norm(p.address))) ||
    Boolean(p.name && t.includes(norm(p.name)));
  const field = q.missing?.field ?? null;
  const required =
    field === "settlement" ||
    field === "address" ||
    field === "name" ||
    field === "floor";
  const needLabel =
    field === "settlement"
      ? "את היישוב"
      : field === "address"
        ? "את הכתובת או תיאור המקום"
        : field === "floor"
          ? "את הקומה"
          : field === "name"
            ? "את השם"
            : "את הפרט החסר";
  // Contact consent: never loop the same yes/no — demand an explicit phrase.
  if (field === "contact_counterparty" || /אימות הפרטים/.test(q.text)) {
    const other = r.parties.find((x) => x.phone !== phone);
    const who =
      other?.name ?? (p.role === "donor" ? "המקבל" : "המוסר");
    if (
      previousBot.includes("לאשר במפורש") ||
      previousBot.includes("תפנה אליו")
    )
      return `עדיין צריך אישור מפורש לפני שפונים ל${who} — למשל «כן, תפנה אליו» או «לא».`;
    return `כדי לוודא — לאשר במפורש שנשלח הודעה ל${who}? למשל «כן, תפנה אליו».`;
  }
  let ask = q.text;
  // Soft variant when the previous bot line already asked the same thing.
  if (previousBot && ask && previousBot.includes(ask.slice(0, Math.min(24, ask.length)))) {
    if (field === "address")
      ask =
        p.settlement === "בית שאן"
          ? "כדי להמשיך צריך כתובת מדויקת — רחוב ומספר בית."
          : "כדי להמשיך צריך תיאור קצר של המקום ביישוב, למשל «ליד המזכירות» או «בכניסה».";
    else if (field === "settlement")
      ask = "כדי להמשיך צריך את שם היישוב שבו נמצא הפריט.";
    else if (field === "floor")
      ask = "כדי להמשיך צריך לדעת באיזו קומה — אפשר גם לכתוב «קרקע».";
    else if (required) ask = `כדי להמשיך צריך ${needLabel}.`;
  }
  if (alreadyStored)
    return `הפרט הזה כבר רשום אצלנו. ${ask}`.trim();
  if (required)
    return `אפשר לענות על ${needLabel}? ${ask}`.trim();
  return `אפשר לענות על זה בבקשה? ${ask}`.trim();
}
export function photoAskAlreadySent(
  history: { role: string; content: string }[],
): boolean {
  return history.some(
    (entry) =>
      entry.role === "assistant" &&
      /תמונה/.test(entry.content) &&
      /(?:שלח|לשלוח|אפשר לשלוח|נא לשלוח|אם יש)/u.test(entry.content),
  );
}
/** Next ask, optionally prefixed with this-turn DB ack only. */
export function composeTurnReply(
  ask: string,
  before: Request | null | undefined,
  after: Request | null | undefined,
): string {
  const ack = summarizeTurnChanges(before, after);
  const next = ask.trim();
  if (ack && next && !next.includes(ack)) return `${ack}\n${next}`;
  return next || ack || "";
}
/** @deprecated use composeTurnReply — kept as alias for call sites mid-migration */
export function composeRecordedReply(
  r: Request,
  _phone: string,
  ask: string,
  before: Request | null | undefined = null,
): string {
  return composeTurnReply(ask, before, r);
}
export function openingPhotoReply(
  r: Request,
  _phone?: string,
  before: Request | null | undefined = null,
): string {
  return composeTurnReply(SOFT_PHOTO_ASK, before, r);
}
export const CONDITION_QUESTION = "האם הפריט תקין ושמיש ב־100%?";
export const DEFAULT_TRANSPORT_CAPACITY = 10;
export const MAX_TRANSPORT_CAPACITY = 100;
export const GREETING =
  "שלום, שמחים שפניתם אלינו 😊\nנוכל לעזור בימי שלישי בין השעות 16:00–20:00. ניתן לתאם עד 10 הובלות בכל יום שלישי; מעבר לכך נבקש אישור מנהל לפני תיאום נוסף.\n\nלהמשך התיאום, נא לוודא שהמוסר והמקבל — כל אחד לחוד ובעצמו — ישלחו הודעה עם הפרטים הבאים:\n\n1. שם מלא\n2. תמונה ושם של החפץ\n3. כתובת\n\nכמה הבהרות:\n\n- אנו לא מפרקים ומרכיבים ארונות\n- אנו מעבירים עד 2 רהיטים לאדם\n- הפעילות בהתנדבות\n- אנו מעבירים רק רהיטים שנמסרו ולא נקנו\n- הפעילות מתקיימת בבית שאן ובעמק הקרוב";
export const HUMAN_REPLY = "העברתי את הפנייה לטיפול אנושי. נעדכן.";
/** Internal monitor text. It may be delivered only to the configured admin phone. */
export const OPS_ALERT_PREFIX = "נדרשת בדיקת מערכת";
export function isOperationsAlert(text: string): boolean {
  return text.startsWith(OPS_ALERT_PREFIX);
}
export const SUKKAH =
  "בשמחה. נא למלא את הטופס הבא, ולאחר מכן יצרו איתכם קשר להמשך:\nhttps://docs.google.com/forms/d/e/1FAIpQLSd-lls8Yp8pstD3M_OsBAV9JK-FbDHHTLatPZbqnGtmhUN1vA/viewform";
export const DONATION = "https://pe4ch.com/ref/av01FlQj2che?lang=he";
export const ABOUT =
  "תוכנית חיים יחד נוסדה על ידי נועם גומעה, בשיתוף גרעין יחד בית שאן, ופועלת מאז 2018 בהתנדבות. הפעילות משלבת נוער מתנדב, ערבות הדדית ושימוש חוזר ברהיטים ובמכשירי חשמל.";
export const ACTIVE = [
  "collecting",
  "available",
  "awaiting_approval",
  "waiting_capacity",
  "coordinated",
  "human",
  "cancel_pending",
] as const;
export function canonicalPhone(value: string): string {
  if (value.includes("@lid")) throw new AppError("lid_is_not_phone");
  if (!/^[+\d\s().-]+(?:@c\.us|@s\.whatsapp\.net)?$/.test(value))
    throw new AppError("invalid_phone");
  let s = value.split("@")[0]!.replace(/\D/g, "");
  if (s.startsWith("00972")) s = s.slice(5);
  else if (s.startsWith("972")) s = s.slice(3);
  if (s.startsWith("0")) s = s.slice(1);
  if (!/^[2-9]\d{7,8}$/.test(s)) throw new AppError("invalid_phone");
  return s;
}
export function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[־–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function isStatus(s: string): boolean {
  return /^(?:מה\s+(?:מצב\s+(?:הפנייה|הפניה|התיאום|ההובלה)|(?:ה)?סטטוס)|מה קורה עם (?:הפנייה|הפניה|ההובלה)|זה כבר מתואם|מה מצב הפנייה|מתי (?:ההובלה|מגיעים))(?:\s+\d+)?[?？!\s]*$/.test(
    norm(s),
  );
}
export function quickReply(s: string): string | null {
  const t = norm(s);
  if (/^(שלום|היי|הי|אהלן|בוקר טוב|ערב טוב|שלום וברכה)[!.,?\s]*$/.test(t))
    return GREETING;
  if (/(?:סוכה|סוכות)/.test(t) && !isStatus(t)) return SUKKAH;
  if (
    /(?:איך|אפשר|רוצה|לינק|קישור).*(?:לתרום כסף|תרומה כספית|לתרומה)|תרומה כספית/.test(
      t,
    )
  )
    return DONATION;
  if (
    /(?:מי (?:הקים|ייסד)|מידע על התוכנית|מה זה חיים יחד|ספר.*על (?:התוכנית|חיים יחד))/.test(
      t,
    )
  )
    return ABOUT;
  return null;
}
export function explicitApproval(t: string): boolean {
  const text = norm(t);
  // Consent often arrives after a short self-introduction, for example:
  // "אני טל, המקבלת. מאשרת את הפרטים."  Approval commands are only
  // accepted in an approval state, so recognise the explicit consent phrase
  // after a sentence boundary as well as at the start of the message.
  return /(?:^|[.!,;]\s*)(?:כן|מאשר|מאשרת|אני מאשר|אני מאשרת|מאושר|מסכים|מסכימה|אני\s+[א-ת]{2,}[,\s]+(?:מ|ומ)?אשר(?:ת)?)(?:[\s.,!]|$)/.test(
    text,
  );
}
export function donationIntent(t: string): boolean {
  return (
    /(?:למסירה|לתרומה|למסור|לתרום|מוסר|מוסרת|להעביר|מעביר|מעבירה|יש לי להעביר)/.test(
      t,
    ) ||
    /(?:תבואו|תבוא|בואו|תגיעו|תגיע)(?:\s+\S+){0,3}\s+לקחת/u.test(t) ||
    /\b(?:donate|donation|donating|give away|giving away)\b/i.test(t) ||
    /\bi have\b.{0,48}\bto give\b/i.test(t) ||
    (/\b(?:give|giving)\b/i.test(t) &&
      !/\bgive\s+(?:me|you|us|him|her|them)\b/i.test(t)) ||
    /تبرع|أتبرع|للتبرع|أعطي|اعطي|أهدي|اهدي/u.test(t) ||
    /отдать|отдаю|отдам|пожертв/iu.test(t)
  );
}
/** Looking for an item. Donation verbs stay on donationIntent. */
export function seekIntent(t: string): boolean {
  return (
    /\b(?:i'm looking for|im looking for|i am looking for|looking for|i need|can i get)\b/i.test(
      t,
    ) ||
    /أبحث|أحتاج|احتاج|أبغى|ابغى/u.test(t) ||
    /ищу|мне нужн|можно получить|хочу получить/iu.test(t)
  );
}
export function customerCancelIntent(text: string): boolean {
  return /(?:לבטל|ביטול|תבטלו|תבטל|מבטל|מבטלת|לא רלוונטי)/u.test(norm(text));
}
export function streetPhrase(text: string): string | null {
  const match = norm(text).match(
    /(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)\s+[א-ת0-9׳״'"’.-]+(?:\s+[א-ת0-9׳״'"’.-]+){0,4}/u,
  );
  return (
    match?.[0]
      ?.replace(/\s+(?:קומה|ק[׳'])\s*-?\d+(?:\s+עם\s+מעלית)?\s*$/u, "")
      .trim() ?? null
  );
}
/** אילת is both a street in the service area and a city outside it. */
export function ambiguousStreetCity(text: string): boolean {
  if (streetPhrase(text)) return false;
  return /(?:^|[\s,])(?:מ|ב|ל)?אילת(?:$|[\s,.;!?])/u.test(norm(text));
}
export function cityOutsideStreet(text: string, name: string): boolean {
  const street = streetPhrase(text);
  const rest = street ? norm(text).replace(street, " ") : norm(text);
  return rest.includes(name);
}

const OUTSIDE_PLACES: { name: string; pattern: RegExp }[] = [
  { name: "תל אביב", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?תל\s+אביב(?=$|[^א-ת])/u },
  { name: "תל אביב", pattern: /\btel\s*aviv\b/i },
  { name: "ראשון לציון", pattern: /ראשון\s+לציון/u },
  { name: "באר שבע", pattern: /באר\s+שבע/u },
  { name: "ירושלים", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?ירושלים(?=$|[^א-ת])/u },
  { name: "ירושלים", pattern: /\bjerusalem\b/i },
  { name: "טבריה", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?טברי[הא](?=$|[^א-ת])/u },
  { name: "טבריה", pattern: /\btiberias\b/i },
  { name: "טבריה", pattern: /طبري[اة]/u },
  { name: "עפולה", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?עפול[הא](?=$|[^א-ת])/u },
  { name: "עפולה", pattern: /\bafula\b/i },
  { name: "חיפה", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?חיפה(?=$|[^א-ת])/u },
  { name: "חיפה", pattern: /\bhaifa\b/i },
  { name: "אשדוד", pattern: /אשדוד/u },
  { name: "אשקלון", pattern: /אשקלון/u },
  { name: "נתניה", pattern: /נתניה/u },
  { name: "ניר דוד", pattern: /ניר\s+דוד/u },
  { name: "בית השיטה", pattern: /בית\s+השיטה/u },
  { name: "חמדיה", pattern: /חמדיה/u },
  { name: "עין הנציב", pattern: /עין\s+הנציב/u },
  { name: "מנחמיה", pattern: /מנחמיה/u },
  { name: "בית יוסף", pattern: /בית\s+יוסף/u },
  { name: "נווה אור", pattern: /נווה\s+אור/u },
  { name: "דגניה", pattern: /דגניה/u },
  { name: "יבנאל", pattern: /יבנאל/u },
  { name: "נצרת", pattern: /נצרת/u },
  { name: "צמח", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?צמח(?=$|[^א-ת])/u },
];

function mentionIsNegated(text: string, index: number): boolean {
  return /(?:לא|אינני|איני)\s*(?:גר(?:ה)?\s*)?(?:ב|מ|ל|in\s+)?$/iu.test(
    text.slice(Math.max(0, index - 20), index),
  );
}

/** A named town outside the service area, from the customer text itself. */
export function namedOutsideSettlement(text: string): string | null {
  const normalized = norm(text);
  for (const place of OUTSIDE_PLACES) {
    place.pattern.lastIndex = 0;
    const match = place.pattern.exec(normalized);
    if (!match || mentionIsNegated(normalized, match.index)) continue;
    const matchedHebrew = /[\u0590-\u05FF]/.test(match[0]);
    if (
      matchedHebrew &&
      /[\u0590-\u05FF]/.test(place.name) &&
      !cityOutsideStreet(normalized, place.name)
    )
      continue;
    return place.name;
  }
  return null;
}

const ALLOWED_PLACES: { name: string; pattern: RegExp }[] = [
  { name: "בית שאן", pattern: /בית\s*[-־]?\s*שאן/u },
  { name: "בית שאן", pattern: /\bbeit\s+she'?an\b/i },
  { name: "בית שאן", pattern: /بيت\s*شان|بيسان|бейт[\s-]*шеан/iu },
  { name: "מסילות", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?מסילות(?=$|[^א-ת])/u },
  { name: "ירדנה", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?ירדנה(?=$|[^א-ת])/u },
  { name: "בית אלפא", pattern: /בית\s*[-־]?\s*אלפא/u },
  { name: "טירת צבי", pattern: /(?:קיבוץ\s+)?טירת\s+צבי/u },
  { name: "שדה אליהו", pattern: /(?:קיבוץ\s+)?שדה\s+אליהו/u },
  { name: "כפר רופין", pattern: /כפר\s+רופין/u },
  { name: "מחולה", pattern: /(?:^|[^א-ת])(?:ב|מ|ל)?מחולה(?=$|[^א-ת])/u },
];

/** Customer keeps pushing after a clear denial (outside area / policy). */
export function customerInsistsAfterDenial(text: string): boolean {
  const t = norm(text);
  return (
    /בכל\s*זאת|עדיין\s+(?:רוצה|מבקש)|אני\s+מתעקש|תעשו\s+(?:לי|בכל)|חייבים|אין\s+ברירה|למה\s+לא|אני\s+צריך\s+ש|תמצאו\s+דרך/.test(
      t,
    ) || /insist|anyway|still\s+want/i.test(text)
  );
}

export function appendTeamNote(
  existing: string | null | undefined,
  note: string,
): string {
  const clean = note.trim();
  if (!clean) return (existing ?? "").trim();
  if (!existing?.trim()) return clean;
  if (existing.includes(clean)) return existing.trim();
  return `${existing.trim()}\n${clean}`;
}

/** An allowed town named as the place itself, not merely "near Beit She'an". */
export function mentionedAllowedSettlement(text: string): string | null {
  if (namedOutsideSettlement(text)) return null;
  const normalized = norm(text)
    .replace(/(?:ליד|קרוב ל|באזור|סמוך ל)\s*בית\s*[-־]?\s*שאן/gu, " ")
    .replace(/\bnear\s+beit\s+she'?an\b/gi, " ");
  for (const place of ALLOWED_PLACES) {
    place.pattern.lastIndex = 0;
    if (place.pattern.test(normalized)) return place.name;
  }
  return null;
}

/** Words after ב that are not a place: "בחינם", "בבקשה", "בעצם", "בשבילי". */
const NOT_A_PLACE = new Set([
  "חינם",
  "בקשה",
  "גלל",
  "בוקר",
  "ערב",
  "לילה",
  "צהריים",
  "קומה",
  "דירה",
  "בית",
  "שכונה",
  "שכונת",
  "רחוב",
  "שיכון",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "ראשון",
  "שני",
  "שבת",
  "שמחה",
  "תמונה",
  "אזור",
  "סביבה",
  "עמק",
  "דרך",
  "מקום",
  "זמן",
  "יום",
  "שבוע",
  "חודש",
  "כלל",
  "סדר",
  "דיוק",
  "כיף",
  "תודה",
  "עבר",
  "עתיד",
  "כסף",
  "מחיר",
  "וידאו",
  "וואטסאפ",
  "טלפון",
  "מספר",
  "פריט",
  "רהיט",
  "כניסה",
  "לבד",
  "עצם",
  "שבילי",
  "חוץ",
  "פנים",
  "פועלים",
]);

/**
 * A place written after ב that is neither an allowed town nor a hard-reject
 * outside town. "רחוב הגלבוע" and "בגלבוע 9" stay streets. The caller checks
 * service_locations; a name that is not there goes to review.
 */
export function mentionedReviewSettlement(text: string): string | null {
  if (!text.trim()) return null;
  if (namedOutsideSettlement(text) || mentionedAllowedSettlement(text)) return null;
  // Only a transport/donation sentence. Bare ב-words such as ביטול or ברורה are not towns.
  if (!donationIntent(text) && !/(?:הובלה|הובלות)/u.test(norm(text))) return null;
  const normalized = norm(text);
  const street = streetPhrase(normalized);
  const scanned = street ? normalized.replace(street, " ") : normalized;
  const pattern = /(?:^|[^א-ת])ב([א-ת]{3,})(?=$|[^א-ת])/gu;
  let found: string | null = null;
  for (const match of scanned.matchAll(pattern)) {
    const name = match[1];
    if (!name || NOT_A_PLACE.has(name)) continue;
    const prefixAt = match[0].startsWith("ב") ? 0 : match[0].indexOf("ב");
    const betAt = (match.index ?? 0) + prefixAt;
    if (mentionIsNegated(scanned, betAt)) continue;
    const after = scanned.slice(betAt + name.length + 1);
    if (/^\s*\d/u.test(after)) continue;
    found = name;
  }
  return found;
}
export function directHandoffIntent(t: string): boolean {
  const text = norm(t);
  // A common direct-handoff sentence names the recipient and explains their
  // intent without a phone number: "למסור את זה לטל, היא רוצה לקבל אותו".
  // It must bypass the open-donation photo gate while still requiring a
  // separate consent step before contacting that recipient.
  if (
    /(?:להעביר|למסור|מעביר|מעבירה|מוסר|מוסרת)/.test(text) &&
    /(?:הוא|היא)\s+רוצה\s+לקבל/.test(text)
  )
    return true;
  // "אולי יעזור למישהו" is an open donation, not a named/direct handoff.
  // Require an explicit qualifier when no real recipient name/phone exists.
  // "מישו" is a common typo for "מישהו".
  if (/(?:מקבל(?:ת)?\s+(?:מסוים|מוגדר)|ל(?:מישהו|מישהי|מישו|אדם)\s+(?:מסוים|מסוימת|ספציפי(?:ת)?|מוגדר(?:ת)?))/ .test(text))
    return /(?:להעביר|למסור|מסירה|מסירה ישירה)/.test(text);
  // A named recipient is often written naturally as "למסור מיטה לטל" or
  // "למסירה לטל". Bare "למסירה" / place names stay open donations.
  if (!/(?:להעביר|למסור|מעביר|מעבירה|מוסר|מוסרת|ישירות|למסירה)/.test(text)) return false;
  if (/(?:לבית שאן|לעפולה|לתל אביב|לצמח|לקרקע)/.test(text)) return false;
  return (
    /(?:להעביר|למסור|מעביר|מעבירה|מוסר|מוסרת|למסירה|ישירות).{0,80}\sל(?!מישהו|מישהי|אדם(?:\s|$))([א-ת]{2,})(?:\s+[א-ת]{2,})?(?=$|[\s,.;!?]|0)/u.test(
      text,
    ) ||
    /(?:להעביר|למסור|מעביר|מעבירה|מוסר|מוסרת|למסירה|ישירות).{0,80}\sל(?:מישהו|מישהי)\s+[א-ת]{2,}(?=$|[\s,.;!?])/u.test(
      text,
    )
  );
}
/**
 * Evidence must come from the customer message. The action manager owns field
 * values (spelling, kind labels, normalized addresses), so a light typo fix in
 * the quote — e.g. מטה→מיטה — is allowed. Inventing a different sentence is not.
 */
function foldEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s,.!?;:״׳"'`\-–—]+/gu, "")
    .replace(/[יו]/gu, "")
    .toLowerCase();
}

function evidenceSupportedByText(evidence: string, text: string): boolean {
  const quote = evidence.trim();
  const message = text.trim();
  if (!quote || !message) return false;
  if (message.includes(quote)) return true;
  const foldedQuote = foldEvidence(quote);
  const foldedMessage = foldEvidence(message);
  if (!foldedQuote || !foldedMessage) return false;
  return (
    foldedMessage.includes(foldedQuote) || foldedQuote.includes(foldedMessage)
  );
}

export function grounded(plan: Plan, text: string): boolean {
  return (
    plan.commands.every((c) => c.type === "status" || c.type === "next") ||
    (plan.evidence.length > 0 && evidenceSupportedByText(plan.evidence, text))
  );
}
export function photoGate(r: Request): boolean {
  // Ask at most once while photo_status is still «לא בוקשה».
  // Once «בוקשה» / «אין תמונה» / «התקבלה», never fire again on this request.
  return (
    (r.origin === "donation" || r.origin === "direct") &&
    r.parties.some((p) => p.role === "donor") &&
    r.photo_ids.length === 0 &&
    (r.photo_status ?? PHOTO_STATUS.NOT_ASKED) === PHOTO_STATUS.NOT_ASKED
  );
}
export function isClosed(r: Request): boolean {
  return ["closed", "cancelled", "rejected"].includes(r.status);
}
export function mutable(r: Request): void {
  if (
    r.status === "coordinated" ||
    isClosed(r) ||
    r.status === "cancel_pending"
  )
    throw new AppError(
      "request_protected",
      409,
      "הפנייה מוגנת משינוי. לפנייה חדשה יש לציין שמדובר בבקשה חדשה; לשינוי התיאום נעביר לטיפול אנושי.",
    );
}
export function ownParty(
  r: Request,
  phone: string,
  role?: "donor" | "receiver",
): Party {
  const own = r.parties.filter(
    (p) => p.phone === phone && (!role || p.role === role),
  );
  const p = own.find((x) => !x.name || !x.settlement || !x.address) ?? own[0];
  if (!p)
    throw new AppError(
      "forbidden_party",
      403,
      "אפשר לעדכן רק את הצד שלך בפנייה.",
    );
  return p;
}
export function itemError(items: Item[], hasPhoto: boolean): string | null {
  if (items.some((i) => i.kind === "piano" || i.kind === "house_move"))
    return "לא ניתן לסייע בהובלת פסנתרים או בהובלות דירה.";
  if (items.reduce((n, i) => n + i.quantity, 0) > 2)
    return "ניתן לסייע בהובלת עד שני פריטים. שולחן וכיסאות נחשבים פריט אחד.";
  if (items.some((i) => i.free === false))
    return "התוכנית מסייעת במסירה בחינם בלבד.";
  if (items.some((i) => i.working === false))
    return "ניתן למסור רק ציוד תקין ושמיש ב־100%.";
  if (
    hasPhoto &&
    items.some(
      (i) =>
        i.kind === "wardrobe" &&
        (i.needs_disassembly === true || i.wardrobe_small_whole === false),
    )
  )
    return "אין אצלנו פירוק והרכבה של ארונות. אפשר להעביר רק ארון קטן שניתן להעביר שלם.";
  return null;
}
export function appliance(i: Item): boolean {
  return [
    "fridge",
    "oven",
    "washing_machine",
    "dryer",
    "freezer",
    "dishwasher",
  ].includes(i.kind);
}
export type MissingRequired = {
  field: string;
  role: Role | null;
  request_number: number;
} | null;

function missingOf(
  r: Request,
  field: string,
  role: Role | null,
): MissingRequired {
  return { field, role, request_number: r.number };
}

/**
 * Own-party identity/location must be complete and items must already pass
 * program rules before we ask consent to contact the other party.
 */
export function itemsReadyForHandoff(r: Request): boolean {
  if (itemError(r.items, r.photo_ids.length > 0)) return false;
  return r.items.every(
    (i) =>
      i.free === true &&
      i.working === true &&
      (i.kind !== "wardrobe" || i.wardrobe_small_whole === true) &&
      (r.origin === "direct" || i.kind !== "oven" || i.oven_type !== null) &&
      (r.origin === "direct" ||
        appliance(i) ||
        i.kind === "wardrobe" ||
        i.needs_disassembly !== null) &&
      i.evacuation !== "different",
  );
}

export function ownPartyDetailsComplete(r: Request, phone: string): boolean {
  try {
    const p = ownParty(r, phone);
    return Boolean(
      p.approved_at &&
        p.approved_by === p.phone &&
        p.name &&
        p.settlement &&
        p.address &&
        p.floor !== null,
    );
  } catch {
    return false;
  }
}

/** Ask "contact the other party?" only after own details + transport rules. */
export function readyToAskContactCounterparty(
  r: Request,
  phone: string,
): boolean {
  if (
    r.origin !== "direct" ||
    r.represents_both_parties ||
    r.verification_contacted
  )
    return false;
  let role: Role | null = null;
  try {
    role = ownParty(r, phone).role;
  } catch {
    return false;
  }
  if (!r.parties.some((x) => x.role !== role)) return false;
  return ownPartyDetailsComplete(r, phone) && itemsReadyForHandoff(r);
}

export function nextQuestion(
  r: Request,
  phone: string,
): { text: string; floorNote: boolean; missing: MissingRequired } {
  if (r.status === "coordinated")
    return { text: statusText([r]), floorNote: false, missing: null };
  if (isClosed(r))
    return { text: `פנייה ${r.number} סגורה.`, floorNote: false, missing: null };
  if (r.status === "human")
    return { text: HUMAN_REPLY, floorNote: false, missing: null };
  const p = ownParty(r, phone);
  const donor = p.role === "donor";
  if (
    donor &&
    r.items.some(
      (i) => i.kind === "wardrobe" && i.wardrobe_small_whole !== true,
    )
  )
    return {
      text: "אפשר להעביר רק ארון קטן שניתן להעביר שלם, ללא פירוק והרכבה. האם זה ארון כזה?",
      floorNote: false,
      missing: missingOf(r, "wardrobe_small_whole", "donor"),
    };
  if (donor && r.items.some((i) => i.working === null))
    return {
      text: CONDITION_QUESTION,
      floorNote: false,
      missing: missingOf(r, "working", "donor"),
    };
  if (
    donor &&
    r.origin !== "direct" &&
    r.items.some((i) => i.kind === "oven" && i.oven_type === null)
  )
    return {
      text: "האם זה תנור בילט־אין או תנור משולב?",
      floorNote: false,
      missing: missingOf(r, "oven_type", "donor"),
    };
  if (
    donor &&
    r.origin !== "direct" &&
    r.items.some(
      (i) =>
        !appliance(i) && i.kind !== "wardrobe" && i.needs_disassembly === null,
    )
  )
    return {
      text: "האם נדרש פירוק של הפריט לצורך ההובלה?",
      floorNote: false,
      missing: missingOf(r, "needs_disassembly", "donor"),
    };
  if (!p.approved_at)
    return {
      text: `נא לאשר את חלקך ב${p.role === "donor" ? "מסירה" : "קבלה"} בפנייה ${r.number}. אישור חלקך נפרד מאישור מועד ההובלה.`,
      floorNote: false,
      missing: missingOf(r, "approved_at", p.role),
    };
  if (!p.settlement)
    return {
      text: donor
        ? "באיזה יישוב נמצא הפריט?"
        : "לאיזה יישוב צריך להעביר את הפריט?",
      floorNote: false,
      missing: missingOf(r, "settlement", p.role),
    };
  if (!p.name || !p.address)
    return {
      text:
        p.settlement === "בית שאן"
          ? !p.name
            ? p.address
              ? "תודה. חסר רק השם."
              : "נא לציין שם וכתובת."
            : "תודה. חסרה רק הכתובת המדויקת."
          : !p.name
            ? "נא לציין שם ותיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״."
            : "תודה. חסר רק תיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״.",
      floorNote: false,
      missing: missingOf(r, !p.name ? "name" : "address", p.role),
    };
  // Always ask floor — never invent קומה 0.
  if (p.floor === null)
    return {
      text: "באיזו קומה?",
      floorNote: !p.floor_note_shown,
      missing: missingOf(r, "floor", p.role),
    };
  if (r.items.some((i) => i.free === null))
    return {
      text: "האם הפריט נמסר בחינם, בלי תשלום?",
      floorNote: false,
      missing: missingOf(r, "free", "donor"),
    };
  // Contact / counterparty only after own details + item rules above.
  if (
    r.origin === "direct" &&
    !r.represents_both_parties &&
    !r.verification_contacted &&
    r.parties.some((x) => x.role !== p.role) &&
    itemsReadyForHandoff(r)
  )
    return {
      text: `האם תרצה שנפנה ל${donor ? "מקבל" : "מוסר"} לצורך אימות הפרטים?`,
      floorNote: false,
      missing: missingOf(r, "contact_counterparty", p.role),
    };
  if (!r.parties.some((x) => x.role !== p.role))
    return {
      text: donor
        ? r.origin === "direct"
          ? "נא לשלוח את מספר הטלפון של המקבל או כרטיס איש קשר, כדי שנוכל להמשיך בתיאום."
          : "האם יש מקבל מסוים? אם כן, נא לשלוח את מספרו או כרטיס איש קשר."
        : "נא לשלוח את מספר המוסר או כרטיס איש קשר.",
      floorNote: false,
      missing: missingOf(r, "counterparty", p.role),
    };
  const other = r.parties.find((x) => x.phone !== p.phone);
  // After consent to contact the other party — wait for their role approval.
  if (
    r.origin === "direct" &&
    r.verification_contacted &&
    other &&
    !other.approved_at
  )
    return {
      text: `ממתינים לאישור של ${other.name ?? (other.role === "receiver" ? "המקבל" : "המוסר")}. נעדכן כשיתקבל.`,
      floorNote: false,
      missing: missingOf(r, "approved_at", other.role),
    };
  const proposal = r.proposed_run_date;
  if (proposal && p.schedule_approved_date !== proposal) {
    const [year, month, day] = proposal.split("-");
    return {
      text: `הוצע מועד ההובלה ליום שלישי ${day}/${month}/${year}, בין 16:00–20:00. נא לאשר את המועד במפורש.`,
      floorNote: false,
      missing: missingOf(r, "schedule_approved_date", p.role),
    };
  }
  if (proposal && other && other.schedule_approved_date !== proposal)
    return {
      text: `אישרת את מועד ההובלה בפנייה ${r.number}. ממתינים לאישור המועד של הצד השני.`,
      floorNote: false,
      missing: missingOf(r, "schedule_approved_date", other.role),
    };
  return { text: "הפרטים נשמרו. נעדכן.", floorNote: false, missing: null };
}
export function readyToProposeSchedule(r: Request): boolean {
  if (
    ![
      "collecting",
      "available",
      "awaiting_approval",
      "waiting_capacity",
    ].includes(r.status) ||
    r.parties.length !== 2 ||
    (r.origin === "direct" && !r.represents_both_parties && !r.verification_contacted) ||
    itemError(r.items, true)
  )
    return false;
  return (
    r.parties.every((p) => p.approved_at && p.approved_by === p.phone && p.name && p.settlement && p.address) &&
    r.items.every(
      (i) =>
        i.free === true &&
        i.working === true &&
        (!["wardrobe"].includes(i.kind) || i.wardrobe_small_whole === true) &&
        (i.kind !== "oven" || i.oven_type !== null) &&
        (r.origin === "direct" ||
          appliance(i) ||
          i.kind === "wardrobe" ||
          i.needs_disassembly !== null) &&
        i.evacuation !== "different",
    )
  );
}
export function readyToCoordinate(r: Request): boolean {
  return Boolean(
    !r.run_date &&
    r.proposed_run_date &&
      readyToProposeSchedule(r) &&
      r.parties.every(
        (p) => p.approved_at && p.approved_by === p.phone && p.schedule_approved_date === r.proposed_run_date,
      ),
  );
}
export function localDate(now: Date): {
  date: string;
  day: number;
  hour: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    date,
    day: new Date(date + "T12:00:00Z").getUTCDay(),
    hour: Number(get("hour")),
  };
}
export function nextTuesday(
  now: Date,
  forceNextWeek = false,
): { date: string; sameDay: boolean } {
  const x = localDate(now);
  let delta = (2 - x.day + 7) % 7;
  if ((delta === 0 && x.hour >= 20) || forceNextWeek)
    delta = delta === 0 ? 7 : delta + 7;
  const d = new Date(x.date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return { date: d.toISOString().slice(0, 10), sameDay: delta === 0 };
}
export function statusText(requests: Request[]): string {
  if (!requests.length) return "לא נמצאו פניות פעילות עבורך.";
  const labels: Record<string, string> = {
    collecting: "בהשלמת פרטים",
    available: "ממתינה למקבל",
    awaiting_approval: "ממתינה לאישורים",
    waiting_capacity: "ממתינה למקום בהובלה",
    coordinated: "תואמה",
    closed: "הושלמה",
    cancelled: "בוטלה",
    rejected: "לא מתאימה",
    human: "בטיפול אנושי",
    cancel_pending: "ממתינה להחלטה לאחר ביטול",
  };
  const details = requests
    .map((r) => {
      const d = r.parties.find((p) => p.role === "donor"),
        v = r.parties.find((p) => p.role === "receiver");
      const line = `פנייה ${r.number}\nפריט: ${r.items.map((i) => i.description + (i.quantity > 1 ? ` ×${i.quantity}` : "")).join(", ")}`;
      const locations = (r.locations ?? []).map((l) =>
        `${l.role === "donor" ? "מיקום איסוף" : "מיקום יעד"}: https://www.waze.com/ul?ll=${l.latitude}%2C${l.longitude}&navigate=yes`,
      ).join("\n");
      const photos = r.photo_ids.length ? `\nתמונות שמורות: ${r.photo_ids.length} (יישלחו בהודעות נפרדות)` : "\nתמונות שמורות: אין";
      const verification = (r.verification_states ?? []).map((x) =>
        `${x.role === "donor" ? "מוסר" : "מקבל"}: ${x.state}`,
      ).join(" · ");
      const dateOnly = (value: string | null | undefined) => value?.slice(0, 10) ?? null;
      const proposedDate = dateOnly(r.proposed_run_date);
      const schedule = r.run_date
        ? `תאריך הובלה שאושר: ${r.run_date}`
        : proposedDate
          ? `מועד מוצע — ממתין לאישור: ${proposedDate} · ${r.parties.map((party) => `${party.role === "donor" ? "מוסר" : "מקבל"}: ${dateOnly(party.schedule_approved_date) === proposedDate ? "אישר/ה" : "ממתין/ה"}`).join(" · ")}`
          : "תאריך הובלה: טרם נקבע";
      return `${line}\nמצב: ${labels[r.status] ?? r.status}\nמוסר: ${d?.name ?? "—"} · ${d?.phone ?? "—"}\nאיסוף: ${d?.settlement ?? "—"}, ${d?.address ?? "—"}\nמקבל: ${v?.name ?? "—"} · ${v?.phone ?? "—"}\nיעד: ${v?.settlement ?? "—"}, ${v?.address ?? "—"}\n${locations ? `${locations}\n` : ""}${photos}\nאימות צד שני: ${verification || (r.verification_contacted ? "מצב קודם לא ודאי" : "טרם התבקש")}\n${schedule}\nחלון הובלה: 16:00–20:00 · בדרך כלל עד ${DEFAULT_TRANSPORT_CAPACITY} הובלות; תוספת דורשת אישור מנהל${r.status === "coordinated" ? "\nביום ההובלה ניצור קשר טלפוני לפני ההגעה" : ""}${r.human_reason ? `\nסיבת טיפול: ${r.human_reason}` : ""}`;
    })
    .join("\n\n");
  const coordinated = requests
    .filter((r) => r.status === "coordinated")
    .map((r) => ({
      r,
      pickup: r.locations?.find((x) => x.role === "donor"),
      target: r.locations?.find((x) => x.role === "receiver"),
    }))
    .filter((x) => x.pickup && x.target)
    .sort((a, b) =>
      `${a.r.run_date ?? "9999-99-99"}:${a.pickup!.latitude}:${a.pickup!.longitude}`
        .localeCompare(
          `${b.r.run_date ?? "9999-99-99"}:${b.pickup!.latitude}:${b.pickup!.longitude}`,
        ),
    );
  if (!coordinated.length) return details;
  const route = coordinated
    .map(
      ({ r, pickup, target }, i) =>
        `${i + 1}. פנייה ${r.number} (${r.run_date}) — איסוף https://www.waze.com/ul?ll=${pickup!.latitude}%2C${pickup!.longitude}&navigate=yes → יעד https://www.waze.com/ul?ll=${target!.latitude}%2C${target!.longitude}&navigate=yes`,
    )
    .join("\n");
  return `${details}\n\nהמלצת סדר הובלות לפי המפה:\n${route}`;
}
