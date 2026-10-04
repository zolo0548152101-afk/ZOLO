import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MAPPING_FILE = resolve("config/legacy-sheets-v9-mapping.json");
export const STATUS_MAP = new Map([
  ["collecting", "collecting"],
  ["available", "available"],
  ["awaiting_approval", "awaiting_approval"],
  ["waiting_capacity", "waiting_capacity"],
  ["coordinated", "coordinated"],
  ["human", "human"],
  ["cancel_pending", "cancel_pending"],
  ["cancelled", "cancelled"],
  ["closed", "closed"],
  ["rejected", "rejected"],
]);
const BOOL_MAP = new Map([
  ["true", true], ["false", false], ["1", true], ["0", false],
  ["yes", true], ["no", false], ["כן", true], ["לא", false],
  ["מאושר", true], ["מאושרת", true], ["מאושר/ת", true],
]);
const KIND_MAP = new Map([
  ["מיטה", "bed"], ["מיטה זוגית", "bed"], ["ספה", "sofa"],
  ["ארון", "wardrobe"], ["מקרר", "fridge"], ["תנור", "oven"],
  ["שולחן", "table"], ["שולחן וכיסאות", "table_set"], ["כיסאות", "chairs"],
  ["מכונת כביסה", "washing_machine"], ["מייבש", "dryer"], ["מקפיא", "freezer"],
  ["מדיח", "dishwasher"], ["פסנתר", "piano"], ["הובלה", "house_move"],
]);
const LOSS_REVIEW_FIELDS = new Set(["הערות", "סטטוס בוט", "נדרש טיפול אנושי"]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false, rowNumber = 1;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => {
    pushCell();
    if (row.some((x) => x.length > 0)) rows.push({ rowNumber, values: row });
    row = [];
    rowNumber++;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch;
      continue;
    }
    if (ch === '"' && cell.length === 0) { quoted = true; continue; }
    if (ch === ",") { pushCell(); continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && next === "\n") i++;
      pushRow();
      continue;
    }
    cell += ch;
  }
  if (quoted) throw new Error("unterminated_csv_quote");
  if (cell.length || row.length) pushRow();
  return rows;
}

export async function readCsv(file, mappingFile = MAPPING_FILE) {
  const bytes = await readFile(file);
  const mapping = JSON.parse(await readFile(mappingFile, "utf8"));
  const parsed = parseCsv(bytes.toString("utf8"));
  const expected = mapping.columns.map((x) => x.source);
  const header = parsed[0]?.values.map((x) => x.trim()) ?? [];
  const headerOk = header.length === expected.length && header.every((x, i) => x === expected[i]);
  const rows = parsed.slice(1).map((item) => {
    const source = Object.fromEntries(header.map((h, i) => [h, item.values[i] ?? ""]));
    return { rowNumber: item.rowNumber, values: item.values, source, rowHash: sha256(JSON.stringify(source)) };
  });
  return { bytes, sourceHash: sha256(bytes), mapping, expected, header, headerOk, rows };
}

function value(source, key) {
  const v = source[key];
  return v == null || v.trim() === "" ? null : v.trim();
}
function parseDate(v) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "invalid_date" };
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? { error: "invalid_date" } : v;
}
export function parseTimestamp(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return { error: "invalid_timestamp" };
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? { error: "invalid_timestamp" } : d.toISOString();
}
function parsePreferredTime(v) {
  if (!v) return { value: null, review: null };
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { value: v, review: null };
  return { value: null, review: { field: "שעה רצויה", sourceValue: v, targetValue: { legacy_preferred_time: v }, transformRule: "preserve_unsupported_legacy_time_for_review", preservedCompletely: true, reviewRequired: true, reason: "only explicit HH:MM is a current preferred-time value" } };
}
function parsePhone(v) {
  if (!v) return null;
  let digits = v.replace(/[\s().-]/g, "");
  if (digits.startsWith("+972")) digits = `0${digits.slice(4)}`;
  if (digits.startsWith("00972")) digits = `0${digits.slice(5)}`;
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (!/^05\d{8}$/.test(digits)) return { error: "invalid_phone" };
  return digits.slice(1);
}
function parseBool(v) {
  if (!v) return null;
  return BOOL_MAP.has(v.toLowerCase()) ? BOOL_MAP.get(v.toLowerCase()) : { error: "invalid_boolean" };
}
function parseIntValue(v, name, min, max) {
  if (!v) return null;
  if (!/^-?\d+$/.test(v)) return { error: `invalid_${name}` };
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : { error: `invalid_${name}` };
}
function parsedOrNull(valueResult, errors, row, field) {
  if (valueResult && typeof valueResult === "object" && valueResult.error) {
    errors.push({ type: valueResult.error, row, field });
    return null;
  }
  return valueResult;
}

