// Operator runbook helper. It never targets production unless the operator
// explicitly supplies both URLs and DRILL_CONFIRM=YES.
import { spawn } from "node:child_process";
const [source, target] = process.argv.slice(2);
if (!source || !target || process.env.DRILL_CONFIRM !== "YES")
  throw new Error("Usage: DRILL_CONFIRM=YES node scripts/backup-restore-drill.mjs <source-url> <target-url>");
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: "inherit", shell: false });
  p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd}:${code}`)));
});
const file = `${process.cwd()}/backup-drill.dump`;
await run("pg_dump", ["--format=custom", "--file", file, source]);
await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", target, file]);
console.log(JSON.stringify({ ok: true, backup: file, restored: true }));
