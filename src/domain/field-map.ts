/**
 * Single registry of customer-facing Postgres fields: which command writes
 * each column, and what the reply manager may claim after a successful write.
 * Rendered into prompts/haim-data-map.he.md and checked by
 * scripts/validate-prompt-wiring.mjs so a migration cannot ship without a
 * matching prompt update.
 */
export const MAPPED_TABLES = [
  "requests",
  "request_parties",
  "request_items",
  "request_media",
  "request_locations",
  "request_verifications",
  "searches",
  "matches",
  "conversations",
  "outbox",
] as const;

export type MappedTable = (typeof MAPPED_TABLES)[number];

export type FieldWriter =
  | "donate"
  | "receive_from_donor"
  | "seek"
  | "interest"
  | "details"
  | "item_facts"
  | "counterparty"
  | "counterparty_candidate"
  | "confirm_counterparty"
  | "contact_counterparty"
  | "approve_self"
  | "approve_schedule"
  | "cancel"
  | "select"
  | "escalate"
  | "system"
  | "engine"
  | "read_only";

export interface FieldMapEntry {
  table: MappedTable;
  column: string;
  hebrew: string;
  writer: FieldWriter;
  commandField?: string;
  claimable: boolean;
  claim?: string;
  missing?: string;
}

/** Columns that exist in scope tables but are never shown to the model. */
export const EXCLUDED_COLUMNS: {
  table: MappedTable;
  column: string;
  reason: string;
}[] = [
  { table: "requests", column: "id", reason: "pk" },
  { table: "requests", column: "version", reason: "concurrency" },
  { table: "requests", column: "created_at", reason: "timestamp" },
  { table: "requests", column: "updated_at", reason: "timestamp" },
  { table: "request_parties", column: "request_id", reason: "fk" },
  { table: "request_parties", column: "contact_id", reason: "fk" },
  { table: "request_items", column: "request_id", reason: "fk" },
  { table: "request_items", column: "position", reason: "internal" },
  { table: "request_media", column: "request_id", reason: "fk" },
  { table: "request_media", column: "added_by", reason: "fk" },
  { table: "request_locations", column: "request_id", reason: "fk" },
  { table: "request_locations", column: "message_id", reason: "fk" },
  { table: "request_locations", column: "captured_at", reason: "timestamp" },
  { table: "request_verifications", column: "request_id", reason: "fk" },
  { table: "request_verifications", column: "offered_at", reason: "timestamp" },
  { table: "request_verifications", column: "queued_at", reason: "timestamp" },
  { table: "request_verifications", column: "provider_accepted_at", reason: "timestamp" },
  { table: "request_verifications", column: "delivered_at", reason: "timestamp" },
  { table: "request_verifications", column: "approved_at", reason: "timestamp" },
  { table: "request_verifications", column: "failed_at", reason: "timestamp" },
  { table: "request_verifications", column: "uncertain_at", reason: "timestamp" },
  { table: "request_verifications", column: "outbox_id", reason: "fk" },
  { table: "request_verifications", column: "updated_at", reason: "timestamp" },
  { table: "searches", column: "contact_id", reason: "pk" },
  { table: "searches", column: "updated_at", reason: "timestamp" },
  { table: "matches", column: "id", reason: "pk" },
  { table: "matches", column: "request_id", reason: "fk" },
  { table: "matches", column: "contact_id", reason: "fk" },
  { table: "matches", column: "created_at", reason: "timestamp" },
  { table: "matches", column: "presented_at", reason: "timestamp" },
  { table: "conversations", column: "id", reason: "pk" },
  { table: "conversations", column: "contact_id", reason: "fk" },
  { table: "conversations", column: "channel", reason: "internal" },
  { table: "conversations", column: "session", reason: "internal" },
  { table: "conversations", column: "chat_id", reason: "internal" },
  { table: "conversations", column: "version", reason: "concurrency" },
  { table: "outbox", column: "id", reason: "pk" },
  { table: "outbox", column: "seq", reason: "internal" },
  { table: "outbox", column: "dedupe_key", reason: "internal" },
  { table: "outbox", column: "message_id", reason: "fk" },
  { table: "outbox", column: "request_id", reason: "fk" },
  { table: "outbox", column: "trace_id", reason: "internal" },
  { table: "outbox", column: "mode", reason: "internal" },
  { table: "outbox", column: "chat_id", reason: "internal" },
  { table: "outbox", column: "media_id", reason: "fk" },
  { table: "outbox", column: "match_id", reason: "fk" },
  { table: "outbox", column: "provider_id", reason: "internal" },
  { table: "outbox", column: "job_id", reason: "internal" },
  { table: "outbox", column: "created_at", reason: "timestamp" },
  { table: "outbox", column: "sent_at", reason: "timestamp" },
  { table: "outbox", column: "error_code", reason: "internal" },
  { table: "outbox", column: "provider_accepted_at", reason: "timestamp" },
  { table: "outbox", column: "delivered_at", reason: "timestamp" },
  { table: "outbox", column: "read_at", reason: "timestamp" },
];