export function normalizeRow(source, rowNumber) {
  const errors = [];
  const requestNumber = parsedOrNull(parseIntValue(value(source, "מספר פנייה"), "request_number", 1, Number.MAX_SAFE_INTEGER), errors, rowNumber, "מספר פנייה");
  const donorPhone = parsedOrNull(parsePhone(value(source, "טלפון המוסר")), errors, rowNumber, "טלפון המוסר");
  const receiverPhone = parsedOrNull(parsePhone(value(source, "נייד מקבל")), errors, rowNumber, "נייד מקבל");
  const quantity = parsedOrNull(parseIntValue(value(source, "כמות פריטים"), "quantity", 1, 2), errors, rowNumber, "כמות פריטים");
  const donorFloor = parsedOrNull(parseIntValue(value(source, "קומה איסוף"), "floor", -3, 100), errors, rowNumber, "קומה איסוף");
  const receiverFloor = parsedOrNull(parseIntValue(value(source, "קומה יעד"), "floor", -3, 100), errors, rowNumber, "קומה יעד");
  const statusSource = value(source, "סטטוס פנייה");
  const status = STATUS_MAP.get(statusSource ?? "") ?? null;
  if (!status) errors.push({ type: "unknown_status", row: rowNumber, field: "סטטוס פנייה", value: statusSource });
  const requestedDate = parsedOrNull(parseDate(value(source, "תאריך רצוי")), errors, rowNumber, "תאריך רצוי");
  const runDate = parsedOrNull(parseDate(value(source, "תאריך הובלה")), errors, rowNumber, "תאריך הובלה");
  const createdAt = parsedOrNull(parseTimestamp(value(source, "תאריך יצירה")), errors, rowNumber, "תאריך יצירה");
  const updatedAt = parsedOrNull(parseTimestamp(value(source, "עדכון אחרון")), errors, rowNumber, "עדכון אחרון");
  const closedAt = parsedOrNull(parseTimestamp(value(source, "תאריך סגירה")), errors, rowNumber, "תאריך סגירה");
  const donorApproved = parsedOrNull(parseBool(value(source, "אישורמוסר")), errors, rowNumber, "אישורמוסר");
  const receiverApproved = parsedOrNull(parseBool(value(source, "אישור מקבל")), errors, rowNumber, "אישור מקבל");
  const representsBoth = parsedOrNull(parseBool(value(source, "מייצג את שני הצדדים")), errors, rowNumber, "מייצג את שני הצדדים");
  const needsDisassembly = parsedOrNull(parseBool(value(source, "פירוק נדרש")), errors, rowNumber, "פירוק נדרש");
  const preferred = parsePreferredTime(value(source, "שעה רצויה"));
  const legacyHumanReview = parsedOrNull(parseBool(value(source, "נדרש טיפול אנושי")), errors, rowNumber, "נדרש טיפול אנושי");
  const description = value(source, "מה מעבירים");
  const itemKind = KIND_MAP.get(description ?? "") ?? (description ? "other" : null);
  if (!description) errors.push({ type: "missing_required", row: rowNumber, field: "מה מעבירים" });
  if (!donorPhone) errors.push({ type: "missing_required", row: rowNumber, field: "טלפון המוסר" });
  if (!requestNumber) errors.push({ type: "missing_required", row: rowNumber, field: "מספר פנייה" });
  if (!statusSource) errors.push({ type: "missing_required", row: rowNumber, field: "סטטוס פנייה" });
  if (status === "coordinated" && !runDate) errors.push({ type: "coordinated_without_run_date", row: rowNumber, field: "תאריך הובלה" });
  if (donorApproved === true && !updatedAt && !createdAt) errors.push({ type: "approval_without_source_timestamp", row: rowNumber, field: "אישורמוסר" });
  if (receiverApproved === true && !updatedAt && !createdAt) errors.push({ type: "approval_without_source_timestamp", row: rowNumber, field: "אישור מקבל" });
  if (value(source, "שם המקבל") && !receiverPhone) errors.push({ type: "receiver_name_without_phone", row: rowNumber, field: "נייד מקבל" });
  const reviews = [];
  for (const field of LOSS_REVIEW_FIELDS) {
    const raw = value(source, field);
    if (raw) reviews.push({ field, sourceValue: raw, targetValue: field === "הערות" ? { human_reason: raw } : field === "נדרש טיפול אנושי" ? { legacy_human_review: legacyHumanReview } : { legacy_bot_status: raw }, transformRule: "preserved_in_source_and_review_evidence", preservedCompletely: true, reviewRequired: true, reason: "legacy field is not a 1:1 business semantic" });
  }
  if (preferred.review) reviews.push(preferred.review);
  const mediaReference = value(source, "תמונות WhatsApp");
  if (mediaReference) reviews.push({ field: "תמונות WhatsApp", sourceValue: mediaReference, targetValue: { media_reference: mediaReference }, transformRule: "preserve_reference_without_fetch", preservedCompletely: true, reviewRequired: true, reason: "external media retrieval is not permitted" });
  return {
    rowNumber, source, requestNumber, status, origin: receiverPhone || value(source, "שם המקבל") ? "direct" : "donation",
    donor: { phone: donorPhone, name: value(source, "שם המוסר"), settlement: value(source, "עיר איסוף"), address: value(source, "כתובת איסוף"), floor: donorFloor, approved: donorApproved },
    receiver: receiverPhone ? { phone: receiverPhone, name: value(source, "שם המקבל"), settlement: value(source, "עיר יעד"), address: value(source, "כתובת יעד"), floor: receiverFloor, approved: receiverApproved } : null,
    item: { description, kind: itemKind, quantity, needsDisassembly },
    status, requestedDate, runDate, preferredTime: preferred.value, preferredTimeReview: preferred.review, representsBoth, createdAt, updatedAt, closedAt,
    humanReason: value(source, "הערות"), legacyHumanReview, mediaReference, reviews, errors,
  };
}

