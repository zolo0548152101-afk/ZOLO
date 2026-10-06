import type { Context } from "./types.js";
import {
  CONDITION_QUESTION,
  HUMAN_REPLY,
  OUTSIDE,
  PHOTO_FIRST,
  PHOTO_THANKS,
  norm,
} from "./policies.js";
import { CLARIFY_REPLY, FAULT_REPLY } from "./ai-guards.js";

export type CustomerLang = "he" | "en" | "ar" | "ru";

export const EMPATHY = "אני מבין, נעזור לך לטפל בזה.";
export const IMPOSSIBLE =
  "אי אפשר לקבוע הובלה מחוץ לחלון. ההובלות רק ביום שלישי בין 16:00 ל־20:00, בלי חריגים, ואי אפשר לעקוף את הכללים.";

const LINES: Record<string, Record<Exclude<CustomerLang, "he">, string>> = {
  [PHOTO_FIRST]: {
    en: "Happy to help. To continue, please send a photo of the item.",
    ar: "بكل سرور. للمتابعة، أرسل صورة الغرض.",
    ru: "Хорошо. Чтобы продолжить, пришлите фото предмета.",
  },
  [PHOTO_THANKS]: {
    en: "Thanks, the photo was received.",
    ar: "شكرًا، تم استلام الصورة.",
    ru: "Спасибо, фото получено.",
  },
  [CONDITION_QUESTION]: {
    en: "Is the item fully working and usable?",
    ar: "هل الغرض سليم وقابل للاستخدام بالكامل؟",
    ru: "Предмет полностью исправен и пригоден к использованию?",
  },
  [OUTSIDE]: {
    en: "We only operate in Beit She'an, Mesilot, Yardena, Beit Alfa, Tirat Zvi, Kfar Ruppin and Mechola. We can't help with this delivery.",
    ar: "نعمل فقط في بيت شان، مسيلوت، يردينا، بيت ألفا، تيرات تسفي، كفار روبين وماحولا. لا يمكننا المساعدة في هذا التوصيل.",
    ru: "Мы работаем только в Бейт-Шеане, Месилот, Ярдене, Бейт-Альфе, Тират-Цви, Кфар-Руппин и Мехоле. С этой доставкой помочь не сможем.",
  },
  [CLARIFY_REPLY]: {
    en: "I didn't understand. Could you write it again?",
    ar: "لم أفهم المقصود. هل يمكنك كتابته مرة أخرى؟",
    ru: "Я не понял. Напишите, пожалуйста, ещё раз.",
  },
  [HUMAN_REPLY]: {
    en: "I passed this to a person. We'll update you.",
    ar: "حوّلت الطلب لمتابعة بشرية. سنحدّثك.",
    ru: "Я передал обращение человеку. Мы сообщим.",
  },
  [FAULT_REPLY]: {
    en: "There's a temporary fault. We'll get back to you.",
    ar: "هناك عطل مؤقت. سنعود إليك.",
    ru: "Временный сбой. Мы свяжемся с вами.",
  },
  [EMPATHY]: {
    en: "I understand, and we'll help you sort this out.",
    ar: "أفهمك، وسنساعدك في معالجة هذا.",
    ru: "Я понимаю, и мы поможем с этим разобраться.",
  },
  [IMPOSSIBLE]: {
    en: "A delivery can't be set outside the window. Deliveries are only on Tuesday between 16:00 and 20:00, with no exceptions, and I can't bypass the rules.",
    ar: "لا يمكن تحديد توصيل خارج النافذة. التوصيل فقط يوم الثلاثاء بين 16:00 و20:00، بلا استثناءات، ولا يمكن تجاوز القواعد.",
    ru: "Доставку нельзя назначить вне окна. Доставки только во вторник с 16:00 до 20:00, без исключений, и правила обойти нельзя.",
  },
};

