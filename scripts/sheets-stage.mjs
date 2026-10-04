// Canonical staging entry point. Dry-run is the default and never mutates business tables.
const file = process.argv[2];
if (!file || process.argv.includes("--apply")) throw new Error("Usage: node scripts/sheets-stage.mjs <export.csv> (dry-run only)");
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, ["scripts/sheets-import.mjs", "--file", file, "--source-label", file, "--mode", "dry-run"], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
