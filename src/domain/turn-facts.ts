/**
 * Facts-only payload for both AI stages. No customer-facing sentences.
 * Built from DB state + this-turn results; rendered into prompt variables.
 */
import type { ChangedField } from "./field-map.js";
import { FIELD_MAP } from "./field-map.js";
import type {
  Context,
  PendingExtraItem,
  Request,
  Search,
} from "./types.js";

export type BoundaryCode =
  | "capacity_full"
  | "outside_area"
  | "schedule_window"
  | "schedule_proposed"
  | "schedule_mismatch"
  | "duplicate_candidate"
  | "duplicate_blocked"
  | null;

export interface FieldState {
  label: string;
  value: string | number | boolean | null;
  required: boolean;
}

export interface PartyFacts {
  role: "donor" | "receiver";
  is_sender: boolean;
  phone: string | null;
  fields: Record<string, FieldState>;
}

export interface ItemFacts {
  kind: string;
  description: string;
  quantity: number;
  fields: Record<string, FieldState>;
}

export interface RequestFacts {
  number: number;
  status: string;
  origin: string;
  photo_status: string;
  parties: PartyFacts[];
  items: ItemFacts[];
  schedule: {
    proposed_run_date: string | null;
    run_date: string | null;
    preferred_time: string | null;
  };
  verification: {
    contacted: boolean;
    states: { role: string; state: string }[];
  };
}

export interface RulesState {
  transport_capacity_limit: number;
  transport_window: {
    weekday: string;
    tz: string;
    start: string;
    end: string;
  };
  service_area: {
    allowed: string[];
    borderline: string[];
    notes?: string;
  };
  capacity: {
    date: string | null;
    booked: number;
    proposed: number;
    limit: number;
    next_free_date: string | null;
  };
}

export interface ActionResultFact {
  command: string;
  ok: boolean;
  blocked_by?: BoundaryCode;
  detail?: Record<string, unknown>;
}

export interface NoticeFact {
  to_role: string | null;
  to_phone: string;
  facts: Record<string, unknown>;
}

export interface TurnFacts {
  history: { role: string; content: string }[];
  current_message: string;
  customer_language: string;
  already_introduced: boolean;
  sender_phone: string;
  contacts: { phone: string; name: string | null }[];
  has_location: boolean;
  media_kind: string;
  rules: RulesState;
  data_map: string;
  state: {
    requests: RequestFacts[];
    open_request_numbers: number[];
    active_search: Search | null;
    pending: {
      duplicate_confirmation: PendingExtraItem | null;
      pending_counterparty_name: string | null;
      pending_counterparty_phone: string | null;
    };
  };
  this_turn: {
    commands: unknown[];
    results: ActionResultFact[];
    changed: ChangedField[];
    boundary: {
      code: BoundaryCode;
      details?: Record<string, unknown>;
    } | null;
    notices_queued: NoticeFact[];
    completeness: {
      request_number: number | null;
      filled: string[];
      missing: string[];
    };
  };
}

const PARTY_REQUIRED: Record<"donor" | "receiver", string[]> = {
  donor: ["name", "settlement", "address"],
  receiver: ["name", "settlement", "address"],
};

const ITEM_OPTIONAL = [
  "free",
  "working",
  "needs_disassembly",
  "wardrobe_small_whole",
  "oven_type",
];

function labelFor(table: string, column: string): string {
  return (
    FIELD_MAP.find((row) => row.table === table && row.column === column)
      ?.hebrew ?? column
  );
}

function partyFields(
  party: Request["parties"][number],
  role: "donor" | "receiver",
): Record<string, FieldState> {
  const required = new Set(PARTY_REQUIRED[role]);
  const raw: Record<string, string | number | boolean | null> = {
    name: party.name,
    settlement: party.settlement,
    address: party.address,
    floor: party.floor,
    approved_at: party.approved_at,
    schedule_approved: party.schedule_approved,
    schedule_approved_date: party.schedule_approved_date,
  };
  const out: Record<string, FieldState> = {};
  for (const [column, value] of Object.entries(raw)) {
    out[column] = {
      label: labelFor("request_parties", column),
      value,
      required: required.has(column),
    };
  }
  return out;
}

function itemFields(item: Request["items"][number]): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  for (const column of ITEM_OPTIONAL) {
    const value = (item as unknown as Record<string, unknown>)[column];
    out[column] = {
      label: labelFor("request_items", column),
      value:
        value === undefined
          ? null
          : (value as string | number | boolean | null),
      required: column === "free" || column === "working",
    };
  }
  return out;
}

export function requestFacts(request: Request, senderPhone: string): RequestFacts {
  return {
    number: request.number,
    status: request.status,
    origin: request.origin,
    photo_status: request.photo_status,
    parties: request.parties.map((party) => ({
      role: party.role,
      is_sender: party.phone === senderPhone,
      phone: party.phone,
      fields: partyFields(party, party.role),
    })),
    items: request.items.map((item) => ({
      kind: item.kind,
      description: item.description,
      quantity: item.quantity,
      fields: itemFields(item),
    })),
    schedule: {
      proposed_run_date: request.proposed_run_date,
      run_date: request.run_date,
      preferred_time: request.preferred_time ?? null,
    },
    verification: {
      contacted: request.verification_contacted,
      states: (request.verification_states ?? []).map((entry) => ({
        role: entry.role,
        state: entry.state,
      })),
    },
  };
}

