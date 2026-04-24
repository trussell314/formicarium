// Fixed-timestep simulation loop with vsync render. SPEC §4.

export interface LoopHandlers {
  step: () => void;        // one logical sim tick
  draw: (alpha: number) => void; // alpha = interpolation [0..1] between ticks
}

export class Loop {
  private readonly handlers: LoopHandlers;
  private readonly tickMs: number;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private raf = 0;
  speedMultiplier = 1;
  // Cap accumulator to avoid spiral-of-death after long pauses.
  private readonly maxFrameMs: number;

  constructor(simHz: number, handlers: LoopHandlers) {
    this.handlers = handlers;
    this.tickMs = 1000 / simHz;
    this.maxFrameMs = this.tickMs * 6;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  pause(): void {
    if (!this.running) return;
    this.stop();
  }

  resume(): void {
    if (this.running) return;
    this.start();
  }

  isRunning(): boolean {
    return this.running;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > this.maxFrameMs) delta = this.maxFrameMs;
    this.accumulator += delta * this.speedMultiplier;
    while (this.accumulator >= this.tickMs) {
      this.handlers.step();
      this.accumulator -= this.tickMs;
    }
    const alpha = this.accumulator / this.tickMs;
    this.handlers.draw(alpha);
    this.raf = requestAnimationFrame(this.frame);
  };
}
