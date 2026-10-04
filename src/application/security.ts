const SECRET_KEY = /(token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item);
  return output;
}

export function validateAdminSecret(value: string): boolean {
  return value.length >= 32 && value.trim() === value && !/^(.{1,8})\1+$/.test(value);
}

export function rotationPlan(current: string, next: string): { accepted: boolean; overlap: boolean; reason?: string } {
  if (!validateAdminSecret(current) || !validateAdminSecret(next)) return { accepted: false, overlap: false, reason: "weak_secret" };
  if (current === next) return { accepted: false, overlap: false, reason: "secret_must_change" };
  return { accepted: true, overlap: true };
}
