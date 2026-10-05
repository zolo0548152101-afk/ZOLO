// Canonical reconciliation entry point; it shares the parser and normalization contract with staging/apply.
import { readCsv, validateSource } from "./sheets-import-lib.mjs";
const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/sheets-reconcile.mjs <export.csv>");
const source = await readCsv(file);
const validation = validateSource(source);
const report = {
  mode: "reconcile_dry_run", source: file, source_hash: source.sourceHash,
  source_rows: source.rows.length, staged_rows: validation.normalized.length,
  valid_rows: validation.validRows.length, invalid_rows: validation.normalized.filter((x) => x.errors.length).length,
  duplicate_rows: validation.duplicateRows.length, review_required_rows: validation.reviewRows.length,
  media_reference_rows: validation.normalized.filter((x) => x.mediaReference).length,
  location_bearing_rows: validation.normalized.filter((x) => x.donor?.settlement || x.receiver?.settlement).length,
  exceptions: validation.exceptions, field_loss_review: validation.reviewRows.flatMap((x) => x.reviews.map((r) => ({ row: x.rowNumber, ...r }))),
  ready_for_import: validation.blocking.length === 0,
};
console.log(JSON.stringify(report, null, 2));
if (validation.blocking.length) process.exitCode = 1;
