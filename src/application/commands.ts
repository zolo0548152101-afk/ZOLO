import type pg from "pg";
import {
  AppError,
  type Context,
  type Command,
  type Request,
  type Item,
  type ItemInput,
  type Party,
  type Notice,
  type PendingExtraItem,
} from "../domain/types.js";
import { Store } from "../infrastructure/store.js";
import {
  HUMAN_REPLY,
  DEFAULT_TRANSPORT_CAPACITY,
  OUTSIDE,
  canonicalPhone,
  donationIntent,
  ambiguousStreetCity,
  itemError,
  ownParty,
  mutable,
  appliance,
  nextQuestion,
  photoGate,
  openingPhotoReply,
  composeRecordedReply,
  photoAskAlreadySent,
  photoDeclined,
  readyToAskContactCounterparty,
  statusText,
  nextTuesday,
  norm,
  mentionedAllowedSettlement,
} from "../domain/policies.js";
export interface Outcome {
  reply: string | null;
  request: Request | null;
  notices: Notice[];
  humanReason?: string;
}

const OPEN_STATUSES = new Set([
  "collecting",
  "available",
  "awaiting_approval",
  "waiting_capacity",
  "human",
  "cancel_pending",
]);

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

function donorOpenRequests(ctx: Context, phone: string): Request[] {
  return ctx.requests.filter(
    (r) =>
      OPEN_STATUSES.has(r.status) &&
      r.parties.some((p) => p.role === "donor" && p.phone === phone),
  );
}

function furnitureCount(requests: Request[]): number {
  return requests.reduce(
    (n, r) => n + r.items.reduce((m, i) => m + i.quantity, 0),
    0,
  );
}

function itemFingerprint(items: Array<Pick<Item, "kind" | "description">>): string {
  return items
    .map((i) =>
      i.kind === "other"
        ? `other:${i.description.replace(/\s+/g, "")}`
        : i.kind,
    )
    .sort()
    .join("|");
}

function sameItemSet(
  existing: Array<Pick<Item, "kind" | "description">>,
  next: Array<Pick<Item, "kind" | "description">>,
): boolean {
  return itemFingerprint(existing) === itemFingerprint(next);
}

function describeItems(items: Array<Pick<Item, "description">>): string {
  return items.map((i) => i.description).join(", ");
}

const THIRD_ITEM_REPLY =
  "ניתן לסייע בהובלת עד שני רהיטים לכל מוסר. כבר רשומים אצלך שני פריטים, לכן לא ניתן להוסיף פריט נוסף כרגע.";

function replaceOrAddQuestion(existingDesc: string, nextDesc: string): string {
  return `כבר רשומה אצלך מסירה של ${existingDesc}. האם ${nextDesc} במקום ${existingDesc}, או בנוסף אליה? כתוב "במקום" או "בנוסף".`;
}

