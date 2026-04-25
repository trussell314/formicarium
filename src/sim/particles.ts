// Tiny ring-buffer particle system for ephemeral visual effects (e.g.
// dust puffs when an ant excavates a soil cell). SoA for the same
// reasons as Colony — keeps render iteration tight.
//
// Particles have float positions in cell space, velocity in cells/tick,
// and a remaining lifetime (ticks). Update applies velocity + a tiny
// gravity term and decrements lifetime. When lifetime hits zero the
// slot is free for the next spawn.
//
// Capacity is fixed; if it fills up, new spawns silently overwrite the
// slot with the lowest remaining lifetime. That's fine — we never need
// strict ordering for fluff like this.

export class ParticleSystem {
  readonly capacity: number;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  /** Remaining lifetime in ticks. Zero = free slot. */
  readonly life: Int16Array;
  /** Lifetime at spawn — used by the renderer to compute fade. */
  readonly maxLife: Int16Array;
  private cursor = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.life = new Int16Array(capacity);
    this.maxLife = new Int16Array(capacity);
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number): void {
    let slot = -1;
    for (let k = 0; k < this.capacity; k++) {
      const idx = (this.cursor + k) % this.capacity;
      if (this.life[idx] === 0) { slot = idx; break; }
    }
    if (slot === -1) {
      // No free slots — overwrite the slot we already consider "next".
      slot = this.cursor;
    }
    this.cursor = (slot + 1) % this.capacity;
    this.posX[slot] = x;
    this.posY[slot] = y;
    this.velX[slot] = vx;
    this.velY[slot] = vy;
    this.life[slot] = life;
    this.maxLife[slot] = life;
  }

  step(): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.posX[i]! += this.velX[i]!;
      this.posY[i]! += this.velY[i]!;
      // Light gravity so puffs settle.
      this.velY[i]! += 0.012;
      // Air drag.
      this.velX[i]! *= 0.96;
      this.velY[i]! *= 0.98;
      this.life[i]!--;
    }
  }
}
