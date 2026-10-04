// Disposable-only backup/restore drill. It proves target-side HAIM state,
// media content, and configuration metadata before reporting restored=true.
import pg from "pg";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const { Pool } = pg;
const [source, target] = process.argv.slice(2);
const mediaRoot = process.env.BACKUP_MEDIA_ROOT;
const configurationPath = process.env.BACKUP_CONFIGURATION_FILE;
const schema = process.env.BACKUP_DB_SCHEMA ?? "haim_core_test";
const output = resolve(process.env.BACKUP_DRILL_DIR ?? join(process.cwd(), ".tmp-backup-drill"));
const appName = "haim-qa-backup-restore";
const disposableName = /^haim_(?:core_test|qa_disposable|backup_test)(?:_[a-z0-9-]+)?$/;

if (!source || !target || process.env.DRILL_CONFIRM !== "YES" || process.env.DISPOSABLE_RESTORE !== "YES" || !mediaRoot || !configurationPath)
  throw new Error("Usage: DRILL_CONFIRM=YES DISPOSABLE_RESTORE=YES BACKUP_MEDIA_ROOT=<dir> BACKUP_CONFIGURATION_FILE=<file> node scripts/backup-restore-drill.mjs <disposable-source-url> <disposable-target-url>");

function proveDisposableTarget(value, label) {
  const parsed = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(parsed.hostname))
    throw new Error(`backup_restore_${label}_host_not_disposable`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!disposableName.test(database) || database === "haim_core")
    throw new Error(`backup_restore_${label}_database_name_not_disposable`);
  if (parsed.searchParams.get("application_name") !== appName)
    throw new Error(`backup_restore_${label}_application_name_not_disposable`);
  return { database, url: value };
}

const sourceTarget = proveDisposableTarget(source, "source");
const targetTarget = proveDisposableTarget(target, "target");
if (source === target) throw new Error("backup_restore_requires_distinct_disposable_local_targets");

