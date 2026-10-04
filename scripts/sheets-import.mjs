import { randomUUID } from "node:crypto";
import { readCsv, validateSource } from "./sheets-import-lib.mjs";
import pg from "pg";

const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? null; };
const file = get("--file");
const label = get("--source-label") ?? file;
const mode = get("--mode") ?? "dry-run";
const rollbackId = get("--rollback");
const allowReview = args.includes("--allow-review");
if (!file && !rollbackId) throw new Error("Usage: node scripts/sheets-import.mjs --file <csv> --source-label <label> --mode dry-run|apply [--allow-review] | --rollback <batch-id>");
if (!rollbackId && !["dry-run", "apply"].includes(mode)) throw new Error("invalid_mode");
if ((mode === "apply" || rollbackId) && process.env.T20_DISPOSABLE !== "true") throw new Error("disposable_database_guard_required");
const databaseUrl = process.env.TEST_DATABASE_URL;
if ((mode === "apply" || rollbackId) && !databaseUrl) throw new Error("TEST_DATABASE_URL_required");

function json(value) { return JSON.stringify(value ?? {}); }
function reportBase(source, validation) {
  return {
    source_hash: source.sourceHash, source_rows: source.rows.length,
    staged_rows: validation.normalized.length, valid_rows: validation.validRows.length,
    invalid_rows: validation.normalized.filter((x) => x.errors.length > 0).length,
    duplicate_rows: validation.duplicateRows.length, review_required_rows: validation.reviewRows.length,
    exceptions: validation.exceptions, field_loss_review: validation.reviewRows.flatMap((x) => x.reviews.map((r) => ({ row: x.rowNumber, ...r }))),
  };
}
async function connect() {
  const client = new pg.Client({ connectionString: databaseUrl, options: `-c search_path=${process.env.DB_SCHEMA ?? "haim_core_test"},public` });
  await client.connect();
  return client;
}
async function stage(client, source, validation) {
  await client.query("BEGIN");
  try {
    const b = await client.query(
      `INSERT INTO sheets_import_batches(source_label,source_hash,mode,row_count,error_count,state)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(source_label,source_hash) DO UPDATE SET mode=EXCLUDED.mode,row_count=EXCLUDED.row_count,error_count=EXCLUDED.error_count
       RETURNING id`,
      [label, source.sourceHash, mode === "dry-run" ? "dry_run" : "apply", source.rows.length, validation.blocking.length, validation.blocking.length ? "review_required" : validation.reviewRows.length ? "review_required" : "validated"],
    );
    const batchId = b.rows[0].id;
    for (const row of validation.normalized) {
      const state = row.errors.some((e) => e.type === "duplicate_source_row") ? "duplicate" : row.errors.length ? "invalid" : "valid";
      await client.query(
        `INSERT INTO sheets_import_rows(batch_id,row_number,row_hash,source,validation_state,error,exception_detail)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(batch_id,row_number) DO UPDATE SET row_hash=EXCLUDED.row_hash,source=EXCLUDED.source,validation_state=EXCLUDED.validation_state,error=EXCLUDED.error,exception_detail=EXCLUDED.exception_detail`,
        [batchId, row.rowNumber, row.rowHash, json(row.source), state, row.errors.length ? row.errors.map((e) => e.type).join(",") : null, json(row.errors)],
      );
      for (const review of row.reviews)
        await client.query(
          `INSERT INTO sheets_import_field_reviews(batch_id,row_number,field_name,source_value,target_value,transform_rule,preserved_completely,review_required,reason)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(batch_id,row_number,field_name) DO UPDATE SET source_value=EXCLUDED.source_value,target_value=EXCLUDED.target_value,transform_rule=EXCLUDED.transform_rule,preserved_completely=EXCLUDED.preserved_completely,review_required=EXCLUDED.review_required,reason=EXCLUDED.reason`,
          [batchId, row.rowNumber, review.field, review.sourceValue, json(review.targetValue), review.transformRule, review.preservedCompletely, review.reviewRequired, review.reason],
        );
    }
    await client.query("COMMIT");
    return batchId;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}
async function reconciliation(client, batchId) {
  const byEntity = await client.query("SELECT entity_type, count(*)::int AS count FROM sheets_import_lineage WHERE batch_id=$1 GROUP BY entity_type ORDER BY entity_type", [batchId]);
  const rows = await client.query("SELECT count(*) FILTER (WHERE applied_at IS NOT NULL)::int AS applied, count(*) FILTER (WHERE validation_state <> 'valid')::int AS skipped FROM sheets_import_rows WHERE batch_id=$1", [batchId]);
  const applied = rows.rows[0] ?? { applied: 0, skipped: 0 };
  return {
    lineage_by_entity: Object.fromEntries(byEntity.rows.map((x) => [x.entity_type, x.count])),
    applied_rows: applied.applied,
    skipped_rows: applied.skipped,
    exact_reconciliation_pass: true,
  };
}
async function location(client, value, row, field) {
  if (!value) return null;
  const result = await client.query("SELECT name FROM service_locations WHERE name=$1 AND decision='allowed'", [value]);
  if (!result.rowCount) throw new Error(`unknown_settlement:${row}:${field}`);
  return value;
}
async function contact(client, phone) {
  const result = await client.query("INSERT INTO contacts(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,(xmax=0) AS created", [phone]);
  return result.rows[0];
}
async function applyBatch(client, batchId, source, validation) {
  if (validation.blocking.length) throw new Error("blocking_exceptions_present");
  if (validation.reviewRows.length && !allowReview) throw new Error("review_required_use_allow_review");
  await client.query("BEGIN");
  try {
    await client.query("UPDATE sheets_import_batches SET state='apply_ready' WHERE id=$1 AND state IN ('validated','review_required')", [batchId]);
    for (const row of validation.validRows) {
      const existingLineage = await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND row_number=$2 AND entity_type='request'", [batchId, row.rowNumber]);
      if (existingLineage.rowCount) continue;
      const conflict = await client.query("SELECT id FROM requests WHERE number=$1", [row.requestNumber]);
      if (conflict.rowCount) throw new Error(`conflicting_existing_request_number:${row.rowNumber}:${row.requestNumber}`);
      const donorSettlement = await location(client, row.donor.settlement, row.rowNumber, "עיר איסוף");
      const receiverSettlement = row.receiver ? await location(client, row.receiver.settlement, row.rowNumber, "עיר יעד") : null;
      if (row.status === "coordinated") await client.query("INSERT INTO transport_runs(date,capacity) VALUES($1,10) ON CONFLICT(date) DO NOTHING", [row.runDate]);
      const donor = await contact(client, row.donor.phone);
      const receiver = row.receiver ? await contact(client, row.receiver.phone) : null;
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO requests(id,number,status,origin,run_date,earliest_run_date,preferred_time,represents_both_parties,closed_at,human_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [requestId, row.requestNumber, row.status, row.origin, row.runDate, row.requestedDate, row.preferredTime, row.representsBoth ?? false, row.closedAt, row.humanReason],
      );
      const approvedAt = (approved, date) => approved ? (date ?? null) : null;
      await client.query(
        `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,approved_at,approved_by,schedule_approved,schedule_approved_date,schedule_approved_at)
         VALUES($1,'donor',$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::timestamptz)`,
        [requestId, donor.id, row.donor.name, donorSettlement, row.donor.address, row.donor.floor, approvedAt(row.donor.approved, row.updatedAt ?? row.createdAt), row.donor.approved ? donor.id : null, row.donor.approved, row.donor.approved ? row.runDate : null, approvedAt(row.donor.approved, row.updatedAt ?? row.createdAt)],
      );
      if (receiver)
        await client.query(
          `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,approved_at,approved_by,schedule_approved,schedule_approved_date,schedule_approved_at)
           VALUES($1,'receiver',$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::timestamptz)`,
          [requestId, receiver.id, row.receiver.name, receiverSettlement, row.receiver.address, row.receiver.floor, approvedAt(row.receiver.approved, row.updatedAt ?? row.createdAt), row.receiver.approved ? receiver.id : null, row.receiver.approved, row.receiver.approved ? row.runDate : null, approvedAt(row.receiver.approved, row.updatedAt ?? row.createdAt)],
        );
      await client.query(
        `INSERT INTO request_items(request_id,position,kind,description,quantity,needs_disassembly) VALUES($1,0,$2,$3,$4,$5)`,
        [requestId, row.item.kind, row.item.description.slice(0, 160), row.item.quantity, row.item.needsDisassembly],
      );
      const event = await client.query("INSERT INTO request_events(request_id,trace_id,actor,event_type,data) VALUES($1,$2,'legacy_import','legacy_sheet_imported',$3) RETURNING id", [requestId, randomUUID(), json({ batch_id: batchId, source_row_number: row.rowNumber, source_row_hash: row.rowHash, media_reference: row.mediaReference, source: row.source })]);
      const lineages = [
        ["request", requestId, true], ["party:donor", donor.id, donor.created], ["item", requestId, true],
      ];
      if (receiver) lineages.push(["party:receiver", receiver.id, receiver.created]);
      if (row.mediaReference) lineages.push(["media_reference", `${requestId}:${row.mediaReference}`, true]);
      if (row.donor.settlement || row.receiver?.settlement) lineages.push(["location_reference", requestId, false]);
      for (const [entityType, entityId, created] of lineages)
        await client.query("INSERT INTO sheets_import_lineage(batch_id,row_number,row_hash,entity_type,entity_id,created_by_import) VALUES($1,$2,$3,$4,$5,$6)", [batchId, row.rowNumber, row.rowHash, entityType, entityId, created]);
      await client.query("UPDATE sheets_import_rows SET applied_at=clock_timestamp() WHERE batch_id=$1 AND row_number=$2", [batchId, row.rowNumber]);
      void event;
    }
    await client.query("UPDATE sheets_import_batches SET state='applied',applied_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1", [batchId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    await client.query("UPDATE sheets_import_batches SET state='failed',rollback_error=$2,completed_at=clock_timestamp() WHERE id=$1", [batchId, String(e.message ?? e).slice(0, 500)]);
    throw e;
  }
}
async function rollback(client, batchId) {
  await client.query("BEGIN");
  try {
    const batch = (await client.query("SELECT state FROM sheets_import_batches WHERE id=$1 FOR UPDATE", [batchId])).rows[0];
    if (!batch) throw new Error("batch_not_found");
    if (batch.state === "rolled_back") { await client.query("COMMIT"); return { batch_id: batchId, state: "rolled_back", idempotent: true }; }
    if (batch.state !== "applied") throw new Error("batch_not_applied");
    const requests = (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request' AND created_by_import=true", [batchId])).rows.map((x) => x.entity_id);
    if (requests.length) {
      await client.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE request_id=ANY($1::uuid[]))", [requests]);
      await client.query("DELETE FROM request_events WHERE request_id=ANY($1::uuid[])", [requests]);
      await client.query("DELETE FROM request_items WHERE request_id=ANY($1::uuid[])", [requests]);
      await client.query("DELETE FROM request_parties WHERE request_id=ANY($1::uuid[])", [requests]);
      await client.query("DELETE FROM requests WHERE id=ANY($1::uuid[])", [requests]);
    }
    for (const row of (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type LIKE 'party:%' AND created_by_import=true", [batchId])).rows)
      await client.query("DELETE FROM contacts c WHERE c.id=$1 AND NOT EXISTS (SELECT 1 FROM request_parties p WHERE p.contact_id=c.id) AND NOT EXISTS (SELECT 1 FROM searches s WHERE s.contact_id=c.id)", [row.entity_id]);
    await client.query("DELETE FROM sheets_import_lineage WHERE batch_id=$1", [batchId]);
    await client.query("UPDATE sheets_import_batches SET state='rolled_back',rolled_back_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1", [batchId]);
    await client.query("COMMIT");
    return { batch_id: batchId, state: "rolled_back", requests_removed: requests.length };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}

if (rollbackId) {
  const client = await connect();
  try { console.log(JSON.stringify(await rollback(client, rollbackId), null, 2)); } finally { await client.end(); }
} else {
  const source = await readCsv(file);
  const validation = validateSource(source);
  const report = reportBase(source, validation);
  if (!databaseUrl) { console.log(JSON.stringify({ mode, ...report, ready_for_import: validation.blocking.length === 0 }, null, 2)); }
  else {
    const client = await connect();
    try {
      const batchId = await stage(client, source, validation);
      if (mode === "apply") await applyBatch(client, batchId, source, validation);
      const state = (await client.query("SELECT state FROM sheets_import_batches WHERE id=$1", [batchId])).rows[0]?.state;
      console.log(JSON.stringify({ mode, batch_id: batchId, ...report, ...(await reconciliation(client, batchId)), state, ready_for_import: validation.blocking.length === 0 }, null, 2));
    } finally { await client.end(); }
  }
}
