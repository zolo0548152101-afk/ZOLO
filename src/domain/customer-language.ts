import type { Context } from "./types.js";
import { OUTSIDE, norm } from "./policies.js";
import { CLARIFY_REPLY, FAULT_REPLY } from "./ai-guards.js";

export type CustomerLang = "he" | "en" | "ar" | "ru";

/** Minimal translations for the only fixed customer lines still allowed. */
const LINES: Record<string, Record<Exclude<CustomerLang, "he">, string>> = {
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
  [FAULT_REPLY]: {
    en: "There's a temporary fault. We'll get back to you.",
    ar: "هناك عطل مؤقت. سنعود إليك.",
    ru: "Временный сбой. Мы свяжемся с вами.",
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

/** @deprecated Code no longer injects pressure sentences — Reply manager owns wording. */
export function pressureCanonical(_text: string): string | null {
  return null;
}

/** Kept for tests that still import detection helpers via this module. */
export function pressureSignals(text: string): { angry: boolean; impossible: boolean } {
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
  return { angry, impossible };
}
