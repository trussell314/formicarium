// mulberry32 — small, fast, decent quality. Seedable so runs are reproducible
// when the user passes ?seed=N. All randomness in src/sim/ goes through this.

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0xdeadbeef;
  }

  /** Current internal state (uint32). For save/restore. */
  getState(): number {
    return this.state;
  }
  /** Restore from a previously-saved state value. */
  setState(s: number): void {
    this.state = s >>> 0;
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

  /** Number of events fired this tick given an expected per-tick rate.
   *  Returns floor(rate) + Bernoulli(rate − floor(rate)). Equivalent to
   *  `rng.next() < rate` for rate < 1 (consumes the same one draw, same
   *  result), but does not saturate at 1 — useful for any per-tick
   *  rate that may exceed unity once the time-compression dial scales
   *  it. Not a true Poisson sample (variance is lower) but fine as a
   *  visible-biology approximation; the "always fire floor(rate)
   *  events" behaviour is actually what we want for plant drops and
   *  egg laying when compression is cranked high. */
  events(rate: number): number {
    if (rate <= 0) return 0;
    const whole = Math.floor(rate);
    const frac = rate - whole;
    return whole + (this.next() < frac ? 1 : 0);
  }
}