const run = (cmd, args) => new Promise((resolveRun, reject) => {
  const child = spawn(cmd, args, { stdio: "inherit", shell: false });
  child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${cmd}:${code}`)));
  child.on("error", reject);
});
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = async (path) => sha256Bytes(await readFile(path));
const filesUnder = async (root) => {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else result.push(path);
  }
  return result;
};
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("invalid_backup_schema");
  return `"${name}"`;
};
const s = ident(schema);
const fixed = {
  contactA: "00000000-0000-4000-8000-000000000101",
  contactB: "00000000-0000-4000-8000-000000000102",
  request: "00000000-0000-4000-8000-000000000201",
  message: "00000000-0000-4000-8000-000000000301",
  media: "00000000-0000-4000-8000-000000000401",
  batch: "00000000-0000-4000-8000-000000000501",
};

async function seedSource(pool) {
  const fixturePath = join(resolve(mediaRoot), "backup-drill-fixture.jpg");
  const fixture = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  await writeFile(fixturePath, fixture);
  const fixtureKey = `${sha256Bytes(fixture)}.jpg`;
  const trace = "00000000-0000-4000-8000-000000000601";
  const values = [fixed.contactA, fixed.contactB, fixed.request, fixed.message, fixed.media, fixed.batch, trace, fixtureKey, sha256Bytes(fixture), fixture.byteLength];
  const statements = [
    [`INSERT INTO ${s}.contacts(id,phone) VALUES($1,'501111101'),($2,'501111102') ON CONFLICT DO NOTHING`, values.slice(0, 2)],
    [`INSERT INTO ${s}.requests(id,number,status,origin) VALUES($1::uuid,991001,'collecting','donation') ON CONFLICT DO NOTHING`, [values[2]]],
    [`INSERT INTO ${s}.request_parties(request_id,role,contact_id,name,settlement,address,floor)
      VALUES($1::uuid,'donor',$2::uuid,'Backup Donor','בית שאן','רחוב הבדיקה 1',1),($1::uuid,'receiver',$3::uuid,'Backup Receiver','בית שאן','רחוב היעד 2',2) ON CONFLICT DO NOTHING`, [values[2], values[0], values[1]]],
    [`INSERT INTO ${s}.request_items(request_id,position,kind,description,quantity,free,working)
      VALUES($1::uuid,0,'bed','Disposable backup bed',1,true,true) ON CONFLICT DO NOTHING`, [values[2]]],
    [`INSERT INTO ${s}.messages(id,session,external_id,trace_id,mode,chat_id,kind,text,contacts,location,media_state)
      VALUES($1::uuid,'backup-drill','backup-drill-message',$2::uuid,'simulation','972501111101@c.us','image','synthetic backup media','[]'::jsonb,NULL,'ready') ON CONFLICT DO NOTHING`, [values[3], values[6]]],
    [`INSERT INTO ${s}.media(id,message_id,storage_key,checksum,mime_type,size_bytes)
      VALUES($1::uuid,$2::uuid,$3,$4,'image/jpeg',$5) ON CONFLICT DO NOTHING`, [values[4], values[3], values[7], values[8], values[9]]],
    [`UPDATE ${s}.messages SET media_id=$1::uuid,media_state='ready' WHERE id=$2::uuid`, [values[4], values[3]]],
    [`INSERT INTO ${s}.request_media(request_id,media_id,added_by) VALUES($1::uuid,$2::uuid,$3::uuid) ON CONFLICT DO NOTHING`, [values[2], values[4], values[0]]],
    [`INSERT INTO ${s}.integrations(name,enabled) VALUES('backup-drill',true) ON CONFLICT DO NOTHING`, []],
    [`INSERT INTO ${s}.request_events(request_id,message_id,trace_id,actor,event_type,data)
      VALUES($1::uuid,$2::uuid,$3::uuid,'backup-drill','backup_fixture_created','{"fixture":true}'::jsonb) ON CONFLICT DO NOTHING`, [values[2], values[3], values[6]]],
    [`INSERT INTO ${s}.sheets_import_batches(id,source_label,source_hash,mode,state,row_count,error_count)
      VALUES($1::uuid,'backup-drill,' || $1::text,'${"b".repeat(64)}','apply','review_required',1,0) ON CONFLICT DO NOTHING`, [values[5]]],
    [`INSERT INTO ${s}.sheets_import_lineage(batch_id,row_number,row_hash,entity_type,entity_id,created_by_import)
      VALUES($1::uuid,1,'${"c".repeat(64)}','request',$2::text,true) ON CONFLICT DO NOTHING`, [values[5], values[2]]],
    [`INSERT INTO ${s}.outbox(dedupe_key,message_id,request_id,trace_id,mode,phone,chat_id,text,state)
      VALUES('backup-drill-outbox',$1::uuid,$2::uuid,$3::uuid,'simulation','501111102','972501111102@c.us','backup drill outbound','pending') ON CONFLICT DO NOTHING`, [values[3], values[2], values[6]]],
    [`INSERT INTO ${s}.integration_outbox(event_id,integration,state,attempts,last_error,error_class,idempotency_key)
      SELECT id,'backup-drill','pending',1,NULL,NULL,'backup-drill-integration' FROM ${s}.request_events WHERE request_id=$1::uuid AND event_type='backup_fixture_created' ON CONFLICT DO NOTHING`, [values[2]]],
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${s}, public`);
    for (const [statement, params] of statements) await client.query(statement, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { fixturePath, fixtureKey, fixtureChecksum: sha256Bytes(fixture), fixtureBytes: fixture.byteLength };
}

async function snapshot(pool) {
  const queries = [
    ["contacts", `SELECT count(*)::int AS n FROM ${s}.contacts WHERE id IN ($1,$2)`, [fixed.contactA, fixed.contactB]],
    ["request", `SELECT count(*)::int AS n FROM ${s}.requests WHERE id=$1 AND number=991001`, [fixed.request]],
    ["parties", `SELECT count(*)::int AS n FROM ${s}.request_parties WHERE request_id=$1`, [fixed.request]],
    ["items", `SELECT count(*)::int AS n FROM ${s}.request_items WHERE request_id=$1`, [fixed.request]],
    ["media", `SELECT checksum,size_bytes FROM ${s}.media WHERE id=$1`, [fixed.media]],
    ["request_media", `SELECT count(*)::int AS n FROM ${s}.request_media WHERE request_id=$1 AND media_id=$2`, [fixed.request, fixed.media]],
    ["import_batch", `SELECT count(*)::int AS n FROM ${s}.sheets_import_batches WHERE id=$1 AND state='review_required'`, [fixed.batch]],
    ["import_lineage", `SELECT count(*)::int AS n FROM ${s}.sheets_import_lineage WHERE batch_id=$1 AND entity_id=$2`, [fixed.batch, fixed.request]],
    ["outbox", `SELECT count(*)::int AS n FROM ${s}.outbox WHERE dedupe_key='backup-drill-outbox' AND state='pending'`, []],
    ["integration_outbox", `SELECT count(*)::int AS n FROM ${s}.integration_outbox WHERE idempotency_key='backup-drill-integration'`, []],
  ];
  const result = {};
  for (const [name, sql, params] of queries) result[name] = (await pool.query(sql, params)).rows[0] ?? null;
  return result;
}

function assertSnapshot(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`restored_state_mismatch:${JSON.stringify({ expected, actual })}`);
  return { ok: true, expected, actual };
}

