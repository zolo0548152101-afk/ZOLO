import type { Command, Context, ItemKind, Plan, Request } from "../domain/types.js";
import {
  appliance,
  canonicalPhone,
  donationIntent,
  directHandoffIntent,
  explicitApproval,
  ambiguousStreetCity,
  streetPhrase,
  norm,
  ownParty,
} from "../domain/policies.js";

const activeRequest = (ctx: Context): Request | undefined => {
  const requests = ctx.requests ?? [];
  const open = requests.filter(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );
  const selected = requests.find((r) => r.id === ctx.conversation?.selected_request_id);
  // A recipient can receive a new verification message before a conversation
  // row exists for that chat. On their first reply prefer the sole open
  // request over an older coordinated request that happens to be selected.
  if (open.length === 1) return open[0];
  return selected ?? (requests.length === 1 ? requests[0] : undefined);
};

const yes = (text: string): boolean =>
  /^(?:כן|בטח|בוודאי|נכון|מאשר|מאשרת)(?:[\s,!.]|$)/.test(norm(text));
const no = (text: string): boolean =>
  /^(?:לא|אין)(?:[\s,!.]|$)/.test(norm(text));

function kindAndDescription(text: string): { kind: ItemKind; description: string } | null {
  const match: [RegExp, ItemKind, string][] = [
    [/מיטה/i, "bed", "מיטה"],
    [/שידה/i, "other", "שידה"],
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
  return found ? { kind: found[1], description: found[2] } : null;
}

const plan = (text: string, commands: Command[]): Plan => ({
  commands,
  evidence: text.slice(0, 2000),
});

function floor(text: string): number | null {
  if (/קומת? קרקע/.test(text)) return 0;
  const match = text.match(/קומה\s*(-?\d+)/);
  return match ? Number(match[1]) : null;
}

function beitShean(text: string): string | null {
  return /בית\s*[-־]?\s*שאן/.test(text) ? "בית שאן" : null;
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
    /(?:^|[,;.!?]\s*)(?:השם(?:\s+הוא)?|שמי|קוראים\s+לי)\s+([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*){0,2})(?=\s*(?:[,;.!?]|$))/u,
  );
  if (match?.[1]) return match[1].trim();
  const introduction = normalized.match(
    /(?:^|[.!?]\s*)אני\s+([א-ת][א-ת׳״'’\-]*(?:\s+[א-ת][א-ת׳״'’\-]*)?)(?=\s*(?:[,;.!?]|$))/u,
  );
  if (!introduction?.[1]) return null;
  const name = introduction[1].trim();
  return /^(?:רוצה|צריך|צריכה|מוסר|מוסרת|מעביר|מעבירה|מחפש|מחפשת|מבקש|מבקשת)(?:\s|$)/.test(name)
    ? null
    : name;
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

