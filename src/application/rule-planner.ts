import type { Command, Context, ItemKind, Plan, Request } from "../domain/types.js";
import { appliance, donationIntent, explicitApproval, norm, ownParty } from "../domain/policies.js";

const activeRequest = (ctx: Context): Request | undefined =>
  ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
  (ctx.requests.length === 1 ? ctx.requests[0] : undefined);

const yes = (text: string): boolean =>
  /^(?:כן|בטח|בוודאי|נכון|מאשר|מאשרת)(?:[\s,!.]|$)/.test(norm(text));
const no = (text: string): boolean =>
  /^(?:לא|אין)(?:[\s,!.]|$)/.test(norm(text));

function kindAndDescription(text: string): { kind: ItemKind; description: string } | null {
  const match: [RegExp, ItemKind, string][] = [
    [/מיטה/i, "bed", "מיטה"],
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

/**
 * Handles the predictable parts of the conversation without an external model.
 * Returning null intentionally delegates only genuinely free-form language to AI.
 */
export function rulePlan(ctx: Context): Plan | null {
  const text = (ctx.message.transcript ?? ctx.message.text).trim();
  if (!text) return null;

  // A new, explicit donation always starts a new request.  Do this before
  // looking at active requests: a contact may have older open requests, but
  // "אני רוצה למסור מיטה" must never be interpreted as an answer to one.
  const item = kindAndDescription(text);
  if (item && donationIntent(text))
    return plan(text, [
      {
        type: "donate",
        items: [{ ...item, quantity: 1 }],
        counterparty_phone: null,
        free: true,
        working: null,
      },
    ]);

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

  if (!party.settlement) {
    const settlement = beitShean(text);
    if (settlement)
      return plan(text, [
        {
          type: "details",
          request_number: current.number,
          role: party.role,
          name: null,
          settlement,
          address: null,
          floor: null,
        },
      ]);
  }

  if (party.settlement && !party.name) {
    const withoutSettlement = norm(text).replace(/בית\s*[-־]?\s*שאן/g, "").trim();
    if (withoutSettlement && !/\d|רחוב|שד[׳']|שדרות/.test(withoutSettlement))
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

  if (party.settlement && party.name && !party.address) {
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

  if (!party.approved_at && explicitApproval(text))
    return plan(text, [{ type: "approve_self", request_number: current.number }]);

  if (
    donor &&
    !current.parties.some((item) => item.role === "receiver") &&
    /^(?:לא|אין(?: לי)?(?: מקבל| מספר)?)/.test(norm(text))
  )
    return plan(text, [{ type: "next" }]);

  return null;
}
