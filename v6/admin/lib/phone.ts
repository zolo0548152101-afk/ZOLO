/** Same canonical form as haim.canon_phone, for filters typed in the admin UI. */
export function canonPhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let digits = trimmed.split("@")[0]?.replace(/\D/g, "") ?? "";
  if (digits.startsWith("00972")) digits = digits.slice(5);
  else if (digits.startsWith("972")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (/^[2-9]\d{7,8}$/.test(digits)) return digits;
  return null;
}
