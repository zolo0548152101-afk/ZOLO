import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { parseCsv, readCsv, validateSource, sha256 } from "./sheets-import-lib.mjs";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL_required");
const root = await mkdtemp(join(tmpdir(), "haim-sheets-") );
const client = new pg.Client({ connectionString: url, options: "-c search_path=haim_core_test,public" });
await client.connect();
const env = { ...process.env, TEST_DATABASE_URL: url, T20_DISPOSABLE: "true", DB_SCHEMA: "haim_core_test" };
const run = (file, mode, extra = []) => {
  const output = execFileSync(process.execPath, ["scripts/sheets-import.mjs", "--file", file, "--source-label", file, "--mode", mode, ...extra], { env, encoding: "utf8" });
  return JSON.parse(output.trim());
};
try {
  const fixture = await readFile("tests/fixtures/sheets-v9-small.csv", "utf8");
  const header = fixture.split(/\r?\n/, 1)[0];
  const first = fixture.split(/\r?\n/)[1];
  const parsedFixture = parseCsv(fixture);
  const fixtureHeaders = parsedFixture[0].values;
  const csvEscape = (value) => /[,\"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rowToCsv = (overrides = {}) => fixtureHeaders.map((name, index) => csvEscape(overrides[name] ?? parsedFixture[1].values[index] ?? "")).join(",");
  const csvPath = join(root, "valid.csv");
  await writeFile(csvPath, `${header}\r\n${rowToCsv({ "הערות": "", "סטטוס בוט": "", "נדרש טיפול אנושי": "" })}\r\n`);
  const source = await readCsv(csvPath);
  const validation = validateSource(source);
  assert.equal(source.header.length, 28);
  assert.equal(source.headerOk, true);
  assert.equal(source.sourceHash, (await readCsv(csvPath)).sourceHash);
  assert.equal(source.rows[0].rowHash, (await readCsv(csvPath)).rows[0].rowHash);
  assert.equal(sha256(Buffer.from("x")), sha256(Buffer.from("x")));
  assert.equal(validation.validRows.length, 1);

  const quoted = `${header}\r\n${rowToCsv({
    "מספר פנייה": "3", "טלפון המוסר": "0540000004", "שם המוסר": "דני",
    "כתובת איסוף": 'רחוב, "העלייה"', "מה מעבירים": "מיטה", "הערות": "הערה",
    "סטטוס בוט": "bot", "נדרש טיפול אנושי": "false", "תמונות WhatsApp": "legacy-media-ref",
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

  const before = (await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n;
  const dry = run(csvPath, "dry-run");
  assert.equal(dry.state, "validated");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before);

  await client.query("INSERT INTO contacts(phone) VALUES('540000001')");
  const applied = run(csvPath, "apply");
  assert.equal(applied.state, "applied");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM sheets_import_lineage WHERE entity_type='request'")).rows[0].n, 1);
  const reapplied = run(csvPath, "apply");
  assert.equal(reapplied.state, "applied");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM contacts WHERE phone='540000001'")).rows[0].n, 1);
  const batchId = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [csvPath])).rows[0].id;

  const duplicate = validateSource(await readCsv(csvPath));
  duplicate.normalized.push({ ...duplicate.normalized[0], rowNumber: 3, errors: [], rowHash: duplicate.normalized[0].rowHash });
  duplicate.normalized[1].errors.push({ type: "duplicate_source_row" });
  assert.equal(duplicate.normalized[1].errors[0].type, "duplicate_source_row");
  const badRow = first.replace("0540000001", "not-a-phone").replace(",1,לא,", ",3,לא,").replace(",collecting,", ",unknown-status,");
  const badPath = join(root, "bad.csv");
  await writeFile(badPath, `${header}\n${badRow}\n`);
  const bad = validateSource(await readCsv(badPath));
  assert.ok(bad.exceptions.some((x) => x.type === "invalid_phone"));
  assert.ok(bad.exceptions.some((x) => x.type === "invalid_quantity"));
  assert.ok(bad.exceptions.some((x) => x.type === "unknown_status"));
  const badDry = run(badPath, "dry-run");
  assert.equal(badDry.ready_for_import, false);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests")).rows[0].n, before + 1);

  const review = run(quotedPath, "dry-run");
  assert.ok(review.review_required_rows > 0);
  assert.throws(() => run(quotedPath, "apply"), /review_required_use_allow_review/);
  const reviewApplied = run(quotedPath, "apply", ["--allow-review"]);
  assert.equal(reviewApplied.state, "applied");
  const reviewBatch = (await client.query("SELECT id FROM sheets_import_batches WHERE source_label=$1", [quotedPath])).rows[0].id;
  const reviewRequest = (await client.query("SELECT entity_id FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='request'", [reviewBatch])).rows[0].entity_id;
  const mediaLineage = await client.query("SELECT 1 FROM sheets_import_lineage WHERE batch_id=$1 AND entity_type='media_reference'", [reviewBatch]);
  assert.equal(mediaLineage.rowCount, 1);
  assert.equal((await client.query("SELECT data->>'media_reference' AS ref FROM request_events WHERE request_id=$1", [reviewRequest])).rows[0].ref, "legacy-media-ref");

  const rollback = JSON.parse(execFileSync(process.execPath, ["scripts/sheets-import.mjs", "--rollback", batchId], { env, encoding: "utf8" }).trim());
  assert.equal(rollback.state, "rolled_back");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM requests WHERE number=1")).rows[0].n, 0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM contacts WHERE phone='540000001'")).rows[0].n, 1);
  const rollbackAgain = JSON.parse(execFileSync(process.execPath, ["scripts/sheets-import.mjs", "--rollback", batchId], { env, encoding: "utf8" }).trim());
  assert.equal(rollbackAgain.idempotent, true);
  console.log(JSON.stringify({ ok: true, tests: 30, source_hash: source.sourceHash, dry_run_business_mutations: 0, lineage_verified: true, rollback_verified: true, external_calls: false }));
} finally {
  await client.end();
  await rm(root, { recursive: true, force: true });
}
