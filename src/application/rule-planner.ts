/**
 * Deterministic rule planner — TEST / FIXTURE ONLY.
 * Production Action Manager owns planning; this file must not be imported by
 * runtime engine paths (`engine.ts`, `commands.ts`, `ai.ts`).
 */
import type { Command, Context, ItemKind, Plan, Request } from "../domain/types.js";
import {
  appliance,
  canonicalPhone,
  donationIntent,
  seekIntent,
  customerCancelIntent,
  mentionedAllowedSettlement,
  mentionedReviewSettlement,
  directHandoffIntent,
  explicitApproval,
  ambiguousStreetCity,
  streetPhrase,
  norm,
  ownParty,
} from "../domain/policies.js";

const openRequests = (ctx: Context): Request[] =>
  (ctx.requests ?? []).filter(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );

const partyNeedsApproval = (request: Request, phone: string): boolean => {
  try {
    return !ownParty(request, phone).approved_at;
  } catch {
    return false;
  }
};

const activeRequest = (ctx: Context): Request | undefined => {
  const requests = ctx.requests ?? [];
  const open = openRequests(ctx);
  const selected = requests.find((r) => r.id === ctx.conversation?.selected_request_id);
  const phone = ctx.conversation?.phone;
  const text = (ctx.message?.transcript ?? ctx.message?.text ?? "").trim();
  // A recipient can receive a new verification message before a conversation
  // row exists for that chat. On their first reply prefer the sole open
  // request over an older coordinated request that happens to be selected.
  if (open.length === 1) return open[0];
  // Stale selected open requests (older handoffs still collecting) must not
  // swallow an explicit approval meant for a newer request that still needs
  // this party's consent. Prefer the sole open request still awaiting them.
  if (
    phone &&
    text &&
    (explicitApproval(text) ||
      /מאשר(?:ת)?\s+(?:ליצור(?:\s+אית(?:ה|ו))?\s+קשר|לפנות)/u.test(norm(text)))
  ) {
    const needing = open.filter((request) => partyNeedsApproval(request, phone));
    if (needing.length === 1) return needing[0];
    if (
      selected &&
      needing.some((request) => request.id === selected.id)
    )
      return selected;
  }
  if (selected && open.some((request) => request.id === selected.id)) return selected;
  return selected ?? (requests.length === 1 ? requests[0] : undefined);
};

const yes = (text: string): boolean =>
  /^(?:כן|בטח|בוודאי|נכון|מאשר|מאשרת)(?:[\s,!.]|$)/.test(norm(text));
const no = (text: string): boolean =>
  /^(?:לא|אין)(?:[\s,!.]|$)/.test(norm(text));
/** Affirmatives about a schedule/receipt must not answer item-fact yes/no gates. */
const itemFactYesNo = (text: string): boolean =>
  (yes(text) || no(text)) &&
  !/(?:מועד|תאריך|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|לקבל|הקבלה|הפרטים)/u.test(
    norm(text),
  );

function kindAndDescription(text: string): { kind: ItemKind; description: string } | null {
  const match: [RegExp, ItemKind, string][] = [
    [/מיקרוגל|\bmicrowaves?\b/i, "other", "מיקרוגל"],
    [/\bfridges?\b|\brefrigerators?\b/i, "fridge", "מקרר"],
    [/ثلاج/u, "fridge", "מקרר"],
    [/холодильник/iu, "fridge", "מקרר"],
    [/диван/iu, "sofa", "ספה"],
    [/\bbeds?\b/i, "bed", "מיטה"],
    [/\bsofas?\b|\bcouches?\b/i, "sofa", "ספה"],
    // מטה is the common missing-י typo for מיטה in live WhatsApp traffic.
    [/מיטה|(?:^|[^\u05D0-\u05EA])מטה(?=[^\u05D0-\u05EA]|$)/iu, "bed", "מיטה"],
    [/שידה/i, "other", "שידה"],
    [/מנורת?\s*שולחן|מנורה/i, "other", "מנורה"],
    [/גוף\s*תאורה/i, "other", "גוף תאורה"],
    [/כוננית|מדף/i, "other", "מדף"],
    [/ספרייה|ספריה/i, "other", "ספרייה"],
    [/שטיח/i, "other", "שטיח"],
    [/טלוויז|מסך/i, "other", "טלוויזיה"],
    [/מחשב|לפטופ/i, "other", "מחשב"],
    [/אופניים/i, "other", "אופניים"],
    [/ספה|כורס/i, "sofa", "ספה"],
    [/ארון/i, "wardrobe", "ארון"],
    [/מקרר/i, "fridge", "מקרר"],
    [/תנור/i, "oven", "תנור"],
    [/מכונת כביסה/i, "washing_machine", "מכונת כביסה"],
    [/מייבש/i, "dryer", "מייבש"],
    [/מקפיא/i, "freezer", "מקפיא"],
    [/מדיח/i, "dishwasher", "מדיח"],
    [/שולחן.*כיס|כיס.*שולחן/i, "table_set", "שולחן וכיסאות"],
    [/שולחן/i, "table", "שולחן"],
    [/כיסאות|כיסא/i, "chairs", "כיסאות"],
  ];
  const found = match.find(([pattern]) => pattern.test(text));
  if (found) return { kind: found[1], description: found[2] };
  // Direct handoffs often name uncommon items ("יש לי מנורה…"). Keep them
  // deterministic as `other` so they open a new request instead of mutating
  // an unrelated open donation.
  const inferred = norm(text).match(
    /יש\s+לי\s+([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){0,3})(?=\s+(?:תקינ|קטנ|גדול|למסירה|למסור|ישירות|למספר)|[,.!]|$)/u,
  );
  if (!inferred?.[1]) return null;
  const description = inferred[1].trim();
  if (
    /^(?:גם|עוד|רק|כבר|כאן|שם|תמונה|כתובת|קומה|בית|רחוב)$/u.test(description) ||
    beitShean(description)
  )
    return null;
  return { kind: "other", description };
}

const plan = (text: string, commands: Command[]): Plan => ({
  commands,
  evidence: text.slice(0, 2000),
});

