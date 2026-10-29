/**
 * Deterministic PRNG (mulberry32). The seed lives in GameState so every peer produces the same
 * numbers: `const [value, rngSeed] = nextRandom(state.rngSeed)` and store the new seed.
 */
export function nextRandom(seed: number): [value: number, nextSeed: number] {
  const next = (seed + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}
