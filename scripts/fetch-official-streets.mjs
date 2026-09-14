// Fetch and stage the official nationwide street source without activating it.
// This command only writes the requested review artifact and its metadata; it
// never changes the database or business tables.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const output = process.argv[2];
if (!output || process.argv.includes("--activate"))
  throw new Error("Usage: node scripts/fetch-official-streets.mjs <output.csv> (staging only)");

const resourceId = "9ad3862c-8391-4b2f-84a4-2d4c68625f4b";
const url = new URL("https://data.gov.il/api/3/action/datastore_search");
url.searchParams.set("resource_id", resourceId);
url.searchParams.set("limit", "100000");
const response = await fetch(url);
if (!response.ok) throw new Error(`official_source_http_${response.status}`);
const payload = await response.json();
if (!payload.success || !payload.result?.records) throw new Error("official_source_invalid_response");

const normalize = (v) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const rows = payload.result.records
  .filter((row) => ["בית שאן", "בית-שאן"].includes(normalize(row["שם_ישוב"])))
  .sort((a, b) => Number(a["סמל_רחוב"] ?? 0) - Number(b["סמל_רחוב"] ?? 0))
  .map((row) => ({
  name: normalize(row["שם_רחוב"]),
  settlement: "בית שאן",
  aliases: "",
  }));
rows.push(
  { name: "שיכון א", settlement: "בית שאן", aliases: "שיכון א|שיכון א׳" },
  { name: "רחוב העלייה", settlement: "בית שאן", aliases: "העלייה|העליה|רחוב העליה" },
);
const unique = new Map(rows.map((row) => [row.name, row]));
if (unique.size < 3) throw new Error(`official_source_too_small:${unique.size}`);
const csv = ["name,settlement,aliases", ...unique.values().map((row) =>
  [row.name, row.settlement, row.aliases].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","),
)].join("\n") + "\n";
await writeFile(output, csv, "utf8");
const checksum = createHash("sha256").update(csv).digest("hex");
await writeFile(`${output}.meta.json`, JSON.stringify({
  source: "Population and Immigration Authority / data.gov.il",
  resource_id: resourceId,
  fetched_at: new Date().toISOString(),
  rows: unique.size,
  checksum,
  activated: false,
}, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ mode: "staged_review_artifact", resource_id: resourceId, rows: unique.size, checksum, activated: false }, null, 2));
