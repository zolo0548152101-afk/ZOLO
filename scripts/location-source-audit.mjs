// Verify the repository does not silently claim that its small fixture is a
// complete municipal street snapshot. This is intentionally read-only.
import { readFile } from "node:fs/promises";

const migration = await readFile("db/migrations/012_location_datasets.sql", "utf8");
const fixture = await readFile("tests/fixtures/beit-shean-streets-small.csv", "utf8");
const official = await readFile("tests/fixtures/beit-shean-streets-official.csv", "utf8");
const metadata = JSON.parse(await readFile("tests/fixtures/beit-shean-streets-official.csv.meta.json", "utf8"));
if (!migration.includes("future imports must add the complete municipal snapshot"))
  throw new Error("location_migration_must_declare_partial_source");
if (!fixture.startsWith("name,settlement,aliases\n"))
  throw new Error("location_fixture_headers_invalid");
const rows = fixture.trim().split(/\r?\n/).slice(1);
if (rows.length !== 2) throw new Error("fixture_is_expected_to_remain_small_test_data");
const officialRows = official.trim().split(/\r?\n/).slice(1);
if (officialRows.length < 200 || metadata.activated !== false)
  throw new Error("official_snapshot_must_be_staged_and_not_activated");
console.log(JSON.stringify({
  mode: "source_audit",
  complete_official_snapshot_present: true,
  official_snapshot_rows: officialRows.length,
  official_snapshot_checksum: metadata.checksum,
  fixture_rows: rows.length,
  activation_blocked_until_reviewed_snapshot: true,
}, null, 2));