function selfTransferDetails(text: string): Command[] | null {
  const self = text.match(/(?:מעביר|מעבירה|להעביר|רוצה להעביר)\s+(?:לעצמי|אליי)/u);
  if (!self) return null;
  const name = selfTransferName(text, self.index!);
  const tail = text.slice(self.index! + self[0].length);
  const pickupDropoff = tail.match(
    /אוספים\s+מ(?<origin>.+?)(?:,\s*)?ו?מביאים\s+ל(?<destination>.+?)(?=[.!?]|$)/u,
  );
  const start = tail.search(/מ(?=(?:בית\s*[-־]?\s*שאן|רחוב|שיכון|שכונה|שדרות|שד[׳']?))/u);
  const originStart = start + 1;
  const destinationMatch = start < 0
    ? null
    : tail.slice(originStart).match(/\s+ל(?=(?:בית\s*[-־]?\s*שאן|רחוב|שיכון|שכונה|שדרות|שד[׳']?))/u);
  const originText = pickupDropoff?.groups?.origin?.trim()
    ?? (destinationMatch?.index === undefined ? null : tail.slice(originStart, originStart + destinationMatch.index).trim());
  const destinationText = pickupDropoff?.groups?.destination?.trim()
    ?? (destinationMatch?.index === undefined ? null : tail.slice(originStart + destinationMatch.index + destinationMatch[0].length).trim());
  if (!originText || !destinationText) return null;
  const place = (value: string) => {
    const settlement = beitShean(value);
    const addressMatch = value.match(/(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד[׳']?)\s+[^,.;?]+/u);
    const address = addressMatch?.[0]
      ?.replace(/\s+ב?בית\s*[-־]?\s*שאן.*$/u, "")
      .replace(/\s+(?:קומה|ק[׳'])\s*-?\d+(?:\s+עם\s+מעלית)?\s*$/u, "")
      .trim() ?? null;
    return { settlement, address, floor: floor(value) };
  };
  const origin = place(originText);
  const destination = place(destinationText);
  const destinationSettlement = destination.settlement ?? origin.settlement;
  if (!origin.settlement || !origin.address || !destinationSettlement || !destination.address)
    return null;
  return [
    {
      type: "details",
      request_number: null,
      role: "donor",
      name,
      settlement: origin.settlement,
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
    .filter((name) => !["מסירה", "תרומה", "מישהו", "מישהי", "אדם", "בית", "עפולה", "צמח", "קרקע"].includes(name));
  return names.at(-1) ?? null;
}

function directLocationRole(text: string): "donor" | "receiver" {
  const normalized = norm(text);
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
export function rulePlan(ctx: Context): Plan | null {
  const text = (ctx.message.transcript ?? ctx.message.text).trim();
  if (!text) return null;

  // Once a candidate photo has been presented, an affirmative reply is an
  // acceptance of that candidate—not a new generic search request.
  const presented = ctx.candidates?.find((candidate) => candidate.state === "presented");
  if (presented && yes(text))
    return plan(text, [{ type: "interest", request_number: presented.request.number }]);

  // A new, explicit donation always starts a new request.  Do this before
  // looking at active requests: a contact may have older open requests, but
  // "אני רוצה למסור מיטה" must never be interpreted as an answer to one.
  const item = kindAndDescription(text);
  const normalizedText = norm(text);
  const selfMove = /(?:להעביר|מעביר|מעבירה)\s+(?:לעצמי|אליי)|אני\s+(?:גם\s+)?(?:המוסר\s+וגם\s+המקבל|שני\s+הצדדים)/.test(
    normalizedText,
  );
  const requesterIntent = /^(?:(?:היי|שלום)\s*[,! ]*)?(?:אני\s+)?(?:מחפש|מחפשת|מבקש|מבקשת|צריך|צריכה)(?=$|[\s,])/.test(
    normalizedText,
  );
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
      existing.items.some((candidate) => candidate.kind === item.kind) &&
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
      : namedRecipientPhone(text) ?? standalonePhone(text);
    const commands: Command[] = [
      {
        type: "donate",
        items: [{ ...item, quantity: 1 }],
        counterparty_phone: other,
        counterparty_name: directHandoffIntent(text) ? namedRecipientName(text) : null,
        direct: Boolean(other) || directHandoffIntent(text),
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
      standalonePhone(text) ??
      namedRecipientPhone(text);
    return plan(text, [
      {
        type: "donate",
        items: [{ ...item, quantity: 1 }],
        counterparty_phone: recipientPhone,
        counterparty_name: recipientName,
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
  if (!current) return null;

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
  if (!party.approved_at && explicitApproval(text)) {
    const commands: Command[] = [
      { type: "approve_self", request_number: current.number },
    ];
    const suppliedLocation = suppliedPartyLocation(text, party.role);
    if (suppliedLocation?.type === "details")
      commands.push({ ...suppliedLocation, request_number: current.number });
    return plan(text, commands);
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
    (yes(text) || no(text))
  )
    return plan(text, [
      {
        type: "contact_counterparty",
        request_number: current.number,
        contact: yes(text),
      },
    ]);

  if (
    donor &&
    items.some((item) => item.kind === "wardrobe" && item.wardrobe_small_whole === null) &&
    (yes(text) || no(text))
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

  if (donor && items.some((item) => item.working === null) && (yes(text) || no(text)))
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
    (yes(text) || no(text))
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

  if (party.settlement && !party.name) {
    const withoutSettlement = norm(text).replace(/בית\s*[-־]?\s*שאן/g, "").trim();
    if (withoutSettlement && !/\d|רחוב|שד[׳']|שדרות/.test(withoutSettlement))
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: explicitName(withoutSettlement) ?? withoutSettlement,
          settlement: null,
          address: null,
          floor: null,
        },
      ]);
  }

  if (party.settlement && !party.address) {
    const address = norm(text);
    if (address && !yes(address) && !no(address))
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

  if (
    donor &&
    !current.parties.some((item) => item.role === "receiver") &&
    /^(?:לא|אין(?: לי)?(?: מקבל| מספר)?)/.test(norm(text))
  )
    return plan(text, [{ type: "next" }]);

  return null;
}