const ITEM_NAMES: Record<string, Record<Exclude<CustomerLang, "he">, string>> = {
  "כיסאות": { en: "chairs", ar: "كراسي", ru: "стулья" },
  "כיסא": { en: "chair", ar: "كرسي", ru: "стул" },
  "מקרר": { en: "fridge", ar: "ثلاجة", ru: "холодильник" },
  "מיטה": { en: "bed", ar: "سرير", ru: "кровать" },
  "ספה": { en: "sofa", ar: "أريكة", ru: "диван" },
  "ספרייה": { en: "bookcase", ar: "مكتبة", ru: "стеллаж" },
};

function scriptLanguage(text: string): CustomerLang | null {
  if (/[\u0600-\u06FF]/u.test(text)) return "ar";
  if (/[\u0400-\u04FF]/u.test(text)) return "ru";
  if (/[\u0590-\u05FF]/u.test(text)) return "he";
  if (/[A-Za-z]/.test(text)) return "en";
  return null;
}

export function conversationLanguage(ctx: Pick<Context, "message" | "history">): CustomerLang {
  const current = scriptLanguage(ctx.message.transcript ?? ctx.message.text);
  if (current) return current;
  for (const entry of [...ctx.history].reverse()) {
    if (entry.role !== "user") continue;
    const found = scriptLanguage(entry.content);
    if (found) return found;
  }
  return "he";
}

function itemLabel(name: string, lang: Exclude<CustomerLang, "he">): string {
  return ITEM_NAMES[name.trim()]?.[lang] ?? name;
}

export function isCustomerClarify(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed === CLARIFY_REPLY) return true;
  const translated = LINES[CLARIFY_REPLY];
  if (!translated) return false;
  return trimmed === translated.en || trimmed === translated.ar || trimmed === translated.ru;
}

export function localizeCustomer(text: string, lang: CustomerLang): string {
  if (lang === "he" || !text) return text;
  const direct = LINES[text];
  if (direct) return direct[lang];
  const cancel = text.match(/^פנייה (\d+) בוטלה: (.+)\. לא תתואם הובלה\.$/u);
  if (cancel) {
    const items = cancel[2]!.split(/,\s*/u).map((item) => itemLabel(item, lang)).join(", ");
    if (lang === "en") return `Request ${cancel[1]} was cancelled: ${items}. No delivery will be scheduled.`;
    if (lang === "ar") return `أُلغي الطلب ${cancel[1]}: ${items}. لن يتم تحديد توصيل.`;
    return `Заявка ${cancel[1]} отменена: ${items}. Доставка не будет назначена.`;
  }
  if (text.includes("\n"))
    return text.split("\n").map((line) => localizeCustomer(line, lang)).join("\n");
  return text;
}

/** Angry or impossible scheduling pressure. Not an unclear message. */
export function pressureCanonical(text: string): string | null {
  const t = norm(text);
  const angry = /(?:דיי עם השטויות|די עם השטויות|נמאס|מספיק עם|עצבנ)/u.test(t);
  const bypass =
    /(?:תתעלם מההוראות|תתעלם מהכללים|לעקוף את הכללים)/u.test(t) ||
    /ignore your instructions|bypass the rules/i.test(text);
  const schedulePressure =
    /(?:תקבע|לקבוע|הובלה)/u.test(t) &&
    /(?:דחוף|עכשיו|מיידי|יום ראשון|יום שישי|יום שני|יום רביעי|יום חמישי|יום שבת)/u.test(t);
  const manager =
    /המנהל אמר/u.test(t) && /(?:מותר|לקבוע|שישי|ראשון|חריג)/u.test(t);
  const englishDay =
    /\b(?:book|schedule)\b/i.test(text) && /\b(?:sunday|friday|monday|saturday)\b/i.test(text);
  const englishManager =
    /manager said/i.test(text) && /\b(?:sunday|friday|allowed|exception)\b/i.test(text);
  const impossible = bypass || schedulePressure || manager || englishDay || englishManager;
  if (!angry && !impossible) return null;
  const parts: string[] = [];
  if (angry) parts.push(EMPATHY);
  if (impossible) parts.push(IMPOSSIBLE);
  return parts.join("\n");
}