export const FIELD_MAP: FieldMapEntry[] = [
  { table: "requests", column: "number", hebrew: "מספר פנייה", writer: "system", claimable: true, claim: "נפתחה פנייה במספר זה" },
  { table: "requests", column: "status", hebrew: "סטטוס פנייה", writer: "system", claimable: true, claim: "הסטטוס במסד הוא הערך שנקרא" },
  { table: "requests", column: "origin", hebrew: "סוג פנייה (מסירה כללית או ישירה)", writer: "donate", commandField: "direct", claimable: false },
  { table: "requests", column: "run_date", hebrew: "תאריך הובלה מתואם", writer: "system", claimable: true, claim: "ההובלה נקבעה לתאריך זה" },
  { table: "requests", column: "earliest_run_date", hebrew: "תאריך מוקדם ביותר אחרי ביטול", writer: "cancel", commandField: "choice", claimable: false },
  { table: "requests", column: "human_reason", hebrew: "סיבת טיפול אנושי", writer: "escalate", commandField: "reason", claimable: false },
  { table: "requests", column: "verification_contacted", hebrew: "האם פנינו לצד השני", writer: "contact_counterparty", commandField: "contact", claimable: true, claim: "פנינו לצד השני", missing: "עדיין לא פנינו" },
  { table: "requests", column: "preferred_time", hebrew: "שעת העדפה", writer: "details", commandField: "preferred_time", claimable: true, claim: "נשמרה שעת ההעדפה", missing: "אין שעת העדפה שמורה" },
  { table: "requests", column: "represents_both_parties", hebrew: "מייצג את שני הצדדים", writer: "donate", commandField: "counterparty_phone", claimable: false },
  { table: "requests", column: "closed_at", hebrew: "מועד סגירה", writer: "cancel", claimable: false },
  { table: "requests", column: "proposed_run_date", hebrew: "מועד הובלה מוצע", writer: "system", claimable: true, claim: "הוצע מועד הובלה", missing: "עדיין אין מועד מוצע" },

  { table: "request_parties", column: "role", hebrew: "תפקיד (מוסר/מקבל)", writer: "donate", commandField: "type", claimable: false },
  { table: "request_parties", column: "name", hebrew: "שם", writer: "details", commandField: "name", claimable: true, claim: "נשמר השם", missing: "חסר שם" },
  { table: "request_parties", column: "settlement", hebrew: "יישוב", writer: "details", commandField: "settlement", claimable: true, claim: "נשמר היישוב", missing: "חסר יישוב" },
  { table: "request_parties", column: "address", hebrew: "כתובת או רחוב", writer: "details", commandField: "address", claimable: true, claim: "נשמרה הכתובת", missing: "חסרה כתובת" },
  { table: "request_parties", column: "floor", hebrew: "קומה", writer: "details", commandField: "floor", claimable: true, claim: "נשמרה הקומה", missing: "אין קומה שמורה" },
  { table: "request_parties", column: "floor_note_shown", hebrew: "האם הוצגה הערת קומה", writer: "system", claimable: false },
  { table: "request_parties", column: "approved_at", hebrew: "אישור החלק בפנייה", writer: "approve_self", claimable: true, claim: "החלק בפנייה אושר", missing: "חסר אישור החלק" },
  { table: "request_parties", column: "approved_by", hebrew: "מי אישר את החלק", writer: "approve_self", claimable: false },
  { table: "request_parties", column: "schedule_approved", hebrew: "האם אושר המועד", writer: "approve_schedule", claimable: true, claim: "המועד אושר", missing: "המועד טרם אושר" },
  { table: "request_parties", column: "schedule_approved_date", hebrew: "תאריך מועד שאושר", writer: "approve_schedule", commandField: "date", claimable: true, claim: "אושר המועד לתאריך זה" },
  { table: "request_parties", column: "schedule_approved_at", hebrew: "מתי אושר המועד", writer: "approve_schedule", claimable: false },

  { table: "request_items", column: "kind", hebrew: "סוג פריט", writer: "donate", commandField: "items", claimable: true, claim: "נשמר סוג הפריט" },
  { table: "request_items", column: "description", hebrew: "תיאור פריט", writer: "donate", commandField: "items", claimable: true, claim: "נשמר תיאור הפריט" },
  { table: "request_items", column: "quantity", hebrew: "כמות", writer: "donate", commandField: "items", claimable: false },
  { table: "request_items", column: "free", hebrew: "נמסר בחינם", writer: "item_facts", commandField: "free", claimable: true, claim: "נרשם שהפריט בחינם", missing: "לא ידוע אם הפריט בחינם" },
  { table: "request_items", column: "working", hebrew: "תקין ושמיש", writer: "item_facts", commandField: "working", claimable: true, claim: "נרשמה תקינות הפריט", missing: "חסרה שאלת תקינות" },
  { table: "request_items", column: "needs_disassembly", hebrew: "נדרש פירוק", writer: "item_facts", commandField: "needs_disassembly", claimable: true, claim: "נרשם אם נדרש פירוק" },
  { table: "request_items", column: "wardrobe_small_whole", hebrew: "ארון קטן ושלם", writer: "item_facts", commandField: "wardrobe_small_whole", claimable: true, claim: "נרשם שהארון קטן ושלם" },
  { table: "request_items", column: "oven_type", hebrew: "סוג תנור", writer: "item_facts", commandField: "oven_type", claimable: true, claim: "נרשם סוג התנור" },
  { table: "request_items", column: "evacuation", hebrew: "פינוי רהיט", writer: "item_facts", commandField: "evacuation", claimable: false },

  { table: "request_media", column: "media_id", hebrew: "תמונת פריט", writer: "engine", claimable: true, claim: "התמונה התקבלה", missing: "אין תמונה שמורה" },

  { table: "request_locations", column: "role", hebrew: "צד שנקודת המיקום שייכת לו", writer: "engine", claimable: false },
  { table: "request_locations", column: "latitude", hebrew: "קו רוחב", writer: "engine", claimable: true, claim: "נקודת המיקום התקבלה" },
  { table: "request_locations", column: "longitude", hebrew: "קו אורך", writer: "engine", claimable: true, claim: "נקודת המיקום התקבלה" },

  { table: "request_verifications", column: "role", hebrew: "צד באימות", writer: "contact_counterparty", claimable: false },
  { table: "request_verifications", column: "state", hebrew: "מצב אימות", writer: "contact_counterparty", commandField: "contact", claimable: true, claim: "מצב האימות במסד הוא הערך שנקרא" },
  { table: "request_verifications", column: "consented_at", hebrew: "מועד הסכמה לפנייה", writer: "contact_counterparty", commandField: "contact", claimable: true, claim: "ניתנה הסכמה לפנייה לצד השני" },
  { table: "request_verifications", column: "last_error", hebrew: "שגיאת אימות", writer: "system", claimable: false },

  { table: "searches", column: "kind", hebrew: "סוג פריט שמחפשים", writer: "seek", commandField: "kind", claimable: true, claim: "נרשם החיפוש", missing: "אין חיפוש פעיל" },
  { table: "searches", column: "state", hebrew: "מצב חיפוש", writer: "seek", claimable: false },
  { table: "searches", column: "settlement", hebrew: "יישוב מועדף למבקש", writer: "seek", commandField: "settlement", claimable: true, claim: "נשמר היישוב לחיפוש", missing: "אין יישוב שמור לחיפוש" },
  { table: "searches", column: "address", hebrew: "כתובת מועדפת למבקש", writer: "seek", commandField: "address", claimable: true, claim: "נשמרה הכתובת לחיפוש", missing: "אין כתובת שמורה לחיפוש" },
  { table: "searches", column: "floor", hebrew: "קומה מועדפת למבקש", writer: "seek", commandField: "floor", claimable: true, claim: "נשמרה הקומה לחיפוש", missing: "אין קומה שמורה לחיפוש" },
  { table: "searches", column: "name", hebrew: "שם המבקש", writer: "seek", commandField: "name", claimable: true, claim: "נשמר השם בחיפוש", missing: "אין שם שמור בחיפוש" },

  { table: "matches", column: "state", hebrew: "מצב התאמה", writer: "interest", commandField: "request_number", claimable: true, claim: "נרשמה התעניינות בפריט" },

  { table: "conversations", column: "mode", hebrew: "מצב שיחה (בוט/אנושי)", writer: "engine", claimable: false },
  { table: "conversations", column: "selected_request_id", hebrew: "פנייה נבחרת בשיחה", writer: "select", commandField: "request_number", claimable: false },
  { table: "conversations", column: "pending_counterparty_name", hebrew: "שם צד ממתין לקישור", writer: "counterparty_candidate", commandField: "name", claimable: true, claim: "נרשם שם הצד השני" },
  { table: "conversations", column: "pending_counterparty_phone", hebrew: "טלפון צד ממתין לקישור", writer: "counterparty_candidate", commandField: "phone", claimable: true, claim: "נרשם מספר הצד השני" },

  { table: "outbox", column: "phone", hebrew: "נמען הודעה יוצאת", writer: "read_only", claimable: false },
  { table: "outbox", column: "text", hebrew: "טקסט הודעה יוצאת", writer: "read_only", claimable: false },
  { table: "outbox", column: "state", hebrew: "מצב שליחה", writer: "read_only", claimable: true, claim: "ההודעה במצב שנקרא מהמסד; pending אינו נשלח" },
  { table: "outbox", column: "format_state", hebrew: "מצב ניסוח", writer: "read_only", claimable: false },
  { table: "outbox", column: "delivery_state", hebrew: "מצב מסירה לספק", writer: "read_only", claimable: true, claim: "המסירה במצב שנקרא מהמסד; אל תאמר נשלח על סמך תור" },
];