export function validateSource(sourceFile) {
  const exceptions = [];
  if (!sourceFile.headerOk) exceptions.push({ type: "header_mismatch", expected: sourceFile.expected, actual: sourceFile.header });
  const normalized = sourceFile.rows.map((row) => {
    if (row.values.length !== sourceFile.expected.length) {
      const error = { type: "row_width_mismatch", row: row.rowNumber, expected: sourceFile.expected.length, actual: row.values.length };
      exceptions.push(error);
      return { rowNumber: row.rowNumber, rowHash: row.rowHash, source: row.source, errors: [error], reviews: [] };
    }
    const item = normalizeRow(row.source, row.rowNumber);
    exceptions.push(...item.errors);
    return { ...item, rowHash: row.rowHash };
  });
  const byNumber = new Map();
  for (const row of normalized) if (row.requestNumber) byNumber.set(row.requestNumber, [...(byNumber.get(row.requestNumber) ?? []), row]);
  for (const [number, rows] of byNumber) if (rows.length > 1) {
    const hashes = new Set(rows.map((x) => x.rowHash));
    exceptions.push({ type: hashes.size === 1 ? "duplicate_source_row" : "conflicting_duplicate_request_number", requestNumber: number, rows: rows.map((x) => x.rowNumber) });
    for (const row of rows.slice(1)) row.errors.push({ type: hashes.size === 1 ? "duplicate_source_row" : "conflicting_duplicate_request_number", row: row.rowNumber });
  }
  const blocking = exceptions.filter((x) => !["duplicate_source_row"].includes(x.type));
  return { normalized, exceptions, blocking, validRows: normalized.filter((x) => x.errors.length === 0 && !x.errors.some((e) => e.type === "duplicate_source_row")), duplicateRows: normalized.filter((x) => x.errors.some((e) => e.type === "duplicate_source_row")), reviewRows: normalized.filter((x) => x.reviews.length > 0) };
}
