import {
  AppError,
  type Request,
  type Item,
  type Party,
  type Plan,
} from "./types.js";
export const OUTSIDE =
  "תוכנית חיים יחד פועלת בבית שאן וביישובים הסמוכים בלבד. מאחר שאחת מנקודות ההובלה נמצאת מחוץ לאזור הפעילות, לא נוכל לסייע בהובלה הזו.";
export const PHOTO_THANKS = "תודה, התמונה התקבלה.";
export const PHOTO_FIRST = "בשמחה. כדי להמשיך, נא לשלוח תמונה של הפריט.";
export const GREETING =
  "שלום וברוכים הבאים לתוכנית חיים יחד 😊\nאיך אפשר לעזור — למסור פריט, לקבל פריט או לתאם הובלה?";
export const HUMAN_REPLY = "העברתי את הפנייה לטיפול אנושי. נעדכן.";
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
  return /^(?:מה\s+(?:מצב\s+(?:התיאום|ההובלה)|(?:ה)?סטטוס)|מה קורה עם ההובלה|מתי (?:ההובלה|מגיעים))(?:\s+\d+)?[?？!\s]*$/.test(
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
  return /^(?:כן|מאשר|מאשרת|אני מאשר|אני מאשרת|מאושר|מסכים|מסכימה)(?:[\s.,!]|$)/.test(
    norm(t),
  );
}
export function donationIntent(t: string): boolean {
  return /(?:למסירה|לתרומה|למסור|לתרום|מוסר|מוסרת|להעביר|מעביר|מעבירה|יש לי להעביר)/.test(
    t,
  );
}
export function directHandoffIntent(t: string): boolean {
  return /(?:להעביר(?:\s+.{1,80})?\s+ל(?:מישהו|מישהי|אדם)|למסור(?:\s+.{1,80})?\s+ל(?:מישהו|מישהי|אדם)|מקבל(?:ת)?\s+(?:מסוים|מוגדר))/.test(
    norm(t),
  );
}
export function grounded(plan: Plan, text: string): boolean {
  return (
    plan.commands.every((c) => c.type === "status" || c.type === "next") ||
    (plan.evidence.length > 0 && text.includes(plan.evidence))
  );
}
export function photoGate(r: Request): boolean {
  return (
    r.origin === "donation" &&
    r.parties.some((p) => p.role === "donor") &&
    !r.parties.some((p) => p.role === "receiver") &&
    r.photo_ids.length === 0
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
export function nextQuestion(
  r: Request,
  phone: string,
): { text: string; floorNote: boolean } {
  if (r.status === "coordinated")
    return { text: statusText([r]), floorNote: false };
  if (isClosed(r))
    return { text: `פנייה ${r.number} סגורה.`, floorNote: false };
  if (r.status === "human") return { text: HUMAN_REPLY, floorNote: false };
  const p = ownParty(r, phone);
  const donor = p.role === "donor";
  if (
    r.origin === "direct" &&
    !r.verification_contacted &&
    r.parties.some((x) => x.role !== p.role)
  )
    return {
      text: `האם תרצה שנפנה ל${donor ? "מקבל" : "מוסר"} לצורך אימות הפרטים?`,
      floorNote: false,
    };
  if (r.origin === "direct" && !r.parties.some((x) => x.role !== p.role))
    return {
      text: `האם תרצה שנפנה ל${donor ? "מקבל" : "מוסר"} לצורך אימות הפרטים? אם כן, נא לשלוח מספר טלפון או כרטיס איש קשר.`,
      floorNote: false,
    };
  if (
    donor &&
    r.items.some(
      (i) => i.kind === "wardrobe" && i.wardrobe_small_whole !== true,
    )
  )
    return {
      text: "אפשר להעביר רק ארון קטן שניתן להעביר שלם, ללא פירוק והרכבה. האם זה ארון כזה?",
      floorNote: false,
    };
  if (donor && r.items.some((i) => i.working === null))
    return {
      text: "האם הפריט תקין ושמיש ב־100%?",
      floorNote: false,
    };
  if (donor && r.items.some((i) => i.kind === "oven" && i.oven_type === null))
    return { text: "האם זה תנור בילט־אין או תנור משולב?", floorNote: false };
  if (
    donor &&
    r.items.some(
      (i) =>
        !appliance(i) && i.kind !== "wardrobe" && i.needs_disassembly === null,
    )
  )
    return { text: "האם נדרש פירוק של הפריט לצורך ההובלה?", floorNote: false };
  if (!p.approved_at || !p.schedule_approved)
    return {
      text: `נא לאשר את חלקך ב${p.role === "donor" ? "מסירה" : "קבלה"} בפנייה ${r.number}. ההובלות בימי שלישי בין 16:00–20:00. נעדכן.`,
      floorNote: false,
    };
  if (!p.settlement)
    return {
      text: donor
        ? "באיזה יישוב נמצא הפריט?"
        : "לאיזה יישוב צריך להעביר את הפריט?",
      floorNote: false,
    };
  if (!p.name || !p.address)
    return {
      text:
        p.settlement === "בית שאן"
          ? (!p.name
              ? "נא לציין שם וכתובת."
              : "תודה. חסרה רק הכתובת המדויקת.") +
            (!p.floor_note_shown ? " בבניין עם קומות — לציין קומה." : "")
          : !p.name
            ? "נא לציין שם ותיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״."
            : "תודה. חסר רק תיאור כללי של המקום ביישוב, למשל ״בכניסה״ או ״ליד המזכירות״.",
      floorNote: p.settlement === "בית שאן" && !p.floor_note_shown,
    };
  if (!r.parties.some((x) => x.role !== p.role))
    return {
      text: donor
        ? "האם יש מקבל מסוים? אם כן, נא לשלוח את מספרו או כרטיס איש קשר."
        : "נא לשלוח את מספר המוסר או כרטיס איש קשר.",
      floorNote: false,
    };
  return { text: "הפרטים נשמרו. נעדכן.", floorNote: false };
}
export function readyToCoordinate(r: Request): boolean {
  if (
    ![
      "collecting",
      "available",
      "awaiting_approval",
      "waiting_capacity",
    ].includes(r.status) ||
    r.parties.length !== 2 ||
    itemError(r.items, true)
  )
    return false;
  return (
    r.parties.every(
      (p) =>
        p.approved_at &&
        p.approved_by === p.phone &&
        p.schedule_approved &&
        p.name &&
        p.settlement &&
        p.address,
    ) &&
    r.items.every(
      (i) =>
        i.free === true &&
        i.working === true &&
        (!["wardrobe"].includes(i.kind) || i.wardrobe_small_whole === true) &&
        (i.kind !== "oven" || i.oven_type !== null) &&
        (appliance(i) ||
          i.kind === "wardrobe" ||
          i.needs_disassembly !== null) &&
        i.evacuation !== "different",
    )
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
  return requests
    .map((r) => {
      const d = r.parties.find((p) => p.role === "donor"),
        v = r.parties.find((p) => p.role === "receiver");
      const line = `פנייה ${r.number}\nפריט: ${r.items.map((i) => i.description + (i.quantity > 1 ? ` ×${i.quantity}` : "")).join(", ")}`;
      return `${line}\nמצב: ${labels[r.status] ?? r.status}\nמוסר: ${d?.name ?? "—"} · ${d?.phone ?? "—"}\nאיסוף: ${d?.settlement ?? "—"}, ${d?.address ?? "—"}\nמקבל: ${v?.name ?? "—"} · ${v?.phone ?? "—"}\nיעד: ${v?.settlement ?? "—"}, ${v?.address ?? "—"}\nאימות צד שני: ${r.verification_contacted ? "נשלחה פנייה" : "טרם התבקש"}\nתאריך הובלה: ${r.run_date ?? "טרם נקבע"}\nחלון הובלה: 16:00–20:00${r.status === "coordinated" ? "\nביום ההובלה ניצור קשר טלפוני לפני ההגעה" : ""}${r.human_reason ? `\nסיבת טיפול: ${r.human_reason}` : ""}`;
    })
    .join("\n\n");
}
