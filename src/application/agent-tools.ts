/**
 * Responses API function tools that wrap Commands.apply.
 * The model writes only through these tools — never raw SQL.
 */
import { z } from "zod";
import {
  commandSchema,
  type Command,
  type Request,
  type Notice,
} from "../domain/types.js";
import type { ChangedField } from "../domain/field-map.js";
import { nextQuestion } from "../domain/policies.js";

type JsonSchemaObject = Record<string, unknown>;

function toStrictToolParameters(source: JsonSchemaObject): JsonSchemaObject {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const node = value as JsonSchemaObject;
    const result: JsonSchemaObject = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "$schema") continue;
      if (key === "oneOf") result.anyOf = visit(child);
      else result[key] = visit(child);
    }
    if (
      result.type === "object" &&
      result.properties &&
      typeof result.properties === "object"
    ) {
      const properties = result.properties as JsonSchemaObject;
      const wasRequired = new Set(
        Array.isArray(node.required)
          ? node.required.filter((field): field is string => typeof field === "string")
          : [],
      );
      for (const [key, property] of Object.entries(properties)) {
        if (!wasRequired.has(key))
          properties[key] = { anyOf: [property, { type: "null" }] };
      }
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return visit(source) as JsonSchemaObject;
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  donate: "Open a donation / direct handoff, or update the open same-item request. Different named recipients in one message need separate donate calls (max 2 items each). Never open a second request for the same donor+same-item+same-recipient while collecting — attach a recipient name/phone with this tool or counterparty on the existing request_number.",
  receive_from_donor: "Receiver opens a request linked to a known donor phone.",
  seek: "Start or update a seeker search for one item kind. Call once per kind (fridge and bed = two seeks). Location on any seek updates sibling active seeks.",
  interest: "Seeker expresses interest in a presented match by request number.",
  details: "Save name/settlement/address/floor/preferred_time for a party role.",
  item_facts: "Update item facts (free/working/disassembly/oven/evacuation).",
  counterparty: "Link or update the other party name/phone on a request.",
  counterparty_candidate: "Store a pending contact-card candidate for confirmation.",
  confirm_counterparty: "Accept or reject the pending counterparty candidate.",
  contact_counterparty: "Record consent to message the other party (true/false). Call again after a phone/vCard is attached if notices_queued was 0. Do not claim the other party was contacted unless notices_queued > 0.",
  approve_self: "Speaker approves their own participation.",
  approve_schedule: "Speaker approves the proposed run date.",
  select: "Select which open request is active.",
  cancel: "Cancel flow: ask / next_week / final.",
  escalate: "Escalate for human review with a reason.",
  status: "Customer asked for status of their requests (read-only).",
  next: "No DB write this turn — only ask/acknowledge in the final reply.",
  clarify_duplicate: "Ask only if the customer clearly started a second delivery of the same item to the same parties after the current request is already complete. Never while collecting missing_required on the open request.",
  resolve_extra_item: "Customer chose replace or add for an extra item.",
  resolve_extra_recipient: "Customer chose same or other recipient for an extra item.",
};

/** Build one Responses function tool per command type. */
export function buildAgentWriteTools(): Array<{
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: JsonSchemaObject;
}> {
  const options = (
    commandSchema as unknown as {
      options: Array<z.ZodObject<z.ZodRawShape>>;
    }
  ).options;
  const tools = [];
  for (const option of options) {
    const shape = option.shape;
    const typeLiteral = shape.type as z.ZodLiteral<string>;
    const name = typeLiteral.value;
    const paramsShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, schema] of Object.entries(shape)) {
      if (key === "type") continue;
      paramsShape[key] = schema as z.ZodTypeAny;
    }
    const paramsZod =
      Object.keys(paramsShape).length === 0
        ? z.strictObject({})
        : z.strictObject(paramsShape);
    const json = toStrictToolParameters(
      z.toJSONSchema(paramsZod) as JsonSchemaObject,
    );
    tools.push({
      type: "function" as const,
      name,
      description: COMMAND_DESCRIPTIONS[name] ?? `Execute ${name}`,
      strict: true as const,
      parameters: json,
    });
  }
  return tools;
}

export const AGENT_WRITE_TOOLS = buildAgentWriteTools();

export function parseAgentToolCall(
  name: string,
  rawArgs: unknown,
): Command {
  const args =
    typeof rawArgs === "string"
      ? (JSON.parse(rawArgs) as unknown)
      : rawArgs;
  const object: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args)
      ? { type: name, ...(args as Record<string, unknown>) }
      : { type: name };
  if (object.type === "donate") {
    if (object.counterparty_name === null) delete object.counterparty_name;
    if (object.direct === null) delete object.direct;
  }
  return commandSchema.parse(object);
}

