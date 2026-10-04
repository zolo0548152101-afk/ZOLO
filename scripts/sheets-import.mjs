import { randomUUID } from "node:crypto";
import { readCsv, validateSource, normalizeRow } from "./sheets-import-lib.mjs";
import pg from "pg";

const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? null; };
const file = get("--file");
const label = get("--source-label") ?? file;
const mode = get("--mode") ?? "dry-run";
const rollbackId = get("--rollback");
const reconcileId = get("--reconcile");
const allowReview = args.includes("--allow-review");
const revalidate = args.includes("--revalidate");
if (!file && !rollbackId && !reconcileId) throw new Error("Usage: node scripts/sheets-import.mjs --file <csv> --source-label <label> --mode dry-run|apply [--allow-review] [--revalidate] | --rollback <batch-id> | --reconcile <batch-id>");
if (!rollbackId && !["dry-run", "apply"].includes(mode)) throw new Error("invalid_mode");
if ((mode === "apply" || rollbackId) && process.env.T20_DISPOSABLE !== "true") throw new Error("disposable_database_guard_required");
const databaseUrl = process.env.TEST_DATABASE_URL;
if ((mode === "apply" || rollbackId || reconcileId) && !databaseUrl) throw new Error("TEST_DATABASE_URL_required");

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
    const current = await client.query("SELECT id,state FROM sheets_import_batches WHERE source_label=$1 AND source_hash=$2 FOR UPDATE", [label, source.sourceHash]);
    const nextState = validation.blocking.length || validation.reviewRows.length ? "review_required" : "validated";
    let batchId;
    if (current.rowCount) {
      batchId = current.rows[0].id;
      if (revalidate) {
        if (!["failed", "rolled_back"].includes(current.rows[0].state)) throw new Error(`revalidate_not_allowed:${current.rows[0].state}`);
        await client.query("UPDATE sheets_import_batches SET mode=$2,row_count=$3,error_count=$4,state=$5,applied_at=NULL,rolled_back_at=NULL,completed_at=NULL,rollback_error=NULL WHERE id=$1", [batchId, mode === "dry-run" ? "dry_run" : "apply", source.rows.length, validation.blocking.length, nextState]);
        await client.query("DELETE FROM sheets_import_rows WHERE batch_id=$1", [batchId]);
        await client.query("DELETE FROM sheets_import_field_reviews WHERE batch_id=$1", [batchId]);
      }
    } else {
      const b = await client.query(
        `INSERT INTO sheets_import_batches(source_label,source_hash,mode,initial_mode,row_count,error_count,state)
         VALUES($1,$2,$3,$3,$4,$5,$6) RETURNING id`,
        [label, source.sourceHash, mode === "dry-run" ? "dry_run" : "apply", source.rows.length, validation.blocking.length, nextState],
      );
      batchId = b.rows[0].id;
    }
    if (current.rowCount && !revalidate) { await client.query("COMMIT"); return batchId; }
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
  const rowResult = await client.query("SELECT row_number, row_hash, source, validation_state, applied_at FROM sheets_import_rows WHERE batch_id=$1 ORDER BY row_number", [batchId]);
  const expected = new Map();
  const mismatches = [];
  const addExpected = (type) => expected.set(type, (expected.get(type) ?? 0) + 1);
  const scalar = (v) => v instanceof Date ? v.toISOString() : v == null ? null : String(v);
  const dateScalar = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10);
  for (const row of rowResult.rows) {
    if (row.validation_state !== "valid" || !row.applied_at) continue;
    const normalized = normalizeRow(row.source, row.row_number);
    const lineages = (await client.query("SELECT entity_type,entity_id,created_by_import FROM sheets_import_lineage WHERE batch_id=$1 AND row_number=$2", [batchId, row.row_number])).rows;
    const byType = (type) => lineages.find((x) => x.entity_type === type);
    const requestLineage = byType("request");
    if (!requestLineage) { mismatches.push({ row_number: row.row_number, entity_type: "request", reason: "missing_lineage" }); continue; }
    addExpected("request"); addExpected("contact:donor"); addExpected("party:donor"); addExpected("item"); addExpected("location_reference");
    if (normalized.receiver) { addExpected("contact:receiver"); addExpected("party:receiver"); }
    if (normalized.mediaReference) addExpected("media_reference");
    const request = (await client.query("SELECT number,status,origin,run_date,earliest_run_date,preferred_time,represents_both_parties,closed_at,human_reason,created_at,updated_at FROM requests WHERE id=$1", [requestLineage.entity_id])).rows[0];
    const expectedRequest = { number: normalized.requestNumber, status: normalized.status, origin: normalized.origin, run_date: normalized.runDate, earliest_run_date: normalized.requestedDate, preferred_time: normalized.preferredTime, represents_both_parties: normalized.representsBoth ?? false, closed_at: normalized.closedAt, human_reason: normalized.humanReason, created_at: normalized.createdAt, updated_at: normalized.updatedAt };
    if (!request) mismatches.push({ row_number: row.row_number, entity_type: "request", reason: "missing_business_row" });
    else for (const [field, value] of Object.entries(expectedRequest)) {
      const compare = field === "run_date" || field === "earliest_run_date" ? dateScalar : scalar;
      if (compare(request[field]) !== compare(value)) mismatches.push({ row_number: row.row_number, entity_type: "request", field, expected: compare(value), actual: compare(request[field]) });
    }
    const donorContact = byType("contact:donor");
    const donorParty = byType("party:donor");
    const receiverContact = normalized.receiver ? byType("contact:receiver") : null;
    const receiverParty = normalized.receiver ? byType("party:receiver") : null;
    for (const [role, person, contactLineage, partyLineage] of [["donor", normalized.donor, donorContact, donorParty], ["receiver", normalized.receiver, receiverContact, receiverParty]]) {
      if (!person) continue;
      if (!contactLineage || !partyLineage) { mismatches.push({ row_number: row.row_number, entity_type: `party:${role}`, reason: "missing_lineage" }); continue; }
      const contactRow = (await client.query("SELECT phone FROM contacts WHERE id=$1", [contactLineage.entity_id])).rows[0];
      if (!contactRow) mismatches.push({ row_number: row.row_number, entity_type: `contact:${role}`, reason: "missing_business_row" });
      else if (String(contactRow.phone) !== String(person.phone)) mismatches.push({ row_number: row.row_number, entity_type: `contact:${role}`, field: "phone", expected: person.phone, actual: contactRow.phone });
      const party = (await client.query("SELECT contact_id,name,settlement,address,floor,approved_at,approved_by,schedule_approved FROM request_parties WHERE request_id=$1 AND role=$2", [requestLineage.entity_id, role])).rows[0];
      const approvedAt = person.approved ? (normalized.updatedAt ?? normalized.createdAt) : null;
      const expectedParty = { contact_id: contactLineage.entity_id, name: person.name, settlement: person.settlement, address: person.address, floor: person.floor, approved_at: approvedAt, approved_by: person.approved ? contactLineage.entity_id : null, schedule_approved: false };
      if (!party) mismatches.push({ row_number: row.row_number, entity_type: `party:${role}`, reason: "missing_business_row" });
      else for (const [field, value] of Object.entries(expectedParty)) if (scalar(party[field]) !== scalar(value)) mismatches.push({ row_number: row.row_number, entity_type: `party:${role}`, field, expected: scalar(value), actual: scalar(party[field]) });
    }
    const item = (await client.query("SELECT kind,description,quantity,needs_disassembly FROM request_items WHERE request_id=$1 AND position=0", [requestLineage.entity_id])).rows[0];
    for (const [field, value] of Object.entries({ kind: normalized.item.kind, description: normalized.item.description, quantity: normalized.item.quantity, needs_disassembly: normalized.item.needsDisassembly })) if (!item || scalar(item[field]) !== scalar(value)) mismatches.push({ row_number: row.row_number, entity_type: "item", field, expected: scalar(value), actual: scalar(item?.[field]) });
    if (normalized.mediaReference) {
      const media = (await client.query("SELECT data->>'media_reference' AS reference FROM request_events WHERE request_id=$1 AND event_type='legacy_sheet_imported'", [requestLineage.entity_id])).rows[0];
      if (!media || media.reference !== normalized.mediaReference) mismatches.push({ row_number: row.row_number, entity_type: "media_reference", reason: "missing_or_different_reference", expected: normalized.mediaReference, actual: media?.reference ?? null });
    }
    const expectedLocations = [normalized.donor.settlement, normalized.receiver?.settlement].filter(Boolean);
    const locationLineage = byType("location_reference");
    if (expectedLocations.length > 0) {
      if (!locationLineage) mismatches.push({ row_number: row.row_number, entity_type: "location_reference", reason: "missing_lineage" });
      for (const settlement of expectedLocations)
        if (!(await client.query("SELECT 1 FROM service_locations WHERE name=$1 AND decision='allowed'", [settlement])).rowCount)
          mismatches.push({ row_number: row.row_number, entity_type: "location_reference", reason: "missing_or_invalid_location", expected: settlement });
    } else if (locationLineage) mismatches.push({ row_number: row.row_number, entity_type: "location_reference", reason: "unexpected_location_lineage" });
  }
  const actualResult = await client.query("SELECT entity_type, count(*)::int AS count FROM sheets_import_lineage WHERE batch_id=$1 GROUP BY entity_type ORDER BY entity_type", [batchId]);
  const actual = Object.fromEntries(actualResult.rows.map((x) => [x.entity_type, x.count]));
  const expectedObject = Object.fromEntries([...expected.entries()].sort());
  const keys = [...new Set([...Object.keys(expectedObject), ...Object.keys(actual)])].sort();
  for (const key of keys) if ((expectedObject[key] ?? 0) !== (actual[key] ?? 0)) mismatches.push({ entity_type: key, expected: expectedObject[key] ?? 0, actual: actual[key] ?? 0, reason: "lineage_count_mismatch" });
  const lineageSummary = { created_contacts: 0, linked_contacts: 0, parties: 0, requests: 0, items: 0, media_references: 0, locations: 0 };
  for (const row of actualResult.rows) {
    if (row.entity_type === "request") lineageSummary.requests += row.count;
    if (row.entity_type.startsWith("party:")) lineageSummary.parties += row.count;
    if (row.entity_type === "item") lineageSummary.items += row.count;
    if (row.entity_type === "media_reference") lineageSummary.media_references += row.count;
    if (row.entity_type === "location_reference") lineageSummary.locations += row.count;
  }
  const contacts = await client.query("SELECT entity_type,created_by_import,count(*)::int AS count FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type LIKE 'contact:%' GROUP BY entity_type,created_by_import", [batchId]);
  for (const row of contacts.rows) lineageSummary[row.created_by_import ? "created_contacts" : "linked_contacts"] += row.count;
  const appliedRows = rowResult.rows.filter((x) => x.applied_at).length;
  const validRows = rowResult.rows.filter((x) => x.validation_state === "valid").length;
  return { expected_by_entity: expectedObject, lineage_by_entity: actual, lineage_summary: lineageSummary, applied_rows: appliedRows, valid_rows: validRows, skipped_rows: rowResult.rows.length - appliedRows, mismatches, exact_reconciliation_pass: mismatches.length === 0 && appliedRows === validRows };
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
    const locked = await client.query("SELECT state FROM sheets_import_batches WHERE id=$1 FOR UPDATE", [batchId]);
    if (!locked.rowCount) throw new Error("batch_not_found");
    if (locked.rows[0].state === "applied") { await client.query("COMMIT"); return; }
    if (!["validated", "review_required", "apply_ready"].includes(locked.rows[0].state)) throw new Error(`invalid_batch_state:${locked.rows[0].state}`);
    const ready = await client.query("UPDATE sheets_import_batches SET state='apply_ready' WHERE id=$1 AND state IN ('validated','review_required','apply_ready')", [batchId]);
    if (ready.rowCount !== 1) throw new Error("batch_not_apply_ready");
    for (const row of validation.validRows) if (row.runDate) {
      const run = await client.query("SELECT date FROM transport_runs WHERE date=$1", [row.runDate]);
      if (!run.rowCount) throw new Error(`${row.status === "coordinated" ? "coordinated_requires_existing_transport_run" : "missing_transport_run"}:${row.rowNumber}:${row.runDate}`);
    }
    for (const row of validation.validRows) {
      const existingLineage = await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND row_number=$2 AND entity_type='request'", [batchId, row.rowNumber]);
      if (existingLineage.rowCount) continue;
      const conflict = await client.query("SELECT id FROM requests WHERE number=$1", [row.requestNumber]);
      if (conflict.rowCount) throw new Error(`conflicting_existing_request_number:${row.rowNumber}:${row.requestNumber}`);
      const donorSettlement = await location(client, row.donor.settlement, row.rowNumber, "עיר איסוף");
      const receiverSettlement = row.receiver ? await location(client, row.receiver.settlement, row.rowNumber, "עיר יעד") : null;
      if (row.status === "coordinated") {
        const run = await client.query("SELECT date FROM transport_runs WHERE date=$1 FOR UPDATE", [row.runDate]);
        if (!run.rowCount) throw new Error(`coordinated_requires_existing_transport_run:${row.rowNumber}:${row.runDate}`);
      }
      const donor = await contact(client, row.donor.phone);
      const receiver = row.receiver ? await contact(client, row.receiver.phone) : null;
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO requests(id,number,status,origin,run_date,earliest_run_date,preferred_time,represents_both_parties,closed_at,human_reason,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [requestId, row.requestNumber, row.status, row.origin, row.runDate, row.requestedDate, row.preferredTime, row.representsBoth ?? false, row.closedAt, row.humanReason, row.createdAt, row.updatedAt],
      );
      const approvedAt = (approved, date) => approved ? (date ?? null) : null;
      await client.query(
        `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,approved_at,approved_by,schedule_approved,schedule_approved_date,schedule_approved_at)
         VALUES($1,'donor',$2,$3,$4,$5,$6,$7,$8,false,NULL,NULL)`,
        [requestId, donor.id, row.donor.name, donorSettlement, row.donor.address, row.donor.floor, approvedAt(row.donor.approved, row.updatedAt ?? row.createdAt), row.donor.approved ? donor.id : null],
      );
      if (receiver)
        await client.query(
          `INSERT INTO request_parties(request_id,role,contact_id,name,settlement,address,floor,approved_at,approved_by,schedule_approved,schedule_approved_date,schedule_approved_at)
           VALUES($1,'receiver',$2,$3,$4,$5,$6,$7,$8,false,NULL,NULL)`,
          [requestId, receiver.id, row.receiver.name, receiverSettlement, row.receiver.address, row.receiver.floor, approvedAt(row.receiver.approved, row.updatedAt ?? row.createdAt), row.receiver.approved ? receiver.id : null],
        );
      await client.query(
        `INSERT INTO request_items(request_id,position,kind,description,quantity,needs_disassembly) VALUES($1,0,$2,$3,$4,$5)`,
        [requestId, row.item.kind, row.item.description, row.item.quantity, row.item.needsDisassembly],
      );
      const event = await client.query("INSERT INTO request_events(request_id,trace_id,actor,event_type,data) VALUES($1,$2,'legacy_import','legacy_sheet_imported',$3) RETURNING id", [requestId, randomUUID(), json({ batch_id: batchId, source_row_number: row.rowNumber, source_row_hash: row.rowHash, media_reference: row.mediaReference, source: row.source })]);
      const lineages = [
        ["request", requestId, true], ["contact:donor", donor.id, donor.created], ["party:donor", `${requestId}:donor`, true], ["item", requestId, true],
      ];
      if (receiver) lineages.push(["contact:receiver", receiver.id, receiver.created], ["party:receiver", `${requestId}:receiver`, true]);
      if (row.mediaReference) lineages.push(["media_reference", `${requestId}:${row.mediaReference}`, true]);
      if (row.donor.settlement || row.receiver?.settlement) lineages.push(["location_reference", requestId, false]);
      for (const [entityType, entityId, created] of lineages)
        await client.query("INSERT INTO sheets_import_lineage(batch_id,row_number,row_hash,entity_type,entity_id,created_by_import) VALUES($1,$2,$3,$4,$5,$6)", [batchId, row.rowNumber, row.rowHash, entityType, entityId, created]);
      await client.query("UPDATE sheets_import_rows SET applied_at=clock_timestamp() WHERE batch_id=$1 AND row_number=$2", [batchId, row.rowNumber]);
      void event;
    }
    await client.query("UPDATE request_counter SET value=GREATEST(value,(SELECT COALESCE(MAX(number),0) FROM requests)) WHERE id=true");
    await client.query("UPDATE sheets_import_batches SET state='applied',mode='apply',applied_from_dry_run=(initial_mode='dry_run'),applied_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1", [batchId]);
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
    for (const row of (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type LIKE 'contact:%' AND created_by_import=true", [batchId])).rows)
      await client.query("DELETE FROM contacts c WHERE c.id=$1 AND NOT EXISTS (SELECT 1 FROM request_parties p WHERE p.contact_id=c.id) AND NOT EXISTS (SELECT 1 FROM searches s WHERE s.contact_id=c.id)", [row.entity_id]);
    await client.query("DELETE FROM sheets_import_lineage WHERE batch_id=$1", [batchId]);
    await client.query("UPDATE sheets_import_batches SET state='rolled_back',rolled_back_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1", [batchId]);
    await client.query("COMMIT");
    return { batch_id: batchId, state: "rolled_back", requests_removed: requests.length };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}

async function reconcileOnly(client, batchId) {
  const batch = await client.query("SELECT state FROM sheets_import_batches WHERE id=$1", [batchId]);
  if (!batch.rowCount) throw new Error("batch_not_found");
  const result = await reconciliation(client, batchId);
  console.log(JSON.stringify({ batch_id: batchId, state: batch.rows[0].state, ...result }, null, 2));
  if (!result.exact_reconciliation_pass) process.exitCode = 1;
}

if (rollbackId) {
  const client = await connect();
  try { console.log(JSON.stringify(await rollback(client, rollbackId), null, 2)); } finally { await client.end(); }
} else if (reconcileId) {
  const client = await connect();
  try { await reconcileOnly(client, reconcileId); } finally { await client.end(); }
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
      const reconciliationResult = await reconciliation(client, batchId);
      if (mode === "apply" && !reconciliationResult.exact_reconciliation_pass) {
        await client.query("UPDATE sheets_import_batches SET state='review_required',rollback_error=$2,completed_at=clock_timestamp() WHERE id=$1", [batchId, "post_apply_reconciliation_failed"]);
        process.exitCode = 1;
      }
      const state = (await client.query("SELECT state FROM sheets_import_batches WHERE id=$1", [batchId])).rows[0]?.state;
      console.log(JSON.stringify({ mode, batch_id: batchId, ...report, ...reconciliationResult, state, ready_for_import: validation.blocking.length === 0 }, null, 2));
    } finally { await client.end(); }
  }
}
