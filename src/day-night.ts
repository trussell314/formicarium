// Day / night cycle math. Pure functions; no DOM or sim dependencies.
// Shared by the renderer (sky color, sun / moon position) and the sim
// (circadian activity modulation).

export interface DayNightCycle {
  dayDurationTicks: number;
  nightDurationTicks: number;
}

/**
 * Returns the celestial state at a given tick:
 *
 *   daylight    — sky brightness, [0..1]. 0 = full night, 1 = noon.
 *   sunPhase    — fraction through the day cycle, [0..1].
 *   moonPhase   — fraction through the night cycle, [0..1].
 *   sunUp       — true when the sun is the visible body.
 */
export function celestialOf(tickCount: number, cycle: DayNightCycle): {
  daylight: number;
  sunPhase: number;
  moonPhase: number;
  sunUp: boolean;
} {
  const day = cycle.dayDurationTicks;
  const night = cycle.nightDurationTicks;
  const total = day + night;
  const t = ((tickCount % total) + total) % total;
  if (t < day) {
    const f = day === 0 ? 0 : t / day;
    return {
      daylight: Math.sin(f * Math.PI),
      sunPhase: f,
      moonPhase: 0,
      sunUp: true,
    };
  }
  const f = night === 0 ? 0 : (t - day) / night;
  return {
    daylight: 0,
    sunPhase: 0,
    moonPhase: f,
    sunUp: false,
  };
}