function sameOrOtherQuestion(nextDesc: string): string {
  return `האם ${nextDesc} מיועד/ת לאותו מקבל, או לאדם אחר? כתוב "אותו מקבל" או "מקבל אחר".`;
}
const party = (
  role: Party["role"],
  phone: string,
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

  private buildPendingFromDonate(
    primary: Request,
    items: ItemInput[],
    cmd: Extract<Command, { type: "donate" }>,
    stage: PendingExtraItem["stage"],
  ): PendingExtraItem {
    return {
      stage,
      request_id: primary.id,
      request_number: primary.number,
      existing_description: describeItems(primary.items),
      items,
      free: cmd.free ?? null,
      working: cmd.working ?? null,
      direct: Boolean(cmd.direct || cmd.counterparty_phone || cmd.counterparty_name),
      counterparty_phone: cmd.counterparty_phone ?? null,
      counterparty_name: cmd.counterparty_name ?? null,
    };
  }

  async apply(c: pg.PoolClient, ctx: Context, cmd: Command): Promise<Outcome> {
    const phone = ctx.conversation.phone,
      text = ctx.message.transcript ?? ctx.message.text,
      notices: Notice[] = [];
    const output = (
      reply: string | null,
      request: Request | null = null,
    ): Outcome => ({ reply, request, notices });
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
        return output("לא ממתין אצלנו לאישור פריט נוסף. אפשר לכתוב מה תרצה למסור.");
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
        const q = nextQuestion(existing, phone);
        return output(
          `עדכנתי את הפריט ל${describeItems(existing.items)}. ${q.text}`.trim(),
          existing,
        );
      }
      // add → ask same/other recipient
      pending.stage = "same_or_other_recipient";
      await this.setPendingExtra(c, ctx, pending);
      return output(sameOrOtherQuestion(describeItems(pending.items)), existing);
    }
    if (cmd.type === "resolve_extra_recipient") {
      const pending = this.pendingExtra(ctx);
      if (!pending || pending.stage !== "same_or_other_recipient")
        return output("לא ממתין אצלנו לאישור מקבל לפריט נוסף.");
      const open = donorOpenRequests(ctx, phone);
      if (furnitureCount(open) >= 2)
        return output(THIRD_ITEM_REPLY, await this.s.request(pending.request_id, c));
      if (cmd.choice === "same") {
        const existing = await this.s.request(pending.request_id, c, true);
        ownParty(existing, phone, "donor");
        const nextQty =
          existing.items.reduce((n, i) => n + i.quantity, 0) +
          pending.items.reduce((n, i) => n + i.quantity, 0);
        if (nextQty > 2) {
          await this.clearPendingExtra(c, ctx);
          return output(THIRD_ITEM_REPLY, existing);
        }
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
        const q = nextQuestion(existing, phone);
        return output(
          `הוספתי את ${describeItems(pending.items)} לאותה פנייה. ${q.text}`.trim(),
          existing,
        );
      }
      // other recipient → second request, one item, same donor
      if (open.length >= 2) {
        await this.clearPendingExtra(c, ctx);
        return output(THIRD_ITEM_REPLY, await this.s.request(pending.request_id, c));
      }
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
      if (!pending.counterparty_phone && pending.counterparty_name) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1",
          [ctx.conversation.id, pending.counterparty_name],
        );
        ctx.conversation.pending_counterparty_name = pending.counterparty_name;
      }
      await this.clearPendingExtra(c, ctx);
      // Soft photo nudge once; otherwise summarize and ask the next missing field.
      if (photoGate(r) && !photoAskAlreadySent(ctx.history))
        return output(openingPhotoReply(r, phone), r);
      return output(
        composeRecordedReply(r, phone, nextQuestion(r, phone).text),
        r,
      );
    }
    if (cmd.type === "status") return output(statusText(ctx.requests));
    if (cmd.type === "seek") {
      const id = await this.s.contact(c, phone);
      let settlement = cmd.settlement ?? null;
      if (settlement) {
        const reg = await this.s.region(c, settlement);
        if (reg.decision === "outside") return output(OUTSIDE);
        if (reg.decision === "review")
          return { ...output(HUMAN_REPLY), humanReason: "borderline_area" };
        settlement = reg.name;
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
      const ack = saved.length ? `נשמר: ${saved.join(", ")}. ` : "";
      const candidates = await this.s.candidates(phone, c);
      if (!candidates.length)
        return output(
          `${ack}כרגע לא נמצא פריט מתאים. נעדכן כשיהיה פריט מתאים.`.trim(),
        );
      const candidate = candidates[0]!.request;
      await this.s.matchPhoto(c, candidate, phone, ctx.message);
      return output(
        candidate.photo_ids.length
          ? ack.trim() || null
          : `${ack}נבקש מהמוסר תמונה של הפריט ונעדכן.`.trim(),
      );
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
      const error = itemError(items, false);
      if (error) return output(error);
      // Soft-gate: a different second item for the same donor must ask
      // replace-vs-add before mutating or opening another request.
      if (cmd.type === "donate" && isDonor) {
        const open = donorOpenRequests(ctx, phone);
        const primary =
          open.find((r) => r.id === ctx.conversation.selected_request_id) ??
          (open.length === 1 ? open[0] : undefined);
        const existingPending = this.pendingExtra(ctx);
        if (primary && primary.items.length && !sameItemSet(primary.items, items)) {
          const total = furnitureCount(open);
          if (total >= 2 || open.length >= 2) {
            await this.clearPendingExtra(c, ctx);
            return output(THIRD_ITEM_REPLY, primary);
          }
          const explicitReplace = /(?:^|[\s,])במקום(?:[\s,]|$)/u.test(text);
          const explicitAdd = /(?:^|[\s,])בנוסף(?:[\s,]|$)|גם\s+(?:ספה|מיטה|ארון|מקרר|כיסא|שולחן)/u.test(
            text,
          );
          if (explicitReplace) {
            await this.setPendingExtra(
              c,
              ctx,
              this.buildPendingFromDonate(primary, items, cmd, "replace_or_add"),
            );
            return this.apply(c, ctx, { type: "resolve_extra_item", choice: "replace" });
          }
          if (explicitAdd) {
            await this.setPendingExtra(
              c,
              ctx,
              this.buildPendingFromDonate(
                primary,
                items,
                cmd,
                "same_or_other_recipient",
              ),
            );
            return output(
              sameOrOtherQuestion(describeItems(items)),
              primary,
            );
          }
          if (
            existingPending &&
            itemFingerprint(existingPending.items) === itemFingerprint(items)
          ) {
            const ask =
              existingPending.stage === "same_or_other_recipient"
                ? sameOrOtherQuestion(describeItems(items))
                : replaceOrAddQuestion(
                    existingPending.existing_description,
                    describeItems(items),
                  );
            return output(ask, primary);
          }
          const pending = this.buildPendingFromDonate(
            primary,
            items,
            cmd,
            "replace_or_add",
          );
          await this.setPendingExtra(c, ctx, pending);
          return output(
            replaceOrAddQuestion(pending.existing_description, describeItems(items)),
            primary,
          );
        }
        if (furnitureCount(open) >= 2 && open.every((r) => !sameItemSet(r.items, items))) {
          return output(THIRD_ITEM_REPLY, open[0] ?? null);
        }
      }
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
      }
      // Keep an explicit condition from the opening message for open
      // donations too.  The photo gate may still request a picture, but it
      // must not discard a fact the donor already supplied and ask it again.
      const sameItemShape = (existing: Request) =>
        existing.parties.some((p) => p.role === "donor" && p.phone === phone) &&
        existing.items.length === items.length &&
        existing.items.every((item, index) => {
          const next = items[index];
          if (!next || item.kind !== next.kind) return false;
          if (item.kind !== "other") return true;
          const a = item.description.replace(/\s+/g, "");
          const b = next.description.replace(/\s+/g, "");
          return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
        });
      let sameOpenRequest = ctx.requests.find(
        (existing) =>
          existing.status !== "coordinated" &&
          !["closed", "cancelled", "rejected", "cancel_pending"].includes(existing.status) &&
          sameItemShape(existing),
      );
      // Prefer continuing a recent outside-area rejection over opening a twin.
      if (!sameOpenRequest)
        sameOpenRequest = ctx.requests.find(
          (existing) => existing.status === "rejected" && sameItemShape(existing),
        );
      if (!sameOpenRequest) {
        const duplicate = await c.query<{ id: string }>(
          `SELECT r.id FROM requests r
           JOIN request_parties p ON p.request_id=r.id
           JOIN contacts co ON co.id=p.contact_id
           JOIN request_items i ON i.request_id=r.id
           WHERE co.phone=$1 AND p.role='donor'
             AND r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending')
             AND (
               (i.kind = ANY($2::text[]) AND i.kind <> 'other')
               OR (i.kind = 'other' AND i.description = ANY($3::text[]))
             )
           ORDER BY r.number LIMIT 1`,
          [
            phone,
            items.map((item) => item.kind),
            items.filter((item) => item.kind === "other").map((item) => item.description),
          ],
        );
        if (duplicate.rows[0]) sameOpenRequest = await this.s.request(duplicate.rows[0].id, c);
      }
      if (!sameOpenRequest) {
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
      if (sameOpenRequest) {
        // Persist every field the action manager sent. Refreshing the same
        // open item must never drop direct/name/phone — that freezes the chat
        // on photo while the AI already named a recipient.
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
        mutable(existing);
        const beforeOrigin = existing.origin;
        const beforeReceiver = existing.parties.find((entry) => entry.role === "receiver");
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
            } else if (linked.phone === receiverPhone) {
              if (cmd.type === "donate" && cmd.counterparty_name)
                linked.name = cmd.counterparty_name;
            } else {
              throw new AppError(
                "party_already_linked",
                409,
                "הצד השני כבר מקושר לפנייה. שינוי זה דורש טיפול אנושי.",
              );
            }
            if (existing.parties.length === 2 && existing.parties[0]!.phone === existing.parties[1]!.phone)
              existing.represents_both_parties = true;
          }
        }
        await this.s.save(c, existing);
        await c.query(
          "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
          [ctx.conversation.id, existing.id],
        );
        if (
          direct &&
          isDonor &&
          cmd.type === "donate" &&
          !other &&
          cmd.counterparty_name &&
          !existing.parties.some((entry) => entry.role === "receiver")
        ) {
          await c.query(
            "UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1",
            [ctx.conversation.id, cmd.counterparty_name],
          );
          ctx.conversation.pending_counterparty_name = cmd.counterparty_name;
        }
        if (other || (cmd.type === "donate" && cmd.counterparty_phone)) {
          await c.query(
            "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
            [ctx.conversation.id],
          );
          ctx.conversation.pending_counterparty_name = null;
          ctx.conversation.pending_counterparty_phone = null;
        }
        const q = nextQuestion(existing, phone);
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
          return output(
            `הפרטים האלה כבר רשומים אצלנו. ${q.text}`.trim(),
            existing,
          );
        return output(q.text, existing);
      }
      const r = await this.s.create(
        c,
        items,
        parties,
        isDonor && !direct ? "donation" : "direct",
      );
      if (parties.length === 2 && parties[0]!.phone === parties[1]!.phone) {
        r.represents_both_parties = true;
        await this.s.save(c, r);
      }
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      if (!other && cmd.type === "donate" && cmd.counterparty_name) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1",
          [ctx.conversation.id, cmd.counterparty_name],
        );
        ctx.conversation.pending_counterparty_name = cmd.counterparty_name;
      }
      if (other || (cmd.type === "donate" && cmd.counterparty_phone)) {
        await c.query(
          "UPDATE conversations SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1 WHERE id=$1",
          [ctx.conversation.id],
        );
        ctx.conversation.pending_counterparty_name = null;
        ctx.conversation.pending_counterparty_phone = null;
      }
      for (const p of parties)
        if (p.phone !== phone && !direct)
          notices.push({
            phone: p.phone,
            text: `נפתחה פנייה ${r.number} לגבי ${r.items.map((i) => i.description).join(", ")}. נא לאשר את חלקך ב${p.role === "donor" ? "מסירה" : "קבלה"}. ההובלות בימי שלישי 16:00–20:00, ובדרך כלל עד ${DEFAULT_TRANSPORT_CAPACITY} הובלות בכל יום שלישי. מעבר לכך נבקש תחילה אישור מנהל. נעדכן.`,
          });
      // Soft optional photo ask once; never a hard PHOTO_FIRST lock.
      if (
        photoGate(r) &&
        !photoAskAlreadySent(ctx.history) &&
        !photoDeclined(ctx.message.transcript ?? ctx.message.text)
      )
        return output(openingPhotoReply(r, phone), r);
      return output(
        composeRecordedReply(r, phone, nextQuestion(r, phone).text),
        r,
      );
    }
    if (cmd.type === "interest") {
      const candidate = ctx.candidates.find(
        (x) => x.request.number === cmd.request_number,
      );
      if (!candidate)
        throw new AppError(
          "match_unavailable",
          409,
          "הפריט כבר אינו זמין. נחפש פריט מתאים נוסף.",
        );
      const r = await this.s.request(candidate.request.id, c, true);
      mutable(r);
      if (candidate.state !== "presented")
        throw new AppError(
          "photo_not_presented",
          409,
          "קודם נציג את תמונת הפריט. נעדכן.",
        );
      if (r.parties.some((p) => p.role === "receiver"))
        throw new AppError(
          "match_taken",
          409,
          "הפריט כבר אינו זמין. נחפש פריט מתאים נוסף.",
        );
      r.parties.push(party("receiver", phone));
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
      return output(nextQuestion(r, phone).text, r);
    }
    if (cmd.type === "escalate" && !ctx.requests.length) {
      if (cmd.reason !== "borderline_area")
        return { ...output(HUMAN_REPLY), humanReason: cmd.reason };
      const r = await this.s.create(c, [], [party("donor", phone)], "donation");
      r.status = "human";
      r.human_reason = "borderline_area";
      await c.query(
        "UPDATE conversations SET selected_request_id=$2 WHERE id=$1",
        [ctx.conversation.id, r.id],
      );
      return { ...output(HUMAN_REPLY, r), humanReason: "borderline_area" };
    }
    if (cmd.type === "next" && !ctx.requests.length) {
      const town = mentionedAllowedSettlement(text);
      if (town && !donationIntent(text))
        return output(`רשמתי את היישוב ${town}. מה תרצה למסור או לקבל?`);
      if (
        /(?:ליד|קרוב|באזור|סמוך)/u.test(norm(text)) &&
        /בית\s*שאן|beit\s+she'?an/i.test(text)
      )
        return output(
          "באיזה יישוב בדיוק? אנחנו פועלים בבית שאן, מסילות, ירדנה, בית אלפא, טירת צבי, כפר רופין ומחולה.",
        );
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
        return output(`רשמתי שמדובר במסירה ל${handoffName}. מה הפריט שברצונך למסור?`);
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
        return output(
          `רשמתי את מספר הטלפון של ${name}. מה הפריט שברצונך למסור?`,
        );
      }
      if (pendingName || stickyName)
        return output(
          `מה הפריט שברצונך למסור ל${pendingName || stickyName}?`,
        );
      if (recentSelfName(ctx, text) && donationIntent(
        (ctx.history ?? [])
          .filter((entry) => entry.role === "user")
          .slice(-6)
          .map((entry) => entry.content)
          .join("\n") +
          "\n" +
          text,
      ))
        return output("מה הפריט שברצונך למסור?");
      return output("איך אפשר לעזור — למסור פריט, לקבל פריט או לתאם הובלה?");
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
        const who = candidateName ?? candidatePhone;
        return output(
          candidatePhone
            ? `רשמתי את מספר הטלפון של ${who}. מה הפריט שברצונך למסור?`
            : `רשמתי שמדובר במסירה ל${who}. מה הפריט שברצונך למסור?`,
        );
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
        const who = ctx.conversation.pending_counterparty_name;
        return output(
          who
            ? `מה הפריט שברצונך למסור ל${who}?`
            : "מה הפריט שברצונך למסור?",
        );
      }
    }
    if (cmd.type === "clarify_duplicate") {
      // A duplicate message can arrive after the other party has approved.
      // Reload under the transaction lock so returning this read-only reply
      // can never overwrite a newer approval with a stale context snapshot.
      const stale = target(ctx, cmd.request_number);
      const existing = await this.s.request(stale.id, c, true);
      ownParty(existing, phone);
      return output(
        `כבר קיימת פנייה ${existing.number} עבור פריט דומה. אם זו פנייה חדשה או פריט נוסף, כתוב זאת במפורש.`,
        existing,
      );
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
      return output(nextQuestion(r, phone).text);
    }
    if (cmd.type === "counterparty_candidate") {
      if (r.parties.some((entry) => entry.role === "receiver"))
        throw new AppError("party_already_linked", 409, "כבר קיים מקבל בפנייה הזו.");
      const candidatePhone = suppliedPhone(ctx, cmd.phone);
      await c.query(
        `UPDATE conversations
            SET pending_counterparty_name=$2,pending_counterparty_phone=$3,version=version+1
          WHERE id=$1`,
        [ctx.conversation.id, cmd.name, candidatePhone],
      );
      const display = cmd.name ? `${cmd.name} (${candidatePhone})` : candidatePhone;
      return output(
        `קיבלתי את איש הקשר של ${display}. האם התכוונת למסור לו/לה את ${r.items.map((item) => item.description).join(", ")}? כתוב כן או לא.`,
        r,
      );
    }
    if (cmd.type === "confirm_counterparty") {
      const candidatePhone = ctx.conversation.pending_counterparty_phone;
      const candidateName = ctx.conversation.pending_counterparty_name;
      if (!candidatePhone)
        throw new AppError("counterparty_candidate_missing", 409, "אין איש קשר שממתין לאישור.");
      await c.query(
        `UPDATE conversations
            SET pending_counterparty_name=NULL,pending_counterparty_phone=NULL,version=version+1
          WHERE id=$1`,
        [ctx.conversation.id],
      );
      if (!cmd.accept)
        return output("בסדר, לא קישרתי את איש הקשר לפנייה. נמשיך במסירה הכללית.", r);
      if (r.parties.some((entry) => entry.role === "receiver"))
        throw new AppError("party_already_linked", 409, "כבר קיים מקבל בפנייה הזו.");
      const receiver = party("receiver", candidatePhone, false);
      receiver.name = candidateName;
      r.parties.push(receiver);
      r.origin = "direct";
      for (const item of r.items)
        if (item.working === null) item.working = true;
      // Linking the recipient is not consent to message them and not proof
      // that own-party details/rules are ready — nextQuestion decides.
      const q = nextQuestion(r, phone);
      return output(
        `מעולה, קישרתי את ${candidateName ?? candidatePhone} כמקבל/ת.\n${q.text}`,
        r,
      );
    }
    if (cmd.type === "contact_counterparty") {
      const other = r.parties.find((p) => p.phone !== phone);
      if (r.origin !== "direct" || !other)
        throw new AppError("counterparty_not_ready", 409, "נא לשלוח קודם את מספר הצד השני או כרטיס איש קשר.");
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
        return output("הפנייה לצד השני כבר בוצעה.", r);
      // Consent to contact only after own details + transport rules hold.
      // Decline can be recorded anytime; early "yes" is deferred via nextQuestion.
      if (cmd.contact && !readyToAskContactCounterparty(r, phone)) {
        const q = nextQuestion(r, phone);
        return output(q.text, r);
      }
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
      if (cmd.contact)
        notices.push({
          phone: other.phone,
          text: `שלום${other.name ? ` ${other.name}` : ""},\n\nפנייה ${r.number}: ${r.items.map((i) => i.description).join(", ")}. ${phone === r.parties.find((p) => p.role === "donor")?.phone ? "המוסר" : "המקבל"} ביקש שנפנה אליך לאימות הפרטים.${other.settlement || other.address || other.floor !== null ? `\nהפרטים שנמסרו: ${[other.settlement, other.address, other.floor === null ? null : `קומה ${other.floor}`].filter(Boolean).join(", ")}.` : ""}\nנא לאשר את חלקך ב${other.role === "donor" ? "מסירה" : "קבלה"}.`,
        });
      if (cmd.contact)
        await c.query(
          `UPDATE conversations SET selected_request_id=$2,version=version+1
             WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)`,
          [other.phone, r.id],
        );
      else invalidateProposal(r);
      const q = nextQuestion(r, phone);
      return output(
        `${cmd.contact ? "נפנה לצד השני עכשיו לצורך אימות." : "בסדר, לא נפנה לצד השני כרגע."}\n${q.text}`,
        r,
      );
    }
    if (cmd.type === "escalate") {
      if (r.status !== "coordinated") {
        r.status = "human";
        r.human_reason = cmd.reason;
      }
      return { ...output(HUMAN_REPLY, r), humanReason: cmd.reason };
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
          if (p.phone !== phone)
            notices.push({
              phone: p.phone,
              text: `התיאום בפנייה ${r.number} בוטל. נעדכן לגבי המשך הטיפול.`,
            });
        return output(
          `התיאום בפנייה ${r.number} בוטל והפרטים נשמרו. האם הפנייה רלוונטית לשבוע הבא, או לבטל סופית?`,
          r,
        );
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
            if (party.phone !== phone)
              notices.push({
                phone: party.phone,
                text: `פנייה ${r.number} בוטלה: ${items}. לא תתואם הובלה.`,
              });
        return output(`פנייה ${r.number} בוטלה: ${items}. לא תתואם הובלה.`, r);
      }
      if (r.status !== "cancel_pending")
        throw new AppError("cancellation_not_pending", 409);
      r.status = "awaiting_approval";
      r.proposed_run_date = null;
      for (const p of r.parties) {
        p.schedule_approved = false;
        p.schedule_approved_date = null;
        p.schedule_approved_at = null;
      }
      return output("הפנייה נשמרה. אבדוק מועד פנוי ליום שלישי; התאריך ייחשב רק כהצעה עד ששני הצדדים יאשרו אותו במפורש.", r);
    }
    if (cmd.type === "next") {
      const pending = this.pendingExtra(ctx);
      if (pending?.stage === "replace_or_add")
        return output(
          replaceOrAddQuestion(
            pending.existing_description,
            describeItems(pending.items),
          ),
          r,
        );
      if (pending?.stage === "same_or_other_recipient")
        return output(sameOrOtherQuestion(describeItems(pending.items)), r);
      const previous = ctx.history.at(-1)?.content ?? "";
      const speaker = ownParty(r, phone);
      if (ambiguousStreetCity(text) && !speaker.address)
        return output(
          "האם הכוונה לרחוב אילת, או ליישוב אילת שמחוץ לאזור הפעילות?",
          r,
        );
      if (
        ownParty(r, phone).role === "donor" &&
        !r.parties.some((p) => p.role === "receiver") &&
        ctx.conversation.pending_counterparty_name &&
        /(?:אין לי מספר|אין מספר|אין מקבל|לא)/.test(text.trim())
      ) {
        await c.query("UPDATE conversations SET pending_counterparty_name=NULL,version=version+1 WHERE id=$1", [ctx.conversation.id]);
        return output("אין בעיה. נמשיך את המסירה וננסה למצוא מקבל מתאים.", r);
      }
      if (
        ownParty(r, phone).role === "donor" &&
        !r.parties.some((p) => p.role === "receiver") &&
        /מקבל מסוים/.test(previous) &&
        /^(?:לא|אין(?: לי)?(?: מקבל)?|אין מקבל)/.test(text.trim())
      )
        return output("הפרטים נשמרו. ננסה למצוא מקבל מתאים ונעדכן.", r);
      const q = nextQuestion(r, phone);
      if (q.floorNote) {
        ownParty(r, phone).floor_note_shown = true;
        return output(q.text, r);
      }
      return output(q.text, r);
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
    if (cmd.type === "details") {
      if (cmd.name || cmd.settlement || cmd.address || cmd.floor !== null)
        invalidateProposal(r);
      let p: Party;
      try {
        p = ownParty(r, phone, cmd.role ?? undefined);
      } catch (error) {
        const actor = r.parties.find((candidate) => candidate.phone === phone);
        const receiver = r.parties.find((candidate) => candidate.role === "receiver");
        const onlyFillsMissingReceiverFields = Boolean(
          receiver &&
          (!cmd.name || !receiver.name || receiver.name === cmd.name) &&
          (!cmd.settlement || !receiver.settlement || receiver.settlement === cmd.settlement) &&
          (!cmd.address || !receiver.address || receiver.address === cmd.address) &&
          (cmd.floor === null || receiver.floor === null || receiver.floor === cmd.floor),
        );
        // In a direct handoff the donor may supply the receiver's destination
        // ("כתובת היעד…"), either in the opening message or together with
        // later consent to contact them. Store those facts as provisional so
        // the receiver can verify a complete summary. Keep this limited to
        // empty/same fields and the period before the receiver has approved;
        // later cross-party edits stay forbidden.
        if (
          !(error instanceof AppError && error.code === "forbidden_party") ||
          r.origin !== "direct" ||
          cmd.role !== "receiver" ||
          actor?.role !== "donor" ||
          !receiver ||
          receiver.approved_at !== null ||
          !onlyFillsMissingReceiverFields
        )
          throw error;
        p = receiver;
      }
      const settlementIsTheStreet =
        Boolean(cmd.settlement) &&
        Boolean(cmd.address) &&
        /^(?:רחוב|שיכון|שכונה|שכונת|שדרות|שד)/.test(cmd.address ?? "") &&
        (cmd.address ?? "").includes(cmd.settlement ?? "");
      if (cmd.settlement && !settlementIsTheStreet) {
        const reg = await this.s.region(c, cmd.settlement);
        if (reg.decision === "outside") {
          r.status = "rejected";
          return output(OUTSIDE, r);
        }
        if (reg.decision === "review") {
          r.status = "human";
          r.human_reason = "borderline_area";
          return { ...output(HUMAN_REPLY, r), humanReason: "borderline_area" };
        }
        p.settlement = reg.name;
      }
      if (cmd.name) {
        p.name = cmd.name;
        if (r.represents_both_parties)
          for (const samePerson of r.parties.filter((entry) => entry.phone === phone))
            samePerson.name = cmd.name;
      }
      if (cmd.address) {
        const address = cmd.address.trim();
        const looksLikeStreet = /^(?:רחוב|שכונת|שכונה|שדרות|שד[׳']?)(?=$|\s)/u.test(address);
        const known = looksLikeStreet ? await this.s.region(c, address) : null;
        p.address = address;
        if (known?.decision === "review")
          p.address = address;
      }
      if (p.settlement && p.settlement !== "בית שאן") p.floor = 0;
      else if (p.settlement === "בית שאן" && cmd.floor !== null)
        p.floor = cmd.floor;
      if (cmd.preferred_time) r.preferred_time = cmd.preferred_time;
      if (cmd.address && /^(?:רחוב|שכונת|שכונה|שדרות|שד[׳']?)(?=$|\s)/u.test(cmd.address.trim())) {
        const known = await this.s.region(c, cmd.address.trim());
        if (known.decision === "review")
          return output(`לא מצאתי את "${cmd.address.trim()}" במאגר הרחובות. אם זה שם מקומי או כינוי, אשר שזה נכון; אחרת כתוב את הרחוב/השכונה מחדש.`, r);
      }
    } else if (cmd.type === "item_facts") {
      invalidateProposal(r);
      ownParty(r, phone, "donor");
      const oldItems = structuredClone(r.items);
      if (cmd.items && r.items.length && !sameItemSet(r.items, cmd.items)) {
        // Different furniture kind is not a silent overwrite — ask replace/add.
        const open = donorOpenRequests(ctx, phone);
        if (furnitureCount(open) >= 2) return output(THIRD_ITEM_REPLY, r);
        const explicitReplace = /(?:^|[\s,])במקום(?:[\s,]|$)/u.test(text);
        const pending: PendingExtraItem = {
          stage: explicitReplace ? "replace_or_add" : "replace_or_add",
          request_id: r.id,
          request_number: r.number,
          existing_description: describeItems(r.items),
          items: cmd.items,
          free: cmd.free,
          working: cmd.working,
          direct: r.origin === "direct",
          counterparty_phone:
            r.parties.find((p) => p.role === "receiver")?.phone ?? null,
          counterparty_name:
            r.parties.find((p) => p.role === "receiver")?.name ?? null,
        };
        if (explicitReplace) {
          await this.setPendingExtra(c, ctx, pending);
          return this.apply(c, ctx, { type: "resolve_extra_item", choice: "replace" });
        }
        await this.setPendingExtra(c, ctx, pending);
        return output(
          replaceOrAddQuestion(pending.existing_description, describeItems(cmd.items)),
          r,
        );
      }
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
      const error = itemError(r.items, r.photo_ids.length > 0);
      if (error) {
        r.status = "rejected";
        if (r.items.reduce((n, i) => n + i.quantity, 0) > 2) r.items = oldItems;
        return output(error, r);
      }
      if (r.items.some((i) => i.evacuation === "different")) {
        r.status = "human";
        r.human_reason = "evacuation";
        return { ...output(HUMAN_REPLY, r), humanReason: "evacuation" };
      }
    } else if (cmd.type === "counterparty") {
      const role = ownParty(r, phone).role === "donor" ? "receiver" : "donor";
      const other = r.parties.find((p) => p.role === role);
      if (!cmd.phone) {
        if (role !== "receiver" || !cmd.name)
          throw new AppError("phone_not_supplied", 403, "נא לשלוח את מספר הצד השני או כרטיס איש קשר.");
        await c.query("UPDATE conversations SET pending_counterparty_name=$2,version=version+1 WHERE id=$1", [ctx.conversation.id, cmd.name]);
        return output(
          `רשמתי שהמקבל הוא ${cmd.name}. נא לשלוח את מספר הטלפון שלו או כרטיס איש קשר. אם אין לך את המספר, כתוב "אין לי מספר" ונמשיך לחיפוש מקבל מתאים.`,
          r,
        );
      }
      const targetPhone = suppliedPhone(ctx, cmd.phone);
      if (other) {
        if (other.phone === targetPhone)
          return output("הצד השני כבר מקושר לפנייה.");
        throw new AppError(
          "party_already_linked",
          409,
          "הצד השני כבר מקושר לפנייה. שינוי זה דורש טיפול אנושי.",
        );
      }
      const p = party(
        role,
        targetPhone,
        targetPhone === phone &&
          r.parties.some((x) => x.phone === phone && x.approved_at !== null),
      );
      // A contact card is identity data, never consent.
      p.name =
        ctx.message.contacts.find((x) => x.phone === targetPhone)?.name ?? ctx.conversation.pending_counterparty_name ?? cmd.name ?? null;
      r.parties.push(p);
      invalidateProposal(r);
      // Adding a named receiver converts an open donation into a direct
      // handoff.  The generic condition question is not part of this flow.
      if (role === "receiver")
        for (const item of r.items)
          if (item.working === null) item.working = true;
      await c.query("UPDATE conversations SET pending_counterparty_name=NULL,version=version+1 WHERE id=$1", [ctx.conversation.id]);
      r.origin = "direct";
      if (r.parties.length === 2 && r.parties[0]!.phone === r.parties[1]!.phone)
        r.represents_both_parties = true;
      // In a direct handoff, receiving a phone number is not permission to
      // contact that person. The initiating party must explicitly choose the
      // verification-message option first.
    } else if (cmd.type === "approve_self") {
      // Trust action-manager approval command; do not re-litigate wording.
      for (const p of r.parties)
        if (p.phone === phone) {
          p.approved_at ??= this.now().toISOString();
          p.approved_by = phone;
        }
    } else if (cmd.type === "approve_schedule") {
      const proposedDate = r.proposed_run_date?.slice(0, 10) ?? null;
      if (!proposedDate || cmd.date !== proposedDate)
        throw new AppError(
          "schedule_approval_mismatch",
          400,
          "המועד לא אושר כי הוא אינו תואם להצעה הנוכחית. נשלח מחדש את המועד המעודכן.",
        );
      if (!ownParty(r, phone).approved_at)
        throw new AppError(
          "identity_approval_required",
          409,
          "נא לאשר תחילה את חלקך בפנייה.",
        );
      for (const p of r.parties)
        if (p.phone === phone) {
          p.schedule_approved = true;
          p.schedule_approved_date = r.proposed_run_date;
          p.schedule_approved_at = this.now().toISOString();
        }
    }
    if (r.parties.length === 1 && r.photo_ids.length) r.status = "available";
    let q = nextQuestion(r, phone);
    const previous = ctx.history.at(-1)?.content ?? "";
    if (
      (cmd.type === "details" || cmd.type === "item_facts") &&
      previous &&
      q.text.slice(0, 24) &&
      previous.includes(q.text.slice(0, 24))
    ) {
      const asked = r.verification_contacted;
      r.verification_contacted = true;
      q = nextQuestion(r, phone);
      r.verification_contacted = asked;
    }
    if (q.floorNote) ownParty(r, phone).floor_note_shown = true;
    return output(q.text, r);
  }
}