export interface ChangedField {
  table: string;
  column: string;
  role?: string | null;
}

export function renderDataMap(): string {
  const byTable = new Map<string, FieldMapEntry[]>();
  for (const entry of FIELD_MAP) {
    const list = byTable.get(entry.table) ?? [];
    list.push(entry);
    byTable.set(entry.table, list);
  }
  const storeLines: string[] = [
    "# מפת נתונים",
    "",
    "מסמך זה נוצר מ-src/domain/field-map.ts. אין לערוך אותו ידנית.",
    "",
    "## מה נשמר ואיפה",
    "",
    "כל עובדה שהלקוח מוסר חייבת לרדת לפקודה שכותבת את העמודה המתאימה. אין next כשאפשר לשמור. אין details על חיפוש, ואין seek על פנייה.",
    "",
  ];
  for (const table of MAPPED_TABLES) {
    const rows = byTable.get(table);
    if (!rows) continue;
    storeLines.push(`### ${table}`);
    for (const row of rows) {
      const via =
        row.writer === "system" || row.writer === "engine" || row.writer === "read_only"
          ? row.writer
          : `פקודה ${row.writer}${row.commandField ? `.${row.commandField}` : ""}`;
      storeLines.push(`- ${row.column} (${row.hebrew}) ← ${via}`);
    }
    storeLines.push("");
  }
  const claimLines: string[] = [
    "## מה מותר לומר",
    "",
    "אמר \"נשמר\" / \"רשמתי\" / \"שמרתי\" / \"עדכנתי\" רק לשדה שמופיע ב-changed_fields של התור הזה. אם changed_fields ריק, אין פועל שמירה. שדה חסר: שאל או אשר בלי פועל שמירה.",
    "",
  ];
  for (const row of FIELD_MAP.filter((entry) => entry.claimable)) {
    claimLines.push(
      `- ${row.table}.${row.column}: ${row.claim ?? "אמור רק לפי changed_fields"}${row.missing ? `; חסר: ${row.missing}` : ""}`,
    );
  }
  claimLines.push("");
  return `${storeLines.join("\n")}${claimLines.join("\n")}`;
}

