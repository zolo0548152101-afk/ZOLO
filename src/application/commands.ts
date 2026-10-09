import type pg from "pg";
import {
  AppError,
  type Context,
  type Command,
  type Request,
  type Item,
  type Party,
  type Notice,
  type PendingExtraItem,
} from "../domain/types.js";
import { Store } from "../infrastructure/store.js";
import {
  DEFAULT_TRANSPORT_CAPACITY,
  canonicalPhone,
  donationIntent,
  ambiguousStreetCity,
  itemError,
  ownParty,
  mutable,
  appliance,
  nextQuestion,
  statusText,
  nextTuesday,
  norm,
  mentionedAllowedSettlement,
  appendTeamNote,
  customerInsistsAfterDenial,
} from "../domain/policies.js";
import { draftCounterpartyVerification } from "../domain/notices.js";
export interface Outcome {
  reply: string | null;
  request: Request | null;
  notices: Notice[];
  humanReason?: string;
}

/**
 * A preference may express a time within the Tuesday delivery window, but it
 * must never turn another weekday or an impossible hour into stored request
 * state. The agent explains the constraint; this guard prevents a bad tool
 * call from persisting it anyway while preserving all other details writes.
 */
export function validTransportPreference(value: string): boolean {
  const text = norm(value);
  const nonTuesday =
    /(?:יום\s*)?(?:ראשון|שני|רביעי|חמישי|שישי|שבת|sunday|monday|wednesday|thursday|friday|saturday)/iu;
  if (nonTuesday.test(text)) return false;
  for (const rawHour of text.matchAll(/\b([01]?\d|2[0-3])(?::\d{2})?\b/g)) {
    const hour = Number(rawHour[1]);
    if (hour < 16 || hour >= 20) return false;
  }
  return true;
}

/** Pull "קוראים לי X" / "שמי X" from recent user turns when opening a request. */
function recentSelfName(ctx: Context, text: string): string | null {
  const blob = [
    ...(ctx.history ?? [])
      .filter((entry) => entry.role === "user")
      .slice(-8)
      .map((entry) => entry.content),
    text,
  ].join("\n");
  const match = norm(blob).match(
    /(?:קוראים\s+לי|שמי|השם(?:\s+(?:הוא|שלי))?)\s+([א-ת]{2,}(?:\s+[א-ת]{2,}){0,2})/u,
  );
  const name = match?.[1]?.trim() ?? null;
  if (!name) return null;
  if (
    /^(?:רוצה|צריך|צריכה|מוסר|מוסרת|מעביר|מעבירה|מחפש|מחפשת|מבקש|מבקשת|מאשר|מאשרת|מיטה|ספה|מקרר)/u.test(
      name,
    )
  )
    return null;
  return name;
}

function describeItems(items: Array<Pick<Item, "description">>): string {
  return items.map((i) => i.description).join(", ");
}


function bareYes(text: string): boolean {
  return /^(?:כן|בטח|בוודאי|נכון|מאשר|מאשרת)(?:[\s,!.]|$)/u.test(norm(text));
}
function bareNo(text: string): boolean {
  return /^(?:לא|אין)(?:[\s,!.]|$)/u.test(norm(text));
}
function explicitAnotherDelivery(text: string): boolean {
  const t = norm(text);
  return (
    (/כן/.test(t) &&
      /(?:הובלה|משלוח|פנייה|מסירה)\s+נוס|נוס(?:פת|ף)|עוד\s+(?:אחת|אחד|פנייה|הובלה)/u.test(
        t,
      )) ||
    /^(?:כן[,.]?\s*)?(?:הובלה|משלוח|פנייה)\s+נוס/.test(t) ||
    /(?:^|[\s,])בנפרד(?:[\s,]|$)|פנייה\s+חדשה|עוד\s+אחת/.test(t)
  );
}
function explicitNotAnotherDelivery(text: string): boolean {
  const t = norm(text);
  return (
    /^(?:לא|לא\s+נוס|אותה\s+פנייה|אותו\s+דבר|רק\s+לעדכן)/u.test(t) ||
    /לא\s+(?:הובלה|משלוח|פנייה)\s+נוס/.test(t)
  );
}

function itemDescriptionsMatch(
  existing: Array<Pick<Item, "kind" | "description">>,
  next: Array<Pick<Item, "kind" | "description">>,
): boolean {
  if (existing.length !== next.length) return false;
  return existing.every((item, index) => {
    const n = next[index];
    if (!n || item.kind !== n.kind) return false;
    if (item.kind !== "other") return true;
    const a = item.description.replace(/\s+/g, "");
    const b = n.description.replace(/\s+/g, "");
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
  });
}

function receiverKey(p: Party | undefined): string | null {
  if (!p) return null;
  if (p.phone) return `p:${p.phone}`;
  if (p.name) return `n:${norm(p.name)}`;
  return null;
}
const party = (
  role: Party["role"],
  phone: string | null,
  approved = false,
): Party => ({
  role,
  phone,
  name: null,
  settlement: null,
  address: null,
  floor: null,
  floor_note_shown: false,
  approved_at: approved ? new Date().toISOString() : null,
  approved_by: approved ? phone : null,
  schedule_approved: false,
  schedule_approved_date: null,
  schedule_approved_at: null,
});
export function asItem(
  i: Pick<Item, "kind" | "description" | "quantity">,
): Item {
  return {
    ...i,
    free: null,
    working: null,
    needs_disassembly: null,
    wardrobe_small_whole: null,
    oven_type: null,
    evacuation: null,
  };
}
function target(ctx: Context, number: number | null): Request {
  const explicit = number
    ? ctx.requests.find((r) => r.number === number)
    : undefined;
  const text = (ctx.message.transcript ?? ctx.message.text).trim();
  const byItem = !number && ctx.requests.length > 1
    ? ctx.requests.filter((r) => r.items.some((i) => text.includes(i.description) || text.includes(i.kind)))
    : [];
  const open = ctx.requests.filter(
    (r) => !["coordinated", "closed", "cancelled", "rejected"].includes(r.status),
  );
  const selected =
    ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
    undefined;
  const r = explicit ?? (byItem.length === 1 ? byItem[0] : undefined) ??
    (open.length === 1 ? open[0] : undefined) ??
    selected ??
    (ctx.requests.length === 1 ? ctx.requests[0] : undefined);
  if (!r)
    throw new AppError(
      "choose_request",
      409,
      ctx.requests.length
        ? "לאיזו פנייה התכוונת? נא לציין מספר פנייה."
        : "נא לציין אם ברצונך למסור פריט, לקבל פריט או לתאם הובלה.",
    );
  return r;
}
function suppliedPhone(_ctx: Context, input: string): string {
  // Action manager supplies the phone field; canonicalize and write.
  return canonicalPhone(input);
}
export class Commands {
  constructor(
    private readonly s: Store,
    private readonly now: () => Date,
  ) {}

