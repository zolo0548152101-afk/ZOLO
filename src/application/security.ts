const SECRET_KEY = /(token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i;
const SECRET_VALUE = /\b(bearer|token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*[^\s,;]+/gi;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item);
  return output;
}

export function redactDiagnosticText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replace(SECRET_VALUE, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`).slice(0, 160);
}

export function validateAdminSecret(value: string): boolean {
  return value.length >= 32 && value.trim() === value && !/^(.{1,8})\1+$/.test(value);
}

export function rotationPlan(current: string, next: string): { accepted: boolean; overlap: boolean; reason?: string } {
  if (!validateAdminSecret(current) || !validateAdminSecret(next)) return { accepted: false, overlap: false, reason: "weak_secret" };
  if (current === next) return { accepted: false, overlap: false, reason: "secret_must_change" };
  return { accepted: true, overlap: true };
}