export interface DroppedField {
  path: string;
  reason: string;
  value?: unknown;
}

export interface AgentToolResult {
  ok: boolean;
  command: Command;
  changed_fields: ChangedField[];
  request_number: number | null;
  request_status: string | null;
  missing_required: unknown;
  notices_queued: number;
  human_reason?: string;
  error?: string;
  /** Paths the model asked to write (write→DB ack). */
  requested: string[];
  /** Paths that appear in changed_fields after save. */
  applied: string[];
  /** Requested but not applied (or cleared), with reason codes. */
  dropped: DroppedField[];
}

function pathOf(field: ChangedField): string {
  return field.role
    ? `${field.table}.${field.column}:${field.role}`
    : `${field.table}.${field.column}`;
}

function partyRole(command: Command, after: Request | null): string | null {
  if (command.type === "details" && command.role) return command.role;
  if (!after) return null;
  return after.parties[0]?.role ?? null;
}

/** Paths the command intended to write (best-effort from tool args). */
export function requestedPathsFromCommand(
  command: Command,
  after: Request | null = null,
): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const push = (path: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    out.push({ path, value });
  };
  if (command.type === "details") {
    const role = command.role ?? partyRole(command, after) ?? "donor";
    push(`request_parties.name:${role}`, command.name);
    push(`request_parties.settlement:${role}`, command.settlement);
    push(`request_parties.address:${role}`, command.address);
    if (command.floor !== null && command.floor !== undefined)
      push(`request_parties.floor:${role}`, command.floor);
    push("requests.preferred_time", command.preferred_time);
    push("requests.earliest_run_date", command.earliest_run_date);
  } else if (command.type === "seek") {
    push("searches.kind", command.kind);
    push("searches.settlement", command.settlement);
    push("searches.address", command.address);
    if (command.floor !== null && command.floor !== undefined)
      push("searches.floor", command.floor);
    push("searches.name", command.name);
  } else if (command.type === "item_facts") {
    if (command.items?.length) {
      push("request_items.kind", command.items.map((i) => i.kind).join(","));
      push(
        "request_items.description",
        command.items.map((i) => i.description).join(","),
      );
    }
    if (command.free !== null) push("request_items.free", command.free);
    if (command.working !== null) push("request_items.working", command.working);
    if (command.needs_disassembly !== null)
      push("request_items.needs_disassembly", command.needs_disassembly);
    if (command.wardrobe_small_whole !== null)
      push("request_items.wardrobe_small_whole", command.wardrobe_small_whole);
    if (command.oven_type) push("request_items.oven_type", command.oven_type);
    if (command.evacuation)
      push("request_items.evacuation", command.evacuation);
  } else if (command.type === "counterparty") {
    push("request_parties.name:receiver", command.name);
    push("request_parties.phone:receiver", command.phone);
  } else if (command.type === "donate" || command.type === "receive_from_donor") {
    if (command.items?.length) {
      push("request_items.kind", command.items.map((i) => i.kind).join(","));
      push(
        "request_items.description",
        command.items.map((i) => i.description).join(","),
      );
    }
    if (command.type === "donate") {
      push("request_parties.name:receiver", command.counterparty_name);
      push("request_parties.phone:receiver", command.counterparty_phone);
    }
  } else if (command.type === "escalate") {
    push("requests.human_reason", command.reason);
    push("requests.status", "human");
  }
  return out;
}

function valuePresentInState(
  path: string,
  value: unknown,
  after: Request | null,
  afterSearch: {
    kind?: string;
    settlement?: string | null;
    address?: string | null;
    floor?: number | null;
    name?: string | null;
  } | null,
): boolean {
  if (!after && !afterSearch) return false;
  const [tableCol, role] = path.split(":");
  const [table, column] = (tableCol ?? "").split(".");
  if (table === "searches" && afterSearch) {
    const current = (afterSearch as Record<string, unknown>)[column ?? ""];
    return current != null && String(current) === String(value);
  }
  if (!after) return false;
  if (table === "requests") {
    const current = (after as unknown as Record<string, unknown>)[column ?? ""];
    return current != null && String(current) === String(value);
  }
  if (table === "request_parties") {
    const party = after.parties.find((p) => !role || p.role === role);
    if (!party) return false;
    if (column === "phone")
      return party.phone != null && String(party.phone) === String(value);
    const current = (party as unknown as Record<string, unknown>)[column ?? ""];
    return current != null && String(current) === String(value);
  }
  if (table === "request_items") {
    if (column === "kind" || column === "description")
      return after.items.some((item) =>
        String(value)
          .split(",")
          .some((part) =>
            column === "kind"
              ? item.kind === part
              : item.description === part,
          ),
      );
    return after.items.some((item) => {
      const current = (item as unknown as Record<string, unknown>)[column ?? ""];
      return current != null && String(current) === String(value);
    });
  }
  return false;
}

