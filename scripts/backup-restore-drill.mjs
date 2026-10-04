// Disposable-only operator drill. It refuses public/production targets and
// emits a verifiable manifest instead of claiming restore success from exit codes alone.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
const [source, target] = process.argv.slice(2);
const mediaRoot = process.env.BACKUP_MEDIA_ROOT;
const configurationPath = process.env.BACKUP_CONFIGURATION_FILE;
const output = resolve(process.env.BACKUP_DRILL_DIR ?? join(process.cwd(), ".tmp-backup-drill"));
if (!source || !target || process.env.DRILL_CONFIRM !== "YES" || process.env.DISPOSABLE_RESTORE !== "YES" || !mediaRoot || !configurationPath)
  throw new Error("Usage: DRILL_CONFIRM=YES DISPOSABLE_RESTORE=YES BACKUP_MEDIA_ROOT=<dir> BACKUP_CONFIGURATION_FILE=<file> node scripts/backup-restore-drill.mjs <disposable-source-url> <disposable-target-url>");
const allowedHost = (value) => ["localhost", "127.0.0.1", "::1", "postgres"].includes(new URL(value).hostname);
if (!allowedHost(source) || !allowedHost(target) || source === target) throw new Error("backup_restore_requires_distinct_disposable_local_targets");
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: "inherit", shell: false });
  p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd}:${code}`)));
});
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const filesUnder = async (root) => {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else result.push(path);
  }
  return result;
};
await mkdir(output, { recursive: true });
const dump = join(output, "postgres.dump");
const mediaManifest = join(output, "media-manifest.json");
const configurationCopy = join(output, "configuration.json");
await run("pg_dump", ["--format=custom", "--file", dump, source]);
await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", target, dump]);
await run("pg_restore", ["--list", dump]);
const mediaFiles = await filesUnder(resolve(mediaRoot));
const mediaRows = await Promise.all(mediaFiles.map(async (path) => ({ path: relative(resolve(mediaRoot), path), sha256: await sha256(path), bytes: (await stat(path)).size })));
await writeFile(mediaManifest, JSON.stringify(mediaRows, null, 2));
await copyFile(configurationPath, configurationCopy);
const configBytes = await stat(configurationCopy);
const components = [
  { name: "postgres", path: relative(output, dump), sha256: await sha256(dump), bytes: (await stat(dump)).size },
  { name: "media", path: relative(output, mediaManifest), sha256: await sha256(mediaManifest), bytes: (await stat(mediaManifest)).size },
  { name: "configuration", path: relative(output, configurationCopy), sha256: await sha256(configurationCopy), bytes: configBytes.size },
];
const { createBackupManifest, validateBackupManifest } = await import(pathToFileURL(resolve("dist/application/backup.js")).href);
const manifest = await createBackupManifest(components, { consistency: "single-disposable-snapshot", rpo_minutes: 60, rto_minutes: 30 });
const validation = validateBackupManifest(manifest);
if (!validation.ok) throw new Error(`backup_manifest_invalid:${validation.errors.join(",")}`);
await writeFile(join(output, "backup-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, restored: true, manifest: join(output, "backup-manifest.json"), components: components.map(({ name, sha256: checksum, bytes }) => ({ name, sha256: checksum, bytes })) }));
