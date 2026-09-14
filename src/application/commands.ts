import type pg from "pg";
import {
  AppError,
  type Context,
  type Command,
  type Request,
  type Item,
  type Party,
  type Notice,
} from "../domain/types.js";
import { Store } from "../infrastructure/store.js";
import {
  HUMAN_REPLY,
  OUTSIDE,
  canonicalPhone,
  donationIntent,
  explicitApproval,
  itemError,
  ownParty,
  mutable,
  appliance,
  nextQuestion,
  statusText,
  nextTuesday,
} from "../domain/policies.js";
export interface Outcome {
  reply: string | null;
  request: Request | null;
  notices: Notice[];
  humanReason?: string;
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
  schedule_approved: approved,
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
  const r = explicit ?? (byItem.length === 1 ? byItem[0] : undefined) ??
    (open.length === 1 ? open[0] : undefined) ??
    (ctx.requests.find((r) => r.id === ctx.conversation.selected_request_id) ??
      (ctx.requests.length === 1 ? ctx.requests[0] : undefined));
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
function suppliedPhone(ctx: Context, input: string): string {
  const phone = canonicalPhone(input),
    text = (ctx.message.transcript ?? ctx.message.text).replace(/[^\d]/g, "");
  const samePerson =
    phone === ctx.conversation.phone &&
    /(?:לעצמי|אני\s+(?:שני הצדדים|גם המוסר וגם המקבל))/.test(
      ctx.message.transcript ?? ctx.message.text,
    );
  if (
    !samePerson &&
    !text.includes(phone) &&
    !ctx.message.contacts.some((p) => p.phone === phone)
  )
    throw new AppError(
      "phone_not_supplied",
      403,
      "נא לשלוח את מספר הצד השני או כרטיס איש קשר.",
    );
  return phone;
}
export class Commands {
  constructor(
    private readonly s: Store,
    private readonly now: () => Date,
  ) {}
  async apply(c: pg.PoolClient, ctx: Context, cmd: Command): Promise<Outcome> {
    const phone = ctx.conversation.phone,
      text = ctx.message.transcript ?? ctx.message.text,
      notices: Notice[] = [];
    const output = (
      reply: string | null,
      request: Request | null = null,
    ): Outcome => ({ reply, request, notices });
    if (cmd.type === "status") return output(statusText(ctx.requests));
    if (cmd.type === "seek") {
      const id = await this.s.contact(c, phone);
      await c.query(
        `INSERT INTO searches(contact_id,kind) VALUES($1,$2) ON CONFLICT(contact_id) DO UPDATE SET kind=EXCLUDED.kind,state='active',updated_at=clock_timestamp()`,
        [id, cmd.kind],
      );
      const candidates = await this.s.candidates(phone, c);
      if (!candidates.length)
        return output("כרגע לא נמצא פריט מתאים. נעדכן כשיהיה פריט מתאים.");
      const candidate = candidates[0]!.request;
      await this.s.matchPhoto(c, candidate, phone, ctx.message);
      return output(
        candidate.photo_ids.length
          ? null
          : "נבקש מהמוסר תמונה של הפריט ונעדכן.",
      );
    }
    if (cmd.type === "donate" || cmd.type === "receive_from_donor") {
      if (cmd.type === "donate" && !donationIntent(text))
        throw new AppError(
          "donor_intent_required",
          400,
          "האם ברצונך למסור את הפריט בחינם?",
        );
      const items = cmd.items.map(asItem);
      const isDonor = cmd.type === "donate",
        other = isDonor ? cmd.counterparty_phone : cmd.donor_phone,
        direct = Boolean(other) || (cmd.type === "donate" && cmd.direct === true);
      if (cmd.type === "donate")
        for (const i of items) {
          // "למסירה" is an explicit free-donation intent.
          i.free = cmd.free === false ? false : true;
          // A direct handoff has a known recipient or an explicit named
          // handoff intent. It never needs the generic condition question.
          i.working = direct ? (cmd.working ?? true) : cmd.working;
        }
      const error = itemError(items, false);
      if (error) return output(error);
      const parties = [party(isDonor ? "donor" : "receiver", phone, isDonor)];
      if (other) {
        const p = suppliedPhone(ctx, other);
        parties.push(
          party(isDonor ? "receiver" : "donor", p, p === phone && isDonor),
        );
      }
      if (isDonor && !direct)
        for (const i of items) {
          i.working = null;
        }
      let sameOpenRequest = ctx.requests.find(
        (existing) =>
          existing.status !== "coordinated" &&
          !["closed", "cancelled", "rejected", "cancel_pending"].includes(existing.status) &&
          existing.parties.some((p) => p.role === "donor" && p.phone === phone) &&
          existing.items.length === items.length &&
          existing.items.every((item, index) => item.kind === items[index]?.kind),
      );
      if (!sameOpenRequest) {
        const duplicate = await c.query<{ id: string }>(
          `SELECT r.id FROM requests r
           JOIN request_parties p ON p.request_id=r.id
           JOIN contacts co ON co.id=p.contact_id
           JOIN request_items i ON i.request_id=r.id
           WHERE co.phone=$1 AND p.role='donor'
             AND r.status NOT IN ('coordinated','closed','cancelled','rejected','cancel_pending')
             AND i.kind=ANY($2::text[])
           ORDER BY r.number LIMIT 1`,
          [phone, items.map((item) => item.kind)],
        );
        if (duplicate.rows[0]) sameOpenRequest = await this.s.request(duplicate.rows[0].id, c);
      }
      if (sameOpenRequest && !/(?:פנייה\s+חדשה|פריט\s+נוסף|עוד\s+פריט)/.test(text))
        return output(
          `כבר קיימת פנייה ${sameOpenRequest.number} עבור פריט דומה. אם זו פנייה חדשה או פריט נוסף, כתוב זאת במפורש.`,
          sameOpenRequest,
        );
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
      for (const p of parties)
        if (p.phone !== phone && !direct)
          notices.push({
            phone: p.phone,
            text: `נפתחה פנייה ${r.number} לגבי ${r.items.map((i) => i.description).join(", ")}. נא לאשר את חלקך ב${p.role === "donor" ? "מסירה" : "קבלה"}. ההובלות בימי שלישי 16:00–20:00. נעדכן.`,
          });
      return output(nextQuestion(r, phone).text, r);
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
    if (cmd.type === "escalate" && !ctx.requests.length)
      return { ...output(HUMAN_REPLY), humanReason: cmd.reason };
    if (cmd.type === "next" && !ctx.requests.length)
      return output("איך אפשר לעזור — למסור פריט, לקבל פריט או לתאם הובלה?");
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
      r.verification_contacted = true;
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
          text: `פנייה ${r.number}: ${r.items.map((i) => i.description).join(", ")}. ${phone === r.parties.find((p) => p.role === "donor")?.phone ? "המוסר" : "המקבל"} ביקש שנפנה אליך לאימות הפרטים. נא לאשר את חלקך ב${other.role === "donor" ? "מסירה" : "קבלה"}.`,
        });
      if (cmd.contact)
        await c.query(
          `UPDATE conversations SET selected_request_id=$2,version=version+1
             WHERE contact_id=(SELECT id FROM contacts WHERE phone=$1)`,
          [other.phone, r.id],
        );
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
        if (!/(?:לבטל|ביטול|מבטל|מבטלת)/.test(text))
          throw new AppError(
            "cancellation_not_explicit",
            400,
            "נא לציין במפורש אם ברצונך לבטל את ההובלה.",
          );
        const base = r.run_date ?? nextTuesday(this.now()).date,
          after = new Date(base + "T12:00:00Z");
        after.setUTCDate(after.getUTCDate() + 7);
        r.earliest_run_date = after.toISOString().slice(0, 10);
        r.run_date = null;
        r.status = "cancel_pending";
        for (const p of r.parties) p.schedule_approved = false;
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
      if (r.status !== "cancel_pending")
        throw new AppError("cancellation_not_pending", 409);
      if (cmd.choice === "final") {
        if (!/(?:סופית|סופי|לגמרי|לא רלוונטי)/.test(text))
          throw new AppError("final_cancellation_not_explicit");
        r.status = "cancelled";
        return output(`פנייה ${r.number} נסגרה לבקשתך.`, r);
      }
      if (!/(?:שבוע הבא|רלוונטי|כן)/.test(text))
        throw new AppError("reschedule_not_explicit");
      r.status = "awaiting_approval";
      for (const p of r.parties)
        if (p.phone === phone) p.schedule_approved = true;
      for (const p of r.parties)
        if (p.phone !== phone)
          notices.push({
            phone: p.phone,
            text: `האם ההובלה בפנייה ${r.number} רלוונטית לשבוע הבא? נא לאשר מחדש את המועד. ההובלות ביום שלישי 16:00–20:00. נעדכן.`,
          });
      return output("הפנייה נשמרה להמשך. נמתין לאישור הצד השני ונעדכן.", r);
    }
    if (cmd.type === "next") {
      const previous = ctx.history.at(-1)?.content ?? "";
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
      return output(q.text);
    }
    mutable(r);
    if (cmd.type === "details") {
      const p = ownParty(r, phone, cmd.role ?? undefined);
      if (cmd.settlement) {
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
      if (cmd.name) p.name = cmd.name;
      if (cmd.address) {
        const address = cmd.address.trim();
        const looksLikeStreet = /^(?:רחוב|שכונת|שכונה|שדרות|שד[׳']?)\b/.test(address);
        const known = looksLikeStreet ? await this.s.region(c, address) : null;
        p.address = address;
        if (known?.decision === "review")
          p.address = address;
      }
      if (p.settlement && p.settlement !== "בית שאן") p.floor = 0;
      else if (p.settlement === "בית שאן" && cmd.floor !== null)
        p.floor = cmd.floor;
      if (cmd.address && /^(?:רחוב|שכונת|שכונה|שדרות|שד[׳']?)\b/.test(cmd.address.trim())) {
        const known = await this.s.region(c, cmd.address.trim());
        if (known.decision === "review")
          return output(`לא מצאתי את "${cmd.address.trim()}" במאגר הרחובות. אם זה שם מקומי או כינוי, אשר שזה נכון; אחרת כתוב את הרחוב/השכונה מחדש.`, r);
      }
    } else if (cmd.type === "item_facts") {
      ownParty(r, phone, "donor");
      const oldItems = structuredClone(r.items);
      if (cmd.items)
        r.items = cmd.items.map((i, index) => ({
          ...asItem(i),
          ...(r.items[index] ?? {}),
          ...i,
        }));
      const prior = ctx.history.at(-1)?.content ?? "";
      for (const i of r.items) {
        if (cmd.free !== null) {
          if (
            cmd.free &&
            !/(?:חינם|תרומה)/.test(text) &&
            !(explicitApproval(text) && prior.includes("בחינם"))
          )
            throw new AppError("free_confirmation_missing");
          i.free = cmd.free;
        }
        if (cmd.working !== null) {
          if (
            cmd.working &&
            !/(?:תקינ|תקין|עובד|שמיש)/.test(text) &&
            !(explicitApproval(text) && prior.includes("תקין"))
          )
            throw new AppError("working_confirmation_missing");
          i.working = cmd.working;
        }
        if (/(?:לא תקין|לא עובד|מקולקל|שבור)/.test(text)) i.working = false;
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
        return output(`רשמתי שהמקבל הוא ${cmd.name}. כדי שנוכל לתאם איתו ב־WhatsApp, נא לשלוח את מספר הטלפון שלו או כרטיס איש קשר. אם אין לך את המספר, כתוב "אין לי מספר" ונמשיך לחיפוש מקבל מתאים.`, r);
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
      // Adding a named receiver converts an open donation into a direct
      // handoff.  The generic condition question is not part of this flow.
      if (role === "receiver")
        for (const item of r.items)
          if (item.working === null) item.working = true;
      await c.query("UPDATE conversations SET pending_counterparty_name=NULL,version=version+1 WHERE id=$1", [ctx.conversation.id]);
      r.origin = "direct";
      // In a direct handoff, receiving a phone number is not permission to
      // contact that person. The initiating party must explicitly choose the
      // verification-message option first.
    } else if (cmd.type === "approve_self") {
      if (
        !explicitApproval(text) ||
        (/^כן/.test(text) &&
          !/(?:נא לאשר|לאשר מחדש)/.test(ctx.history.at(-1)?.content ?? ""))
      )
        throw new AppError(
          "explicit_approval_required",
          400,
          "נא לאשר במפורש את חלקך בפנייה.",
        );
      for (const p of r.parties)
        if (p.phone === phone) {
          p.approved_at ??= this.now().toISOString();
          p.approved_by = phone;
          p.schedule_approved = true;
        }
    }
    if (r.parties.length === 1 && r.photo_ids.length) r.status = "available";
    const q = nextQuestion(r, phone);
    if (q.floorNote) ownParty(r, phone).floor_note_shown = true;
    return output(q.text, r);
  }
}
