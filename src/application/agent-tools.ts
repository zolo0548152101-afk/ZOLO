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
  donate: "Open or update a donation / direct handoff request with items.",
  receive_from_donor: "Receiver opens a request linked to a known donor phone.",
  seek: "Start a seeker search for an item kind.",
  interest: "Seeker expresses interest in a presented match by request number.",
  details: "Save name/settlement/address/floor/preferred_time for a party role.",
  item_facts: "Update item facts (free/working/disassembly/oven/evacuation).",
  counterparty: "Link or update the other party name/phone on a request.",
  counterparty_candidate: "Store a pending contact-card candidate for confirmation.",
  confirm_counterparty: "Accept or reject the pending counterparty candidate.",
  contact_counterparty: "Record consent to message the other party (true/false).",
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
}): AgentToolResult {
  const after = input.after;
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
  };
}

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
});

export type AgentFinalReply = z.infer<typeof agentFinalReplySchema>;