export function completenessOf(
  request: Request | null,
  senderPhone: string,
): { request_number: number | null; filled: string[]; missing: string[] } {
  if (!request)
    return { request_number: null, filled: [], missing: [] };
  const filled: string[] = [];
  const missing: string[] = [];
  const self =
    request.parties.find((party) => party.phone === senderPhone) ??
    request.parties[0];
  if (self) {
    for (const column of PARTY_REQUIRED[self.role]) {
      const value = (self as unknown as Record<string, unknown>)[column];
      const path = `parties.${self.role}.${column}`;
      if (value === null || value === undefined || value === "")
        missing.push(path);
      else filled.push(path);
    }
  }
  for (const [index, item] of request.items.entries()) {
    for (const column of ["free", "working"] as const) {
      const path = `items[${index}].${column}`;
      if (item[column] === null) missing.push(path);
      else filled.push(path);
    }
  }
  if (request.origin === "donation" && request.photo_status === "לא בוקשה")
    missing.push("photo");
  else if (request.photo_ids.length) filled.push("photo");
  return { request_number: request.number, filled, missing };
}

/** Static write map: command → table.column (Hebrew labels). */
export function renderWriteMapMarkdown(): string {
  const lines = [
    "## מפת כתיבה",
    "",
    "כל עובדה שנמסרה חייבת לרדת לפקודה שכותבת את העמודה המתאימה.",
    "",
  ];
  const byWriter = new Map<string, string[]>();
  for (const row of FIELD_MAP) {
    if (row.writer === "system" || row.writer === "engine" || row.writer === "read_only")
      continue;
    const key = row.writer;
    const list = byWriter.get(key) ?? [];
    list.push(
      `${row.table}.${row.column} (${row.hebrew})${row.commandField ? ` ← ${row.commandField}` : ""}`,
    );
    byWriter.set(key, list);
  }
  for (const [writer, entries] of byWriter) {
    lines.push(`### פקודה ${writer}`);
    for (const entry of entries) lines.push(`- ${entry}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function defaultRulesState(capacityLimit = 10): RulesState {
  return {
    transport_capacity_limit: capacityLimit,
    transport_window: {
      weekday: "tuesday",
      tz: "Asia/Jerusalem",
      start: "16:00",
      end: "20:00",
    },
    service_area: {
      allowed: [
        "בית שאן",
        "מסילות",
        "ירדנה",
        "בית אלפא",
        "טירת צבי",
        "שדה אליהו",
        "כפר רופין",
        "מחולה",
      ],
      borderline: ["שדה אליהו"],
      notes: "Beit Shean and nearby settlements",
    },
    capacity: {
      date: null,
      booked: 0,
      proposed: 0,
      limit: capacityLimit,
      next_free_date: null,
    },
  };
}

export function buildStage1Facts(input: {
  ctx: Context;
  rules: RulesState;
  alreadyIntroduced: boolean;
  customerLanguage: string;
}): Omit<TurnFacts, "this_turn"> & {
  this_turn: Pick<TurnFacts["this_turn"], "completeness">;
} {
  const { ctx, rules, alreadyIntroduced, customerLanguage } = input;
  const open = ctx.requests.filter(
    (request) =>
      !["coordinated", "closed", "cancelled", "rejected"].includes(request.status),
  );
  const selected =
    open.find((request) => request.id === ctx.conversation.selected_request_id) ??
    open[0] ??
    null;
  return {
    history: ctx.history,
    current_message: ctx.message.transcript ?? ctx.message.text,
    customer_language: customerLanguage,
    already_introduced: alreadyIntroduced,
    sender_phone: ctx.conversation.phone,
    contacts: ctx.message.contacts,
    has_location: ctx.message.location !== null,
    media_kind: ctx.message.kind,
    rules,
    data_map: renderWriteMapMarkdown(),
    state: {
      requests: ctx.requests.map((request) =>
        requestFacts(request, ctx.conversation.phone),
      ),
      open_request_numbers: open.map((request) => request.number),
      active_search: ctx.active_search ?? null,
      pending: {
        duplicate_confirmation:
          ctx.conversation.pending_extra_item?.stage === "confirm_another_delivery"
            ? ctx.conversation.pending_extra_item
            : null,
        pending_counterparty_name: ctx.conversation.pending_counterparty_name,
        pending_counterparty_phone:
          ctx.conversation.pending_counterparty_phone ?? null,
      },
    },
    this_turn: {
      completeness: completenessOf(selected, ctx.conversation.phone),
    },
  };
}

export function buildStage2Facts(input: {
  ctx: Context;
  rules: RulesState;
  alreadyIntroduced: boolean;
  customerLanguage: string;
  commands: unknown[];
  results: ActionResultFact[];
  changed: ChangedField[];
  boundary: TurnFacts["this_turn"]["boundary"];
  notices: NoticeFact[];
}): TurnFacts {
  const base = buildStage1Facts(input);
  const open = input.ctx.requests.filter(
    (request) =>
      !["coordinated", "closed", "cancelled", "rejected"].includes(request.status),
  );
  const selected =
    open.find(
      (request) => request.id === input.ctx.conversation.selected_request_id,
    ) ??
    open[0] ??
    null;
  return {
    ...base,
    this_turn: {
      commands: input.commands,
      results: input.results,
      changed: input.changed,
      boundary: input.boundary,
      notices_queued: input.notices,
      completeness: completenessOf(selected, input.ctx.conversation.phone),
    },
  };
}
