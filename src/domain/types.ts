import { z } from "zod";

export const itemKind = z.enum([
  "bed",
  "sofa",
  "wardrobe",
  "fridge",
  "oven",
  "table_set",
  "table",
  "chairs",
  "washing_machine",
  "dryer",
  "freezer",
  "dishwasher",
  "other",
  "piano",
  "house_move",
]);
export type ItemKind = z.infer<typeof itemKind>;
export const itemInput = z
  .strictObject({
    kind: itemKind,
    description: z.string().trim().min(1).max(160),
    quantity: z.number().int().min(1).max(20),
  })
  .strict();
const ref = z.number().int().positive().nullable();
const str = z.string().trim().min(1).max(240).nullable();
const fact = z.boolean().nullable();
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("donate"),
    items: z.array(itemInput).min(1).max(20),
    counterparty_phone: str,
    free: fact,
    working: fact,
  }),
  z.strictObject({
    type: z.literal("receive_from_donor"),
    items: z.array(itemInput).min(1).max(20),
    donor_phone: str,
  }),
  z.strictObject({ type: z.literal("seek"), kind: itemKind }),
  z.strictObject({
    type: z.literal("interest"),
    request_number: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal("details"),
    request_number: ref,
    role: z.enum(["donor", "receiver"]).nullable(),
    name: str,
    settlement: str,
    address: str,
    floor: z.number().int().min(-3).max(100).nullable(),
  }),
  z.strictObject({
    type: z.literal("item_facts"),
    request_number: ref,
    items: z.array(itemInput).min(1).max(20).nullable(),
    free: fact,
    working: fact,
    needs_disassembly: fact,
    wardrobe_small_whole: fact,
    oven_type: z.enum(["built_in", "combined"]).nullable(),
    evacuation: z.enum(["none", "equivalent", "different"]).nullable(),
  }),
  z.strictObject({
    type: z.literal("counterparty"),
    request_number: ref,
    phone: z.string().min(3).max(40).nullable(),
    name: str,
  }),
  z.strictObject({ type: z.literal("approve_self"), request_number: ref }),
  z.strictObject({
    type: z.literal("select"),
    request_number: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal("cancel"),
    request_number: ref,
    choice: z.enum(["ask", "next_week", "final"]),
  }),
  z.strictObject({
    type: z.literal("escalate"),
    request_number: ref,
    reason: z.enum([
      "borderline_area",
      "unusual_access",
      "evacuation",
      "customer_request",
      "unclear",
      "technical",
    ]),
  }),
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("next") }),
]);
export const planSchema = z
  .strictObject({
    commands: z.array(commandSchema).min(1).max(5),
    evidence: z.string().max(2000),
  })
  .superRefine((p, ctx) => {
    if (
      new Set(p.commands.map((c) => JSON.stringify(c))).size !==
      p.commands.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_command" });
    if (
      p.commands.filter((c) =>
        ["donate", "receive_from_donor", "interest"].includes(c.type),
      ).length > 1
    )
      ctx.addIssue({ code: "custom", message: "multiple_request_creations" });
    if (p.commands.some((c) => c.type === "status") && p.commands.length !== 1)
      ctx.addIssue({ code: "custom", message: "status_must_be_read_only" });
  });
export type Command = z.infer<typeof commandSchema>;
export type Plan = z.infer<typeof planSchema>;
export type ItemInput = z.infer<typeof itemInput>;
export type Role = "donor" | "receiver";
export type Mode = "shadow" | "live" | "simulation";
export type RequestStatus =
  | "collecting"
  | "available"
  | "awaiting_approval"
  | "waiting_capacity"
  | "coordinated"
  | "human"
  | "cancel_pending"
  | "cancelled"
  | "closed"
  | "rejected";
export interface Item extends ItemInput {
  free: boolean | null;
  working: boolean | null;
  needs_disassembly: boolean | null;
  wardrobe_small_whole: boolean | null;
  oven_type: "built_in" | "combined" | null;
  evacuation: "none" | "equivalent" | "different" | null;
}
export interface Party {
  role: Role;
  phone: string;
  name: string | null;
  settlement: string | null;
  address: string | null;
  floor: number | null;
  floor_note_shown: boolean;
  approved_at: string | null;
  approved_by: string | null;
  schedule_approved: boolean;
}
export interface Request {
  id: string;
  number: number;
  version: number;
  status: RequestStatus;
  origin: "donation" | "direct";
  items: Item[];
  parties: Party[];
  photo_ids: string[];
  run_date: string | null;
  earliest_run_date: string | null;
  human_reason: string | null;
  created_at: string;
}
export interface Candidate {
  request: Request;
  match_id: string | null;
  state: "waiting_photo" | "queued_photo" | "presented" | "interested" | null;
}
export interface Conversation {
  id: string;
  phone: string;
  chat_id: string;
  mode: "bot" | "human";
  selected_request_id: string | null;
  version: number;
  pending_counterparty_name: string | null;
}
export interface Incoming {
  id: string;
  seq: string;
  external_id: string;
  trace_id: string;
  mode: Mode;
  chat_id: string;
  phone: string | null;
  kind: "text" | "image" | "voice" | "contact" | "location";
  text: string;
  contacts: { phone: string; name: string | null }[];
  location: { latitude: number; longitude: number } | null;
  media_url: string | null;
  media_id: string | null;
  media_state: "none" | "pending" | "ready" | "failed";
  transcript: string | null;
  processed_at: string | null;
  ai_plan: Plan | null;
}
export interface Context {
  conversation: Conversation;
  requests: Request[];
  candidates: Candidate[];
  message: Incoming;
  history: { role: "user" | "assistant"; content: string }[];
}
export interface Notice {
  phone: string;
  text: string;
  media_id?: string;
  match_id?: string;
}
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly publicMessage = "הבקשה לא הושלמה.",
  ) {
    super(code);
    this.name = "AppError";
  }
}
export class RetryableError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export function errorCode(e: unknown): string {
  return e instanceof AppError || e instanceof RetryableError
    ? e.code
    : e instanceof Error && e.name === "AbortError"
      ? "timeout"
      : "internal_error";
}
export interface Log {
  info(data: Record<string, unknown>, message?: string): void;
  warn(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}