export function buildWriteAck(input: {
  command: Command;
  changed: ChangedField[];
  after: Request | null;
  before: Request | null;
  afterSearch?: {
    kind?: string;
    settlement?: string | null;
    address?: string | null;
    floor?: number | null;
    name?: string | null;
  } | null;
  softDrops?: DroppedField[];
  error?: string;
}): {
  requested: string[];
  applied: string[];
  dropped: DroppedField[];
} {
  const requestedEntries = requestedPathsFromCommand(input.command, input.after);
  const requested = requestedEntries.map((entry) => entry.path);
  const applied = input.changed.map(pathOf);
  const appliedSet = new Set(applied);
  const dropped: DroppedField[] = [...(input.softDrops ?? [])];
  const droppedPaths = new Set(dropped.map((d) => d.path));

  if (input.error) {
    for (const entry of requestedEntries) {
      if (droppedPaths.has(entry.path)) continue;
      dropped.push({
        path: entry.path,
        reason: input.error,
        value: entry.value,
      });
      droppedPaths.add(entry.path);
    }
  } else {
    for (const entry of requestedEntries) {
      if (appliedSet.has(entry.path) || droppedPaths.has(entry.path)) continue;
      if (
        valuePresentInState(
          entry.path,
          entry.value,
          input.after,
          input.afterSearch ?? null,
        )
      )
        continue;
      dropped.push({
        path: entry.path,
        reason: "not_persisted",
        value: entry.value,
      });
      droppedPaths.add(entry.path);
    }
  }

  // Floor cleared on address/settlement change without an explicit floor write.
  if (input.command.type === "details" && input.before && input.after) {
    const role =
      input.command.role ??
      input.after.parties.find((p) => p.phone)?.role ??
      "donor";
    const beforeParty = input.before.parties.find((p) => p.role === role);
    const afterParty = input.after.parties.find((p) => p.role === role);
    if (
      beforeParty?.floor != null &&
      afterParty &&
      afterParty.floor == null &&
      (input.command.floor === null || input.command.floor === undefined)
    ) {
      const path = `request_parties.floor:${role}`;
      if (!droppedPaths.has(path)) {
        dropped.push({
          path,
          reason: "floor_cleared_on_address_change",
          value: beforeParty.floor,
        });
      }
    }
  }

  return { requested, applied, dropped };
}

export function snapshotToolResult(input: {
  command: Command;
  before: Request | null;
  after: Request | null;
  changed: ChangedField[];
  notices: Notice[];
  humanReason?: string;
  phone: string;
  error?: string;
  afterSearch?: {
    kind?: string;
    settlement?: string | null;
    address?: string | null;
    floor?: number | null;
    name?: string | null;
  } | null;
  softDrops?: DroppedField[];
}): AgentToolResult {
  const after = input.after;
  const ack = buildWriteAck({
    command: input.command,
    changed: input.changed,
    after,
    before: input.before,
    afterSearch: input.afterSearch,
    softDrops: input.softDrops,
    error: input.error,
  });
  return {
    ok: !input.error,
    command: input.command,
    changed_fields: input.changed,
    request_number: after?.number ?? null,
    request_status: after?.status ?? null,
    missing_required: after ? nextQuestion(after, input.phone).missing : null,
    notices_queued: input.notices.length,
    human_reason: input.humanReason,
    error: input.error,
    requested: ack.requested,
    applied: ack.applied,
    dropped: ack.dropped,
  };
}

export const persistenceGapSchema = z.strictObject({
  path: z.string().trim().min(1).max(120),
  evidence: z.string().trim().min(1).max(500),
  missing_in_state: z.string().trim().min(1).max(500),
});

export const agentFinalReplySchema = z.strictObject({
  reply: z.string().trim().min(1).max(4000),
  claims: z.strictObject({
    saved: z.array(z.string()).max(40),
    contacted_counterparty: z.boolean(),
    opened_request: z.number().int().positive().nullable(),
    schedule_date: z.string().nullable(),
    cancelled: z.boolean(),
    human_handoff: z.boolean(),
  }),
  persistence_gaps: z.array(persistenceGapSchema).max(20),
});

export type PersistenceGap = z.infer<typeof persistenceGapSchema>;
export type AgentFinalReply = z.infer<typeof agentFinalReplySchema>;
