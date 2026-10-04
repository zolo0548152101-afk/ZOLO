const SECRET_KEY = /(token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|credential)/i;
const DIAGNOSTIC_SECRET_PATTERNS = [
  /\b(authorization|proxy-authorization)\b\s*[:=]\s*bearer\s+[^\s,;]+/gi,
  /\bbearer\s+[^\s,;]+/gi,
  /\b(bearer|token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item);
  return output;
}

export function redactDiagnosticText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return DIAGNOSTIC_SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match) => {
    const separator = match.search(/[:=]/);
    return separator >= 0 ? `${match.slice(0, separator + 1)} [REDACTED]` : "[REDACTED]";
  }), value).slice(0, 160);
}

export function validateAdminSecret(value: string): boolean {
  return value.length >= 32 && value.trim() === value && !/^(.{1,8})\1+$/.test(value);
}

export function rotationPlan(current: string, next: string): { accepted: boolean; overlap: boolean; reason?: string } {
  if (!validateAdminSecret(current) || !validateAdminSecret(next)) return { accepted: false, overlap: false, reason: "weak_secret" };
  if (current === next) return { accepted: false, overlap: false, reason: "secret_must_change" };
  return { accepted: true, overlap: true };
}