  private pendingExtra(ctx: Context): PendingExtraItem | null {
    return (ctx.conversation.pending_extra_item as PendingExtraItem | null) ?? null;
  }

  private async setPendingExtra(
    c: pg.PoolClient,
    ctx: Context,
    pending: PendingExtraItem | null,
  ): Promise<void> {
    await c.query(
      "UPDATE conversations SET pending_extra_item=$2,version=version+1 WHERE id=$1",
      [ctx.conversation.id, pending ? JSON.stringify(pending) : null],
    );
    ctx.conversation.pending_extra_item = pending;
  }

  private async clearPendingExtra(c: pg.PoolClient, ctx: Context): Promise<void> {
    await this.setPendingExtra(c, ctx, null);
  }

  async apply(c: pg.PoolClient, ctx: Context, cmd: Command): Promise<Outcome> {
    const phone = ctx.conversation.phone,
      text = ctx.message.transcript ?? ctx.message.text,
      notices: Notice[] = [];
    // Customer wording is owned by the Reply manager post-commit. Command
    // handlers may still pass draft strings for logs, but they never seed
    // the customer outbox.
    const output = (
      _reply: string | null,
      request: Request | null = null,
    ): Outcome => ({ reply: null, request, notices });
    const invalidateProposal = (request: Request) => {
      request.proposed_run_date = null;
      for (const party of request.parties) {
        party.schedule_approved = false;
        party.schedule_approved_date = null;
        party.schedule_approved_at = null;
      }
    };
    if (cmd.type === "resolve_extra_item") {
      const pending = this.pendingExtra(ctx);
      if (!pending || pending.stage !== "replace_or_add")
        return output(null);
      const existing = await this.s.request(pending.request_id, c, true);
      ownParty(existing, phone, "donor");
      if (cmd.choice === "replace") {
        mutable(existing);
        existing.items = pending.items.map((item) => {
          const next = asItem(item);
          next.free = pending.free === false ? false : true;
          next.working =
            pending.direct ? (pending.working ?? true) : pending.working;
          return next;
        });
        if (pending.direct) existing.origin = "direct";
        await this.s.save(c, existing);
        await this.clearPendingExtra(c, ctx);
        return output(null, existing);
      }
      // add → ask same/other recipient
      pending.stage = "same_or_other_recipient";
      await this.setPendingExtra(c, ctx, pending);
      return output(null, existing);
    }
    if (cmd.type === "resolve_extra_recipient") {
      const pending = this.pendingExtra(ctx);
      if (!pending || pending.stage !== "same_or_other_recipient")
        return output(null);
      if (cmd.choice === "same") {
        const existing = await this.s.request(pending.request_id, c, true);
        ownParty(existing, phone, "donor");
        mutable(existing);
        for (const item of pending.items) {
          const next = asItem(item);
          next.free = pending.free === false ? false : true;
          next.working =
            pending.direct ? (pending.working ?? true) : pending.working;
          existing.items.push(next);
        }
        await this.s.save(c, existing);
        await this.clearPendingExtra(c, ctx);
        return output(null, existing);
      }
      // other recipient → second request, one item, same donor
      const items = pending.items.map((item) => {
        const next = asItem(item);
        next.free = pending.free === false ? false : true;
        next.working =
          pending.direct ? (pending.working ?? true) : pending.working;
        return next;
      });
      const parties = [party("donor", phone, true)];
      if (pending.counterparty_phone) {
        const receiverPhone = suppliedPhone(ctx, pending.counterparty_phone);
        const receiver = party("receiver", receiverPhone, receiverPhone === phone);
        if (pending.counterparty_name) receiver.name = pending.counterparty_name;
        parties.push(receiver);
      } else if (pending.counterparty_name) {
        const receiver = party("receiver", null, false);
        receiver.name = pending.counterparty_name;
        parties.push(receiver);
      }
      const r = await this.s.create(
        c,
        items,
        parties,
        pending.direct || pending.counterparty_phone || pending.counterparty_name
          ? "direct"
          : "donation",
      );
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      if (pending.counterparty_name || pending.counterparty_phone) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        ctx.conversation.pending_counterparty_name = null;
        ctx.conversation.pending_counterparty_phone = null;
      }
      await this.clearPendingExtra(c, ctx);
      return output(null, r);
    }
    if (cmd.type === "status") return output(statusText(ctx.requests));
    if (cmd.type === "seek") {
      const id = await this.s.contact(c, phone);
      let settlement = cmd.settlement ?? null;
      if (settlement) {
        const reg = await this.s.region(c, settlement);
        if (reg.decision === "outside") return output(null);
        if (reg.decision === "review") {
          settlement = await this.s.ensureLocation(c, reg.name, "review");
        } else settlement = reg.name;
      }
      const floor = cmd.floor ?? null;
      const address = cmd.address ?? null;
      const name = cmd.name ?? null;
      await c.query(
        `INSERT INTO searches(contact_id,kind,settlement,address,floor,name)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(contact_id) DO UPDATE SET
           kind=EXCLUDED.kind,
           state='active',
           settlement=COALESCE(EXCLUDED.settlement, searches.settlement),
           address=COALESCE(EXCLUDED.address, searches.address),
           floor=COALESCE(EXCLUDED.floor, searches.floor),
           name=COALESCE(EXCLUDED.name, searches.name),
           updated_at=clock_timestamp()`,
        [id, cmd.kind, settlement, address, floor, name],
      );
      const saved: string[] = [];
      if (name) saved.push(`שם ${name}`);
      if (settlement) saved.push(settlement);
      if (address) saved.push(address);
      if (floor !== null) saved.push(`קומה ${floor}`);
      const candidates = await this.s.candidates(phone, c);
      if (!candidates.length)
        return output(null);
      const candidate = candidates[0]!.request;
      await this.s.matchPhoto(c, candidate, phone, ctx.message);
      return output(null);
    }
    if (cmd.type === "donate" || cmd.type === "receive_from_donor") {
      const items = cmd.items.map(asItem);
      const isDonor = cmd.type === "donate";
      // Contact cards often arrive in the same coalesced turn as the item.
      // Enrich missing counterparty phone/name from the vCard before write.
      const card = ctx.message.contacts[0];
      let other = isDonor ? cmd.counterparty_phone : cmd.donor_phone;
      if (isDonor && !other && card?.phone) other = card.phone;
      if (
        isDonor &&
        cmd.type === "donate" &&
        !cmd.counterparty_name &&
        card?.name
      )
        cmd.counterparty_name = card.name.replace(/^אא\s+/u, "").trim() || card.name;
      // A named recipient from the action manager is a direct handoff even
      // when the model omitted direct:true — persist that, do not keep the
      // open-donation photo loop.
      const direct =
          Boolean(other) ||
          (cmd.type === "donate" &&
            (cmd.direct === true || Boolean(cmd.counterparty_name)));
      // Action manager chose donate/receive — persist it. Do not re-judge
      // donor intent from the raw customer wording.
      if (cmd.type === "donate")
        for (const i of items) {
          i.free = cmd.free === false ? false : true;
          // A direct handoff has a known recipient or an explicit named
          // handoff intent. It never needs the generic condition question.
          i.working = direct ? (cmd.working ?? true) : cmd.working;
        }
      // itemError is advisory for prompts only — never block the write.
      void itemError(items, false);
      const parties = [party(isDonor ? "donor" : "receiver", phone, isDonor)];
      if (isDonor) {
        const selfName = recentSelfName(ctx, text);
        if (selfName) parties[0]!.name = selfName;
      }
      if (other) {
        const p = suppliedPhone(ctx, other);
        const counterparty = party(
          isDonor ? "receiver" : "donor",
          p,
          p === phone && isDonor,
        );
        if (isDonor && cmd.counterparty_name)
          counterparty.name = cmd.counterparty_name;
        parties.push(counterparty);
      } else if (
        isDonor &&
        cmd.type === "donate" &&
        cmd.counterparty_name
      ) {
        // Name-only receiver: persist on the party (phone null). Do not use
        // pending_counterparty_name for this case — prompts ask for phone.
        const receiver = party("receiver", null, false);
        receiver.name = cmd.counterparty_name;
        parties.push(receiver);
      }
      // Soft photo ask is prompt/reply-manager owned.
      // Hard boundary #4 — duplicate request (donor+receiver+item[+date]):
      // incomplete fields → update existing; full triple+date → update only;
      // full triple without date → ask before opening a twin; different
      // known receiver → new request allowed.
      const sameItemShape = (existing: Request) =>
        existing.parties.some((p) => p.role === "donor" && p.phone === phone) &&
        itemDescriptionsMatch(existing.items, items);
      const openSameItem = ctx.requests.filter(
        (existing) =>
          !["coordinated", "closed", "cancelled", "rejected", "cancel_pending"].includes(
            existing.status,
          ) && sameItemShape(existing),
      );
      const incomingReceiver = parties.find((p) => p.role === "receiver");
      const incomingReceiverKey = receiverKey(incomingReceiver);
      const pendingAnother = this.pendingExtra(ctx);
      const confirmedAnother =
        pendingAnother?.stage === "confirm_another_delivery" &&
        itemDescriptionsMatch(
          pendingAnother.items.map((i) => ({
            kind: i.kind,
            description: i.description,
          })),
          items,
        ) &&
        (explicitAnotherDelivery(text) || bareYes(text));
      if (
        pendingAnother?.stage === "confirm_another_delivery" &&
        (explicitNotAnotherDelivery(text) ||
          (bareNo(text) && !explicitAnotherDelivery(text)))
      ) {
        await this.clearPendingExtra(c, ctx);
        const existing = await this.s.request(pendingAnother.request_id, c, true);
        // Fall through to update path via sameOpenRequest below.
        openSameItem.unshift(existing);
      }
      let sameOpenRequest: Request | undefined;
      if (!confirmedAnother && openSameItem.length) {
        const withRecv = openSameItem.map((existing) => {
          const existingRecv = existing.parties.find((p) => p.role === "receiver");
          const existingKey = receiverKey(existingRecv);
          const incomplete = !existingKey || !incomingReceiverKey;
          const match =
            Boolean(existingKey && incomingReceiverKey && existingKey === incomingReceiverKey);
          const different =
            Boolean(existingKey && incomingReceiverKey && existingKey !== incomingReceiverKey);
          const existingDate =
            existing.proposed_run_date?.slice(0, 10) ??
            existing.run_date?.slice(0, 10) ??
            existing.earliest_run_date?.slice(0, 10) ??
            null;
          // Donate has no date field; date is complete only when existing has one
          // and the customer restated the same date in this turn.
          const dateInText = existingDate && text.includes(existingDate);
          const dateMatch = Boolean(existingDate && dateInText);
          const dateIncomplete = !existingDate || !dateInText;
          return { existing, incomplete, match, different, dateMatch, dateIncomplete };
        });
        // Prefer updating when incomplete or date-certain match.
        const updateCandidate =
          withRecv.find((x) => x.incomplete) ??
          withRecv.find((x) => x.match && x.dateMatch) ??
          withRecv.find((x) => x.match && x.dateIncomplete);
        if (updateCandidate?.incomplete || updateCandidate?.dateMatch) {
          sameOpenRequest = updateCandidate.existing;
        } else if (updateCandidate?.match && updateCandidate.dateIncomplete) {
          // Full donor+receiver+item match, date unknown → ask; do not create.
          await this.setPendingExtra(c, ctx, {
            stage: "confirm_another_delivery",
            request_id: updateCandidate.existing.id,
            request_number: updateCandidate.existing.number,
            existing_description: describeItems(updateCandidate.existing.items),
            items: cmd.type === "donate" ? cmd.items : items,
            free: cmd.type === "donate" ? (cmd.free ?? null) : null,
            working: cmd.type === "donate" ? (cmd.working ?? null) : null,
            direct: Boolean(direct),
            counterparty_phone: other ?? null,
            counterparty_name:
              cmd.type === "donate" ? (cmd.counterparty_name ?? null) : null,
          });
          return output(null, updateCandidate.existing);
        } else if (!withRecv.some((x) => x.different)) {
          // Same item, no differing receiver → default update (covers empty #1 + vCard).
          sameOpenRequest = openSameItem[0];
        }
        // else: known different receiver → allow create below
      }
      if (!sameOpenRequest && !confirmedAnother) {
        const rejectedOutside = await c.query<{ id: string }>(
          `SELECT r.id FROM requests r
           JOIN request_parties p ON p.request_id=r.id
           JOIN contacts co ON co.id=p.contact_id
           JOIN request_items i ON i.request_id=r.id
           WHERE co.phone=$1 AND p.role='donor'
             AND r.status='rejected'
             AND EXISTS (
               SELECT 1 FROM request_events e
               WHERE e.request_id=r.id AND e.event_type='outside_area_rejected'
             )
             AND (
               (i.kind = ANY($2::text[]) AND i.kind <> 'other')
               OR (i.kind = 'other' AND i.description = ANY($3::text[]))
             )
           ORDER BY r.number DESC LIMIT 1`,
          [
            phone,
            items.map((item) => item.kind),
            items.filter((item) => item.kind === "other").map((item) => item.description),
          ],
        );
        if (rejectedOutside.rows[0])
          sameOpenRequest = await this.s.request(rejectedOutside.rows[0].id, c);
      }
      if (confirmedAnother) await this.clearPendingExtra(c, ctx);
      if (sameOpenRequest) {
        // Reopen outside-area rejection and persist fields the action manager sent.
        const existing = await this.s.request(sameOpenRequest.id, c, true);
        if (existing.status === "rejected") {
          const outside = await c.query(
            `SELECT 1 FROM request_events
              WHERE request_id=$1 AND event_type='outside_area_rejected'
              LIMIT 1`,
            [existing.id],
          );
          if (outside.rowCount) {
            existing.status = "collecting";
            existing.human_reason = null;
          }
        }
        const beforeMerge: Request = {
          ...existing,
          parties: existing.parties.map((p) => ({ ...p })),
          items: existing.items.map((i) => ({ ...i })),
        };
        mutable(existing);
        const beforeOrigin = beforeMerge.origin;
        const beforeReceiver = beforeMerge.parties.find((entry) => entry.role === "receiver");
        const beforePendingName = ctx.conversation.pending_counterparty_name;
        existing.items = items.map((item, index) => ({
          ...(existing.items[index] ?? asItem(item)),
          ...item,
          free: item.free === false ? false : true,
          working:
            direct
              ? (item.working ?? existing.items[index]?.working ?? true)
              : (item.working ?? existing.items[index]?.working ?? null),
        }));
        if (direct && isDonor) {
          existing.origin = "direct";
          for (const item of existing.items)
            if (item.working === null) item.working = true;
          if (other) {
            const receiverPhone = suppliedPhone(ctx, other);
            const linked = existing.parties.find((entry) => entry.role === "receiver");
            if (!linked) {
              const receiver = party("receiver", receiverPhone, receiverPhone === phone);
              if (cmd.type === "donate" && cmd.counterparty_name)
                receiver.name = cmd.counterparty_name;
              existing.parties.push(receiver);
            } else if (linked.phone === null || linked.phone === receiverPhone) {
              linked.phone = receiverPhone;
              if (cmd.type === "donate" && cmd.counterparty_name)
                linked.name = cmd.counterparty_name;
            } else {
              // Prompt owns conflicts — overwrite linked phone/name on write.
              linked.phone = receiverPhone;
              if (cmd.type === "donate" && cmd.counterparty_name)
                linked.name = cmd.counterparty_name;
            }
            if (
              existing.parties.length === 2 &&
              existing.parties[0]!.phone &&
              existing.parties[0]!.phone === existing.parties[1]!.phone
            )
              existing.represents_both_parties = true;
          } else if (
            cmd.type === "donate" &&
            cmd.counterparty_name &&
            !existing.parties.some((entry) => entry.role === "receiver")
          ) {
            const receiver = party("receiver", null, false);
            receiver.name = cmd.counterparty_name;
            existing.parties.push(receiver);
          } else if (cmd.type === "donate" && cmd.counterparty_name) {
            const linked = existing.parties.find((entry) => entry.role === "receiver");
            if (linked && !linked.phone) linked.name = cmd.counterparty_name;
          }
        }
        await this.s.save(c, existing);
        await c.query(
          "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
          [ctx.conversation.id, existing.id],
        );
        // Name-only or phone receiver is on the party — clear pending name/phone.
        if (
          other ||
          (cmd.type === "donate" && (cmd.counterparty_phone || cmd.counterparty_name))
        ) {
          await c.query(
            "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
            [ctx.conversation.id],
          );
          ctx.conversation.pending_counterparty_name = null;
          ctx.conversation.pending_counterparty_phone = null;
        }
        const unchangedDirect =
          beforeOrigin === existing.origin &&
          beforeReceiver?.phone ===
            existing.parties.find((entry) => entry.role === "receiver")?.phone &&
          beforeReceiver?.name ===
            existing.parties.find((entry) => entry.role === "receiver")?.name &&
          beforePendingName === ctx.conversation.pending_counterparty_name;
        // Same facts again: keep the conversation moving with the next missing
        // detail instead of looping on the opening photo ask.
        if (unchangedDirect && existing.origin === "direct")
          return output(null, existing);
        return output(null, existing);
      }
      const r = await this.s.create(
        c,
        items,
        parties,
        isDonor && !direct ? "donation" : "direct",
      );
      if (
        parties.length === 2 &&
        parties[0]!.phone &&
        parties[0]!.phone === parties[1]!.phone
      ) {
        r.represents_both_parties = true;
        await this.s.save(c, r);
      }
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      // Clear any sticky pending — name-only receiver is already on parties.
      if (
        other ||
        (cmd.type === "donate" && (cmd.counterparty_phone || cmd.counterparty_name))
      ) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        ctx.conversation.pending_counterparty_name = null;
        ctx.conversation.pending_counterparty_phone = null;
      }
      for (const p of parties)
        if (p.phone && p.phone !== phone && !direct)
          notices.push({
            phone: p.phone,
            text: `נפתחה פנייה ${r.number} לגבי ${r.items.map((i) => i.description).join(", ")}. נא לאשר את חלקך ב${p.role === "donor" ? "מסירה" : "קבלה"}. ההובלות בימי שלישי 16:00–20:00, ובדרך כלל עד ${DEFAULT_TRANSPORT_CAPACITY} הובלות בכל יום שלישי. מעבר לכך נבקש תחילה אישור מנהל. נעדכן.`,
          });
      // or set NO_PHOTO here.
      return output(null, r);
    }
    if (cmd.type === "interest") {
      const candidate = ctx.candidates.find(
        (x) => x.request.number === cmd.request_number,
      );
      if (!candidate) return output(null);
      const r = await this.s.request(candidate.request.id, c, true);
      mutable(r);
      if (candidate.state !== "presented") return output(null, r);
      if (!r.parties.some((p) => p.role === "receiver"))
        r.parties.push(party("receiver", phone));
      else {
        const recv = r.parties.find((p) => p.role === "receiver")!;
        recv.phone = phone;
      }
      r.status = "awaiting_approval";
      await c.query(
        `UPDATE matches SET state=CASE WHEN id=$2 THEN 'interested' ELSE 'unavailable' END WHERE request_id=$1`,
        [r.id, candidate.match_id],
      );
      await c.query(
        `UPDATE searches SET state='matched' WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)`,
        [phone],
      );
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      return output(null, r);
    }
    if (cmd.type === "escalate" && !ctx.requests.length) {
      // Borderline / unknown questions: open a request, park for team, keep talking.
      const r = await this.s.create(c, [], [party("donor", phone)], "donation");
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      if (cmd.reason === "borderline_area") {
        r.needs_distance_check = true;
        r.team_notes = appendTeamNote(
          r.team_notes,
          `בדיקת מרחק (לפני פרטי יישוב): ${text.slice(0, 200)}`,
        );
        await this.s.save(c, r);
        return output(null, r);
      }
      r.team_notes = appendTeamNote(
        r.team_notes,
        `שאלה לצוות (${cmd.reason}): ${text.slice(0, 400)}`,
      );
      await this.s.save(c, r);
      return output(null, r);
    }
    if (cmd.type === "next" && !ctx.requests.length) {
      const town = mentionedAllowedSettlement(text);
      if (town && !donationIntent(text))
        return output(null);
      if (
        /(?:ליד|קרוב|באזור|סמוך)/u.test(norm(text)) &&
        /בית\s*שאן|beit\s+she'?an/i.test(text)
      )
        return output(null);
      const pendingName = ctx.conversation.pending_counterparty_name;
      const handoffName = (() => {
        const names = [
          ...norm(text).matchAll(/(?:^|\s)ל([א-ת]{2,})(?=$|[\s,.;!?])/gu),
        ]
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
                "מסור",
                "מסורה",
                "העביר",
                "העבירה",
                "קבל",
                "קבלת",
                "תת",
                "תרום",
              ].includes(name),
          );
        return names.at(-1) ?? null;
      })();
      if (donationIntent(text) && handoffName) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1",
          [ctx.conversation.id, handoffName],
        );
        ctx.conversation.pending_counterparty_name = handoffName;
        return output(null);
      }
      const supplied =
        ctx.message.contacts[0]?.phone ??
        (() => {
          try {
            const match = text.match(/(?:\+?972|0)?[\d][\d\s().-]{7,14}\d/);
            return match ? canonicalPhone(match[0]) : null;
          } catch {
            return null;
          }
        })();
      const contactName =
        ctx.message.contacts[0]?.name?.replace(/^אא\s+/u, "").trim() || null;
      const stickyName =
        pendingName ||
        handoffName ||
        contactName ||
        (() => {
          const recent = (ctx.history ?? [])
            .filter((entry) => entry.role === "user")
            .slice(-6)
            .map((entry) => entry.content)
            .join("\n");
          const match = norm(recent).match(
            /(?:למסור|להעביר|מוסר|מוסרת|מעביר|מעבירה)\s+(?:את\s+)?(?:הפריט|הרהיט|רהיט|מיטה|שולחן|ספה|כיסא|ארון)?\s*ל([א-ת]{2,})/u,
          );
          return match?.[1] ?? null;
        })();
      if (stickyName && !pendingName) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1",
          [ctx.conversation.id, stickyName],
        );
        ctx.conversation.pending_counterparty_name = stickyName;
      }
      if ((pendingName || stickyName) && supplied) {
        const name = pendingName || stickyName!;
        await c.query(
          `UPDATE conversations
              SET pending_counterparty_name=$2,pending_counterparty_phone=$3,version=version+1
            WHERE id=$1`,
          [ctx.conversation.id, name, supplied],
        );
        ctx.conversation.pending_counterparty_name = name;
        ctx.conversation.pending_counterparty_phone = supplied;
        return output(null);
      }
      if (pendingName || stickyName)
        return output(null);
      if (recentSelfName(ctx, text) && donationIntent(
        (ctx.history ?? [])
          .filter((entry) => entry.role === "user")
          .slice(-6)
          .map((entry) => entry.content)
          .join("\n") +
          "\n" +
          text,
      ))
        return output(null);
      return output(null);
    }
    // Contact card / counterparty before any request exists: keep sticky
    // handoff and ask for the item instead of choose_request / path re-ask.
    if (
      (cmd.type === "counterparty_candidate" || cmd.type === "counterparty") &&
      !ctx.requests.length
    ) {
      const candidatePhone =
        "phone" in cmd && cmd.phone
          ? suppliedPhone(ctx, cmd.phone)
          : ctx.message.contacts[0]?.phone
            ? suppliedPhone(ctx, ctx.message.contacts[0].phone)
            : null;
      const candidateName =
        ("name" in cmd && cmd.name) ||
        ctx.message.contacts[0]?.name?.replace(/^אא\s+/u, "").trim() ||
        ctx.conversation.pending_counterparty_name;
      if (candidatePhone || candidateName) {
        await c.query(
          `UPDATE conversations
              SET pending_counterparty_name=COALESCE($2, pending_counterparty_name),
                  pending_counterparty_phone=COALESCE($3, pending_counterparty_phone),
                  version=version+1
            WHERE id=$1`,
          [ctx.conversation.id, candidateName, candidatePhone],
        );
        if (candidateName)
          ctx.conversation.pending_counterparty_name = candidateName;
        if (candidatePhone)
          ctx.conversation.pending_counterparty_phone = candidatePhone;
        return output(null);
      }
    }
    if (cmd.type === "details" && !ctx.requests.length) {
      if (
        ctx.conversation.pending_counterparty_name ||
        donationIntent(
          (ctx.history ?? [])
            .filter((entry) => entry.role === "user")
            .slice(-6)
            .map((entry) => entry.content)
            .join("\n"),
        )
      ) {
        return output(null);
      }
    }
    if (cmd.type === "clarify_duplicate") {
      // A duplicate message can arrive after the other party has approved.
      // Reload under the transaction lock so returning this read-only reply
      // can never overwrite a newer approval with a stale context snapshot.
      const stale = target(ctx, cmd.request_number);
      const existing = await this.s.request(stale.id, c, true);
      ownParty(existing, phone);
      return output(null, existing);
    }
    const n = "request_number" in cmd ? cmd.request_number : null;
    const initial = target(ctx, n),
      r = await this.s.request(initial.id, c, true);
    ownParty(r, phone);
    if (cmd.type === "select") {
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      return output(null);
    }
    if (cmd.type === "counterparty_candidate") {
      const candidatePhone = suppliedPhone(ctx, cmd.phone);
      await c.query(
        `UPDATE conversations
            SET pending_counterparty_name=$2,pending_counterparty_phone=$3,version=version+1
          WHERE id=$1`,
        [ctx.conversation.id, cmd.name, candidatePhone],
      );
      return output(null, r);
    }
    if (cmd.type === "confirm_counterparty") {
      const candidatePhone = ctx.conversation.pending_counterparty_phone;
      const candidateName = ctx.conversation.pending_counterparty_name;
      if (!candidatePhone) return output(null, r);
      await c.query(
        `UPDATE conversations
            SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1
          WHERE id=$1`,
        [ctx.conversation.id],
      );
      if (!cmd.accept)
        return output(null, r);
      const existingReceiver = r.parties.find((entry) => entry.role === "receiver");
      if (existingReceiver) {
        existingReceiver.phone = candidatePhone;
        existingReceiver.name = candidateName ?? existingReceiver.name;
      } else {
        const receiver = party("receiver", candidatePhone, false);
        receiver.name = candidateName;
        r.parties.push(receiver);
      }
      r.origin = "direct";
      for (const item of r.items)
        if (item.working === null) item.working = true;
      // Linking the recipient is not consent to message them and not proof
      // that own-party details/rules are ready — nextQuestion decides.
      return output(null, r);
    }
    if (cmd.type === "contact_counterparty") {
      const other = r.parties.find((p) => p.phone !== phone);
      if (r.origin !== "direct" || !other) return output(null, r);
      const verification = await c.query<{ state: string }>(
        "SELECT state FROM request_verifications WHERE request_id=$1 AND role=$2",
        [r.id, other.role],
      );
      if (
        r.verification_contacted ||
        ["consented", "queued", "provider_accepted", "delivered", "approved"].includes(
          verification.rows[0]?.state ?? "",
        )
      )
        return output(null, r);
      // AI owns when to contact. Soft progress gates must not block the write.
      r.verification_contacted = cmd.contact;
      await c.query(
        `INSERT INTO request_verifications(request_id,role,state,consented_at,updated_at,last_error)
         VALUES($1,$2,$3,$4,clock_timestamp(),$5)
         ON CONFLICT(request_id,role) DO UPDATE SET state=EXCLUDED.state,consented_at=EXCLUDED.consented_at,updated_at=clock_timestamp(),last_error=EXCLUDED.last_error`,
        [
          r.id,
          other.role,
          cmd.contact ? "consented" : "declined",
          cmd.contact ? new Date() : null,
          cmd.contact ? null : "user_declined_contact",
        ],
      );
      if (cmd.contact) {
        if (other.phone) {
          notices.push({
            phone: other.phone,
            text: draftCounterpartyVerification({
              request: r,
              recipient: other,
              now: this.now(),
            }),
          });
          await c.query(
            `UPDATE conversations SET selected_request_id=$2,version=version+1
               WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)`,
            [other.phone, r.id],
          );
        }
      } else invalidateProposal(r);
      return output(null, r);
    }
    if (cmd.type === "escalate") {
      // Human handoff only when the customer insists after a clear denial.
      if (customerInsistsAfterDenial(text)) {
        if (r.status !== "coordinated") {
          r.status = "human";
          r.human_reason = "customer_insisted";
        }
        return { ...output(null, r), humanReason: "customer_insisted" };
      }
      if (cmd.reason === "borderline_area") {
        r.needs_distance_check = true;
        r.team_notes = appendTeamNote(
          r.team_notes,
          `בדיקת מרחק: ${text.slice(0, 200)}`,
        );
        if (r.status === "human") r.status = "collecting";
        r.human_reason = null;
        return output(null, r);
      }
      if (cmd.reason === "evacuation") {
        if (r.status !== "coordinated") {
          r.status = "human";
          r.human_reason = cmd.reason;
        }
        return { ...output(null, r), humanReason: cmd.reason };
      }
      // Unknown / unclear questions: park for team, keep collecting.
      r.team_notes = appendTeamNote(
        r.team_notes,
        `שאלה לצוות (${cmd.reason}): ${text.slice(0, 400)}`,
      );
      if (r.status === "human" && r.human_reason !== "customer_insisted") {
        r.status = "collecting";
        r.human_reason = null;
      }
      return output(null, r);
    }
    if (cmd.type === "cancel") {
      if (cmd.choice === "ask") {
        // Trust action-manager cancel choice; do not re-parse customer text.
        const base = r.run_date ?? nextTuesday(this.now()).date,
          after = new Date(base + "T12:00:00Z");
        after.setUTCDate(after.getUTCDate() + 7);
        r.earliest_run_date = after.toISOString().slice(0, 10);
        r.run_date = null;
        r.proposed_run_date = null;
        r.status = "cancel_pending";
        for (const p of r.parties) {
          p.schedule_approved = false;
          p.schedule_approved_date = null;
          p.schedule_approved_at = null;
        }
        for (const p of r.parties)
          if (p.phone && p.phone !== phone)
            notices.push({
              phone: p.phone,
              text: `התיאום בפנייה ${r.number} בוטל. נעדכן לגבי המשך הטיפול.`,
            });
        return output(null, r);
      }
      if (cmd.choice === "final") {
        const wasCoordinated = r.status === "coordinated";
        const items = r.items.map((item) => item.description).join(", ") || "פריט";
        r.status = "cancelled";
        r.run_date = null;
        r.proposed_run_date = null;
        r.closed_at = this.now().toISOString();
        for (const party of r.parties) {
          party.schedule_approved = false;
          party.schedule_approved_date = null;
          party.schedule_approved_at = null;
        }
        if (wasCoordinated)
          for (const party of r.parties)
            if (party.phone && party.phone !== phone)
              notices.push({
                phone: party.phone,
                text: `פנייה ${r.number} בוטלה: ${items}. לא תתואם הובלה.`,
              });
        return output(null, r);
      }
      if (r.status !== "cancel_pending")
        return output(null, r);
      r.status = "awaiting_approval";
      r.proposed_run_date = null;
      for (const p of r.parties) {
        p.schedule_approved = false;
        p.schedule_approved_date = null;
        p.schedule_approved_at = null;
      }
      return output(null, r);
    }
    if (cmd.type === "next") {
      const pending = this.pendingExtra(ctx);
      if (pending?.stage === "replace_or_add")
        return output(
          null,
          r,
        );
      if (pending?.stage === "same_or_other_recipient")
        return output(null, r);
      if (pending?.stage === "confirm_another_delivery") {
        if (explicitNotAnotherDelivery(text) || bareNo(text)) {
          await this.clearPendingExtra(c, ctx);
          return output(null, r);
        }
        if (explicitAnotherDelivery(text) || bareYes(text)) {
          // Keep pending so the next donate may open a twin; acknowledge.
          return output(null, r);
        }
        return output(null, r);
      }
      const previous = ctx.history.at(-1)?.content ?? "";
      const speaker = ownParty(r, phone);
      if (ambiguousStreetCity(text) && !speaker.address)
        return output(null, r);
      if (
        ownParty(r, phone).role === "donor" &&
        !r.parties.some((p) => p.role === "receiver") &&
        ctx.conversation.pending_counterparty_name &&
        /(?:אין לי מספר|אין מספר|אין מקבל|לא)/.test(text.trim())
      ) {
        await c.query("UPDATE conversations SET pending_counterparty_name=NULL,version=version+1 WHERE id=$1", [ctx.conversation.id]);
        return output(null, r);
      }
      if (
        ownParty(r, phone).role === "donor" &&
        !r.parties.some((p) => p.role === "receiver") &&
        /מקבל מסוים/.test(previous) &&
        /^(?:לא|אין(?: לי)?(?: מקבל)?|אין מקבל)/.test(text.trim())
      )
        return output(null, r);
      const q = nextQuestion(r, phone);
      if (q.floorNote) {
        ownParty(r, phone).floor_note_shown = true;
        return output(null, r);
      }
      return output(null, r);
    }
    if (
      cmd.type === "details" &&
      r.status === "rejected" &&
      cmd.settlement &&
      r.parties.some((candidate) => candidate.phone === phone)
    ) {
      const outsideRejection = await c.query(
        `SELECT 1 FROM request_events
         WHERE request_id=$1 AND event_type='outside_area_rejected'
         LIMIT 1`,
        [r.id],
      );
      const correctedRegion = await this.s.region(c, cmd.settlement);
      // Reopen on a corrected allowed town without requiring "טעיתי" wording.
      if (outsideRejection.rowCount && correctedRegion.decision === "allowed") {
        r.status = "collecting";
        r.human_reason = null;
      }
    }
    mutable(r);
    let distanceReviewThisTurn = false;
    if (cmd.type === "details") {
      if (cmd.name || cmd.settlement || cmd.address || cmd.floor !== null)
        invalidateProposal(r);
      const p = ownParty(r, phone, cmd.role ?? undefined);
      const settlementIsTheStreet =
        Boolean(cmd.settlement) &&
        Boolean(cmd.address) &&
        /^(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד)/.test(cmd.address ?? "") &&
        (cmd.address ?? "").includes(cmd.settlement ?? "");
      if (cmd.settlement && !settlementIsTheStreet) {
        // Always persist what Action wrote. Outside/review messaging is prompt-owned.
        const reg = await this.s.region(c, cmd.settlement);
        if (reg.decision === "review") {
          p.settlement = await this.s.ensureLocation(c, reg.name, "review");
          r.needs_distance_check = true;
          distanceReviewThisTurn = true;
          r.team_notes = appendTeamNote(
            r.team_notes,
            `בדיקת מרחק ליישוב: ${p.settlement}`,
          );
          if (r.status === "human") {
            r.status = "collecting";
            r.human_reason = null;
          }
        } else {
          p.settlement = reg.name || cmd.settlement;
        }
      }
      if (cmd.name) {
        p.name = cmd.name;
        if (r.represents_both_parties)
          for (const samePerson of r.parties.filter((entry) => entry.phone === phone))
            samePerson.name = cmd.name;
      }
      if (cmd.address) p.address = cmd.address.trim();
      // Never invent floor=0 — only store a floor the customer actually gave.
      if (cmd.floor !== null) p.floor = cmd.floor;
      if (cmd.preferred_time && validTransportPreference(cmd.preferred_time))
        r.preferred_time = cmd.preferred_time;
    } else if (cmd.type === "item_facts") {
      invalidateProposal(r);
      ownParty(r, phone, "donor");
      // Apply AI items directly — replace-vs-add / furniture-count are prompt-only.
      if (cmd.items)
        // Action manager owns the replacement item list. New kind/description
        // overwrite the previous row; keep prior free/working only when the
        // command leaves those fields unset on the item object.
        r.items = cmd.items.map((i, index) => {
          const previous = r.items[index];
          const next = { ...asItem(i), ...i };
          if (previous) {
            if (next.free === null && previous.free !== null) next.free = previous.free;
            if (next.working === null && previous.working !== null)
              next.working = previous.working;
          }
          return next;
        });
      for (const i of r.items) {
        // Trust action-manager field values; do not re-litigate free/working
        // from raw customer wording.
        if (cmd.free !== null) i.free = cmd.free;
        if (cmd.working !== null) i.working = cmd.working;
        if (i.kind === "wardrobe") {
          if (cmd.wardrobe_small_whole !== null)
            i.wardrobe_small_whole = cmd.wardrobe_small_whole;
          if (cmd.needs_disassembly !== null)
            i.needs_disassembly = cmd.needs_disassembly;
        } else if (appliance(i)) i.needs_disassembly = false;
        else if (cmd.needs_disassembly !== null)
          i.needs_disassembly = cmd.needs_disassembly;
        if (i.kind === "oven" && cmd.oven_type) i.oven_type = cmd.oven_type;
        if (cmd.evacuation) i.evacuation = cmd.evacuation;
      }
      // itemError / evacuation policy are prompt-owned — persist facts as written.
      void itemError(r.items, r.photo_ids.length > 0);
      if (r.items.some((i) => i.evacuation === "different")) {
        r.human_reason = "evacuation";
      }
    } else if (cmd.type === "counterparty") {
      const role = ownParty(r, phone).role === "donor" ? "receiver" : "donor";
      const other = r.parties.find((p) => p.role === role);
      if (!cmd.phone) {
        // Missing phone is incompleteness for Reply to ask — not a 403 human escalate.
        if (role !== "receiver" || !cmd.name)
          return output(null, r);
        if (other) {
          other.name = cmd.name;
        } else {
          const receiver = party("receiver", null, false);
          receiver.name = cmd.name;
          r.parties.push(receiver);
        }
        r.origin = "direct";
        for (const item of r.items)
          if (item.working === null) item.working = true;
        invalidateProposal(r);
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        ctx.conversation.pending_counterparty_name = null;
        ctx.conversation.pending_counterparty_phone = null;
        // Fall through to nextQuestion — prompts may ask for phone naturally.
      } else {
        const targetPhone = suppliedPhone(ctx, cmd.phone);
        if (other) {
          if (other.phone === targetPhone)
            return output(null);
          if (other.phone === null) {
            // Attach phone to a prior name-only receiver party.
            other.phone = targetPhone;
            other.name =
              ctx.message.contacts.find((x) => x.phone === targetPhone)?.name ??
              other.name ??
              ctx.conversation.pending_counterparty_name ??
              cmd.name ??
              null;
          } else {
            // Prompt owns phone changes — overwrite linked counterparty.
            other.phone = targetPhone;
            other.name =
              ctx.message.contacts.find((x) => x.phone === targetPhone)?.name ??
              other.name ??
              ctx.conversation.pending_counterparty_name ??
              cmd.name ??
              null;
          }
        } else {
          const p = party(
            role,
            targetPhone,
            targetPhone === phone &&
              r.parties.some((x) => x.phone === phone && x.approved_at !== null),
          );
          // A contact card is identity data, never consent.
          p.name =
            ctx.message.contacts.find((x) => x.phone === targetPhone)?.name ??
            ctx.conversation.pending_counterparty_name ??
            cmd.name ??
            null;
          r.parties.push(p);
        }
        invalidateProposal(r);
        // Adding a named receiver converts an open donation into a direct
        // handoff.  The generic condition question is not part of this flow.
        if (role === "receiver")
          for (const item of r.items)
            if (item.working === null) item.working = true;
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        ctx.conversation.pending_counterparty_name = null;
        ctx.conversation.pending_counterparty_phone = null;
        r.origin = "direct";
        if (
          r.parties.length === 2 &&
          r.parties[0]!.phone &&
          r.parties[0]!.phone === r.parties[1]!.phone
        )
          r.represents_both_parties = true;
        // In a direct handoff, receiving a phone number is not permission to
        // contact that person. The initiating party must explicitly choose the
        // verification-message option first.
      }
    } else if (cmd.type === "approve_self") {
      // Trust action-manager approval command; do not re-litigate wording.
      for (const p of r.parties)
        if (p.phone === phone) {
          p.approved_at ??= this.now().toISOString();
          p.approved_by = phone;
        }
    } else if (cmd.type === "approve_schedule") {
      const proposedDate = r.proposed_run_date?.slice(0, 10) ?? null;
      // Persist approval when Action asks; prompt owns date/self-approval gates.
      if (!proposedDate) return output(null, r);
      if (cmd.date && cmd.date !== proposedDate) return output(null, r);
      for (const p of r.parties)
        if (p.phone === phone) {
          p.schedule_approved = true;
          p.schedule_approved_date = r.proposed_run_date;
          p.schedule_approved_at = this.now().toISOString();
        }
    }
    if (r.parties.length === 1 && r.photo_ids.length) r.status = "available";
    let q = nextQuestion(r, phone);
    if (q.floorNote) ownParty(r, phone).floor_note_shown = true;
    if (distanceReviewThisTurn)
      return output(null, r);
    return output(null, r);
  }
}