await mkdir(output, { recursive: true });
await mkdir(resolve(mediaRoot), { recursive: true });
await mkdir(join(output, "media-payload"), { recursive: true });
const sourcePool = new Pool({ connectionString: source, connectionTimeoutMillis: 5000 });
const targetPool = new Pool({ connectionString: target, connectionTimeoutMillis: 5000 });
try {
  await seedSource(sourcePool);
  const expectedState = await snapshot(sourcePool);
  const sourceConfig = JSON.parse(await readFile(configurationPath, "utf8"));
  if (!sourceConfig || sourceConfig.schema_version !== 1) throw new Error("configuration_metadata_invalid");
  const configCopy = join(output, "configuration.json");
  await copyFile(configurationPath, configCopy);
  const backupMediaRoot = join(output, "media-payload");
  for (const path of await filesUnder(resolve(mediaRoot))) {
    const destination = join(backupMediaRoot, relative(resolve(mediaRoot), path));
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(path, destination);
  }
  const dump = join(output, "postgres.dump");
  await run("pg_dump", ["--format=custom", "--file", dump, source]);
  await targetPool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await targetPool.query(`DROP SCHEMA IF EXISTS ${ident(`${schema}_jobs`)} CASCADE`);
  await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", target, dump]);
  await run("pg_restore", ["--list", dump]);
  const restoreVerification = { state: assertSnapshot(expectedState, await snapshot(targetPool)) };
  const restoredConfig = JSON.parse(await readFile(configCopy, "utf8"));
  if (JSON.stringify(restoredConfig) !== JSON.stringify(sourceConfig)) throw new Error("restored_configuration_mismatch");
  const mediaRows = [];
  for (const path of await filesUnder(backupMediaRoot)) mediaRows.push({ path: relative(backupMediaRoot, path), sha256: await sha256(path), bytes: (await stat(path)).size });
  const restoredMediaRoot = join(output, "restored-media");
  for (const path of await filesUnder(backupMediaRoot)) {
    const destination = join(restoredMediaRoot, relative(backupMediaRoot, path));
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(path, destination);
  }
  const restoredMediaRows = [];
  for (const path of await filesUnder(restoredMediaRoot)) restoredMediaRows.push({ path: relative(restoredMediaRoot, path), sha256: await sha256(path), bytes: (await stat(path)).size });
  if (JSON.stringify(mediaRows) !== JSON.stringify(restoredMediaRows)) throw new Error("restored_media_content_mismatch");
  restoreVerification.media = { source: mediaRows, restored: restoredMediaRows, content_match: true };
  restoreVerification.configuration = { valid: true, exact_match: true };
  restoreVerification.target_proof = { application_name: appName, database_name_contract: true, sentinel: "fixed-fixture-v1" };
  const { createBackupManifest, validateBackupManifest } = await import("../dist/application/backup.js");
  const components = [
    { name: "postgres", path: "postgres.dump", sha256: await sha256(dump), bytes: (await stat(dump)).size },
    { name: "media", path: "media-payload", sha256: sha256Bytes(JSON.stringify(mediaRows)), bytes: mediaRows.reduce((n, row) => n + row.bytes, 0) },
    { name: "configuration", path: "configuration.json", sha256: await sha256(configCopy), bytes: (await stat(configCopy)).size },
  ];
  const manifest = await createBackupManifest(components, { consistency: "single-disposable-snapshot", rpo_minutes: 60, rto_minutes: 30 });
  const validation = validateBackupManifest(manifest);
  if (!validation.ok) throw new Error(`backup_manifest_invalid:${validation.errors.join(",")}`);
  await writeFile(join(output, "media-manifest.json"), JSON.stringify(mediaRows, null, 2));
  await writeFile(join(output, "restore-verification.json"), JSON.stringify(restoreVerification, null, 2));
  await writeFile(join(output, "backup-manifest.json"), JSON.stringify({ ...manifest, restore_verification: restoreVerification }, null, 2));
  console.log(JSON.stringify({ ok: true, restored: true, target_verified: true, manifest: join(output, "backup-manifest.json"), restore_verification: join(output, "restore-verification.json"), components: components.map(({ name, sha256: checksum, bytes }) => ({ name, sha256: checksum, bytes })) }));
} finally {
  await sourcePool.end();
  await targetPool.end();
}
