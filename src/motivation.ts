// High-level "what is this ant doing?" summary, derived from its
// state and current target. The UI uses this to caption the selected
// ant. Kept as a pure function of sim state so behaviour changes
// don't drift out of sync with the UI text.

import { CELLS_PER_CM } from './scenario';
import {
  Colony,
  STATE_CARRY,
  STATE_DIG,
  STATE_REST,
  STATE_WANDER,
} from './sim/colony';
import { World } from './sim/world';

export interface Motivation {
  /** One-word label (WANDER / DIG / CARRY / REST). */
  stateLabel: string;
  /** Short human-readable sentence. */
  description: string;
  /** Whether the ant is above this column's natural surface row. */
  aboveGround: boolean;
  /** Navigation target in cm, or null if none. */
  destinationCm: { x: number; y: number } | null;
  /** Ticks spent in the current state. */
  stateTicks: number;
}

export function motivationOf(colony: Colony, i: number, world?: World): Motivation {
  const state = colony.state[i]!;
  const hasTarget = colony.hasTarget(i);
  const tx = colony.targetX[i]!;
  const ty = colony.targetY[i]!;
  // Above- vs below-ground decision. Real ants don't have an
  // explicit "I'm in the nest" cognition — they use chemical and
  // path-integration cues. Here we proxy with a position test:
  // is the ant above or below this column's natural surface row?
  // Defaults to false when no world is provided (legacy callers).
  const ix = colony.posX[i]! | 0;
  const surfY = world ? (world.naturalSurface[ix] ?? 0) : 0;
  const aboveGround = world ? colony.posY[i]! < surfY : false;

  let stateLabel: string;
  let description: string;
  switch (state) {
    case STATE_WANDER:
      stateLabel = 'WANDER';
      description = aboveGround
        ? 'patrolling above ground'
        : 'exploring the nest';
      break;
    case STATE_DIG:
      stateLabel = 'DIG';
      description = hasTarget
        ? `excavating soil at (${tx.toFixed(1)}, ${ty.toFixed(1)})`
        : 'excavating soil';
      break;
    case STATE_CARRY: {
      stateLabel = 'CARRY';
      const hx = colony.homeX[i]!;
      const hy = colony.homeY[i]!;
      const mag = Math.hypot(hx, hy);
      if (aboveGround) {
        description = 'carrying a grain — looking for a surface spot to deposit';
      } else if (mag > 2) {
        const cmDist = mag / CELLS_PER_CM;
        description = `hauling a grain up (~${cmDist.toFixed(1)} cm from home)`;
      } else {
        description = 'carrying a grain — heading up';
      }
      break;
    }
    case STATE_REST:
      stateLabel = 'REST';
      description = aboveGround ? 'resting on the surface' : 'resting in the nest';
      break;
    default:
      stateLabel = `STATE${state}`;
      description = '?';
  }
  return {
    stateLabel,
    description,
    aboveGround,
    destinationCm: hasTarget
      ? { x: tx / CELLS_PER_CM, y: ty / CELLS_PER_CM }
      : null,
    stateTicks: colony.stateTimer[i]!,
  };
}
