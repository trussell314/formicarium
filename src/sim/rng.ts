// Seeded PRNG: mulberry32. Single source of truth for sim randomness.
// SPEC §5.4 — Math.random is banned in src/sim/**.

export class RNG {
  private state: number;

  constructor(seed: number) {
    // Avoid the degenerate 0 state.
    this.state = (seed | 0) >>> 0 || 0xdeadbeef;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(loInclusive: number, hiExclusive: number): number {
    return Math.floor(this.range(loInclusive, hiExclusive));
  }

  // Box-Muller; returns standard normal.
  gauss(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  reseed(seed: number): void {
    this.state = (seed | 0) >>> 0 || 0xdeadbeef;
  }
}
