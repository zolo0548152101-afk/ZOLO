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
  check("sheets_reconciliation", Boolean(env.SHEETS_RECONCILIATION_ID), "a reviewed Sheets reconciliation run is required before live");
}
console.log(JSON.stringify({ ok: failures.length === 0, ...report }, null, 2));
if (failures.length) process.exitCode = 1;