function floor(text: string): number | null {
  const t = norm(text);
  // Customer may answer a floor ask with bare «קרקע» / «קומת קרקע».
  if (/קומת?\s*קרקע|(?:^|[\s,])קרקע(?:[\s,!.]|$)/u.test(t)) return 0;
  const matches = [...t.matchAll(/קומה\s*(-?\d+)/g)];
  const match = matches.at(-1);
  if (match) return Number(match[1]);
  // An apartment number is not a floor. Never invent קומה from «דירה N».
  return null;
}

function preferredTime(text: string): string | null {
  const match = norm(text).match(
    /(?:אחרי|לפני|בשעה|סביב)\s+\d{1,2}(?::\d{2})?|בין\s+\d{1,2}\s*[-–]\s*\d{1,2}/u,
  );
  return match?.[0] ?? null;
}

/** "מאשר ליצור קשר" often trails an address line with no punctuation. */
function contactConsent(text: string): boolean {
  return /מאשר(?:ת)?\s+(?:ליצור(?:\s+אית(?:ה|ו))?\s+קשר|לפנות)/u.test(norm(text));
}

function beitShean(text: string): string | null {
  const cleaned = text
    .replace(/(?:ליד|קרוב\s*ל?|באזור|סמוך\s*ל?)\s*בית\s*[-־]?\s*שאן/gu, " ")
    .replace(/\bnear\s+beit\s+she'?an\b/gi, " ");
  if (
    /בית\s*[-־]?\s*שאן/.test(cleaned) ||
    /\bbeit\s+she'?an\b/i.test(cleaned) ||
    /بيت\s*شان|بيسان|бейт[\s-]*шеан/iu.test(cleaned)
  )
    return "בית שאן";
  return null;
}

/** First comma-separated place token, e.g. "טבריה" in "טבריה, רחוב …". */
function leadingSettlement(text: string): string | null {
  const first = norm(text)
    .split(/[,;]/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!first) return null;
  if (/^(?:רחוב|שכונת|שכונה|שיכון|שדרות|שד[׳']?)(?:\s|$)/u.test(first)) return null;
  if (/^קומה\s*-?\d+/u.test(first)) return null;
  const beit = beitShean(first);
  if (beit) return beit;
  if (!/^[א-ת][א-ת\s\-]{1,40}$/u.test(first)) return null;
  return first;
}

function addressWithSettlement(text: string): string | null {
  const match = norm(text).match(
    /(?:[,;]\s*|בית\s*[-־]?\s*שאן\s+)((?:רחוב|שכונת|שכונה|שיכון|שדרות|שד[׳']?)\s+.+)$/,
  );
  return match?.[1]?.trim() ?? null;
}

function explicitName(text: string): string | null {
  const normalized = norm(text);
  const match = normalized.match(
    /(?:^|[,;.!?]\s*)(?:השם(?:\s+(?:הוא|שלי))?|שמי|קוראים\s+לי)\s+([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){0,2})(?=\s*(?:[,;.!?]|$))/u,
  );
  if (match?.[1]) {
    const name = match[1].trim();
    return looksLikePersonName(name) ? name : null;
  }
  const introduction = normalized.match(
    /(?:^|[.!?]\s*)אני\s+([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*)?)(?=\s*(?:[,;.!?]|$)|(?:\s+(?:ו)?מאשר))/u,
  );
  if (!introduction?.[1]) return null;
  const name = introduction[1].trim();
  if (
    /^(?:רוצה|צריך|צריכה|מוסר|מוסרת|מעביר|מעבירה|מחפש|מחפשת|מבקש|מבקשת|מאשר|מאשרת)(?:\s|$)/.test(
      name,
    )
  )
    return null;
  return looksLikePersonName(name) ? name : null;
}

function looksLikePersonName(name: string): boolean {
  const value = norm(name);
  if (!value) return false;
  if (
    /(?:מאשר|מאשרת|מועד|המועד|הפרטים|כתובת|איסוף|מסירה|ליצור|קשר|שלישי|רביעי)/u.test(
      value,
    )
  )
    return false;
  return /^[א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){0,2}$/u.test(value);
}

function addressAndName(text: string): { address: string; name: string | null } | null {
  const normalized = norm(text);
  const pickupContext = /^(?:לגבי\s+)?(?:האיסוף|כתובת\s+האיסוף)\s*[:,-]?\s*/u.test(normalized);
  const locationText = normalized.replace(
    /^(?:לגבי\s+)?(?:האיסוף|כתובת\s+האיסוף)\s*[:,-]?\s*/u,
    "",
  );
  const parts = locationText
    .replace(/בית\s*[-־]?\s*שאן/g, "")
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 1) return null;
  const markedStreet = /^(?:רחוב|שכונת|שכונה|שיכון|שדרות|שד[׳']?)(?:\s|$)/u.test(parts[0]!);
  const unmarkedPickupStreet = pickupContext
    ? parts[0]!.match(/^([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){1,4})\s+(\d+[א-ת]?(?:\/\d+)?)$/u)
    : null;
  if (!markedStreet && !unmarkedPickupStreet) return null;
  const address = markedStreet
    ? parts[0]!
    : `רחוב ${unmarkedPickupStreet![1]} ${unmarkedPickupStreet![2]}`;
  // A floor supplied after the address is a location field, never a person's
  // name. This matters when a recipient answers in a second message such as
  // "בית שאן, רחוב המלך 5, קומה 2".
  const name =
    explicitName(locationText) ??
    (parts
      .slice(1)
      .filter((part) => !/^קומה\s*-?\d+\.?$/u.test(part))
      .join(" ")
      .trim() || null);
  return { address, name };
}

function selfTransferName(text: string, markerIndex: number): string | null {
  const prefix = text.slice(0, markerIndex).trim();
  const match = prefix.match(
    /(?:^|[,.،]\s*)אני\s+([א-ת][א-ת׳״'’.-]*?(?:\s+[א-ת][א-ת׳״'’.-]*?){0,3})(?=\s*(?:[,،]|וישלי|(?<!ו)ישלי|ויש\s+לי|(?<!ו)יש\s+לי|צריך|צריכה|רוצה|מבקש|מבקשת|מתכוון|מתכוונת))/u,
  );
  return match?.[1]?.trim() ?? null;
}

function placeFromFragment(value: string): {
  settlement: string | null;
  address: string | null;
  floor: number | null;
} {
  const cleaned = norm(value)
    .replace(/\s+(?:מאשר(?:ת)?|ואפשר|אפשר)\b.*$/u, "")
    .trim();
  const settlement = beitShean(cleaned);
  const streetToken = String.raw`(?!(?:קומה|דירה|בית)(?:\s|$))[א-ת][א-ת׳״'’\-]*`;
  const withHouse = cleaned.match(
    new RegExp(
      String.raw`((?:רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)\s+${streetToken}(?:\s+${streetToken}){0,3}\s+\d+[א-ת]?)`,
      "u",
    ),
  );
  const withoutHouse = cleaned.match(/(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)\s+[^,.;?]+/u);
  const bare = cleaned.match(
    new RegExp(
      String.raw`(?:^|[\s,;])(?!(?:בית|רחוב|שיכון|שכונה|שכונת|שדרות|שד|קומה|דירה)\b)(${streetToken}(?:\s+${streetToken}){0,3})\s+(\d+[א-ת]?)`,
      "u",
    ),
  );
  const address =
    withHouse?.[1]?.trim() ??
    withoutHouse?.[0]
      ?.replace(/\s+ב?בית\s*[-־]?\s*שאן.*$/u, "")
      .replace(/\s+(?:קומה|ק[׳']|דירה)\s*-?\d+(?:\s+עם\s+מעלית)?\s*$/u, "")
      .trim() ??
    (bare?.[1] && bare[2] ? `רחוב ${bare[1].trim()} ${bare[2]}` : null);
  return { settlement, address, floor: floor(cleaned) };
}

function sameOtherItem(existingDescription: string, nextDescription: string): boolean {
  const a = norm(existingDescription).replace(/\s+/g, "");
  const b = norm(nextDescription).replace(/\s+/g, "");
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

/** Parses "איסוף …, מסירה …" (and self-transfer pickup/dropoff) into two location facts. */
function pickupAndDeliveryDetails(text: string, name: string | null = null): Command[] | null {
  const normalized = norm(text);
  const labeled = normalized.match(
    /איסוף\s+(?<origin>.+?)(?:,\s*)?מסירה\s+(?<destination>.+?)(?=(?:[.!?]|[,\s]+(?:מאשר|ואפשר|אפשר)|$))/u,
  );
  const pickupDropoff = normalized.match(
    /אוספים\s+מ(?<origin>.+?)(?:,\s*)?ו?מביאים\s+ל(?<destination>.+?)(?=[.!?]|$)/u,
  );
  let originText = labeled?.groups?.origin?.trim() ?? pickupDropoff?.groups?.origin?.trim() ?? null;
  let destinationText =
    labeled?.groups?.destination?.trim() ?? pickupDropoff?.groups?.destination?.trim() ?? null;
  if (!originText || !destinationText) {
    const start = normalized.search(/מ(?=(?:בית\s*[-־]?\s*שאן|רחוב|שיכון|שכונה|שדרות|שד[׳']?))/u);
    if (start >= 0) {
      const originStart = start + 1;
      const destinationMatch = normalized
        .slice(originStart)
        .match(/\s+ל(?=(?:בית\s*[-־]?\s*שאן|רחוב|שיכון|שכונה|שדרות|שד[׳']?))/u);
      if (destinationMatch?.index !== undefined) {
        originText = normalized.slice(originStart, originStart + destinationMatch.index).trim();
        destinationText = normalized
          .slice(originStart + destinationMatch.index + destinationMatch[0].length)
          .trim();
      }
    }
  }
  if (!originText || !destinationText) return null;
  const origin = placeFromFragment(originText);
  const destination = placeFromFragment(destinationText);
  // Labeled איסוף/מסירה almost always omits the city on WhatsApp. Default to
  // בית שאן (the only in-area settlement) so both endpoints persist.
  const originSettlement = origin.settlement ?? (origin.address ? "בית שאן" : null);
  const destinationSettlement =
    destination.settlement ?? originSettlement ?? (destination.address ? "בית שאן" : null);
  if (!originSettlement || !origin.address || !destinationSettlement || !destination.address)
    return null;
  return [
    {
      type: "details",
      request_number: null,
      role: "donor",
      name,
      settlement: originSettlement,
      address: origin.address,
      floor: origin.floor,
    },
    {
      type: "details",
      request_number: null,
      role: "receiver",
      name,
      settlement: destinationSettlement,
      address: destination.address,
      floor: destination.floor,
    },
  ];
}

function selfTransferDetails(text: string): Command[] | null {
  const self = text.match(/(?:מעביר|מעבירה|להעביר|רוצה להעביר)\s+(?:לעצמי|אליי)/u);
  if (!self) return null;
  const name = selfTransferName(text, self.index!);
  return pickupAndDeliveryDetails(text.slice(self.index! + self[0].length), name);
}

function suppliedPartyLocation(text: string, role: "donor" | "receiver"): Command | null {
  const normalized = norm(text);
  const pickup = normalized.match(/(?:האיסוף|כתובת\s+האיסוף)\s*[:,-]?\s*מ?(.+?)(?=[.!?]|$)/u);
  if (pickup?.[1]) {
    const pickupText = pickup[1].trim();
    const settlement = beitShean(normalized);
    const street = pickupText.replace(/^רחוב\s+/u, "").match(/^([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){0,4})\s+(\d+[א-ת]?(?:\/\d+)?)/u);
    if (settlement && street) {
      const introduced = normalized.match(/אני\s+([א-ת]{2,})(?=\s+(?:מבית|בבית)\s*[-־]?\s*שאן)/u);
      return {
        type: "details",
        request_number: null,
        role,
        name: introduced?.[1] ?? null,
        settlement,
        address: `רחוב ${street[1]} ${street[2]}`,
        floor: floor(pickupText),
        ...(preferredTime(text) ? { preferred_time: preferredTime(text) } : {}),
      };
    }
  }
  const settlement = beitShean(text);
  const address = text
    .match(/(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)\s+[^,.;?]+/u)?.[0]
    ?.replace(
      /\s+(?:קומה|ק[׳'])\s*-?\d+(?:\s+עם\s+מעלית)?\s*$/u,
      "",
    )
    .trim();
  if (!settlement || !address) return null;
  return {
    type: "details",
    request_number: null,
    role,
    name: null,
    settlement,
    address,
    floor: floor(text),
    ...(preferredTime(text) ? { preferred_time: preferredTime(text) } : {}),
  };
}

function namedRecipientPhone(text: string): string | null {
  const match = text.match(
    /(?:למקבל(?:ת)?|מקבל(?:ת)?(?:\s+מספר)?|אל|(?:^|[\s,])ל)\s*[:־-]?\s*([+\d\s().-]{8,})/,
  );
  if (!match?.[1]) return null;
  try {
    return canonicalPhone(match[1]);
  } catch {
    return null;
  }
}

function standalonePhone(text: string): string | null {
  const candidates = text.match(/(?:\+?972|0)?[\d][\d\s().-]{7,14}\d/g) ?? [];
  for (const candidate of candidates) {
    try {
      return canonicalPhone(candidate);
    } catch {
      // Keep looking; a message can contain other numeric text.
    }
  }
  return null;
}

function contactCardName(text: string): string | null {
  return text.match(/(?:^|[\r\n])FN:([^\r\n]+)/i)?.[1]?.trim() || null;
}

function namedRecipientName(text: string): string | null {
  const names = [...norm(text).matchAll(/(?:^|\s)ל([א-ת]{2,})(?=$|[\s,.;!?])/gu)]
    .map((match) => match[1]!)
    .filter(
      (name) =>
        ![
          "מסירה",
          "תרומה",
          "מישהו",
          "מישהי",
          "אדם",
          "בית",
          "עפולה",
          "צמח",
          "קרקע",
          "עצמי",
          "אליי",
          // Infinitive stems after ל־ (להעביר / למסור / לקבל…)
          "העביר",
          "העבירה",
          "מסור",
          "מסורה",
          "קבל",
          "קבלת",
          "תת",
          "תרום",
          "תאאם",
          "תאם",
          "חפש",
          "חפשת",
        ].includes(name),
    );
  return names.at(-1) ?? null;
}

function directLocationRole(text: string): "donor" | "receiver" {
  const normalized = norm(text);
  if (/(?:כתובת\s+היעד|(?:^|[\s,;])יעד(?:\s|$)|כתובת\s+המקבל|אצל\s+(?:המקבל|המקבלת))/u.test(normalized))
    return "receiver";
  if (/(?:האיסוף|כתובת\s+האיסוף|הפריט\s+(?:נמצא|נמצאת)|אצלי)/u.test(normalized))
    return "donor";
  const recipientName = namedRecipientName(text);
  if (!recipientName) return "donor";
  const recipientIndex = normalized.lastIndexOf(`ל${recipientName}`);
  const locationIndex = normalized.search(/(?:ב?בית\s*[-־]?\s*שאן|רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)/u);
  if (recipientIndex < 0 || locationIndex <= recipientIndex) return "donor";
  const between = normalized.slice(recipientIndex, locationIndex);
  return /(?:אצלי|איסוף|נמצא|נמצאת|מהבית\s+שלי|(?:^|\s)(?:היא|הוא|הפריט|המיטה|השידה)(?:\s|$))/u.test(between)
    ? "donor"
    : "receiver";
}

function hasPartialNamedHandoff(ctx: Context): boolean {
  const recent = ctx.history
    .filter((entry) => entry.role === "user")
    .slice(-3)
    .map((entry) => entry.content)
    .join("\n");
  return /(?:למסור|להעביר|מוסר|מוסרת|מעביר|מעבירה)\s+(?:את\s+)?(?:הפריט|הרהיט|רהיט|מיטה|שולחן|ספה|כיסא|ארון)?\s*ל[א-ת]{1,}(?:\s|$)/.test(norm(recent));
}

/**
 * Handles the predictable parts of the conversation without an external model.
 * Returning null intentionally delegates only genuinely free-form language to AI.
 */
function replaceExtraChoice(text: string): "replace" | "add" | null {
  const t = norm(text);
  if (/^(?:במקום|להחליף|החלף|תחת)(?:\s|$)/u.test(t) || /(?:^|[\s,])במקום(?:[\s,]|$)/u.test(t))
    return "replace";
  if (
    /^(?:בנוסף|גם|ועוד)(?:\s|$)/u.test(t) ||
    /(?:^|[\s,])בנוסף(?:[\s,]|$)/u.test(t) ||
    /פריט\s+נוסף|עוד\s+פריט/.test(t)
  )
    return "add";
  return null;
}

function recipientExtraChoice(text: string): "same" | "other" | null {
  const t = norm(text);
  if (/אותו\s+מקבל|לאותו\s+מקבל|לאותו\s+אדם|לאותה|אותו/.test(t) && !/אחר/.test(t))
    return "same";
  if (/מקבל\s+אחר|לאדם\s+אחר|אדם\s+אחר|מישהו\s+אחר|אחר/.test(t))
    return "other";
  return null;
}

export function rulePlan(ctx: Context): Plan | null {
  const text = (ctx.message.transcript ?? ctx.message.text).trim();
  if (!text) return null;
  const pendingExtra = ctx.conversation?.pending_extra_item ?? null;
  if (pendingExtra?.stage === "replace_or_add") {
    const choice = replaceExtraChoice(text);
    // Compat: still resolve במקום/בנוסף when pending_extra exists.
    // Unclear answers defer to AI — do not force sticky {type:next}.
    if (choice) return plan(text, [{ type: "resolve_extra_item", choice }]);
    return null;
  }
  if (pendingExtra?.stage === "same_or_other_recipient") {
    const choice = recipientExtraChoice(text);
    if (choice) return plan(text, [{ type: "resolve_extra_recipient", choice }]);
    return null;
  }
  if (pendingExtra?.stage === "confirm_another_delivery") {
    // AI owns follow-up donate/next; do not force a sticky plan.
    return null;
  }
  if (customerCancelIntent(text)) {
    const requests = ctx.requests ?? [];
    const selected = requests.find(
      (request) => request.id === ctx.conversation.selected_request_id,
    );
    const candidates = [
      selected,
      ...requests.filter(
        (request) => !["closed", "cancelled", "rejected"].includes(request.status),
      ),
    ].filter((request): request is Request => Boolean(request));
    for (const request of candidates) {
      if (["closed", "cancelled", "rejected"].includes(request.status)) continue;
      try {
        ownParty(request, ctx.conversation.phone);
      } catch {
        continue;
      }
      return plan(text, [
        { type: "cancel", request_number: request.number, choice: "final" },
      ]);
    }
  }

  // Once a candidate photo has been presented, an affirmative reply is an
  // acceptance of that candidate—not a new generic search request.
  const presented = ctx.candidates?.find((candidate) => candidate.state === "presented");
  if (presented && yes(text))
    return plan(text, [{ type: "interest", request_number: presented.request.number }]);

  const normalizedText = norm(text);
  // "Near Beit She'an" is not Beit She'an. Ask which town and do not schedule.
  if (
    /(?:ליד|קרוב|באזור|סמוך)/u.test(normalizedText) &&
    /בית\s*שאן|beit\s+she'?an/i.test(text) &&
    !beitShean(text) &&
    !activeRequest(ctx)
  )
    return plan(text, [{ type: "next" }]);

  // A new, explicit donation always starts a new request.  Do this before
  // looking at active requests: a contact may have older open requests, but
  // "אני רוצה למסור מיטה" must never be interpreted as an answer to one.
  const item = kindAndDescription(text);
  const selfMove = /(?:להעביר|מעביר|מעבירה)\s+(?:לעצמי|אליי)|אני\s+(?:גם\s+)?(?:המוסר\s+וגם\s+המקבל|שני\s+הצדדים)/.test(
    normalizedText,
  );
  const requesterIntent =
    /^(?:(?:היי|שלום)\s*[,! ]*)?(?:אני\s+)?(?:(?:רוצה\s+)?לקבל|מחפש|מחפשת|מבקש|מבקשת|צריך|צריכה)(?=$|[\s,])/u.test(
      normalizedText,
    ) ||
    (seekIntent(text) && !donationIntent(text));
  const explicitDonationDeclaration = /(?:יש\s+לי(?=$|[\s,])|אני\s+(?:רוצה\s+)?(?:למסור|לתרום|מוסר|מוסרת|מעביר|מעבירה)|צריך(?:ה)?\s+(?:למסור|לתרום|להעביר))/.test(
    normalizedText,
  );

  // A seeker may describe the desired item as "למסירה" to distinguish it
  // from a purchase. That phrase alone must not turn the request into a
  // donation. Explicit donor declarations and self-transfers retain priority.
  if (item && requesterIntent && !selfMove && !explicitDonationDeclaration)
    return plan(text, [{ type: "seek", kind: item.kind }]);

  if (item && donationIntent(text)) {
    const existing = activeRequest(ctx);
    if (
      existing &&
      existing.items.some(
        (candidate) =>
          candidate.kind === item.kind &&
          (item.kind !== "other" || sameOtherItem(candidate.description, item.description)),
      ) &&
      !/(?:פנייה\s+חדשה|פריט\s+נוסף|עוד\s+פריט)/.test(text)
    ) {
      const recipientName = directHandoffIntent(text)
        ? namedRecipientName(text)
        : null;
      if (
        recipientName &&
        existing.origin === "donation" &&
        existing.parties.some(
          (candidate) =>
            candidate.phone === ctx.conversation.phone &&
            candidate.role === "donor",
        ) &&
        !existing.parties.some((candidate) => candidate.role === "receiver")
      )
        return plan(text, [
          {
            type: "counterparty",
            request_number: existing.number,
            phone: null,
            name: recipientName,
          },
        ]);
      return plan(text, [
        { type: "clarify_duplicate", request_number: existing.number },
      ]);
    }
    // Natural direct-handoff wording often puts the recipient's name before
    // the phone ("ישירות לטל 058...").  Keep the named parser first, then
    // fall back to the standalone phone parser so the request is classified
    // as direct and never enters the open-donation photo gate.
    const other = selfMove
      ? ctx.conversation.phone
      : namedRecipientPhone(text) ??
        standalonePhone(text) ??
        ctx.message.contacts[0]?.phone ??
        null;
    const commands: Command[] = [
      {
        type: "donate",
        items: [{ ...item, quantity: 1 }],
        counterparty_phone: other,
        counterparty_name:
          namedRecipientName(text) ??
          ctx.message.contacts[0]?.name?.replace(/^אא\s+/u, "").trim() ??
          null,
        direct:
          Boolean(other) ||
          directHandoffIntent(text) ||
          Boolean(ctx.message.contacts[0]?.phone),
        free: true,
        working:
          /שבור|מקולקל|לא\s+(?:תקין|שמיש|עובד)/.test(text)
            ? false
            : /תקינ|שמיש|עובד/.test(text) || Boolean(other) || directHandoffIntent(text)
              ? true
              : null,
      },
    ];
    if (selfMove) commands.push(...(selfTransferDetails(text) ?? []));
    else if (other) {
      const location = suppliedPartyLocation(text, directLocationRole(text));
      if (location) commands.push(location);
    } else {
      // Open donations may include pickup facts in the first message.  Persist
      // them before entering the photo gate so they never need to be repeated.
      const location = suppliedPartyLocation(text, "donor");
      if (location) commands.push(location);
    }
    if (!commands.some((command) => command.type === "details")) {
      const recent = (ctx.history ?? [])
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.content)
        .join("\n");
      const settlement =
        mentionedAllowedSettlement(text) ?? mentionedAllowedSettlement(recent);
      const reviewSettlement = settlement ? null : mentionedReviewSettlement(text);
      const place = settlement ?? reviewSettlement;
      if (place)
        commands.push({
          type: "details",
          request_number: null,
          role: "donor",
          name: null,
          settlement: place,
          address: null,
          floor: floor(text),
          ...(preferredTime(text) ? { preferred_time: preferredTime(text) } : {}),
        });
    }
    return plan(text, commands);
  }

  // A named handoff often arrives as two messages: "רוצה למסור לטל" then
  // "מיטה". Keep the pending name and open the direct request when the item
  // finally appears, without asking the AI to invent facts.
  if (
    item &&
    !requesterIntent &&
    (ctx.conversation.pending_counterparty_name || hasPartialNamedHandoff(ctx))
  ) {
    const recipientName =
      ctx.conversation.pending_counterparty_name ??
      namedRecipientName(
        ctx.history
          .filter((entry) => entry.role === "user")
          .slice(-3)
          .map((entry) => entry.content)
          .join("\n"),
      );
    const recipientPhone =
      ctx.conversation.pending_counterparty_phone ??
      ctx.message.contacts[0]?.phone ??
      standalonePhone(text) ??
      namedRecipientPhone(text);
    const recipientFromCard =
      recipientName ??
      ctx.message.contacts[0]?.name?.replace(/^אא\s+/u, "").trim() ??
      null;
    return plan(text, [
      {
        type: "donate",
        items: [{ ...item, quantity: 1 }],
        counterparty_phone: recipientPhone,
        counterparty_name: recipientFromCard,
        direct: true,
        free: true,
        working: true,
      },
    ]);
  }

  // Named handoff without an item yet: remember the recipient and ask only
  // for the missing item. Do not escalate or invent a donation.
  if (!item && directHandoffIntent(text))
    return plan(text, [{ type: "next" }]);
  // Self-name after "רוצה למסור ל…" (pending or recent history): keep the
  // sticky handoff and ask for the item — never re-ask מסירה/קבלה.
  if (
    !item &&
    !activeRequest(ctx) &&
    explicitName(text) &&
    (ctx.conversation.pending_counterparty_name || hasPartialNamedHandoff(ctx))
  )
    return plan(text, [{ type: "next" }]);
  // Contact card / phone after a sticky donate handoff: store the number and
  // ask for the item. Do not fall through to choose_request / path re-ask.
  if (
    !item &&
    !activeRequest(ctx) &&
    (standalonePhone(text) || ctx.message.contacts[0]?.phone) &&
    (ctx.conversation.pending_counterparty_name ||
      hasPartialNamedHandoff(ctx) ||
      donationIntent(
        (ctx.history ?? [])
          .filter((entry) => entry.role === "user")
          .slice(-6)
          .map((entry) => entry.content)
          .join("\n") +
          "\n" +
          text,
      ))
  )
    return plan(text, [{ type: "next" }]);
  if (
    !item &&
    ctx.conversation.pending_counterparty_name &&
    !activeRequest(ctx) &&
    (standalonePhone(text) || ctx.message.contacts[0]?.phone)
  )
    return plan(text, [{ type: "next" }]);

  // A general request must start a search even when older requests exist in
  // the database.  Conversation reset hides those requests from the context;
  // this guard also makes the intent unambiguous for short/slang messages.
  if (item && requesterIntent)
    return plan(text, [{ type: "seek", kind: item.kind }]);

  // An out-of-area answer is reversible when the same party immediately
  // corrects their own endpoint. Keep this deterministic so the correction
  // stays attached to the selected request instead of being treated as a new
  // request by the language model.
  if (/(?:טעיתי|תיקון|בעצם|התכוונתי)/.test(normalizedText)) {
    const rejectedForSender = (ctx.requests ?? []).filter((request) => {
      if (request.status !== "rejected") return false;
      try {
        ownParty(request, ctx.conversation.phone);
        return true;
      } catch {
        return false;
      }
    });
    const selected = rejectedForSender.find(
      (request) => request.id === ctx.conversation.selected_request_id,
    ) ?? (rejectedForSender.length === 1 ? rejectedForSender[0] : undefined);
    if (selected) {
      try {
        const role = ownParty(selected, ctx.conversation.phone).role;
        const location = suppliedPartyLocation(text, role);
        if (location?.type === "details")
          return plan(text, [{ ...location, request_number: selected.number }]);
      } catch {
        // A non-party may not reopen or alter a rejected request.
      }
    }
  }

  const current = activeRequest(ctx);
  if (!current) {
    const search = ctx.active_search;
    if (search) {
      const settlement =
        mentionedAllowedSettlement(text) ?? beitShean(text);
      const address = streetPhrase(text);
      const seekFloor = floor(text);
      const seekName = explicitName(text);
      if (settlement || address || seekFloor !== null || seekName)
        return plan(text, [
          {
            type: "seek",
            kind: search.kind,
            ...(seekName ? { name: seekName } : {}),
            ...(settlement ? { settlement } : {}),
            ...(address ? { address } : {}),
            ...(seekFloor !== null ? { floor: seekFloor } : {}),
          },
        ]);
    }
    if (
      mentionedAllowedSettlement(text) ||
      streetPhrase(text) ||
      floor(text) !== null ||
      (/(?:ליד|קרוב|באזור|סמוך)/u.test(normalizedText) &&
        /בית\s*שאן|beit\s+she'?an/i.test(text))
    )
      return plan(text, [{ type: "next" }]);
    const reviewTown = mentionedReviewSettlement(text);
    if (reviewTown)
      return plan(text, [
        { type: "escalate", request_number: null, reason: "borderline_area" },
      ]);
    return null;
  }

  let party;
  try {
    party = ownParty(current, ctx.conversation.phone);
  } catch {
    return null;
  }
  const donor = party.role === "donor";
  const items = current.items;
  const suppliedContact = ctx.message.contacts[0]?.phone ?? standalonePhone(text);
  // A contact card after "למסור לט" is a candidate direct handoff. Ask one
  // confirmation question before connecting or contacting the person.
  if (
    current.origin === "donation" &&
    donor &&
    !current.parties.some((entry) => entry.role === "receiver") &&
    suppliedContact &&
    hasPartialNamedHandoff(ctx)
  )
    return plan(text, [{
      type: "counterparty_candidate",
      request_number: current.number,
      phone: suppliedContact,
      name: ctx.message.contacts[0]?.name ?? contactCardName(text),
    }]);
  if (ctx.conversation.pending_counterparty_phone && (yes(text) || no(text)))
    return plan(text, [{
      type: "confirm_counterparty",
      request_number: current.number,
      accept: yes(text),
    }]);
  const proposedDate = current.proposed_run_date?.slice(0, 10) ?? null;
  const priorReply = ctx.history.at(-1)?.content ?? "";
  const [proposalYear, proposalMonth, proposalDay] = proposedDate?.split("-") ?? [];
  const proposalLabel = proposedDate
    ? `${proposalDay}/${proposalMonth}/${proposalYear}`
    : null;
  const enteredApprovalDate = text.match(/(?:^|\D)(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\D|$)/);
  const enteredProposalDate = enteredApprovalDate
    ? `${enteredApprovalDate[3]}-${enteredApprovalDate[2]!.padStart(2, "0")}-${enteredApprovalDate[1]!.padStart(2, "0")}`
    : null;
  const sameChatProposalPrompt = Boolean(
    proposalLabel &&
    priorReply.includes(proposalLabel) &&
    /(?:נא לאשר את המועד|נא לאשר במפורש|נדרש עדיין אישור(?: שלך)?|ממתינים לאישור המועד)/.test(priorReply),
  );
  if (
    party.approved_at &&
    proposedDate &&
    (sameChatProposalPrompt || enteredProposalDate === proposedDate) &&
    explicitApproval(text)
  ) {
    const date = enteredProposalDate ?? proposedDate;
    return plan(text, [{
      type: "approve_schedule",
      request_number: current.number,
      date,
    }]);
  }
  // A recipient can introduce themself and explicitly consent in one
  // message. Consent must win over profile extraction, otherwise it is
  // misclassified as a name and the approval is lost.
  // Donors are auto-approved when a direct handoff opens, so destination
  // ("כתובת היעד…") plus contact consent must still apply after approval.
  // "מאשר ליצור קשר" often trails an address with no comma — treat that as
  // consent too so the AI never invents a "I'll message them" reply.
  if (explicitApproval(text) || contactConsent(text)) {
    const commands: Command[] = [];
    if (!party.approved_at)
      commands.push({ type: "approve_self", request_number: current.number });
    const selfName = explicitName(text);
    if (selfName && (!party.name || !looksLikePersonName(party.name) || party.name !== selfName))
      commands.push({
        type: "details",
        request_number: current.number,
        role: party.role,
        name: selfName,
        settlement: null,
        address: null,
        floor: null,
      });
    // Donors often send both pickup and destination in one consent message:
    // "איסוף …, מסירה …, מאשר ליצור קשר".
    const bothLocations =
      current.origin === "direct" ? pickupAndDeliveryDetails(text) : null;
    if (bothLocations) {
      for (const location of bothLocations) {
        if (location.type === "details")
          commands.push({ ...location, request_number: current.number });
      }
    } else {
      // In a direct handoff the donor often sends the receiver's destination
      // ("כתובת היעד…") together with consent to contact them. Store that on
      // the receiver, not on the donor's pickup address. A receiver approving
      // their own address always writes to their own role.
      const locationRole =
        current.origin === "direct" && party.role === "donor"
          ? directLocationRole(text)
          : party.role;
      const suppliedLocation = suppliedPartyLocation(text, locationRole);
      if (suppliedLocation?.type === "details")
        commands.push({ ...suppliedLocation, request_number: current.number });
    }
    if (
      current.origin === "direct" &&
      (contactConsent(text) ||
        /(?:נפנה|לפנות|ליצור\s+קשר|ליצור\s+אית(?:ה|ו)\s+קשר)/u.test(norm(text))) &&
      current.parties.some((item) => item.role !== party.role)
    )
      commands.push({
        type: "contact_counterparty",
        request_number: current.number,
        contact: true,
      });
    if (commands.length) return plan(text, commands);
  }

  // Persist איסוף/מסירה even when the donor has not yet answered the
  // verification question — otherwise the facts evaporate into AI replies.
  if (current.origin === "direct") {
    const bothLocations = pickupAndDeliveryDetails(text);
    if (bothLocations?.length) {
      const commands: Command[] = bothLocations
        .filter((location) => location.type === "details")
        .map((location) =>
          location.type === "details"
            ? { ...location, request_number: current.number }
            : location,
        );
      if (contactConsent(text) && current.parties.some((item) => item.role !== party.role))
        commands.push({
          type: "contact_counterparty",
          request_number: current.number,
          contact: true,
        });
      if (commands.length) return plan(text, commands);
    }
  }

  // Bare personal name after we asked for the name (e.g. «שלי»).
  if (!party.name) {
    const prior = ctx.history.at(-1)?.content ?? "";
    const askedName =
      /חסר(?:ה)?(?:\s+רק)?\s+השם|מה שמך|נא לציין שם|שואלים לשמך|שם מלא/u.test(
        prior,
      );
    const bare = norm(text).trim();
    const extracted = explicitName(bare);
    if (
      askedName &&
      !/(?:רחוב|שכונ|קומה|בית\s*שאן|תמונה|כן|לא)/u.test(bare) &&
      (extracted ||
        (looksLikePersonName(bare) &&
          !/(?:השם|שמי|קוראים\s+לי)/u.test(bare)))
    ) {
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: extracted ?? bare,
          settlement: null,
          address: null,
          floor: null,
          preferred_time: null,
        },
      ]);
    }
  }

  // A direct handoff commonly arrives as two WhatsApp messages: first the
  // item/name, then a phone number or contact card. Persist that second
  // message deterministically before asking the AI to phrase anything.
  if (current.origin === "direct") {
    const supplied =
      ctx.message.contacts[0]?.phone ?? standalonePhone(text);
    if (supplied && !current.parties.some((p) => p.phone === supplied))
      return plan(text, [
        {
          type: "counterparty",
          request_number: current.number,
          phone: supplied,
          name:
            ctx.message.contacts[0]?.name ??
            ctx.conversation.pending_counterparty_name ??
            null,
        },
      ]);
  }
  const askedVerification = /האם תרצה שנפנה ל(?:מקבל|מוסר) לצורך אימות/.test(
    ctx.history.at(-1)?.content ?? "",
  );
  if (
    askedVerification &&
    current.origin === "direct" &&
    current.parties.some((item) => item.role !== party.role) &&
    (yes(text) || no(text) || explicitApproval(text) || contactConsent(text))
  ) {
    // Bare «כן» still reaches contact_counterparty; the command refuses to
    // message a third party without an explicit confirmation phrase.
    const consent = !no(text);
    const commands: Command[] = [];
    if (consent) {
      const location = suppliedPartyLocation(text, directLocationRole(text));
      if (location?.type === "details")
        commands.push({ ...location, request_number: current.number });
    }
    commands.push({
      type: "contact_counterparty",
      request_number: current.number,
      contact: consent,
    });
    return plan(text, commands);
  }

  if (
    donor &&
    items.some((item) => item.kind === "wardrobe" && item.wardrobe_small_whole === null) &&
    itemFactYesNo(text)
  )
    return plan(text, [
      {
        type: "item_facts",
        request_number: current.number,
        items: null,
        free: null,
        working: null,
        needs_disassembly: yes(text) ? false : null,
        wardrobe_small_whole: yes(text),
        oven_type: null,
        evacuation: null,
      },
    ]);

  if (donor && items.some((item) => item.working === null) && itemFactYesNo(text))
    return plan(text, [
      {
        type: "item_facts",
        request_number: current.number,
        items: null,
        free: null,
        working: yes(text),
        needs_disassembly: null,
        wardrobe_small_whole: null,
        oven_type: null,
        evacuation: null,
      },
    ]);

  if (donor && items.some((item) => item.kind === "oven" && item.oven_type === null)) {
    const ovenType = /בילט|built.?in/i.test(text)
      ? "built_in"
      : /משולב|כיריים/i.test(text)
        ? "combined"
        : null;
    if (ovenType)
      return plan(text, [
        {
          type: "item_facts",
          request_number: current.number,
          items: null,
          free: null,
          working: null,
          needs_disassembly: null,
          wardrobe_small_whole: null,
          oven_type: ovenType,
          evacuation: null,
        },
      ]);
  }

  if (
    donor &&
    items.some((item) => !appliance(item) && item.kind !== "wardrobe" && item.needs_disassembly === null) &&
    itemFactYesNo(text)
  )
    return plan(text, [
      {
        type: "item_facts",
        request_number: current.number,
        items: null,
        free: null,
        working: null,
        needs_disassembly: yes(text),
        wardrobe_small_whole: null,
        oven_type: null,
        evacuation: null,
      },
    ]);

  // A street prefix is an address. It must be saved before any city list sees
  // the same word, so "רחוב אילת" is never an out-of-area rejection.
  const street = streetPhrase(text);
  if (street && !party.address) {
    const withoutStreet = text.replace(street, " ");
    const settlement =
      beitShean(text) ?? beitShean(withoutStreet) ?? leadingSettlement(withoutStreet);
    return plan(text, [
      {
        type: "details",
        request_number: current.number,
        role: party.role,
        name: null,
        settlement,
        address: street,
        floor: floor(text),
      },
    ]);
  }
  if (!party.address && ambiguousStreetCity(text))
    return plan(text, [{ type: "next" }]);

  if (!party.settlement) {
    const settlement = beitShean(text);
    if (settlement) {
      const parsed = addressAndName(text);
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: parsed?.name ?? null,
          settlement,
          address: parsed?.address ?? addressWithSettlement(text),
          floor: floor(text),
        },
      ]);
    }
  }

  // A direct/self-transfer reply may contain settlement, street and name in
  // one message even when the settlement was already captured on an earlier
  // turn.  Re-parse the complete tuple before the single-field fallbacks so a
  // comma-separated name is never appended to the address.
  const combined = addressAndName(text);
  if (party.settlement && combined)
    return plan(text, [
      {
        type: "details",
        request_number: current.number,
        role: party.role,
        name: combined.name,
        settlement: null,
        address: combined.address,
        floor: floor(text),
      },
    ]);

  if (party.settlement && (!party.name || !looksLikePersonName(party.name))) {
    const withoutSettlement = norm(text).replace(/בית\s*[-־]?\s*שאן/g, "").trim();
    const name = explicitName(withoutSettlement);
    if (name)
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name,
          settlement: null,
          address: null,
          floor: null,
        },
      ]);
    if (
      !party.name &&
      withoutSettlement &&
      !/\d|רחוב|שד[׳']|שדרות/.test(withoutSettlement) &&
      looksLikePersonName(withoutSettlement)
    )
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: withoutSettlement,
          settlement: null,
          address: null,
          floor: null,
        },
      ]);
  }

  if (party.settlement && !party.address) {
    const address = norm(text);
    const repeatsTown =
      Boolean(party.settlement && norm(party.settlement) === address) ||
      mentionedAllowedSettlement(text) !== null;
    if (
      address &&
      !yes(address) &&
      !no(address) &&
      !/^(?:בעצם\s+)?קומה\s*-?\d+$/u.test(address) &&
      !repeatsTown &&
      floor(address) === null
    )
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: null,
          settlement: null,
          address,
          floor: floor(address),
        },
      ]);
  }

  if (party.address && party.floor === null) {
    const value = floor(text);
    if (value !== null)
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: null,
          settlement: null,
          address: null,
          floor: value,
        },
      ]);
  }

  if (
    donor &&
    !current.parties.some((item) => item.role === "receiver") &&
    /^(?:לא|אין(?: לי)?(?: מקבל| מספר)?)/.test(norm(text))
  )
    return plan(text, [{ type: "next" }]);

  const correctedFloor = text.match(/בעצם\s+קומה\s*(-?\d+)/);
  if (correctedFloor)
    return plan(text, [
      {
        type: "details",
        request_number: current.number,
        role: party.role,
        name: null,
        settlement: null,
        address: null,
        floor: Number(correctedFloor[1]),
      },
    ]);

  return null;
}
