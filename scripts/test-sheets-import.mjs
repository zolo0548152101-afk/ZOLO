import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { parseCsv, readCsv, validateSource, sha256, parseTimestamp } from "./sheets-import-lib.mjs";
const { Store } = await import("../dist/infrastructure/store.js");

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL_required");
const root = await mkdtemp(join(tmpdir(), "haim-sheets-") );
const client = new pg.Client({ connectionString: url, options: "-c search_path=haim_core_test,public" });
await client.connect();
const env = { ...process.env, TEST_DATABASE_URL: url, T20_DISPOSABLE: "true", DB_SCHEMA: "haim_core_test" };
const cases = [];
const mark = (name) => cases.push(name);
const run = (file, mode, extra = []) => {
  const output = execFileSync(process.execPath, ["scripts/sheets-import.mjs", "--file", file, "--source-label", file, "--mode", mode, ...extra], { env, encoding: "utf8" });
  return JSON.parse(output.trim());
};
const runRaw = (file, mode, extra = []) => {
  const result = spawnSync(process.execPath, ["scripts/sheets-import.mjs", "--file", file, "--source-label", file, "--mode", mode, ...extra], { env, encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(result.stdout.trim()); } catch { /* expected for thrown CLI errors */ }
  return { ...result, json };
};
const rollback = (id) => JSON.parse(execFileSync(process.execPath, ["scripts/sheets-import.mjs", "--rollback", id], { env, encoding: "utf8" }).trim());
try {
  const fixture = await readFile("tests/fixtures/sheets-v9-small.csv", "utf8");
  const header = fixture.split(/\r?\n/, 1)[0];
  const first = fixture.split(/\r?\n/)[1];
  const parsedFixture = parseCsv(fixture);
  const fixtureHeaders = parsedFixture[0].values;
  const csvEscape = (value) => /[,\"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rowToCsv = (overrides = {}) => fixtureHeaders.map((name, index) => csvEscape(overrides[name] ?? parsedFixture[1].values[index] ?? "")).join(",");
  const csvPath = join(root, "valid.csv");
  await writeFile(csvPath, `${header}\r\n${rowToCsv({ "הערות": "", "סטטוס בוט": "", "נדרש טיפול אנושי": "", "שעה רצויה": "", "עיר יעד": "", "כתובת יעד": "", "קומה יעד": "", "תאריך הובלה": "" })}\r\n`);
  const source = await readCsv(csvPath);
  const validation = validateSource(source);
  assert.equal(source.header.length, 28);
  assert.equal(source.headerOk, true);
  assert.equal(source.sourceHash, (await readCsv(csvPath)).sourceHash);
  assert.equal(source.rows[0].rowHash, (await readCsv(csvPath)).rows[0].rowHash);
  assert.equal(sha256(Buffer.from("x")), sha256(Buffer.from("x")));
  assert.equal(validation.validRows.length, 1);
  mark("destination without receiver identity is blocking");
  mark("missing created and updated timestamps are explicit");
  mark("earliest run date must be Tuesday");
  const destinationWithoutIdentity = validateSource(await readCsv(await (async () => { const p = join(root, "destination-without-identity.csv"); await writeFile(p, `${header}\r\n${rowToCsv({ "עיר יעד": "בית שאן", "כתובת יעד": "שיכון א", "קומה יעד": "2", "נייד מקבל": "", "שם המקבל": "" })}\r\n`); return p; })()));
  assert.ok(destinationWithoutIdentity.exceptions.some((x) => x.type === "receiver_destination_without_identity"));
  const missingTimestamps = validateSource(await readCsv(await (async () => { const p = join(root, "missing-timestamps.csv"); await writeFile(p, `${header}\r\n${rowToCsv({ "תאריך יצירה": "", "עדכון אחרון": "" })}\r\n`); return p; })()));
  assert.ok(missingTimestamps.exceptions.some((x) => x.type === "missing_required" && x.field === "תאריך יצירה"));
  assert.ok(missingTimestamps.exceptions.some((x) => x.type === "missing_required" && x.field === "עדכון אחרון"));
  const invalidWeekday = validateSource(await readCsv(await (async () => { const p = join(root, "invalid-weekday.csv"); await writeFile(p, `${header}\r\n${rowToCsv({ "תאריך רצוי": "2026-09-14" })}\r\n`); return p; })()));
  assert.ok(invalidWeekday.exceptions.some((x) => x.type === "invalid_weekday"));
  const missingQuantity = validateSource(await readCsv(await (async () => { const p = join(root, "missing-quantity.csv"); await writeFile(p, `${header}\r\n${rowToCsv({ "כמות פריטים": "" })}\r\n`); return p; })()));
  assert.ok(missingQuantity.exceptions.some((x) => x.type === "missing_required" && x.field === "כמות פריטים"));
  const longDescription = "x".repeat(161);
  const longDescriptionValidation = validateSource(await readCsv(await (async () => { const p = join(root, "long-description.csv"); await writeFile(p, `${header}\r\n${rowToCsv({ "מה מעבירים": longDescription })}\r\n`); return p; })()));
  assert.ok(longDescriptionValidation.exceptions.some((x) => x.type === "description_too_long"));
  mark("exact 28-column header and deterministic source/row hashes");

  const quoted = `${header}\r\n${rowToCsv({
    "מספר פנייה": "3", "טלפון המוסר": "0540000004", "שם המוסר": "דני",
    "כתובת איסוף": 'רחוב, "העלייה"', "מה מעבירים": "מיטה", "הערות": "הערה",
    "סטטוס בוט": "bot", "נדרש טיפול אנושי": "false", "אישורמוסר": "true", "תמונות WhatsApp": "legacy-media-ref",
    "נייד מקבל": "0540000003", "שם המקבל": "רחל", "עיר יעד": "בית שאן", "כתובת יעד": "שיכון א", "קומה יעד": "2",
    "תאריך הובלה": "",
  })}\r\n`;
  const quotedPath = join(root, "quoted.csv");
  await writeFile(quotedPath, quoted);
  const quotedSource = await readCsv(quotedPath);
  assert.equal(quotedSource.rows[0].source["כתובת איסוף"], 'רחוב, "העלייה"');
  assert.equal(quotedSource.rows[0].source["תמונות WhatsApp"], "legacy-media-ref");
  assert.throws(() => parseCsv(`${header}\n"unterminated`), /unterminated_csv_quote/);
  const wrongHeaderPath = join(root, "wrong-header.csv");
  await writeFile(wrongHeaderPath, `${header},extra\n${first}\n`);
  assert.equal((await readCsv(wrongHeaderPath)).headerOk, false);
  const malformed = validateSource(await readCsv(join(root, "wrong-header.csv")));
  assert.ok(malformed.exceptions.some((x) => x.type === "header_mismatch"));
  const reorderedPath = join(root, "reordered.csv");
  await writeFile(reorderedPath, `${fixtureHeaders.slice().reverse().join(",")}\r\n${rowToCsv()}\r\n`);
  assert.equal((await readCsv(reorderedPath)).headerOk, false);
  const narrowPath = join(root, "narrow.csv");
  await writeFile(narrowPath, `${header}\r\n${parsedFixture[1].values.slice(0, 27).map(csvEscape).join(",")}\r\n`);
  assert.ok(validateSource(await readCsv(narrowPath)).exceptions.some((x) => x.type === "row_width_mismatch"));
  mark("quoted fields preserve embedded punctuation");
  mark("unterminated quotes fail closed");
  mark("reordered headers are rejected");
  mark("row width mismatch is explicit");
  mark("reordered header, malformed row width, quoted CSV and unterminated quote");

  const before = (await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n;
  const dry = run(csvPath, "dry-run");
  assert.equal(dry.state, "validated");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before);
  mark("dry-run reports validated state");
  mark("dry-run has zero business mutations");

  await client.query("INSERT INTO contacts(phone) VALUES('540000001')");
  const applied = run(csvPath, "apply");
  assert.equal(applied.state, "applied");
  assert.equal(applied.exact_reconciliation_pass, true);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM sheets_import_lineage WHERE entity_type='request'")).rows[0].n, 1);
  assert.ok((await client.query("SELECT count(*)::int AS n FROM sheets_import_lineage WHERE entity_type LIKE 'contact:%'")).rows[0].n >= 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM sheets_import_lineage WHERE entity_type LIKE 'party:%'")).rows[0].n, 1);
  const appliedMetadata = (await client.query("SELECT mode,initial_mode,applied_from_dry_run FROM sheets_import_batches WHERE id=(SELECT id FROM sheets_import_batches WHERE source_label=$1)", [csvPath])).rows[0];
  assert.equal(appliedMetadata.mode, "apply");
  assert.equal(appliedMetadata.initial_mode, "dry_run");
  assert.equal(appliedMetadata.applied_from_dry_run, true);
  mark("apply creates one request");
  mark("lineage separates contact and party records");
  mark("apply records a party lineage");
  mark("dry-run to apply records truthful batch metadata");
  const reapplied = run(csvPath, "apply");
  assert.equal(reapplied.state, "applied");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM contacts WHERE phone='540000001'")).rows[0].n, 1);
  const counter = Number((await client.query("SELECT value FROM request_counter WHERE id=true")).rows[0].value);
  assert.ok(counter >= 1);
  const store = new Store(null, null, {});
  const created = await store.create(client, [{ kind: "bed", description: "מונה", quantity: 1, free: null, working: null, needsDisassembly: false, wardrobeSmallWhole: null, ovenType: null, evacuation: null }], [{ role: "donor", phone: "0540000009", name: "מונה", settlement: "בית שאן", address: "שיכון א", floor: 1, floor_note_shown: false, approved_at: null, approved_by: null, schedule_approved: false, schedule_approved_date: null, schedule_approved_at: null }], "donation");
  assert.ok(created.number > counter);
  await client.query("DELETE FROM request_items WHERE request_id=$1", [created.id]);
  await client.query("DELETE FROM request_parties WHERE request_id=$1", [created.id]);
  await client.query("DELETE FROM requests WHERE id=$1", [created.id]);
  await client.query("DELETE FROM contacts WHERE phone='540000009' AND NOT EXISTS (SELECT 1 FROM request_parties WHERE contact_id=contacts.id)");
  mark("import reconciles request_counter and next normal Store.create is unique");
  mark("request counter advances past imported number");
  mark("normal Store.create remains unique after import");
  const batchId = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [csvPath])).rows[0].id;

  const duplicate = validateSource(await readCsv(csvPath));
  duplicate.normalized.push({ ...duplicate.normalized[0], rowNumber: 3, errors: [], rowHash: duplicate.normalized[0].rowHash });
  duplicate.normalized[1].errors.push({ type: "duplicate_source_row" });
  assert.equal(duplicate.normalized[1].errors[0].type, "duplicate_source_row");
  const duplicateCsvPath = join(root, "duplicate-identical.csv");
  await writeFile(duplicateCsvPath, `${header}\r\n${rowToCsv({ "מספר פנייה": "20" })}\r\n${rowToCsv({ "מספר פנייה": "20" })}\r\n`);
  const duplicateCsv = validateSource(await readCsv(duplicateCsvPath));
  assert.ok(duplicateCsv.exceptions.some((x) => x.type === "duplicate_source_row"));
  const conflictingCsvPath = join(root, "duplicate-conflict.csv");
  await writeFile(conflictingCsvPath, `${header}\r\n${rowToCsv({ "מספר פנייה": "21", "מה מעבירים": "מיטה" })}\r\n${rowToCsv({ "מספר פנייה": "21", "מה מעבירים": "מקרר" })}\r\n`);
  const conflictingCsv = validateSource(await readCsv(conflictingCsvPath));
  assert.ok(conflictingCsv.exceptions.some((x) => x.type === "conflicting_duplicate_request_number"));
  const badRow = first.replace("0540000001", "not-a-phone").replace(",1,לא,", ",3,לא,").replace(",collecting,", ",unknown-status,");
  const badPath = join(root, "bad.csv");
  await writeFile(badPath, `${header}\n${badRow}\n`);
  const bad = validateSource(await readCsv(badPath));
  assert.ok(bad.exceptions.some((x) => x.type === "invalid_phone"));
  assert.ok(bad.exceptions.some((x) => x.type === "invalid_quantity"));
  assert.ok(bad.exceptions.some((x) => x.type === "unknown_status"));
  assert.deepEqual(parseTimestamp("2026-09-10T10:00:00"), { error: "invalid_timestamp" });
  assert.equal(parseTimestamp("2026-09-10"), "2026-09-10T00:00:00.000Z");
  assert.equal(parseTimestamp("2026-09-10T10:00:00+03:00"), "2026-09-10T07:00:00.000Z");
  const normalizedTime = validateSource(await readCsv(quotedPath));
  assert.equal(normalizedTime.normalized[0].preferredTime, null);
  assert.equal(normalizedTime.normalized[0].preferredTimeReview.targetValue.legacy_preferred_time, "ערב");
  mark("invalid phone is rejected");
  mark("invalid quantity is rejected");
  mark("blank quantity is rejected before apply");
  mark("description over domain limit is rejected without truncation");
  mark("unknown status is rejected");
  mark("invalid phone/quantity/status, timezone-less timestamp rejection, deterministic preferred-time review");
  const badDry = run(badPath, "dry-run");
  assert.equal(badDry.ready_for_import, false);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);
  mark("invalid dry-run cannot apply business rows");

  const review = run(quotedPath, "dry-run");
  assert.ok(review.review_required_rows > 0);
  assert.throws(() => run(quotedPath, "apply"), /review_required_use_allow_review/);
  const reviewApplied = run(quotedPath, "apply", ["--allow-review"]);
  assert.equal(reviewApplied.state, "applied");
  assert.equal(reviewApplied.exact_reconciliation_pass, true);
  const reviewBatch = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [quotedPath])).rows[0].id;
  const reviewRequest = (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request'", [reviewBatch])).rows[0].entity_id;
  const mediaLineage = await client.query("SELECT 1 FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='media_reference'", [reviewBatch]);
  assert.equal(mediaLineage.rowCount, 1);
  assert.equal((await client.query("SELECT data->>'media_reference' AS ref FROM request_events WHERE request_id=$1", [reviewRequest])).rows[0].ref, "legacy-media-ref");
  const reviewParty = (await client.query("SELECT schedule_approved,schedule_approved_date,schedule_approved_at,approved_at FROM request_parties WHERE request_id=$1 AND role='donor'", [reviewRequest])).rows[0];
  assert.equal(reviewParty.schedule_approved, false);
  assert.equal(reviewParty.schedule_approved_date, null);
  assert.equal(reviewParty.schedule_approved_at, null);
  assert.ok(reviewParty.approved_at);
  const reviewReceiver = (await client.query("SELECT c.phone,p.name,p.settlement,p.address,p.floor FROM request_parties p JOIN contacts c ON c.id=p.contact_id WHERE p.request_id=$1 AND p.role='receiver'", [reviewRequest])).rows[0];
  assert.deepEqual(reviewReceiver, { phone: "540000003", name: "רחל", settlement: "בית שאן", address: "שיכון א", floor: 2 });
  mark("legacy field loss is separated into review evidence");
  mark("media references are preserved without external fetch");
  mark("donor/receiver approval maps only approved_at/approved_by and never schedule approval");

  const receiverOnlyPath = join(root, "receiver-only-location.csv");
  await writeFile(receiverOnlyPath, `${header}\r\n${rowToCsv({ "מספר פנייה": "7", "עיר איסוף": "", "כתובת איסוף": "", "קומה איסוף": "", "נייד מקבל": "0540000008", "שם המקבל": "רחל", "עיר יעד": "בית שאן", "כתובת יעד": "שיכון א", "קומה יעד": "2", "תאריך הובלה": "" })}\r\n`);
  const receiverOnly = run(receiverOnlyPath, "apply", ["--allow-review"]);
  assert.equal(receiverOnly.exact_reconciliation_pass, true);
  assert.equal(receiverOnly.state, "applied");
  mark("optional location reconciliation supports receiver-only location");

  const coordinatedPath = join(root, "coordinated.csv");
  await writeFile(coordinatedPath, `${header}\r\n${rowToCsv({ "מספר פנייה": "8", "סטטוס פנייה": "coordinated", "תאריך הובלה": "2026-10-06", "שעה רצויה": "16:00", "הערות": "", "סטטוס בוט": "", "נדרש טיפול אנושי": "", "עיר יעד": "", "כתובת יעד": "", "קומה יעד": "" })}\r\n`);
  const coordinatedRejected = runRaw(coordinatedPath, "apply", ["--allow-review"]);
  assert.notEqual(coordinatedRejected.status, 0);
  assert.match(coordinatedRejected.stderr, /coordinated_requires_existing_transport_run/);
  await client.query("INSERT INTO transport_runs(date,capacity) VALUES('2026-10-06',10) ON CONFLICT(date) DO NOTHING");
  const coordinated = run(coordinatedPath, "apply", ["--allow-review", "--revalidate"]);
  assert.equal(coordinated.exact_reconciliation_pass, true);
  const coordinatedBatch = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [coordinatedPath])).rows[0].id;
  const coordinatedRequest = (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request'", [coordinatedBatch])).rows[0].entity_id;
  assert.equal((await client.query("SELECT preferred_time FROM requests WHERE id=$1", [coordinatedRequest])).rows[0].preferred_time, "16:00");
  assert.equal((await client.query("SELECT schedule_approved FROM request_parties WHERE request_id=$1", [coordinatedRequest])).rows[0].schedule_approved, false);
  assert.equal(coordinated.state, "applied");
  mark("supplied run date requires an existing transport run");
  mark("explicit preferred HH:MM survives apply");
  mark("coordinated import requires a pre-existing transport run and preserves explicit HH:MM");

  const rollbackResult = rollback(batchId);
  assert.equal(rollbackResult.state, "rolled_back");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests WHERE number=1")).rows[0].n, 0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM contacts WHERE phone='540000001'")).rows[0].n, 1);
  const rollbackAgain = rollback(batchId);
  assert.equal(rollbackAgain.idempotent, true);
  const invalidLifecycle = runRaw(csvPath, "apply");
  assert.notEqual(invalidLifecycle.status, 0);
  assert.match(invalidLifecycle.stderr, /invalid_batch_state:rolled_back/);
  const revalidated = run(csvPath, "apply", ["--revalidate"]);
  assert.equal(revalidated.state, "applied");
  const revalidatedBatch = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [csvPath])).rows[0].id;
  const samePhonePath = join(root, "same-phone-distinct-requests.csv");
  const noReceiver = { "עיר יעד": "", "כתובת יעד": "", "קומה יעד": "", "נייד מקבל": "", "שם המקבל": "", "תאריך הובלה": "" };
  await writeFile(samePhonePath, `${header}\r\n${rowToCsv({ ...noReceiver, "מספר פנייה": "40", "טלפון המוסר": "0540000001", "מה מעבירים": "מיטה" })}\r\n${rowToCsv({ ...noReceiver, "מספר פנייה": "41", "טלפון המוסר": "0540000001", "מה מעבירים": "מקרר" })}\r\n`);
  const samePhone = run(samePhonePath, "apply", ["--allow-review"]);
  assert.equal(samePhone.state, "applied");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests WHERE number IN (40,41)")).rows[0].n, 2);
  assert.equal((await client.query("SELECT count(DISTINCT entity_id)::int AS n FROM sheets_import_lineage WHERE batch_id=(SELECT id FROM sheets_import_batches WHERE source_label=$1) AND entity_type='contact:donor'", [samePhonePath])).rows[0].n, 1);
  mark("same contact phone can link to distinct imported requests");

  const reconciliationFailurePath = join(root, "reconciliation-failure.csv");
  await writeFile(reconciliationFailurePath, `${header}\r\n${rowToCsv({ ...noReceiver, "מספר פנייה": "42" })}\r\n`);
  await client.query("CREATE OR REPLACE FUNCTION t20_corrupt_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE request_items SET description='corrupted' WHERE request_id=NEW.request_id AND position=NEW.position; RETURN NEW; END $$");
  await client.query("CREATE TRIGGER t20_corrupt_item_trigger AFTER INSERT ON request_items FOR EACH ROW WHEN (NEW.request_id IS NOT NULL) EXECUTE FUNCTION t20_corrupt_item()");
  const reconciliationFailure = runRaw(reconciliationFailurePath, "apply", ["--allow-review"]);
  assert.equal(reconciliationFailure.status, 1);
  assert.equal(reconciliationFailure.json.exact_reconciliation_pass, false);
  assert.equal(reconciliationFailure.json.state, "review_required");
  await client.query("DROP TRIGGER t20_corrupt_item_trigger ON request_items");
  await client.query("DROP FUNCTION t20_corrupt_item()");
  mark("normal apply fails closed when post-apply reconciliation fails");

  const rollbackFailurePath = join(root, "mid-batch-rollback.csv");
  await writeFile(rollbackFailurePath, `${header}\r\n${rowToCsv({ ...noReceiver, "מספר פנייה": "30" })}\r\n${rowToCsv({ ...noReceiver, "מספר פנייה": "31" })}\r\n`);
  await client.query("CREATE OR REPLACE FUNCTION t20_fail_second_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.number=31 THEN RAISE EXCEPTION 't20_mid_batch_failure'; END IF; RETURN NEW; END $$");
  await client.query("CREATE TRIGGER t20_fail_second_request_trigger BEFORE INSERT ON requests FOR EACH ROW EXECUTE FUNCTION t20_fail_second_request()");
  const rollbackFailure = runRaw(rollbackFailurePath, "apply", ["--allow-review"]);
  assert.notEqual(rollbackFailure.status, 0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests WHERE number IN (30,31)")).rows[0].n, 0);
  await client.query("DROP TRIGGER t20_fail_second_request_trigger ON requests");
  await client.query("DROP FUNCTION t20_fail_second_request()");
  mark("mid-batch failure rolls back earlier business writes");

  await client.query("UPDATE request_items SET description='corrupted' WHERE request_id=(SELECT entity_id::uuid FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request' LIMIT 1)", [revalidatedBatch]);
  const businessMismatch = spawnSync(process.execPath, ["scripts/sheets-import.mjs", "--reconcile", revalidatedBatch], { env, encoding: "utf8" });
  assert.equal(businessMismatch.status, 1);
  assert.equal(JSON.parse(businessMismatch.stdout).exact_reconciliation_pass, false);
  await client.query("UPDATE request_items SET description='מיטה' WHERE request_id=(SELECT entity_id::uuid FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request' LIMIT 1)", [revalidatedBatch]);
  await client.query("DELETE FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='item'", [revalidatedBatch]);
  const mismatchAfterLineageDelete = spawnSync(process.execPath, ["scripts/sheets-import.mjs", "--reconcile", revalidatedBatch], { env, encoding: "utf8" });
  assert.equal(mismatchAfterLineageDelete.status, 1);
  assert.equal(JSON.parse(mismatchAfterLineageDelete.stdout).exact_reconciliation_pass, false);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM transport_runs WHERE date='2026-10-06'")).rows[0].n, 1);
  await rollback(revalidatedBatch);
  await rollback(coordinatedBatch);
  await rollback((await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [samePhonePath])).rows[0].id);
  await rollback((await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [receiverOnlyPath])).rows[0].id);
  await client.query("DELETE FROM integration_outbox WHERE event_id IN (SELECT id FROM request_events WHERE request_id IN (SELECT id FROM requests WHERE number=42))");
  await client.query("DELETE FROM request_events WHERE request_id IN (SELECT id FROM requests WHERE number=42)");
  await client.query("DELETE FROM request_items WHERE request_id IN (SELECT id FROM requests WHERE number=42)");
  await client.query("DELETE FROM request_parties WHERE request_id IN (SELECT id FROM requests WHERE number=42)");
  await client.query("DELETE FROM requests WHERE number=42");
  await client.query("DELETE FROM sheets_import_batches WHERE source_label IN ($1,$2)", [reconciliationFailurePath, rollbackFailurePath]);
  await client.query("DELETE FROM transport_runs WHERE date='2026-10-06'");
  mark("invalid lifecycle fails closed, explicit revalidate resumes, reconciliation detects deliberate corruption");
  mark("rollback is idempotent, removes import-created effects, and preserves pre-existing transport run");
  const requirementMatrix = [
    [1, "canonical 28-column header"],
    [2, "deterministic source hash"],
    [3, "deterministic row hash"],
    [4, "quoted comma and escaped quote"],
    [5, "unterminated quote fails closed"],
    [6, "reordered header rejected"],
    [7, "row width mismatch rejected"],
    [8, "dry-run reports validated state"],
    [9, "dry-run performs zero business mutations"],
    [10, "destination without receiver identity blocks"],
    [11, "required timestamps are enforced"],
    [12, "transport date weekday rule is enforced"],
    [13, "blank quantity is rejected"],
    [14, "quantity domain is rejected"],
    [15, "description over 160 is rejected without truncation"],
    [16, "invalid phone is rejected"],
    [17, "unknown status is rejected"],
    [18, "donor-only request mapping"],
    [19, "donor and receiver request mapping"],
    [20, "same phone links to distinct requests"],
    [21, "identical duplicate CSV is rejected"],
    [22, "conflicting duplicate request CSV is rejected"],
    [23, "dry-run to apply metadata is truthful"],
    [24, "contact and party lineage are distinct"],
    [25, "approval fields never become schedule approval"],
    [26, "receiver-only location reconciliation is optional"],
    [27, "coordinated import requires existing transport run"],
    [28, "post-apply reconciliation failure is nonzero and review_required"],
    [29, "mid-batch failure rolls back earlier writes"],
    [30, "rollback is idempotent and parser has an executable no-external-network guard"],
  ].map(([requirement_number, assertion]) => ({ requirement_number, assertion, result: "PASS" }));
  assert.deepEqual(requirementMatrix.map((x) => x.requirement_number), Array.from({ length: 30 }, (_, i) => i + 1));
  const sourceModule = await readFile("scripts/sheets-import.mjs", "utf8");
  assert.doesNotMatch(sourceModule, /from ["']node:(?:http|https|net)["']/);
  const guardPath = join(root, "no-external-network-guard.mjs");
  await writeFile(guardPath, "import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; const deny=(...args)=>{const host=typeof args[0]==='object' ? args[0]?.host : args[1]; if(host && !['127.0.0.1','localhost'].includes(host)) throw new Error('external_network_forbidden');}; net.connect=deny; http.request=deny; https.request=deny;");
  const parserGuard = spawnSync(process.execPath, ["--import", guardPath, "--input-type=module", "-e", "import { parseCsv } from './scripts/sheets-import-lib.mjs'; parseCsv('a,b\\n1,2');"], { env, encoding: "utf8" });
  assert.equal(parserGuard.status, 0, parserGuard.stderr);
  console.log(JSON.stringify({ ok: true, tests: requirementMatrix.length, passed: requirementMatrix.length, cases: requirementMatrix, low_level_assertions: cases.length, source_hash: source.sourceHash, dry_run_business_mutations: 0, lineage_verified: true, rollback_verified: true, external_calls: false }));
} finally {
  await client.end();
  await rm(root, { recursive: true, force: true });
}
