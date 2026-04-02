/**
 * Split `totalCents` across buckets proportionally to positive `weights`.
 * Uses largest-remainder method so the parts sum exactly to `totalCents`.
 */
export function allocateProportionalCents(weights: number[], totalCents: number): number[] {
  const n = weights.length;
  if (n === 0 || totalCents === 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 0);

  const exact = weights.map((w) => (totalCents * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const fracs = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
  const out = [...floors];
  for (let k = 0; k < remainder; k++) {
    if (fracs[k]) out[fracs[k].i] += 1;
  }
  return out;
}
