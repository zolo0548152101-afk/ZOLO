/** Stable pseudo-random in [0, 1) from a string seed. */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Place a cluster near settlement center with a stable random offset
 * so multiple clusters in the same town do not stack.
 */
export function offsetWithinSettlement(
  lat: number,
  lng: number,
  ashkol: string,
  radiusKm = 1.2,
): { lat: number; lng: number } {
  const a = hash01(`${ashkol}:a`) * Math.PI * 2;
  const r = Math.sqrt(hash01(`${ashkol}:r`)) * radiusKm;
  const dLat = (r / 111.32) * Math.cos(a);
  const dLng = (r / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
  return { lat: lat + dLat, lng: lng + dLng };
}
