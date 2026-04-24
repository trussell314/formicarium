// Lightweight perf stats for the dev overlay.

export class Perf {
  private frameCount = 0;
  private lastReport = 0;
  fps = 0;
  // Rolling averages of recent measurements.
  private simSamples: number[] = [];
  private renderSamples: number[] = [];
  simMs = 0;
  renderMs = 0;

  recordSim(ms: number): void {
    this.simSamples.push(ms);
    if (this.simSamples.length > 60) this.simSamples.shift();
  }

  recordRender(ms: number): void {
    this.renderSamples.push(ms);
    if (this.renderSamples.length > 60) this.renderSamples.shift();
  }

  /** Call once per rendered frame. Returns true once per second. */
  tick(now: number): boolean {
    this.frameCount++;
    if (now - this.lastReport >= 1000) {
      const dt = now - this.lastReport;
      this.fps = (this.frameCount * 1000) / dt;
      this.simMs = avg(this.simSamples);
      this.renderMs = avg(this.renderSamples);
      this.frameCount = 0;
      this.lastReport = now;
      return true;
    }
    return false;
  }
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
