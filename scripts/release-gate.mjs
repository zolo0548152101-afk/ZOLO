// Pure release-gate verifier. It does not deploy, migrate, send, or change
// any external state. It only validates the environment presented to it.
const env = process.env;
const mode = env.BOT_MODE ?? "shadow";
const report = { mode, checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
};
const failures = [];
if (mode !== "live") {
  check("non_live_default", true, "shadow/simulation has no live channel effect");
} else {
  check("operator_approval", env.APPROVE_LIVE_RELEASE === "YES", "set APPROVE_LIVE_RELEASE=YES only after review");
  check("snapshot", Boolean(env.RELEASE_SNAPSHOT_ID), "a named pre-release DB/media snapshot is required");
  check("allowlist", Boolean((env.LIVE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean).length), "LIVE_ALLOWLIST must not be empty");
  check("dependencies", env.LIVE_DEPENDENCIES_VERIFIED === "true", "WAHA/API dependency smoke check is required");
  check("media_volume", env.MEDIA_VOLUME_CONFIRMED === "true", "media volume and restore path must be confirmed");
  check("schema", env.DB_SCHEMA === "haim_core", "live must use the production schema only at the canary gate");
  check("location_dataset", env.LOCATION_DATASET_ACTIVATED === "true" && Boolean(env.LOCATION_DATASET_VERSION), "a reviewed, checksum-backed location dataset must be activated");
  check("remote_prompt_eval", env.REMOTE_PROMPT_EVAL_PASSED === "true", "the pinned OpenAI managed prompt must pass the paid remote golden evaluation");
  const qaNoLegacyImport = env.RELEASE_DATA_SOURCE_MODE === "qa_no_legacy_import";
  if (qaNoLegacyImport) {
    const normalizedRecipients = [...new Set((env.LIVE_ALLOWLIST ?? "").split(",").map((phone) => {
      const digits = phone.trim().replace(/^\+/, "");
      if (digits.startsWith("0")) return `972${digits.slice(1)}`;
      if (/^5\d{8}$/.test(digits)) return `972${digits}`;
      return digits;
    }).filter(Boolean))].sort();
    check("qa_allowlist", JSON.stringify(normalizedRecipients) === JSON.stringify(["972536662043", "972584152101"]), "QA live allowlist must contain exactly the two authorized test numbers");
    check("qa_data_scope", env.QA_DISPOSABLE_DB_VERIFIED === "YES" && Boolean(env.QA_DATA_SCOPE_EVIDENCE_ID), "QA mode requires verified disposable application DB and an evidence ID; do not use for a legacy Sheets import");
    check("sheets_reconciliation", true, "not applicable: QA-only release with no legacy Sheets import");
  } else {
    check("sheets_reconciliation", Boolean(env.SHEETS_RECONCILIATION_ID), "a reviewed Sheets reconciliation run is required before live when migrating legacy data");
  }
}
console.log(JSON.stringify({ ok: failures.length === 0, ...report }, null, 2));
if (failures.length) process.exitCode = 1;
