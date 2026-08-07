// Deterministic seeded RNG (mulberry32). ALL sim randomness must come from here —
// same seed + same inputs = same run (replays, share-code verification, headless tests).

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** float in [0, 1) */
  next(): number {
    // state must stay u32: an unmasked `+=` accumulates in f64 and starts
    // rounding past 2^53 (~4.9M draws), silently leaving the mulberry32 stream
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [0, 256) — cheap byte for probability checks */
  byte(): number {
    return (this.next() * 256) | 0;
  }
  /** integer in [0, n) */
  int(n: number): number {
    return (this.next() * n) | 0;
  }
  /** true/false coin flip */
  bool(): boolean {
    return this.next() < 0.5;
  }
}