export function dataMapSection(markdown: string, heading: string): string {
  const pattern = new RegExp(
    `(## ${heading}\\n[\\s\\S]*?)(?=\\n## |$)`,
  );
  return markdown.match(pattern)?.[1]?.trim() ?? "";
}

function pushIfChanged(
  out: ChangedField[],
  table: string,
  column: string,
  before: unknown,
  after: unknown,
  role?: string | null,
): void {
  if (Object.is(before, after)) return;
  if (before === after) return;
  out.push(role ? { table, column, role } : { table, column });
}

export function diffChangedFields(input: {
  beforeRequest: {
    preferred_time?: string | null;
    verification_contacted?: boolean;
    status?: string;
    proposed_run_date?: string | null;
    parties?: {
      role: string;
      name: string | null;
      settlement: string | null;
      address: string | null;
      floor: number | null;
      approved_at: string | null;
      schedule_approved_date: string | null;
    }[];
    items?: {
      kind: string;
      description: string;
      free: boolean | null;
      working: boolean | null;
      needs_disassembly: boolean | null;
      wardrobe_small_whole: boolean | null;
      oven_type: string | null;
      evacuation: string | null;
    }[];
    photo_ids?: string[];
  } | null;
  afterRequest: {
    preferred_time?: string | null;
    verification_contacted?: boolean;
    status?: string;
    proposed_run_date?: string | null;
    parties?: {
      role: string;
      name: string | null;
      settlement: string | null;
      address: string | null;
      floor: number | null;
      approved_at: string | null;
      schedule_approved_date: string | null;
    }[];
    items?: {
      kind: string;
      description: string;
      free: boolean | null;
      working: boolean | null;
      needs_disassembly: boolean | null;
      wardrobe_small_whole: boolean | null;
      oven_type: string | null;
      evacuation: string | null;
    }[];
    photo_ids?: string[];
  } | null;
  beforeSearch: {
    kind: string;
    settlement: string | null;
    address: string | null;
    floor: number | null;
    name: string | null;
  } | null;
  afterSearch: {
    kind: string;
    settlement: string | null;
    address: string | null;
    floor: number | null;
    name: string | null;
  } | null;
}): ChangedField[] {
  const out: ChangedField[] = [];
  const before = input.beforeRequest;
  const after = input.afterRequest;
  if (after) {
    pushIfChanged(out, "requests", "preferred_time", before?.preferred_time ?? null, after.preferred_time ?? null);
    pushIfChanged(out, "requests", "verification_contacted", before?.verification_contacted ?? false, after.verification_contacted ?? false);
    pushIfChanged(out, "requests", "status", before?.status ?? null, after.status ?? null);
    pushIfChanged(out, "requests", "proposed_run_date", before?.proposed_run_date ?? null, after.proposed_run_date ?? null);
    if ((after.photo_ids?.length ?? 0) > (before?.photo_ids?.length ?? 0))
      out.push({ table: "request_media", column: "media_id" });
    for (const party of after.parties ?? []) {
      const prior = before?.parties?.find((entry) => entry.role === party.role);
      pushIfChanged(out, "request_parties", "name", prior?.name ?? null, party.name, party.role);
      pushIfChanged(out, "request_parties", "settlement", prior?.settlement ?? null, party.settlement, party.role);
      pushIfChanged(out, "request_parties", "address", prior?.address ?? null, party.address, party.role);
      pushIfChanged(out, "request_parties", "floor", prior?.floor ?? null, party.floor, party.role);
      pushIfChanged(out, "request_parties", "approved_at", prior?.approved_at ?? null, party.approved_at, party.role);
      pushIfChanged(out, "request_parties", "schedule_approved_date", prior?.schedule_approved_date ?? null, party.schedule_approved_date, party.role);
    }
    const afterItems = after.items ?? [];
    const beforeItems = before?.items ?? [];
    if (afterItems.length && !beforeItems.length)
      out.push({ table: "request_items", column: "kind" });
    for (const [index, item] of afterItems.entries()) {
      const prior = beforeItems[index];
      pushIfChanged(out, "request_items", "free", prior?.free ?? null, item.free);
      pushIfChanged(out, "request_items", "working", prior?.working ?? null, item.working);
      pushIfChanged(out, "request_items", "needs_disassembly", prior?.needs_disassembly ?? null, item.needs_disassembly);
      pushIfChanged(out, "request_items", "wardrobe_small_whole", prior?.wardrobe_small_whole ?? null, item.wardrobe_small_whole);
      pushIfChanged(out, "request_items", "oven_type", prior?.oven_type ?? null, item.oven_type);
    }
  }
  const beforeSearch = input.beforeSearch;
  const afterSearch = input.afterSearch;
  if (afterSearch) {
    pushIfChanged(out, "searches", "kind", beforeSearch?.kind ?? null, afterSearch.kind);
    pushIfChanged(out, "searches", "settlement", beforeSearch?.settlement ?? null, afterSearch.settlement);
    pushIfChanged(out, "searches", "address", beforeSearch?.address ?? null, afterSearch.address);
    pushIfChanged(out, "searches", "floor", beforeSearch?.floor ?? null, afterSearch.floor);
    pushIfChanged(out, "searches", "name", beforeSearch?.name ?? null, afterSearch.name);
  }
  return out;
}
