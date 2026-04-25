// mulberry32 — small, fast, decent quality. Seedable so runs are reproducible
// when the user passes ?seed=N. All randomness in src/sim/ goes through this.

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0xdeadbeef;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(loIncl: number, hiExcl: number): number {
    return loIncl + Math.floor(this.next() * (hiExcl - loIncl));
  }

  /** Box-Muller standard normal. */
  gauss(): number {
    const u1 = Math.max(1e-9, this.next());
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
