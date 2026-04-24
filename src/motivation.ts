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

export interface Motivation {
  /** One-word label (WANDER / DIG / CARRY / REST). */
  stateLabel: string;
  /** Short human-readable sentence. */
  description: string;
  /** Navigation target in cm, or null if none. */
  destinationCm: { x: number; y: number } | null;
  /** Ticks spent in the current state. */
  stateTicks: number;
}

export function motivationOf(colony: Colony, i: number): Motivation {
  const state = colony.state[i]!;
  const hasTarget = colony.hasTarget(i);
  const tx = colony.targetX[i]!;
  const ty = colony.targetY[i]!;
  let stateLabel: string;
  let description: string;
  switch (state) {
    case STATE_WANDER:
      stateLabel = 'WANDER';
      description = 'exploring the nest';
      break;
    case STATE_DIG:
      stateLabel = 'DIG';
      description = hasTarget
        ? `excavating soil at (${tx.toFixed(1)}, ${ty.toFixed(1)})`
        : 'excavating soil';
      break;
    case STATE_CARRY:
      stateLabel = 'CARRY';
      description = 'hauling a grain up to the surface';
      break;
    case STATE_REST:
      stateLabel = 'REST';
      description = 'resting';
      break;
    default:
      stateLabel = `STATE${state}`;
      description = '?';
  }
  return {
    stateLabel,
    description,
    destinationCm: hasTarget
      ? { x: tx / CELLS_PER_CM, y: ty / CELLS_PER_CM }
      : null,
    stateTicks: colony.stateTimer[i]!,
  };
}
