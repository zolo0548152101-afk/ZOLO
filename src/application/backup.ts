export type BackupComponentName = "postgres" | "media" | "configuration";
export type BackupComponent = { name: BackupComponentName; path: string; sha256: string; bytes: number };
export type BackupManifest = {
  schema_version: 1;
  generated_at: string;
  consistency: "single-disposable-snapshot";
  rpo_minutes: number;
  rto_minutes: number;
  components: BackupComponent[];
};

const REQUIRED = new Set<BackupComponentName>(["postgres", "media", "configuration"]);

export type DatabaseIdentity = { host: string; port: number; database: string };

export function normalizeDatabaseIdentity(value: string): DatabaseIdentity {
  const parsed = new URL(value);
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

export function assertDistinctDatabaseIdentity(source: string, target: string): void {
  const sourceIdentity = normalizeDatabaseIdentity(source);
  const targetIdentity = normalizeDatabaseIdentity(target);
  if (sourceIdentity.host === targetIdentity.host && sourceIdentity.port === targetIdentity.port && sourceIdentity.database === targetIdentity.database)
    throw new Error("backup_restore_requires_distinct_disposable_database_identity");
}

export async function createBackupManifest(
  components: BackupComponent[],
  options: Pick<BackupManifest, "consistency" | "rpo_minutes" | "rto_minutes">,
): Promise<BackupManifest> {
  return { schema_version: 1, generated_at: new Date().toISOString(), ...options, components: components.map((component) => ({ ...component })) };
}

export function validateBackupManifest(manifest: Partial<BackupManifest>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const names = new Set((manifest.components ?? []).map((component) => component.name));
  for (const required of REQUIRED) if (!names.has(required)) errors.push(`missing_component:${required}`);
  for (const component of manifest.components ?? []) {
    if (!/^[a-f0-9]{64}$/.test(component.sha256)) errors.push(`invalid_checksum:${component.name}`);
    if (!Number.isSafeInteger(component.bytes) || component.bytes <= 0) errors.push(`invalid_size:${component.name}`);
    if (!component.path || component.path.includes("..")) errors.push(`invalid_path:${component.name}`);
  }
  if (manifest.consistency !== "single-disposable-snapshot") errors.push("invalid_consistency");
  if (!Number.isFinite(manifest.rpo_minutes) || !Number.isFinite(manifest.rto_minutes)) errors.push("invalid_recovery_targets");
  return { ok: errors.length === 0, errors };
}
