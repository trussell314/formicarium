// Per-tick agent behaviour. Pure decision logic — agents call into
// the env (physics.ts, pheromone.ts) for actions; they never write
// to world.cells directly. The behavioural model is the smallest
// composition of cited primitives that produces emergent excavation:
//
//   1. CORRELATED RANDOM WALK — heading += Gaussian noise per tick.
//      The standard movement model for ants and other foragers.
//        Kareiva, P., Shigesada, N. (1983). Analyzing insect movement
//          as a correlated random walk. Oecologia 56: 234–238.
//
//   2. STIGMERGY — agents bias their heading toward the gradient of
//      a pheromone field they're sensitive to. WANDER ants follow
//      the DIG field (concentrates effort at active excavation
//      fronts); CARRY ants follow the BUILD field (concentrates
//      spoil at growing entrance mounds).
//        Grassé, P-P. (1959). La reconstruction du nid...
//        Bonabeau, E., Theraulaz, G., Deneubourg, J-L. (1998).
//          Phil. Trans. R. Soc. Lond. B 353: 1561–1576.
//        Deneubourg, J-L., Goss, S. (1989). Collective patterns and
//          decision-making. Ethol. Ecol. Evol. 1: 295–311.
//
//   3. CONTACT-TRIGGERED EXCAVATION — every soil contact in WANDER
//      rolls a per-contact dig probability. Drops dig pheromone on
//      success.
//        Sudd, J. H. (1970). The response of isolated digging
//          workers in the ant Formica lemani Bondroit. Insectes
//          Sociaux 17: 261–272. Reports per-contact dig probabilities
//          in the 5–15% range.
//
//   4. NEGATIVE GEOTAXIS — laden (CARRY) ants have a small heading
//      bias against gravity. Documented in many myrmecology texts;
//      foragers carrying loads orient upslope toward the nest exit.
//
// Three tunable parameters per behaviour. No tip-shape, no recency,
// no mound-height caps, no homing vector, no preferredHeading
// stickiness, no shallow-dig depth gates. If a "scientifically-
// flavoured" hack creeps back in, it should justify itself with a
// citation right here.

import {
  Colony, STATE_CARRY, STATE_CARRY_FOOD, STATE_DEAD, STATE_EGG,
  STATE_FORAGE, STATE_LARVA, STATE_NECRO_CARRY, STATE_PUPA,
  STATE_QUEEN, STATE_REST, STATE_WANDER, type AntState,
} from './colony';
import type { ParticleSystem } from './particles';
import { Pheromone, uploadPheromoneCells } from './pheromone';
import { digCell, pickGrain, placeGrain, settle, tryStep } from './physics';
import type { RNG } from './rng';
import { type AntSpecies, HARVESTER } from './species';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, daylight, World } from './world';

export interface SimParams {
  /** Cells/tick walking speed. Sub-stepped so soil contacts aren't skipped. */
  walkSpeed: number;
  /** Per-tick std-dev of heading noise (radians). Correlated random walk. */
  turnNoise: number;
  /** P(dig) per soil contact, per Sudd 1970 (range 0.05–0.15 typical). */
  digProb: number;
  /** P(pickup) per tick when a WANDER ant is adjacent to a grain
   *  cell. Theraulaz/Bonabeau/Deneubourg 1998 construction model:
   *  ants both deposit and pick up grain; the balance generates
   *  emergent structure. Set lower than digProb so mounds still
   *  accumulate net-positively. */
  pickProb: number;
  /** Strength of stigmergy gradient bias in heading update (0..1). */
  stigmergy: number;
  /** Strength of negative-geotaxis bias for CARRY ants (0..1). */
  geotaxis: number;
  /** Pheromone amount deposited on a successful dig. */
  digDeposit: number;
  /** Pheromone amount deposited on grain placement. */
  buildDeposit: number;
  /** Mean of the per-ant collision threshold (Beshers & Fewell
   *  individual-threshold sample). Aina et al. 2023 report behavioural
   *  withdrawal after ~4–5 close contacts. */
  restThreshold: number;
  /** Ticks an ant stays in REST before resuming WANDER. Hard-capped
   *  for deadlock safety — REST always exits cleanly. */
  restDuration: number;
}

export const DEFAULT_PARAMS: SimParams = {
  // 1.2 cells/tick × 3 mm/cell ÷ 120 ms/tick = 30 mm/sec — matches
  // Gordon (1989) Pogonomyrmex foraging speed. Scales with cell size:
  // walkSpeed × cellMM = constant 30 × 0.12 = 3.6 mm/tick.
  walkSpeed: 1.2,
  // 0.05 rad/tick ÷ 0.12 sec/tick = 0.42 rad/sec ≈ 24°/sec — within
  // observed correlated random walk turn rates for foragers (Kareiva
  // & Shigesada 1983). Earlier 0.35 was 24× faster, ants spun in place.
  turnNoise: 0.05,
  digProb: 0.10,    // Sudd 1970: 5–15% per contact
  // pickProb 0.02/tick = 17%/sec biological. Keep lower than digProb
  // so mound net-grows over time.
  pickProb: 0.02,
  stigmergy: 0.55,
  geotaxis: 0.35,
  // digDeposit and buildDeposit reduced 10× from the 1.0 originals
  // to compensate for the 100× time-compression. With ~10× more
  // dig events and grain placements per tick, the original deposit
  // amounts saturated buildField into a self-reinforcing pile-up
  // attractor that trapped half the colony in a magenta blob. The
  // reduced per-event deposit keeps the steady-state field
  // magnitude similar to the pre-compression calibration.
  digDeposit: 0.1,
  buildDeposit: 0.1,
  // Beshers & Fewell 2001: per-ant individual-threshold mean ~8
  // recent collisions before behavioural withdrawal.
  restThreshold: 8.0,
  // Aina et al. 2023 calibrates REST by real-time minutes. Strict
  // 100× time-compression would give 5-10 ticks — but REST is a
  // SPATIAL dispersal mechanism: the ant random-walks during REST
  // and the goal is to leave the crowded area. At only 8 ticks of
  // walking (with turn noise), random-walk dispersal is ~3 cells —
  // not enough to escape any meaningful cluster. Pick 100 ticks
  // instead so the dispersal radius (≤ 60 cells of straight-walk,
  // ~7 cells of random-walk variance) is large enough to actually
  // leave a chamber-sized pile-up. Bio time is ~12 sec which is
  // shorter than literature but spatially correct.
  restDuration: 100,
};

/** Distance below which two ants count as colliding. ≈ 1 body length
 *  (6 mm at our 3 mm/cell scale = 2 cells). Scales with cell size:
 *  COLLISION_RADIUS × cellMM = 6 mm constant. */
/** Cardinal-direction unit offsets for the sanctum-maintenance
 *  partition scan. Hoisted to module scope so the per-ant loop
 *  doesn't re-allocate the array every tick (4 arrays × 50 ants
 *  × 250+ ticks/sec = 50K+ allocations/sec at speed, enough to
 *  visibly spike GC). */
const SANCTUM_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
];
const COLLISION_RADIUS = 2.0;
/** Multiplicative decay applied to collisionCount each tick. ~50-tick
 *  half-life — collisions are recent indicators, not lifetime tally. */
const COLLISION_DECAY = 0.985;

// Spatial-bin scratch buffers for the collision pass. Hoisted to
// module scope so we don't allocate w·h bytes every tick — that
// allocation cost would dominate the actual collision work. Lazily
// resized when the world or colony grows. fill(-1) at the start of
// each tick is a single memset.
let _binHead: Int16Array | null = null;
let _binLink: Int16Array | null = null;
let _binCells = 0;
let _binAnts = 0;
function getCollisionBins(cells: number, ants: number): { head: Int16Array; link: Int16Array } {
  if (!_binHead || _binCells < cells) {
    _binHead = new Int16Array(cells);
    _binCells = cells;
  }
  if (!_binLink || _binAnts < ants) {
    _binLink = new Int16Array(ants);
    _binAnts = ants;
  }
  return { head: _binHead, link: _binLink };
}

const TWO_PI = Math.PI * 2;

function wrapAngle(a: number): number {
  if (a > Math.PI) return a - TWO_PI;
  if (a < -Math.PI) return a + TWO_PI;
  return a;
}

/**
 * Pick the cardinal-neighbour SOIL cell that's most aligned with the
 * ant's current heading. Used only as the "which face am I touching"
 * resolver — the dig-or-not decision is the Sudd contact roll, made
 * by the caller. Returns null if no cardinal neighbour is soil.
 *
 * Note: a dig-target downward bias was tried as an additional lever
 * for vertical-gallery formation. It paradoxically REDUCED depth
 * (chamber-floor ants all dug the cell below them, spreading the dig
 * effort laterally across the wide floor rather than concentrating
 * at any particular point). The asymmetric dig-pheromone deposit
 * (see step()) plus strong below-surface geotaxis on WANDER ants
 * give the right gradient pull without flattening the dig front.
 */
function adjacentSoil(world: World, ix: number, iy: number, h: number): { x: number; y: number } | null {
  const w = world.width;
  const candidates: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  let bestX = -1, bestY = -1, bestDot = -Infinity;
  const hx = Math.cos(h);
  const hy = Math.sin(h);
  for (const [dx, dy] of candidates) {
    const x = ix + dx;
    const y = iy + dy;
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
    if (world.cells[y * w + x] !== CELL_SOIL) continue;
    const dot = hx * dx + hy * dy;
    if (dot > bestDot) { bestDot = dot; bestX = x; bestY = y; }
  }
  return bestX < 0 ? null : { x: bestX, y: bestY };
}

/**
 * Pick a cardinal-neighbour GRAIN cell at random. Used by the
 * Theraulaz pickup rule — when a WANDER ant is adjacent to deposited
 * grain, this resolves which one to handle. Order of preference is
 * randomized so ants on the side of a mound don't always pick the
 * same cell.
 */
function adjacentGrain(world: World, ix: number, iy: number, rng: RNG): { x: number; y: number } | null {
  const w = world.width;
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, -1], [0, 1],
  ];
  // Reservoir sample over all grain neighbours so each is equally
  // likely (avoids a left-preference bias).
  let pickX = -1, pickY = -1, count = 0;
  for (const [dx, dy] of offsets) {
    const x = ix + dx;
    const y = iy + dy;
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
    if (world.cells[y * w + x] !== CELL_GRAIN) continue;
    count++;
    if (rng.next() < 1 / count) { pickX = x; pickY = y; }
  }
  return pickX < 0 ? null : { x: pickX, y: pickY };
}

export function step(
  world: World,
  colony: Colony,
  digField: Pheromone,
  buildField: Pheromone,
  rng: RNG,
  params: SimParams = DEFAULT_PARAMS,
  particles?: ParticleSystem,
  species: AntSpecies = HARVESTER,
  trailField?: Pheromone,
  alarmField?: Pheromone,
  queenField?: Pheromone,
  broodField?: Pheromone,
  necroField?: Pheromone,
  noEntryField?: Pheromone,
  granaryField?: Pheromone,
  trunkField?: Pheromone,
): void {
  world.tick++;
  // Decay the forager-return-rate counter (Greene & Gordon 2007
  // antennation-feedback model). Multiplicative decay 0.998 per tick
  // gives a half-life of ~350 ticks (~7 sec biological at 100×
  // compression, or ~12 min real time at the original biological
  // rate). Successful CARRY_FOOD deposits pulse this back up; the
  // forage roll uses the running value as a boost so a colony with
  // recent successful trips ramps up outflow, and a colony with no
  // returns in the last few minutes cools down again.
  world.foragerReturnRate *= 0.998;
  // Brood-starving flag (FIX H precomputation). Scanned once per
  // tick so CARRY_FOOD ants can route food directly to a starving
  // brood pile rather than always going to the granary. Threshold
  // is "any larva below trophallaxisRecipientThreshold" — even one
  // hungry larva is enough to redirect a delivery.
  let broodStarving = false;
  for (let i = 0; i < colony.count; i++) {
    if (colony.state[i]! === STATE_LARVA &&
        colony.energy[i]! < species.trophallaxisRecipientThreshold) {
      broodStarving = true;
      break;
    }
  }
  // Open-shaft count refresh. O(W × 5) once every ~100 ticks.
  // Each column counts as "open" if any of the natural-surface
  // row or the four cells immediately below it is AIR — i.e. the
  // colony has at least a partial way in here. Cached so the
  // stranded-drill recovery rule can be a single integer compare
  // per surface ant per tick instead of a 16-column scan.
  if (world.tick - world.openShaftTick >= 100 || world.openShaftTick < 0) {
    let openCount = 0;
    const wW = world.width;
    for (let xc = 0; xc < wW; xc++) {
      const sf = world.naturalSurface[xc]!;
      const yMax = Math.min(world.height - 1, sf + 4);
      for (let yc = sf; yc <= yMax; yc++) {
        if (world.cells[yc * wW + xc] === CELL_AIR) { openCount++; break; }
      }
    }
    world.openShaftCount = openCount;
    world.openShaftTick = world.tick;
  }

  // Diurnal/nocturnal foraging gate. Gordon (1991) tracked P. barbatus
  // forager activity by time of day and found it crashes to zero at
  // sunset and only resumes at dawn; the underground colony continues
  // doing nest work throughout. Cached once per tick because every
  // WANDER ant rolls forageProb every tick they're underground.
  const day = daylight(world.tick);
  const forageActivity = species.diurnal ? day : 1 - day;

  // Surface seed rain — two pathways. The legacy uniform-Poisson
  // path (seedsPerTick) drops a single seed at a random surface
  // column. The clump path (clumpInterval/Size/Radius, default
  // pathway for HARVESTER) drops a Gaussian-scattered handful at
  // one location every interval — visually a "windfall" rather
  // than a drizzle. Both are skipped entirely for non-granivorous
  // species.
  // NB: rng.next() is called unconditionally even when seedsPerTick
  // is 0. Short-circuiting via `seedsPerTick > 0 &&` would shift
  // every subsequent rng draw on this tick, silently breaking any
  // seeded behavioural test that doesn't enable seedsPerTick.
  if (species.granivorous && rng.next() < species.seedsPerTick) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const sx = (rng.next() * world.width) | 0;
      const sy = world.naturalSurface[sx]!;
      if (sy < 1) continue;
      const surfIdx = sy * world.width + sx;
      const aboveIdx = surfIdx - world.width;
      if (
        world.cells[surfIdx] === CELL_SOIL &&
        world.cells[aboveIdx] === CELL_AIR &&
        world.food[aboveIdx] === 0
      ) {
        world.food[aboveIdx] = 1;
        world.foodMoves[aboveIdx] = 0;
        break;
      }
    }
  }
  if (species.granivorous && species.clumpSize > 0 && world.foodCap > 0) {
    // Population-driven food rate. Each tick we add to a fractional
    // seed accumulator at a rate equal to 110% of the colony's
    // current metabolic demand (in seed-equivalent units). The
    // accumulator fires a clump whenever it crosses the clumpSize
    // threshold.
    //
    // No upper rate cap: a 1000-ant colony gets 100× the supply of
    // a 10-ant colony. Larger colonies need proportionally more
    // food and would starve under a flat cap. Smaller colonies
    // still get a small rate (proportional to their demand) so
    // founding queens can sustain themselves and first nanitics.
    //
    // The standing-inventory throttle below (150%-of-population
    // hard cap) is what keeps the surface from drowning in seeds
    // when nobody is foraging fast enough — it gates new drops
    // without rate-limiting the colony as it grows.
    let demand = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      if (s === STATE_DEAD || s === STATE_EGG || s === STATE_PUPA) continue;
      if (s === STATE_LARVA) {
        demand += species.larvaMetabolism;
      } else if (s === STATE_QUEEN) {
        demand += species.metabolism * 0.5;
      } else {
        demand += species.metabolism;
      }
    }
    // Saturation throttle. Without this, supply matches demand
    // exactly so any unconsumed seed accumulates indefinitely —
    // foragers can't pick up perfectly-balanced supply, surplus
    // builds, sprouts, the world turns green. We periodically count
    // standing food and scale supply down once inventory exceeds a
    // few days of consumption. Refresh every 200 ticks; drift is
    // fine since the throttle is soft.
    // Refresh per tick. Originally cached every 200 ticks to save
    // a 40K-cell scan, but the lag let the throttle accumulate
    // ~30 seeds per refresh window — over a long run this added
    // up to hundreds of seeds dropped above the supposed cap. The
    // scan is a Uint8 linear sweep, easily under 50 µs at default
    // world dims; the cost is invisible.
    let n = 0;
    const f = world.food;
    for (let i = 0; i < f.length; i++) if (f[i]! > 0) n++;
    world.foodCountCached = n;
    world.foodCountTick = world.tick;
    // Saturation. Hard stop at 150% of current population: if
    // standing seed inventory already covers more than that, no new
    // drops fire this tick. Below the threshold supply ramps up
    // smoothly via a soft taper rather than bang-bang switching
    // (otherwise the spawn rate oscillates as seeds get picked up
    // and the threshold is repeatedly crossed).
    //
    //   inventory ≤ 75% pop:   full rate
    //   inventory  75-150%:    linearly fade from 1.0 to 0.0
    //   inventory ≥ 150%:      drops stop completely
    //
    // The cap is in HEAD COUNT, not energy demand. The earlier
    // version used `demand / species.metabolism` which weighted
    // larvae by their metabolism (15× worker rate); a colony with
    // 100 larvae would have cap of ~1500, which let the surface
    // drown in seeds even though larvae consume food indirectly
    // via trophallaxis (surface → granary → worker → larva). What
    // we actually want to cap is the visible standing inventory,
    // and that's a head-count thing: 150% of consuming bodies.
    let aliveBodies = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      if (s === STATE_DEAD || s === STATE_EGG || s === STATE_PUPA) continue;
      aliveBodies++;
    }
    const popCap = Math.max(10, aliveBodies);
    const hardCap = popCap * 1.5;
    const softFloor = popCap * 0.75;
    let satMult: number;
    if (world.foodCountCached >= hardCap) satMult = 0;
    else if (world.foodCountCached <= softFloor) satMult = 1;
    else satMult = (hardCap - world.foodCountCached) / (hardCap - softFloor);
    // When the throttle is at zero, also drain any accumulated clump
    // budget so a leftover from before the cap kicked in doesn't
    // immediately fire as soon as the throttle next eases. Without
    // this, clumpAccum can sit at e.g. 9.9 indefinitely waiting
    // for the next 0.1 to push it over.
    if (satMult === 0 && world.clumpAccum >= species.clumpSize) {
      world.clumpAccum = 0;
    }
    const targetEnergyPerTick = demand * 1.10 * satMult;
    const targetSeedsPerTick = targetEnergyPerTick / species.foodValue;
    world.clumpAccum += targetSeedsPerTick;
    // Fire as many clumps as the accumulator can pay for. Typically
    // 0 clumps per tick (rate << clumpSize/tick); occasionally 1; at
    // saturation this loop might fire 2-3 in a busy tick.
    while (world.clumpAccum >= species.clumpSize) {
      world.clumpAccum -= species.clumpSize;
      // Pick a random surface column for the clump centre, then
      // place clumpSize seeds at Gaussian offsets (1-σ = clumpRadius).
      // Each seed seeks the topmost AIR cell above the natural surface
      // in its column — past any mound/grain stacked there — and
      // settles into it. If nothing's free in that column the seed is
      // lost (real seeds bouncing off a mound roll away or get buried;
      // we don't simulate the roll).
      const cx = (rng.next() * world.width) | 0;
      for (let k = 0; k < species.clumpSize; k++) {
        const dx = Math.round(rng.gauss() * species.clumpRadius);
        const sx = cx + dx;
        if (sx < 0 || sx >= world.width) continue;
        const sy = world.naturalSurface[sx]!;
        if (sy < 1) continue;
        let placeIdx = -1;
        for (let py = sy - 1; py >= 0; py--) {
          const pIdx = py * world.width + sx;
          const cell = world.cells[pIdx]!;
          if (cell === CELL_AIR && world.food[pIdx] === 0) {
            placeIdx = pIdx;
            break;
          }
          if (cell === CELL_SOIL) break;
        }
        if (placeIdx >= 0) {
          world.food[placeIdx] = 1;
          world.foodMoves[placeIdx] = 0;
          if (particles) {
            const py = (placeIdx / world.width) | 0;
            const pxx = placeIdx - py * world.width;
            const a = rng.range(-Math.PI, 0);
            const sp = rng.range(0.04, 0.10);
            particles.spawn(
              pxx + 0.5, py + 0.3,
              Math.cos(a) * sp, Math.sin(a) * sp - 0.04,
              22 + ((rng.next() * 14) | 0),
            );
          }
        }
      }
    }
  }

  // Environmental dynamics: pheromone fields advance one tick;
  // dust particle ringbuffer ages and gravity-falls one tick.
  // Each step receives world.cells so diffusion is gated to AIR —
  // volatile pheromones live in the carved-out air column, not
  // through soil walls. See pheromone.ts step() for the full note.
  // The WASM kernel keeps its own copy of cells; upload once per
  // tick before stepping any field. No-op when running on the JS
  // path (tests / unsupported environments).
  const cells = world.cells;
  uploadPheromoneCells(cells);
  digField.step(cells);
  buildField.step(cells);
  if (trailField) trailField.step(cells);
  if (alarmField) alarmField.step(cells);
  // Slow-evaporation pheromone fields step every 2 ticks instead
  // of every tick. With per-tick retention ≥ 0.99, half-lives in
  // these fields are 700+ ticks; a 1-tick lag in the diffusion
  // update is invisibly small relative to the field's natural
  // dynamics. The deposit calls (queen emission, larva emission,
  // CARRY_FOOD anchor, etc.) still write to `current` every tick;
  // they accumulate into the field across the skipped step. Halves
  // the per-tick CPU for 6 of the 10 pheromone fields. Profile
  // confirmed pheromone.step() is the largest single hot path
  // and these slow fields contribute ~half of it.
  const slowStep = (world.tick & 1) === 0;
  if (queenField && slowStep) queenField.step(cells);
  if (broodField && slowStep) broodField.step(cells);
  if (necroField && slowStep) necroField.step(cells);
  if (noEntryField && slowStep) noEntryField.step(cells);
  if (granaryField && slowStep) granaryField.step(cells);
  if (trunkField && slowStep) trunkField.step(cells);
  if (particles) particles.step();

  // Necromone emission. Corpse cells evaporate oleic acid (Wilson,
  // Durlach & Roth 1958). Sparse — most cells have no corpse. We
  // sweep the world.corpse field every 10 ticks to amortise cost
  // and use an accumulated-amount-per-corpse model that produces
  // roughly steady-state concentrations around middens.
  if (necroField && world.tick % 10 === 0) {
    const wW = world.width;
    const wH = world.height;
    for (let y = 0; y < wH; y++) {
      const row = y * wW;
      for (let x = 0; x < wW; x++) {
        if (world.corpse[row + x]! > 0) {
          // 0.5 every 10 ticks ≈ 0.05/tick, balancing the 0.99
          // retention to give an equilibrium concentration of ~5
          // at corpse cells. Necrophoresis followers respond at
          // gradient threshold ~0.1.
          necroField.deposit(x, y, 0.5);
        }
      }
    }
  }

  // Seed germination + sprout decay sweep. Tschinkel (1999): some
  // stored seeds in granaries occasionally sprout instead of being
  // eaten. We sweep the food field once per germinationSweepInterval
  // ticks and roll sproutProb on each stored seed (foodMoves > 0,
  // i.e. previously deposited rather than freshly fallen on the
  // surface). Decay path: any sprout older than sproutLifetimeTicks
  // dries up and is cleared. The combined cost is a single O(W·H)
  // pass per interval.
  if (species.sproutProb > 0 && world.tick % species.germinationSweepInterval === 0) {
    const total = world.food.length;
    for (let idx = 0; idx < total; idx++) {
      // Germination roll on stored seeds.
      if (
        world.food[idx]! > 0 &&
        world.foodMoves[idx]! > 0 &&
        rng.next() < species.sproutProb
      ) {
        world.food[idx] = 0;
        world.foodMoves[idx] = 0;
        world.sprout[idx] = 1;
        world.sproutTick[idx] = world.tick;
      }
      // Decay aged sprouts back to nothing. Renderer treats
      // sprout=0 as "no sprout here".
      if (
        world.sprout[idx]! > 0 &&
        world.tick - world.sproutTick[idx]! > species.sproutLifetimeTicks
      ) {
        world.sprout[idx] = 0;
      }
    }
  }

  // Corpse + food gravity. Cell-overlay markers (corpse, food)
  // don't have movement of their own, so a body or seed dropped on
  // top of a grain mound becomes "floating" the moment another
  // worker picks up that supporting grain. Cheap recovery: every
  // 30 ticks (~3.5 sec biological), scan upward — bottom row first
  // — and shift any marker down one row if the cell beneath is AIR
  // with no other occupant. Bottom-up so a stack of N orphaned
  // markers settles in a single sweep rather than needing N sweeps.
  // The sweep is also cheap because both fields are mostly zero —
  // branch prediction skips the empty cells.
  //
  // The natural-surface row acts as a one-way barrier from above.
  // Real soil has cohesion + ants reinforce the mound's contact
  // with the substrate, so above-ground bodies/seeds shouldn't
  // cascade through the surface horizon into the dug nest below.
  // Above-surface markers refuse to descend into a row at or below
  // their column's natural surface.
  if (world.tick % 30 === 0) {
    const wW = world.width;
    const wH = world.height;
    for (let y = wH - 2; y >= 0; y--) {
      const row = y * wW;
      const below = (y + 1) * wW;
      for (let x = 0; x < wW; x++) {
        const ridx = row + x;
        const bidx = below + x;
        const crossesSurface = y < world.naturalSurface[x]! && (y + 1) >= world.naturalSurface[x]!;
        if (crossesSurface) continue;
        // Corpses fall through AIR cells with no existing occupant.
        if (world.corpse[ridx]! > 0) {
          if (
            world.cells[bidx] === CELL_AIR &&
            world.corpse[bidx]! === 0 &&
            world.food[bidx]! === 0
          ) {
            world.corpse[bidx] = 1;
            world.corpse[ridx] = 0;
          }
        }
        // Food (seeds) settle the same way. Without this, a seed
        // dropped on a grain pile or on a chamber ceiling stays put
        // when the supporting cell gets dug or hauled away — visible
        // as floating green pixels mid-air. Carry-over the seed's
        // foodMoves counter so the renderer's age-based saturation
        // is preserved across the fall.
        if (world.food[ridx]! > 0) {
          if (
            world.cells[bidx] === CELL_AIR &&
            world.food[bidx]! === 0 &&
            world.corpse[bidx]! === 0 &&
            world.sprout[bidx]! === 0
          ) {
            world.food[bidx] = world.food[ridx]!;
            world.foodMoves[bidx] = world.foodMoves[ridx]!;
            world.food[ridx] = 0;
            world.foodMoves[ridx] = 0;
          }
        }
      }
    }
  }

  // walkSpeed, geotaxis, and the deposit amounts stay as colony-wide
  // constants; the per-ant heterogeneity (digProb, pickProb,
  // stigmergy, turnNoise) is sampled at spawn into Colony arrays.
  const { walkSpeed, geotaxis, digDeposit, buildDeposit } = params;
  const subSteps = Math.max(2, Math.ceil(walkSpeed));
  const stepLen = walkSpeed / subSteps;
  // Count alive non-brood workers for colony-size-dependent caste
  // gating. Wilson's polyethism research: in small colonies all
  // workers act as multi-purpose generalists; specialisation
  // (forager-vs-nurse) emerges only in larger colonies. We use this
  // below to bypass the nurse-only `ageFrac < 0.5` gate on queen-
  // and brood-pheromone bias when the colony is below SMALL_COLONY,
  // so even old workers attend the queen when she'd otherwise be
  // alone. Counting is O(N) per tick but N is small at the regime
  // where this matters.
  let aliveWorkers = 0;
  let carriers = 0;
  for (let i = 0; i < colony.count; i++) {
    const s = colony.state[i]!;
    if (s !== STATE_DEAD && s !== STATE_EGG && s !== STATE_LARVA
        && s !== STATE_PUPA && s !== STATE_QUEEN) {
      aliveWorkers++;
      if (s === STATE_CARRY || s === STATE_CARRY_FOOD || s === STATE_NECRO_CARRY) carriers++;
    }
  }
  const SMALL_COLONY = 30;
  const isSmallColony = aliveWorkers < SMALL_COLONY;
  // Carry-saturation suppression. When most workers are already
  // carrying spoil and can't find a deposit site, additional
  // digging just makes the problem worse — every fresh dig adds
  // another CARRY ant that has nowhere to deposit. Real colonies
  // self-pace this via local crowding feedback (workers brushing
  // mandibles with other carriers reduce their own dig roll). We
  // approximate with a colony-level multiplier on dig probability:
  //   ratio < 0.5:  full dig rate (1.0)
  //   0.5 → 0.7:    linear taper 1.0 → 0
  //   ≥ 0.7:        0.0 — no more digs until the queue clears
  // Empirical: at the original 30/50 thresholds the colony stopped
  // building after ~50 cells were excavated because the throttle
  // fired even at modest carrier ratios. Healthy P. barbatus
  // colonies typically run 40-60% of workers in transport at any
  // moment; leaving room there for ongoing excavation.
  const carryRatio = aliveWorkers > 0 ? carriers / aliveWorkers : 0;
  let carrySaturation: number;
  if (carryRatio >= 0.7) carrySaturation = 0;
  else if (carryRatio <= 0.5) carrySaturation = 1;
  else carrySaturation = 1 - (carryRatio - 0.5) / 0.2;

  // Collision pass — Aguilar et al. 2018 / Aina et al. 2023 "agitation"
  // model. Each ant's collisionCount decays each tick and is bumped
  // by overlap with any other ant within COLLISION_RADIUS. WANDER
  // ants whose count crosses their restThreshold withdraw into REST.
  //
  // Spatial-binned at COLLISION_RADIUS: each ant goes into its cell
  // bucket, and we scan only the 3×3 cell neighbourhood for overlap
  // candidates. O(n) average instead of O(n²); the chamber-floor
  // pile-ups (where most ants cluster) get most of the speedup.
  for (let i = 0; i < colony.count; i++) {
    const s0 = colony.state[i];
    if (s0 === STATE_DEAD || s0 === STATE_QUEEN || s0 === STATE_EGG) continue;
    colony.collisionCount[i]! *= COLLISION_DECAY;
  }
  const cr2 = COLLISION_RADIUS * COLLISION_RADIUS;
  // Same pattern as classical particle-grid neighbour search:
  // a head-of-bucket array indexed by world cell, plus a per-ant
  // next-pointer chain. Reset by filling head with -1 (single
  // memset). Buffers are reused across ticks (module scope above).
  const bw = world.width;
  const bh = world.height;
  const { head, link } = getCollisionBins(bw * bh, colony.count);
  head.fill(-1, 0, bw * bh);
  // Include queens and eggs in the spatial bins so trophallaxis
  // (below) can find queens as recipients of nestmate feeding.
  // Collision-count increments below specifically skip queens and
  // eggs so a worker near them doesn't accumulate fake "collisions"
  // and bounce into REST.
  for (let i = 0; i < colony.count; i++) {
    const sB = colony.state[i];
    if (sB === STATE_DEAD) {
      link[i] = -1;
      continue;
    }
    const bx = colony.posX[i]! | 0;
    const by = colony.posY[i]! | 0;
    if (bx < 0 || by < 0 || bx >= bw || by >= bh) { link[i] = -1; continue; }
    const b = by * bw + bx;
    link[i] = head[b]!;
    head[b] = i;
  }
  for (let i = 0; i < colony.count; i++) {
    const sP = colony.state[i];
    if (sP === STATE_DEAD) continue;
    const bx = colony.posX[i]! | 0;
    const by = colony.posY[i]! | 0;
    if (bx < 0 || by < 0 || bx >= bw || by >= bh) continue;
    // Scan 3×3 buckets. Each pair counted once via j > i guard.
    for (let oy = -1; oy <= 1; oy++) {
      const ny = by + oy;
      if (ny < 0 || ny >= bh) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = bx + ox;
        if (nx < 0 || nx >= bw) continue;
        for (let j = head[ny * bw + nx]!; j !== -1; j = link[j]!) {
          if (j <= i) continue;
          const dx = colony.posX[j]! - colony.posX[i]!;
          const dy = colony.posY[j]! - colony.posY[i]!;
          const d2 = dx * dx + dy * dy;
          if (d2 < cr2 && d2 > 1e-6) {
            const stI = colony.state[i]!;
            const stJ = colony.state[j]!;
            // Skip eggs entirely — they can't collide or trophallax.
            if (stI === STATE_EGG || stJ === STATE_EGG) continue;
            // Collision count only between mobile workers; queens
            // and larvae are stationary brood-pile entities, so a
            // worker pressed against them shouldn't trigger her
            // into REST (workers crowd the brood pile by design,
            // not by congestion). Larvae and queens have no REST
            // state of their own.
            const stationaryI = stI === STATE_QUEEN || stI === STATE_LARVA || stI === STATE_PUPA;
            const stationaryJ = stJ === STATE_QUEEN || stJ === STATE_LARVA || stJ === STATE_PUPA;
            if (!stationaryI && !stationaryJ) {
              colony.collisionCount[i]! += 1;
              colony.collisionCount[j]! += 1;
            }
            // Trophallaxis. Hölldobler & Wilson (1990) Ch. 7: the
            // higher-energy partner regurgitates a small aliquot
            // into the lower-energy partner. Pair gates: donor ≥
            // donorThreshold, recipient ≤ recipientThreshold,
            // recipient is alive (not DEAD/EGG), donor is a
            // worker-class state (not DEAD/EGG; QUEEN can receive
            // but never donates her own reserves). The transfer
            // amount is capped at the recipient's missing energy
            // and at the donor's surplus above the threshold so
            // a single contact never fully drains either ant.
            if (species.trophallaxisAmount > 0) {
              const ei = colony.energy[i]!;
              const ej = colony.energy[j]!;
              const donor = ei >= ej ? i : j;
              const recip = ei >= ej ? j : i;
              const donorE = colony.energy[donor]!;
              const recipE = colony.energy[recip]!;
              const donorState = colony.state[donor]!;
              const recipState = colony.state[recip]!;
              // Larva-priority trophallaxis (FIX D). Larvae starve
              // faster than workers (15× metabolism in real biology,
              // 5× in our compressed model) and are the colony's
              // most precious investment — losing one wastes the
              // queen-feeding + worker-feeding effort that produced
              // it. Real nurses prioritise larva feeding over their
              // own consumption (Cassill 2002 measured S. invicta
              // nurses voluntarily down-feeding to keep brood at
              // capacity). Override the donor-threshold gate when
              // the recipient is a starving larva: workers donate
              // even with sub-threshold crops, but the donor retains
              // a survival floor of 0.3 — below that they need their
              // own food and refuse the donation. Without the floor
              // a worker walking through a chamber with 5 starving
              // larvae burns through 0.025 energy/tick from
              // trophallaxis alone (5 pairs × 0.005) and dies in ~30
              // ticks. Monitoring run with no floor showed 6 worker
              // deaths by t=120k from this exact mechanism.
              const recipIsStarvingLarva =
                recipState === STATE_LARVA &&
                recipE < species.trophallaxisRecipientThreshold;
              // Floor below which donors don't volunteer for priority
              // trophallaxis. Above the standard donorThreshold (0.5)
              // the standard gate fires anyway; below 0.3 the worker
              // is too lean to give. The 0.3-0.5 band is the priority
              // zone where workers lower their own threshold to feed
              // brood — but they still keep enough reserve to walk to
              // food if needed.
              const PRIORITY_DONOR_FLOOR = 0.3;
              const donorOk =
                donorState !== STATE_DEAD &&
                donorState !== STATE_EGG &&
                donorState !== STATE_LARVA &&
                // Queens normally aren't trophallaxis donors — they
                // don't have a crop full of forager-collected food.
                // EXCEPTION: claustral founding (Hölldobler & Wilson
                // 1990 Ch. 5) — pre-eclosion of the first nanitics,
                // queens nourish the first brood from wing-muscle
                // reserves and trophallactic exchange. Allow queen
                // donation when the recipient is a larva.
                (donorState !== STATE_QUEEN || recipState === STATE_LARVA) &&
                // Standard donor gate: must have surplus above the
                // threshold. Priority path lowers the gate to
                // PRIORITY_DONOR_FLOOR for starving larvae.
                (recipIsStarvingLarva
                  ? donorE > PRIORITY_DONOR_FLOOR
                  : donorE > species.trophallaxisDonorThreshold);
              const recipOk =
                recipState !== STATE_DEAD &&
                recipState !== STATE_EGG &&
                recipE < species.trophallaxisRecipientThreshold;
              if (donorOk && recipOk) {
                const want = species.maxEnergy - recipE;
                // Surplus calculation: standard path uses (donorE −
                // donorThreshold). Priority path uses (donorE −
                // PRIORITY_DONOR_FLOOR) — donor never goes below the
                // floor.
                const surplus = recipIsStarvingLarva
                  ? Math.max(0, donorE - PRIORITY_DONOR_FLOOR)
                  : donorE - species.trophallaxisDonorThreshold;
                const give = Math.min(species.trophallaxisAmount, want, surplus);
                if (give > 0) {
                  colony.energy[recip] = recipE + give;
                  // Queens feeding larvae draw on non-modelled wing-
                  // muscle / yolk reserves rather than the per-ant
                  // energy pool (Hölldobler & Wilson 1990 Ch. 5). If
                  // we drained queen.energy here, a queen surrounded
                  // by N hungry larvae would lose N × trophallaxisAmount
                  // per tick — a queen with 20 adjacent larvae would
                  // crash to zero in 10 ticks. Worker→worker and
                  // worker→queen transfers still drain the donor
                  // normally.
                  if (donorState !== STATE_QUEEN) {
                    colony.energy[donor] = donorE - give;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < colony.count; i++) {
    const stateNow = colony.state[i]!;

    // Dead ants are inert: position frozen, no decisions, no
    // collision contribution. Skip the rest of the per-ant body.
    if (stateNow === STATE_DEAD) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      continue;
    }

    // Brood maturation. Eggs sit at the queen's chamber, accumulating
    // stateTicks until species.eggMatureTicks → emerge as a mature
    // worker. Hölldobler & Wilson (1990) Ch. 9: real egg→larva→pupa
    // →adult takes ~4 weeks, compressed here for observability.
    if (stateNow === STATE_EGG) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      colony.stateTicks[i]!++;
      // Brood thermoregulation. Penick & Tschinkel (2008): real
      // ants move eggs/larvae between depth strata to track the
      // optimal temperature range — deeper at noon (escaping heat),
      // shallower at midnight (seeking residual warmth). We don't
      // model the nurse-carry intermediate explicitly; the visible
      // outcome — eggs slowly drifting up and down with the diurnal
      // cycle — is the part the user wants to see. Each egg gets
      // nudged at most one cell per broodMigrateInterval ticks
      // toward a target-depth that swings linearly with daylight.
      if (colony.stateTicks[i]! % species.broodMigrateInterval === 0) {
        const ex = colony.posX[i]! | 0;
        const eyNow = colony.posY[i]! | 0;
        if (ex >= 0 && ex < world.width) {
          const surf = world.naturalSurface[ex]!;
          const day = daylight(world.tick);
          const targetDepth =
            species.broodMinDepth +
            (species.broodMaxDepth - species.broodMinDepth) * day;
          const targetY = surf + Math.round(targetDepth);
          let dy = 0;
          if (eyNow < targetY) dy = 1;
          else if (eyNow > targetY) dy = -1;
          if (dy !== 0) {
            const newY = eyNow + dy;
            // Chamber-only constraint: brood is kept in chambers,
            // not in the 1-cell-wide entrance shaft. Real nurses
            // don't shelve eggs in the connecting tunnel; they stay
            // in the broodpile chamber. A "chamber" cell here is
            // one with BOTH lateral neighbours non-SOIL — i.e. the
            // cell sits in a 3+ cell-wide passage. The earlier
            // weaker check (one lateral non-SOIL) admitted 2-wide
            // horizontal tunnels and shaft-adjacent corridors, so
            // eggs rode upward through narrow excavated tunnels
            // and looked "ghostly" rising toward the surface. Real
            // broodpiles sit in wider chambers; the queen's
            // 5-wide pocket and any properly excavated chamber
            // satisfies both-laterals-AIR easily, so this doesn't
            // lock brood out of legitimate destinations.
            const wW = world.width;
            const leftIsSoil =
              ex > 0 && world.cells[newY * wW + (ex - 1)] === CELL_SOIL;
            const rightIsSoil =
              ex < wW - 1 && world.cells[newY * wW + (ex + 1)] === CELL_SOIL;
            const isChamber = !leftIsSoil && !rightIsSoil;
            if (
              newY >= 0 && newY < world.height &&
              world.cells[world.index(ex, newY)] === CELL_AIR &&
              isChamber
            ) {
              colony.posY[i] = colony.posY[i]! + dy;
            }
          }
        }
      }
      if (colony.stateTicks[i]! >= species.eggMatureTicks) {
        // Hatch into LARVA — same position, but now needs feeding.
        // Spawn at half-energy: a freshly-hatched larva still has
        // some yolk reserves but will starve if not fed.
        colony.setState(i, STATE_LARVA);
        colony.energy[i] = species.maxEnergy * 0.5;
      }
      continue;
    }

    // LARVA tick. The middle stage of brood: stationary like the
    // egg, but with two new dynamics — its energy drains every
    // tick (faster than an adult worker; growing tissue is
    // expensive) and it accepts trophallactic feeding from any
    // passing worker (handled in the collision/trophallaxis pass
    // above; LARVA is a valid recipient state). Same brood-
    // thermoregulation drift as eggs. After larvaMatureTicks of
    // STATE_LARVA the larva emerges as a fully-functioning worker.
    if (stateNow === STATE_LARVA) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      colony.stateTicks[i]!++;
      // Brood pheromone emission. Cassill (2002), Slipinski et al.
      // (2006): larvae emit a hunger-call pheromone distinct from
      // queen pheromone; nurses respond to it directly. Since
      // larvae thermoregulate to deeper rows during the day, the
      // brood signal travels with them — workers attending the
      // queen alone might miss the migrating larvae, so a separate
      // field is needed.
      if (broodField) {
        const lx = colony.posX[i]! | 0;
        const ly = colony.posY[i]! | 0;
        if (lx >= 0 && ly >= 0 && lx < world.width && ly < world.height) {
          // Per-larva emission. Original 0.05 was calibrated for the
          // pre-100×-compression broodpile (~7 larvae steady-state).
          // After uniform 100× time compression the broodpile is
          // ~126 larvae and that emission rate saturates the field
          // far past the chamber. 0.005 keeps total broodpile signal
          // similar in magnitude regardless of larva count.
          broodField.deposit(lx, ly, 0.005);
        }
      }
      // Same depth-tracking drift as eggs.
      if (colony.stateTicks[i]! % species.broodMigrateInterval === 0) {
        const ex = colony.posX[i]! | 0;
        const eyNow = colony.posY[i]! | 0;
        if (ex >= 0 && ex < world.width) {
          const surf = world.naturalSurface[ex]!;
          const day = daylight(world.tick);
          const targetDepth =
            species.broodMinDepth +
            (species.broodMaxDepth - species.broodMinDepth) * day;
          const targetY = surf + Math.round(targetDepth);
          let dy = 0;
          if (eyNow < targetY) dy = 1;
          else if (eyNow > targetY) dy = -1;
          if (dy !== 0) {
            const newY = eyNow + dy;
            // Chamber-only constraint: brood is kept in chambers,
            // not in the 1-cell-wide entrance shaft. Real nurses
            // don't shelve eggs in the connecting tunnel; they stay
            // in the broodpile chamber. A "chamber" cell here is
            // one with BOTH lateral neighbours non-SOIL — i.e. the
            // cell sits in a 3+ cell-wide passage. The earlier
            // weaker check (one lateral non-SOIL) admitted 2-wide
            // horizontal tunnels and shaft-adjacent corridors, so
            // eggs rode upward through narrow excavated tunnels
            // and looked "ghostly" rising toward the surface. Real
            // broodpiles sit in wider chambers; the queen's
            // 5-wide pocket and any properly excavated chamber
            // satisfies both-laterals-AIR easily, so this doesn't
            // lock brood out of legitimate destinations.
            const wW = world.width;
            const leftIsSoil =
              ex > 0 && world.cells[newY * wW + (ex - 1)] === CELL_SOIL;
            const rightIsSoil =
              ex < wW - 1 && world.cells[newY * wW + (ex + 1)] === CELL_SOIL;
            const isChamber = !leftIsSoil && !rightIsSoil;
            if (
              newY >= 0 && newY < world.height &&
              world.cells[world.index(ex, newY)] === CELL_AIR &&
              isChamber
            ) {
              colony.posY[i] = colony.posY[i]! + dy;
            }
          }
        }
      }
      // Larval metabolism. Drain energy; on zero, the larva dies
      // and becomes a corpse cell at its position (just like a
      // starving adult). Workers may then haul the body to the
      // midden via the necrophoresis pathway.
      colony.energy[i]! -= species.larvaMetabolism;
      if (colony.energy[i]! <= 0) {
        colony.energy[i] = 0;
        colony.setState(i, STATE_DEAD);
        world.totalDied++;
        const wW = world.width;
        const lx = colony.posX[i]! | 0;
        const ly = colony.posY[i]! | 0;
        if (lx >= 0 && ly >= 0 && lx < wW && ly < world.height) {
          world.corpse[ly * wW + lx] = 1;
        }
        continue;
      }
      // Maturation: enough fed-and-growing time → pupa stage.
      // Real Pogonomyrmex larvae spin a cocoon and pupate before
      // emerging as adults; we route through STATE_PUPA so the
      // renderer shows a distinct cocoon shape and the ~2-week
      // pupal window is visible in the brood pile rather than
      // being hidden in the larva timer.
      if (colony.stateTicks[i]! >= species.larvaMatureTicks) {
        colony.setState(i, STATE_PUPA);
        // Pupae don't drain energy through metabolism; reset to a
        // healthy reserve so the maturation timer can run cleanly.
        colony.energy[i] = species.maxEnergy;
      }
      continue;
    }

    // Pupa. Stationary cocoon: no movement, no metabolism drain, no
    // trophallaxis. Just runs the maturation timer and emerges as
    // an adult worker once pupaMatureTicks have elapsed. Renderer
    // shows them as small white oblongs in the brood pile.
    if (stateNow === STATE_PUPA) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      colony.stateTicks[i]!++;
      if (colony.stateTicks[i]! >= species.pupaMatureTicks) {
        colony.setState(i, STATE_WANDER);
        colony.energy[i] = species.maxEnergy;
        colony.heading[i] = rng.range(0, Math.PI * 2);
        colony.age[i] = 0;
        world.totalBorn++;
      }
      continue;
    }

    // Queen. Stationary at her starter chamber. Lays an egg every
    // species.eggLayInterval ticks while alive, energy permitting,
    // and the colony is below maxColonySize. Hölldobler & Wilson
    // 1990 Ch. 5 (claustral founding); Tschinkel 1998 (P. barbatus
    // colony growth). She drains energy at 0.05× the worker rate —
    // real queens are well-fed via trophallaxis from attendants, but
    // we don't yet model attendant-orientation behaviour (e.g., a
    // queen-pheromone field), so workers reach her sporadically. The
    // very low drain ensures founding-queen survival even with
    // unreliable feeding; the trophallaxis pathway tops her up the
    // rest of the way when nestmates do happen by. Empirically the
    // previous 0.5× rate left the queen below the lay-energy
    // threshold by ~3 hours biological in small worlds.
    if (stateNow === STATE_QUEEN) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      // Queen migration. Real queens don't sit forever at one cell:
      // attendants jostle them within the brood chamber (Pratt 2005)
      // and the queen tracks the brood pile when nurses migrate it
      // for thermoregulation (Penick & Tschinkel 2008, P. badius).
      // Without movement she gets stranded when the brood pile
      // diel-migrates away, loses her trophallaxis ring, and the
      // colony decays even though brood and food are nominally fine.
      // We follow the same diurnal depth target the brood piles do
      // but at a 6× slower cadence — she's larger and harder to
      // budge. Same chamber constraint: she only steps into 3+ wide
      // passages, never the 1-cell entrance shaft.
      const QUEEN_MIGRATE_TICK = species.broodMigrateInterval * 6;
      if (
        colony.stateTicks[i]! > 0 &&
        colony.stateTicks[i]! % QUEEN_MIGRATE_TICK === 0
      ) {
        const qx = colony.posX[i]! | 0;
        const qyNow = colony.posY[i]! | 0;
        if (qx >= 0 && qx < world.width) {
          const surf = world.naturalSurface[qx]!;
          const day = daylight(world.tick);
          const targetDepth =
            species.broodMinDepth +
            (species.broodMaxDepth - species.broodMinDepth) * day;
          const targetY = surf + Math.round(targetDepth);
          let dy = 0;
          if (qyNow < targetY) dy = 1;
          else if (qyNow > targetY) dy = -1;
          if (dy !== 0) {
            const newY = qyNow + dy;
            // Queen passes through narrower spaces than the brood —
            // attendants jostle her through 1-cell connectors all
            // the time in lab observation. Drop the both-laterals
            // requirement to "destination is AIR and floor is
            // supported (not freefall)". Real queens DO move
            // through the access shaft, just slowly. Without this
            // relaxation the migration timer fires but every step
            // is rejected because the shaft is 1 cell wide.
            const supportedAtNew = newY + 1 >= world.height
              || world.cells[world.index(qx, newY + 1)] !== CELL_AIR;
            if (
              newY >= 0 && newY < world.height &&
              world.cells[world.index(qx, newY)] === CELL_AIR &&
              supportedAtNew
            ) {
              colony.posY[i] = qyNow + dy + 0.5;
            }
          }
        }
      }
      // Queen pheromone emission. Real ants emit non-volatile cuticular
      // hydrocarbons — Hölldobler & Wilson 1990 Ch. 7 list "queen
      // recognition substances" as one of the dozen-plus chemical
      // classes social insects use for caste signalling. Modelled
      // here as a slow-diffuse, very-low-evaporation field that
      // young workers (nurse caste, ageFrac < 0.5) bias their
      // heading along. Output is the visible broodpile crowd
      // around the queen — and reliable trophallaxis-driven feeding
      // of the queen herself (see the nurse-bias block in WANDER
      // stigmergy below).
      if (queenField) {
        const qx = colony.posX[i]! | 0;
        const qy = colony.posY[i]! | 0;
        if (qx >= 0 && qy >= 0 && qx < world.width && qy < world.height) {
          queenField.deposit(qx, qy, 0.10);
        }
      }
      // Queen energy drain. Real Pogonomyrmex queens have wing-
      // muscle reserves (Tschinkel 2006) that buffer them through
      // the founding phase. We model this as a tapered drain:
      // when energy ≥ 0.5 the queen draws on her reserve at 0.02×
      // metabolism (very slow), only ramping to the original
      // 0.05× when she's running low. This keeps a queen with
      // unreliable trophallaxis attendance alive long enough for
      // brood to mature without being trivially immortal.
      const drain = colony.energy[i]! >= 0.5 ? 0.02 : 0.05;
      colony.energy[i]! -= species.metabolism * drain;
      if (colony.energy[i]! <= 0) {
        // Queen death → colony doom. We mark her STATE_DEAD just
        // like a worker; brood production stops and the colony
        // fades over its remaining workforce lifetime.
        colony.energy[i] = 0;
        colony.setState(i, STATE_DEAD);
        world.totalDied++;
        const wW = world.width;
        const ix0 = colony.posX[i]! | 0;
        const iy0 = colony.posY[i]! | 0;
        if (ix0 >= 0 && iy0 >= 0 && ix0 < wW && iy0 < world.height) {
          world.corpse[iy0 * wW + ix0] = 1;
        }
        continue;
      }
      colony.stateTicks[i]!++;
      // Egg-laying: requires positive timer threshold + energy above
      // threshold + colony has slot capacity left. Egg appears at
      // queen's cell with stateTicks=0; the maturation handler above
      // will tick it through to adulthood.
      if (
        colony.stateTicks[i]! >= species.eggLayInterval &&
        // Lower threshold (0.2 vs the original 0.4) so a queen who's
        // had a long drought between trophallaxis bouts still keeps
        // brood production ticking. She uses ~10% energy per egg-
        // laying interval at the new metabolism, so 0.2 leaves room
        // for several lays before she'd actually starve.
        colony.energy[i]! > 0.2 &&
        colony.count < colony.capacity &&
        colony.count < species.maxColonySize
      ) {
        colony.stateTicks[i] = 0;
        const eggIdx = colony.spawn(
          colony.posX[i]!, colony.posY[i]!,
          rng.range(0, Math.PI * 2), rng,
          DEFAULT_PARAMS,
        );
        if (eggIdx >= 0) {
          colony.state[eggIdx] = STATE_EGG;
          colony.stateTicks[eggIdx] = 0;
          colony.age[eggIdx] = 0;
        }
      }
      continue;
    }

    colony.prevX[i] = colony.posX[i]!;
    colony.prevY[i] = colony.posY[i]!;
    let h = colony.heading[i]!;
    let stateIn: AntState = colony.state[i] as AntState;
    const ix = colony.posX[i]! | 0;
    const iy = colony.posY[i]! | 0;

    // Per-ant aging.
    colony.age[i]!++;

    // Caste-based polyethism (age polyethism). Mersch, Crespi &
    // Keller 2013 tracked individual Camponotus fellah workers
    // through nurse → cleaner → forager phases over weeks; Beshers
    // & Fewell 2001 review the broader principle. Three smooth
    // multipliers driven by ageFrac = age / matureAge, applied to
    // the relevant per-ant decisions. Floors are non-zero so even
    // freshly-spawned (age=0) ants retain some forage / dig capacity
    // — a hard zero would freeze the colony in tests where workers
    // are seeded young.
    //   - geoMult on belowGeotaxis: 1.0 → 0.3 across [0, 1].
    //     Young workers stay deep near brood; old workers roam
    //     shallow toward the surface.
    //   - forageMult on forageProb: 0.1 → 1.5 across [0, 1].
    //     Foraging is the senescent specialty (Mersch et al. found
    //     real workers transition to forager last).
    //   - digMult on digProb: bell curve, peaks 1.5 at ageFrac=0.5,
    //     floor 0.5 at the extremes. Excavation is the
    //     middle-aged specialty.
    // The earlier (pre-brood) version of this was reverted because
    // monotone aging without replenishment collapsed dig throughput
    // by old age. With egg → larva → adult brood now in, workers
    // are continuously replaced and the cohort balance is stable.
    const ageFrac = Math.min(1, colony.age[i]! / species.matureAge);
    // Sigmoid-stepped polyethism plateaus. Real Pogonomyrmex caste
    // transitions (Mirenda & Vinson 1981; Tschinkel 2006) aren't
    // smooth ramps — workers spend ~weeks on each role, then
    // transition over a ~few-day window. Soft sigmoids (logistic-
    // like) reproduce that better than the previous linear ramps:
    // each multiplier saturates inside its caste age range and
    // transitions sharply between phases. Centres at ageFrac
    // 0.3 (nurse → cleaner) and 0.65 (cleaner → forager) match
    // the published age-band proportions.
    const sig = (x: number, c: number, k: number): number =>
      1 / (1 + Math.exp(-k * (x - c)));
    // geoMult: 1.0 (young, dives deep with brood) → 0.3 (old,
    // shallow / outside). Centre 0.5, fairly sharp.
    const geoMult = 1.0 - 0.7 * sig(ageFrac, 0.5, 8);
    // forageMult: 0.1 (young) → 1.5 (old). Centre 0.65 — foraging
    // is the late-life specialty.
    const forageMult = 0.1 + 1.4 * sig(ageFrac, 0.65, 10);
    // Bell curve: 0.7 at the extremes, 1.5 at middle age. Floor of
    // 0.7 (rather than the more aggressive 0.5 originally tried)
    // keeps dig productivity from collapsing at age=0; the
    // excavator caste still has a clear 2× advantage.
    const digMult = 0.7 + 0.8 * (1 - 2 * Math.abs(ageFrac - 0.5));

    // Senescence: workers die of old age once they exceed
    // species.workerLifespan. Real Pogonomyrmex barbatus workers
    // average ~1 year (Hölldobler & Wilson 1990 Ch. 13); we
    // compress for observability.
    if (colony.age[i]! >= species.workerLifespan) {
      colony.energy[i] = 0;
      // Drop any cargo first (same logic as starvation death below).
      const wW = world.width;
      if (stateIn === STATE_CARRY || stateIn === STATE_CARRY_FOOD) {
        const cargoMoves = colony.carryMoves[i]!;
        const isFood = stateIn === STATE_CARRY_FOOD;
        const offsets: ReadonlyArray<readonly [number, number]> = [
          [0, 1], [0, -1], [1, 0], [-1, 0],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ];
        for (const [dx, dy] of offsets) {
          const nx = ix + dx;
          const ny = iy + dy;
          if (nx < 0 || ny < 0 || nx >= wW || ny >= world.height) continue;
          const nIdx = ny * wW + nx;
          if (world.cells[nIdx] !== CELL_AIR) continue;
          if (isFood) {
            if (world.food[nIdx]! > 0) continue;
            world.food[nIdx] = 1;
            world.foodMoves[nIdx] = Math.min(255, cargoMoves + 1);
          } else {
            placeGrain(world, nx, ny, rng, cargoMoves + 1);
          }
          break;
        }
      }
      colony.carryMoves[i] = 0;
      colony.setState(i, STATE_DEAD);
      world.totalDied++;
      if (ix >= 0 && iy >= 0 && ix < wW && iy < world.height) {
        world.corpse[iy * wW + ix] = 1;
      }
      continue;
    }

    // Homeostasis. Drain basal-metabolism energy; eat from any
    // food cell on contact when below the hunger threshold; die
    // (transition to STATE_DEAD + place a corpse marker) when
    // energy reaches zero. CARRY_FOOD ants don't eat their cargo
    // (they're committed to delivering); FORAGE/CARRY_GRAIN/REST
    // ants will if hungry. WANDER is the most common eater.
    colony.energy[i]! -= species.metabolism;
    if (colony.energy[i]! <= 0) {
      colony.energy[i] = 0;
      // Drop any carried cargo before becoming a corpse — otherwise
      // each dead carrier permanently sinks 1 grain or 1 seed and
      // grain conservation breaks. We try the 4 cardinal neighbours
      // (then diagonals as a fallback) for an empty AIR cell to drop
      // into. If absolutely nothing is reachable the cargo is lost,
      // but that's the genuine entombment edge case.
      const wW = world.width;
      if (stateIn === STATE_CARRY || stateIn === STATE_CARRY_FOOD) {
        const cargoMoves = colony.carryMoves[i]!;
        const isFood = stateIn === STATE_CARRY_FOOD;
        const offsets: ReadonlyArray<readonly [number, number]> = [
          [0, 1], [0, -1], [1, 0], [-1, 0],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ];
        for (const [dx, dy] of offsets) {
          const nx = ix + dx;
          const ny = iy + dy;
          if (nx < 0 || ny < 0 || nx >= wW || ny >= world.height) continue;
          const nIdx = ny * wW + nx;
          if (world.cells[nIdx] !== CELL_AIR) continue;
          if (isFood) {
            if (world.food[nIdx]! > 0) continue;
            world.food[nIdx] = 1;
            world.foodMoves[nIdx] = Math.min(255, cargoMoves + 1);
          } else {
            placeGrain(world, nx, ny, rng, cargoMoves + 1);
          }
          break;
        }
      }
      colony.carryMoves[i] = 0;
      colony.setState(i, STATE_DEAD);
      world.totalDied++;
      if (ix >= 0 && iy >= 0 && ix < wW && iy < world.height) {
        world.corpse[iy * wW + ix] = 1;
      }
      continue;
    }
    if (
      stateIn !== STATE_CARRY_FOOD &&
      colony.energy[i]! < species.hungerThreshold &&
      ix >= 0 && iy >= 0 && ix < world.width && iy < world.height
    ) {
      // Eat from current cell or any cardinal-adjacent food cell.
      // Adjacency is the realistic semantic — an ant in a tunnel
      // segment next to a granary doesn't need to walk INTO the
      // granary cell to grab a seed. Without this, ants starve
      // while standing one cell away from food.
      const wW = world.width;
      let fIdx = -1;
      const here = iy * wW + ix;
      if (world.food[here]! > 0) fIdx = here;
      else if (ix > 0 && world.food[here - 1]! > 0) fIdx = here - 1;
      else if (ix < wW - 1 && world.food[here + 1]! > 0) fIdx = here + 1;
      else if (iy > 0 && world.food[here - wW]! > 0) fIdx = here - wW;
      else if (iy < world.height - 1 && world.food[here + wW]! > 0) fIdx = here + wW;
      if (fIdx >= 0) {
        world.food[fIdx] = 0;
        world.foodMoves[fIdx] = 0;
        colony.energy[i] = Math.min(
          species.maxEnergy,
          colony.energy[i]! + species.foodValue,
        );
      }
    }

    // REST tick. The Aina et al. 2023 model has withdrawn ants
    // wandering AWAY from the crowd — not freezing — so the ant
    // moves with correlated random walk only (no stigmergy
    // recruitment, no geotaxis). They can't dig and can't pick up
    // grain. After restDuration ticks the ant resumes WANDER with
    // a cleared collision count.
    if (stateIn === STATE_REST) {
      colony.stateTicks[i]!++;
      if (colony.stateTicks[i]! >= params.restDuration) {
        colony.setState(i, STATE_WANDER);
        colony.collisionCount[i] = 0;
        // Fresh random heading. Without this, the exiting ant keeps
        // the heading it had when it entered REST — which was, by
        // construction, pointing INTO the crowd that exhausted it.
        // Combined with the dig-pheromone gradient drawing ants
        // toward active fronts, that produces sticky feedback loops
        // where the same ants cycle through REST → WANDER → REST in
        // the same crowded chamber. A uniform-random reset breaks
        // the loop without overcommitting to any specific dispersal
        // direction.
        colony.heading[i] = rng.range(0, Math.PI * 2);
        // Update the local stateIn so the rest of the per-ant body
        // sees STATE_WANDER this tick. Without this, the freshly-
        // resumed ant gets one tick of "neither REST nor WANDER"
        // behaviour (no foraging roll, no collision-overload, no
        // stigmergy bias — only geotaxis and movement run).
        stateIn = STATE_WANDER;
      } else {
        // Random-walk step. Move-only; no stigmergy bias.
        h += rng.gauss() * colony.turnNoise[i]!;
        colony.heading[i] = wrapAngle(h);
        let nx = colony.posX[i]!;
        let ny = colony.posY[i]!;
        for (let s = 0; s < subSteps; s++) {
          const dx = Math.cos(h) * stepLen;
          const dy = Math.sin(h) * stepLen;
          const r = tryStep(world, nx, ny, dx, dy);
          nx = r.x; ny = r.y;
          if (r.hitSoil) {
            h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
            colony.heading[i] = h;
          }
        }
        colony.posX[i] = nx;
        colony.posY[i] = ny;
        continue;
      }
    }

    // FORAGE tick. Negative geotaxis drives the ant out of the nest;
    // once on the surface, it patrols via correlated random walk.
    // No stigmergy (the dig pheromone gradient that pulls WANDER
    // ants in would defeat the whole point of leaving). On surface
    // contact with a food cell, transition to CARRY_FOOD. After
    // forageDuration ticks without finding food, return to WANDER
    // (the patrol returned empty-handed).
    //   Hölldobler & Wilson (1990), The Ants, Ch. 8: Foraging.
    //   Gordon (1989). Dynamics of task switching in harvester ants.
    if (stateIn === STATE_FORAGE) {
      colony.stateTicks[i]!++;
      // Trip ends on EITHER a fixed-duration timeout OR the
      // species' active phase ending. Real diurnal harvester
      // foragers head home at sunset rather than continuing to
      // patrol (Gordon 1991), so when forageActivity drops to
      // ~0 we send them back. We use 0.05 not 0 so the threshold
      // crosses cleanly through the dawn/dusk shoulder rather
      // than flipping a tick before the daylight curve does.
      //
      // Scout-mode duration extension (FIX G). When the colony has
      // no trail pheromone yet (foragerReturnRate near zero), the
      // standard 100-tick trip is barely enough to get from the
      // chamber to the surface (10 cells × 10 ticks/cell at walk
      // speed). The forager exits, takes a few steps, and is
      // recalled before searching properly. Real Pogonomyrmex
      // foundress colonies do "scout" trips that last 10–30 min
      // (Gordon 2010 Ch. 4) — much longer than the steady-state
      // patrol cadence. Extend forageDuration by 5× while the
      // return-rate is sub-bootstrap; once trips are succeeding,
      // the standard short cadence resumes.
      const scoutMode = world.foragerReturnRate < 0.05;
      const effectiveForageDuration = scoutMode
        ? species.forageDuration * 5
        : species.forageDuration;
      if (
        colony.stateTicks[i]! >= effectiveForageDuration ||
        forageActivity < 0.05
      ) {
        colony.setState(i, STATE_WANDER);
        colony.collisionCount[i] = 0;
        // Reset heading toward the nest entrance so the trip
        // unwinds in a sensible direction (positive geotaxis
        // does the rest from below the surface).
        colony.heading[i] = Math.PI / 2 + rng.range(-0.3, 0.3);
      } else {
        h += rng.gauss() * colony.turnNoise[i]!;
        // Below natural surface: hard upward bias toward exit. Above
        // surface: pure random walk on the open ground, OR — if a
        // foraging trail pheromone gradient is available — bias up
        // the trail toward whatever food source the returning carrier
        // marked. Bonabeau et al. 1998: foragers follow the recruit
        // pheromone gradient laid by successful returners; the
        // result is the visible "ant column" converging on a food
        // patch. We multiply the bias by min(1, trail/0.05) so the
        // ant only commits to a trail with measurable concentration.
        if (iy >= world.naturalSurface[ix]!) {
          h += wrapAngle(-Math.PI / 2 - h) * geotaxis;
        } else {
          // Direct food-sensing (FIX F). Real Pogonomyrmex foragers
          // detect seeds via volatile chemicals at ~3–5 cm distance
          // (Gordon 2010, Ch. 4 on harvester olfactory foraging). At
          // our 3 mm/cell scale that's ~10–17 cells of sniff radius.
          // Without this, foragers above-ground rely entirely on
          // trail pheromone to find food — but the first trip has
          // no trail to follow, so the bootstrap fails: trips abort
          // at forageDuration without locating sparse food. Scan a
          // 10-cell box for the nearest food cell and bias heading
          // toward it; combine with trail/trunk biases below for the
          // typical multi-source compass average. Cheap: 21×21 = 441
          // cell-reads per forager per tick is fine for the small
          // forager subset.
          let sniffX = 0, sniffY = 0, sniffD = 121; // 11² = max
          const sniffR = 10;
          const wWf = world.width;
          for (let dy2 = -sniffR; dy2 <= sniffR; dy2++) {
            for (let dx2 = -sniffR; dx2 <= sniffR; dx2++) {
              const cx2 = ix + dx2;
              const cy2 = iy + dy2;
              if (cx2 < 0 || cy2 < 0 || cx2 >= wWf || cy2 >= world.height) continue;
              if (world.food[cy2 * wWf + cx2]! === 0) continue;
              const d2 = dx2 * dx2 + dy2 * dy2;
              if (d2 < sniffD) { sniffD = d2; sniffX = dx2; sniffY = dy2; }
            }
          }
          if (sniffD < 121 && sniffD > 0) {
            const want = Math.atan2(sniffY, sniffX);
            // Strong bias — the food is right there. Stigmergy weight
            // matches the alarm-pheromone urgency (1.8) since a hungry
            // colony in bootstrap mode treats finding food as critical.
            h += wrapAngle(want - h) * Math.min(1, colony.stigmergy[i]! * 1.5);
          }
          if (trailField) {
            const grad = trailField.gradient(ix, iy);
            const gMag = Math.hypot(grad.dx, grad.dy);
            if (gMag > 1e-5) {
              const want = Math.atan2(grad.dy, grad.dx);
              const local = trailField.sample(ix, iy);
              const strength = Math.min(1, local / 0.05) * colony.stigmergy[i]!;
              h += wrapAngle(want - h) * strength;
            }
          }
          // Trunk-trail bias. Layered atop the volatile trail
          // pheromone — even when the volatile trail has decayed,
          // the long-half-life trunk continues to point foragers
          // at known-good patches. Lower weight than trailField
          // since the trunk reflects historical paths, not the
          // current expedition.
          if (trunkField) {
            const tGrad = trunkField.gradient(ix, iy);
            const tMag = Math.hypot(tGrad.dx, tGrad.dy);
            if (tMag > 1e-5) {
              const want = Math.atan2(tGrad.dy, tGrad.dx);
              h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.3;
            }
          }
        }
        h = wrapAngle(h);
        colony.heading[i] = h;
        let nx = colony.posX[i]!;
        let ny = colony.posY[i]!;
        for (let s = 0; s < subSteps; s++) {
          const dx = Math.cos(h) * stepLen;
          const dy = Math.sin(h) * stepLen;
          const r = tryStep(world, nx, ny, dx, dy);
          nx = r.x; ny = r.y;
          if (r.hitSoil) {
            h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
            colony.heading[i] = h;
          }
        }
        colony.posX[i] = nx;
        colony.posY[i] = ny;
        // Food contact: any food cell within 2-cell radius triggers
        // a pickup. Discrete grab — no probability, foragers
        // actively collect on contact (Gordon 2010, Ch. 4). The
        // generous radius matches real harvester foraging — they
        // don't have to land exactly on the seed; they smell it
        // and walk over. Without it, foragers regularly fail to
        // notice piles of seeds 1-2 cells off their random-walk
        // path.
        const fx = nx | 0;
        const fy = ny | 0;
        const wW = world.width;
        let fIdx = -1;
        let bestD2 = 9; // max 2-cell radius (3² for safety)
        for (let dy = -2; dy <= 2 && fIdx < 0; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const cx = fx + dx, cy = fy + dy;
            if (cx < 0 || cy < 0 || cx >= wW || cy >= world.height) continue;
            const d2 = dx * dx + dy * dy;
            if (d2 > 5) continue; // Euclidean radius ~2.24
            if (world.food[cy * wW + cx]! > 0 && d2 < bestD2) {
              fIdx = cy * wW + cx;
              bestD2 = d2;
              if (d2 === 0) break; // can't beat zero distance
            }
          }
        }
        if (fIdx >= 0) {
          colony.carryMoves[i] = world.foodMoves[fIdx]!;
          // Strong trail anchor at the pickup site. Bonabeau et al.
          // 1998: the source location gets a heavier deposit than
          // the path, so the gradient sharpens at the food rather
          // than smearing along the trail. 1.0 vs 0.10 per-step.
          if (trailField) {
            const fy = (fIdx / world.width) | 0;
            const fxx = fIdx - fy * world.width;
            trailField.deposit(fxx, fy, 1.0);
            // Trunk-trail: long-half-life persistent path. Each
            // pickup contributes a small amount; over many trips
            // the cumulative concentration on a stable food
            // patch's path saturates and reads as a "highway"
            // even after the volatile foraging trail has decayed.
            if (trunkField) trunkField.deposit(fxx, fy, 0.10);
          }
          world.food[fIdx] = 0;
          world.foodMoves[fIdx] = 0;
          colony.setState(i, STATE_CARRY_FOOD);
          // Re-orient downward — head back to the nest.
          colony.heading[i] = Math.PI / 2 + rng.range(-0.3, 0.3);
        }
        continue;
      }
    }

    // CARRY_FOOD tick. Positive geotaxis drives the ant DOWN into
    // the nest; on reaching a below-surface AIR cell it deposits
    // the seed (creating a new food cell with foodMoves = carry+1)
    // and returns to WANDER. Granaries emerge naturally where ants
    // happen to drop their loads — Tschinkel (2004) found that real
    // Pogonomyrmex badius granaries form at consistent depths
    // without any explicit chamber-allocation rule.
    if (stateIn === STATE_CARRY_FOOD) {
      h += rng.gauss() * colony.turnNoise[i]!;
      // Below or above surface, bias DOWN (positive geotaxis).
      h += wrapAngle(Math.PI / 2 - h) * geotaxis;
      // Brood emergency rerouting (FIX H). Standard CARRY_FOOD
      // behaviour heads down via geotaxis and biases toward
      // granaryField for storage. But a colony with starving
      // larvae needs food delivered to the BROOD PILE first,
      // not stored in the granary. Real nurses prioritise direct
      // larva-feeding over storage when brood is hungry (Cassill
      // 2002 on S. invicta brood-care allocation). When at least
      // one larva is below trophallaxisRecipientThreshold, swap
      // the granary bias for a brood-pheromone bias: the carrier
      // goes to the broodpile, deposits food there (the granary
      // emerges naturally around the broodpile via positive
      // feedback from later deposits), and walks past hungry
      // larvae who then trophallax it. This couples the foraging
      // pipeline directly to brood feeding instead of going via
      // a separate granary chamber that may be far from larvae.
      if (broodStarving && broodField && iy >= world.naturalSurface[ix]!) {
        const bGrad = broodField.gradient(ix, iy);
        const bMag = Math.hypot(bGrad.dx, bGrad.dy);
        if (bMag > 1e-5) {
          const want = Math.atan2(bGrad.dy, bGrad.dx);
          // Stronger weight than granary (0.4×) because the
          // emergency response is urgent. 0.7 brings carriers
          // toward the brood pile reliably.
          h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.7;
        }
      } else if (granaryField && iy >= world.naturalSurface[ix]!) {
        // Granary attraction. Once the ant is below the surface,
        // bias toward the granary-marker gradient — established
        // granaries pull subsequent deposits toward them, producing
        // the consistent-depth seed caches Tschinkel observed.
        const gGrad = granaryField.gradient(ix, iy);
        const gMag = Math.hypot(gGrad.dx, gGrad.dy);
        if (gMag > 1e-5) {
          const want = Math.atan2(gGrad.dy, gGrad.dx);
          h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.4;
        }
      }
      h = wrapAngle(h);
      colony.heading[i] = h;
      let nx = colony.posX[i]!;
      let ny = colony.posY[i]!;
      let cfHitSoil = false;
      for (let s = 0; s < subSteps; s++) {
        const dx = Math.cos(h) * stepLen;
        const dy = Math.sin(h) * stepLen;
        const r = tryStep(world, nx, ny, dx, dy);
        nx = r.x; ny = r.y;
        if (r.hitSoil) {
          cfHitSoil = true;
          h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
          colony.heading[i] = h;
        }
      }
      colony.posX[i] = nx;
      colony.posY[i] = ny;
      // Stuck-tick tracking. Asymmetric counter so an ant thrashing
      // between two cells (a "stuck" tick of bouncing into a wall
      // alternated with a "progress" tick of falling back into the
      // same pocket) still accumulates toward the give-up threshold.
      // +2 on stuck, -1 on progress: pure-stuck ants bail in ~30
      // ticks; 50/50 thrashers bail in ~120; ants making real
      // progress never accumulate (clamped at 0).
      const newAxF = nx | 0;
      const newAyF = ny | 0;
      const stuckThisTickF =
        cfHitSoil && newAxF === ix && newAyF === iy;
      if (stuckThisTickF) {
        colony.stuckTicks[i] = Math.min(255, colony.stuckTicks[i]! + 2);
      } else if (colony.stuckTicks[i]! > 0) {
        colony.stuckTicks[i]!--;
      }
      // Give-up: a CARRY_FOOD ant who's been jammed against a wall
      // for ~7 sec biological drops her cargo at an adjacent AIR
      // cell, transitions to WANDER, and joins the dig effort. The
      // alarm-pheromone responders piling up around her can then
      // actually relieve the obstruction instead of compounding it.
      const STUCK_GIVE_UP_TICKS = 60;
      // Long-CARRY bail (FIX I). The stuckTicks accumulator only
      // bumps on hitSoil+no-cell-change ticks; a worker walking back
      // and forth in a narrow shaft section can stay in CARRY for
      // thousands of ticks without ever accumulating stuckTicks.
      // Headless monitoring at t=180k showed 11/13 CARRY workers
      // stuck >2000 ticks unable to deposit. Extra bail on
      // stateTicks: 4000 ticks in CARRY (~50 sim-minutes biological
      // at 100× compression) → drop cargo at the first available
      // neighbour, bail to WANDER. Releases the workforce so it can
      // forage / re-dig instead of treadmilling.
      if (colony.stuckTicks[i]! >= STUCK_GIVE_UP_TICKS || colony.stateTicks[i]! >= 4000) {
        const wW = world.width;
        const cargoMoves = colony.carryMoves[i]!;
        const offsetsCF: ReadonlyArray<readonly [number, number]> = [
          [0, 1], [0, -1], [1, 0], [-1, 0],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ];
        for (const [dxx, dyy] of offsetsCF) {
          const px = newAxF + dxx;
          const py = newAyF + dyy;
          if (px < 0 || py < 0 || px >= wW || py >= world.height) continue;
          const pIdx = py * wW + px;
          if (world.cells[pIdx] !== CELL_AIR) continue;
          if (world.food[pIdx]! > 0) continue;
          world.food[pIdx] = 1;
          world.foodMoves[pIdx] = Math.min(255, cargoMoves + 1);
          break;
        }
        colony.carryMoves[i] = 0;
        colony.stuckTicks[i] = 0;
        colony.setState(i, STATE_WANDER);
        colony.heading[i] = rng.range(0, Math.PI * 2);
        continue;
      }
      // Stranded-forager alarm. A CARRY_FOOD ant that hits soil
      // above the natural surface is being denied entry to the nest
      // (e.g. the entrance is buried by a grain cascade). Each bump
      // emits a small alarm puff at the ant's cell; sustained
      // bumping accumulates a real signal that diffuses through the
      // soil and pulls underground workers up to dig her in.
      // Hölldobler & Wilson (1990) Ch. 7 on alarm/recruitment.
      if (cfHitSoil && alarmField) {
        const ax2 = nx | 0;
        const ay2 = ny | 0;
        if (ay2 < world.naturalSurface[ax2]!) {
          alarmField.deposit(ax2, ay2, 0.05);
        }
      }
      // Recruitment trail. CARRY_FOOD ants returning from a food
      // source lay a small amount of trail pheromone at every
      // step. This is the classical Bonabeau et al. 1998 mechanism
      // that turns successful foraging trips into recruitment
      // signals: the trip backwards from food draws a fading
      // breadcrumb chain that other foragers can read on their
      // outbound trip. Strongest near the food source (the trail
      // accumulates as bouts converge there) and decays along the
      // return path. Only deposit above the surface — underground
      // recruitment goes via dig pheromone, not trail.
      if (trailField) {
        const tx = nx | 0;
        const ty = ny | 0;
        if (ty < world.naturalSurface[tx]!) {
          trailField.deposit(tx, ty, 0.10);
          // Persistent trunk-trail accumulates with every
          // returning forager along this path. Smaller per-step
          // than the volatile trail (0.02 vs 0.10) but with much
          // longer retention so a frequented route consolidates
          // into a stable highway over many trips.
          if (trunkField) trunkField.deposit(tx, ty, 0.02);
        }
      }
      // Deposit if we're in a below-surface AIR cell with no food
      // already there.
      const dxIdx = nx | 0;
      const dyIdx = ny | 0;
      const dIdx = dyIdx * world.width + dxIdx;
      if (
        dyIdx > world.naturalSurface[dxIdx]! &&
        world.cells[dIdx] === CELL_AIR &&
        world.food[dIdx] === 0
      ) {
        world.food[dIdx] = 1;
        world.foodMoves[dIdx] = Math.min(255, colony.carryMoves[i]! + 1);
        // Granary marker. Tschinkel (2004) observed P. badius
        // granaries form at consistent depths via positive
        // feedback — CARRY_FOOD ants prefer to deposit where
        // deposits already happened. Strong stamp at the deposit
        // cell builds the gradient that biases the next CARRY_FOOD
        // ant toward this column.
        if (granaryField) granaryField.deposit(dxIdx, dyIdx, 1.0);
        // Greene & Gordon 2007 antennation feedback. A successful
        // round trip is the signal that activates the next forager
        // departure. Pulse the global counter; the forage roll
        // higher up the loop reads it as a multiplicative boost.
        world.foragerReturnRate += 1;
        colony.carryMoves[i] = 0;
        colony.setState(i, STATE_WANDER);
        colony.heading[i] = rng.range(0, Math.PI * 2);
      }
      continue;
    }

    // NECRO_CARRY tick. Hauling a corpse out of the nest. Below-
    // surface: negative geotaxis (head UP) to exit the chamber.
    // Above-surface: random walk on the surface to drift away from
    // the nest entrance. Drop the body once we're (a) above the
    // natural surface, (b) on intact ground, and (c) past the
    // species.necroHaulMinTicks gate so the drop spot is some
    // distance from the door.
    //   Wilson, E. O., Durlach, N. I. & Roth, L. M. (1958). Chemical
    //   releaser of necrophoric behavior in ants. Psyche 65: 108–114.
    //   Hart, A. G. & Ratnieks, F. L. W. (2002). Waste management in
    //   the leaf-cutting ant Atta colombica. Behav Ecol. 13: 224–231.
    if (stateIn === STATE_NECRO_CARRY) {
      colony.stateTicks[i]!++;
      h += rng.gauss() * colony.turnNoise[i]!;
      // Below or at surface: hard upward bias toward exit. Above
      // surface: pure random walk (drift the body away from the
      // entrance). Mirror of the FORAGE outbound geometry.
      if (iy >= world.naturalSurface[ix]!) {
        h += wrapAngle(-Math.PI / 2 - h) * geotaxis;
      }
      h = wrapAngle(h);
      colony.heading[i] = h;
      let nx = colony.posX[i]!;
      let ny = colony.posY[i]!;
      for (let s = 0; s < subSteps; s++) {
        const dx = Math.cos(h) * stepLen;
        const dy = Math.sin(h) * stepLen;
        const r = tryStep(world, nx, ny, dx, dy);
        nx = r.x; ny = r.y;
        if (r.hitSoil) {
          h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
          colony.heading[i] = h;
        }
      }
      colony.posX[i] = nx;
      colony.posY[i] = ny;
      const dxIdx = nx | 0;
      const dyIdx = ny | 0;
      if (
        dxIdx >= 0 && dyIdx >= 0 && dxIdx < world.width && dyIdx < world.height
      ) {
        // Drop position: settle the body downward from the ant's
        // current cell to the lowest AIR cell with a non-AIR (or
        // existing-corpse) cell directly beneath. Real bodies don't
        // hover. Without this, a carrier walking along the top of a
        // grain mound — or hovering during a single tick before
        // gravity kicks in at end-of-tick — leaves her cargo at her
        // body row instead of on the substrate.
        let landY = dyIdx;
        while (
          landY + 1 < world.height &&
          world.cells[(landY + 1) * world.width + dxIdx] === CELL_AIR &&
          world.corpse[(landY + 1) * world.width + dxIdx] === 0
        ) {
          landY++;
        }
        const dIdx = landY * world.width + dxIdx;
        const aboveSurface = landY < world.naturalSurface[dxIdx]!;
        const groundIsIntact =
          world.cells[world.index(dxIdx, world.naturalSurface[dxIdx]!)] !== CELL_AIR;
        const cellIsAir = world.cells[dIdx] === CELL_AIR;
        const noCorpseHere = world.corpse[dIdx]! === 0;
        if (
          aboveSurface && groundIsIntact && cellIsAir && noCorpseHere &&
          colony.stateTicks[i]! >= species.necroHaulMinTicks &&
          // Probabilistic drop while on the surface so the deposit
          // point isn't always the first valid air cell. Distributes
          // bodies across a few cells of midden rather than
          // stacking them all at one column.
          rng.next() < 0.05
        ) {
          world.corpse[dIdx] = 1;
          colony.setState(i, STATE_WANDER);
          colony.heading[i] = Math.PI / 2 + rng.range(-0.3, 0.3);
        }
      }
      continue;
    }

    // No-entry deposit. Robinson, Jackson, Holcombe & Ratnieks
    // 2005: Pharaoh-ant workers who explored a branch without
    // success leave a "skip me" mark. We use stateTicks as the
    // proxy for "unproductive duration" — a WANDER ant resets her
    // timer on entering CARRY/REST/etc, so high stateTicks means
    // "I've been wandering this region without doing anything for
    // a long time". 600 ticks ≈ 72 sec biological (100× compressed
    // from the ~2 hr real-time threshold ants typically take to
    // give up on a branch). Other workers' WANDER stigmergy biases
    // AWAY from the gradient so dead ends gradually clear of
    // traffic.
    if (
      stateIn === STATE_WANDER && noEntryField &&
      colony.stateTicks[i]! > 600 &&
      ix >= 0 && iy >= 0 && ix < world.width && iy < world.height
    ) {
      noEntryField.deposit(ix, iy, 0.005);
    }

    // Sprout removal. WANDER ants standing on or cardinally
    // adjacent to a sprout cell clear it (real ants either eat or
    // remove accidental germinations from the granary; Tschinkel
    // 1999). Adjacency mirrors the food-pickup pattern: an ant in
    // a tunnel one cell away from a sprout shouldn't walk past it
    // forever just because their continuous-position cell didn't
    // exactly land on the sprout. No state transition; the ant
    // just continues its current behaviour.
    if (
      stateIn === STATE_WANDER &&
      ix >= 0 && iy >= 0 && ix < world.width && iy < world.height
    ) {
      const wW = world.width;
      const here = iy * wW + ix;
      let sIdx = -1;
      if (world.sprout[here]! > 0) sIdx = here;
      else if (ix > 0 && world.sprout[here - 1]! > 0) sIdx = here - 1;
      else if (ix < wW - 1 && world.sprout[here + 1]! > 0) sIdx = here + 1;
      else if (iy > 0 && world.sprout[here - wW]! > 0) sIdx = here - wW;
      else if (iy < world.height - 1 && world.sprout[here + wW]! > 0) sIdx = here + wW;
      if (sIdx >= 0 && rng.next() < 0.5) {
        world.sprout[sIdx] = 0;
      }
    }

    // Necrophoresis pickup. WANDER ants on (or cardinally adjacent
    // to) a corpse cell roll species.necrophoresisProb. On success,
    // the corpse marker is cleared from world and the ant becomes
    // STATE_NECRO_CARRY — the haul logic in its own block above
    // handles the trip out of the nest. Wilson et al. (1958) showed
    // the response is contact-triggered, not gradient-followed.
    if (stateIn === STATE_WANDER && species.necrophoresisProb > 0) {
      const wW = world.width;
      // Cell-or-cardinal-adjacent — mirror of the food-pickup
      // adjacency logic. Pure cell-only is too narrow; agents at
      // continuous positions sub-cell-cross before sampling.
      let cIdx = -1;
      const here = iy * wW + ix;
      if (ix >= 0 && iy >= 0 && ix < wW && iy < world.height && world.corpse[here]! > 0) cIdx = here;
      else if (ix > 0 && world.corpse[here - 1]! > 0) cIdx = here - 1;
      else if (ix < wW - 1 && world.corpse[here + 1]! > 0) cIdx = here + 1;
      else if (iy > 0 && world.corpse[here - wW]! > 0) cIdx = here - wW;
      else if (iy < world.height - 1 && world.corpse[here + wW]! > 0) cIdx = here + wW;
      if (cIdx >= 0 && rng.next() < species.necrophoresisProb) {
        world.corpse[cIdx] = 0;
        colony.setState(i, STATE_NECRO_CARRY);
        // Head upward to start the trip out of the nest.
        colony.heading[i] = -Math.PI / 2 + rng.range(-0.3, 0.3);
        continue;
      }
    }

    // WANDER ants underground roll the foraging-trip transition.
    // Above-surface WANDER ants are already on the way back into
    // the nest (positive geotaxis below) so we don't pull them
    // back out immediately. Probability is constant per Mersch et
    // al.; the age-modulation was reverted (see comment at age++
    // above). Diurnal species (HARVESTER) only roll at daylight;
    // nocturnal species at darkness — see `forageActivity` above.
    // Small-colony forage damper. With only a handful of workers
    // alive, sending any of them outside on a foraging trip leaves
    // the queen unattended (no trophallaxis donor, no brood-pile
    // assistance). Real Pogonomyrmex founding colonies foraging at
    // this scale show 1-2 trips/day rather than the steady-state
    // sortie rate. Scale forageProb down sharply when aliveWorkers
    // is below SMALL_COLONY: 0.05× at 5 workers ramping linearly to
    // full rate at SMALL_COLONY=30.
    const smallForageMult = isSmallColony
      ? Math.max(0.05, aliveWorkers / SMALL_COLONY)
      : 1.0;
    // Food-visible recruitment. When seeds are sitting on the
    // surface (or in granaries) the colony "knows" food is around
    // — successful returners' trail pheromone, granary-pheromone
    // halos, antennation between nestmates. Boost the per-tick
    // forage roll 5× when standing inventory is positive. Without
    // this, base forageProb at 8.3e-4/tick gates so few WANDERers
    // (most workers are stuck in CARRY) into FORAGE that the
    // colony can starve while sitting on a pile of seeds.
    const foodVisibleBoost = world.foodCountCached > 0 ? 5.0 : 1.0;
    // Starvation emergency. When average alive worker energy drops
    // below 0.4 the colony is in real trouble — half of the workers
    // are running on fumes and the queen's drain is starting to
    // outpace incoming trophallaxis. Real colonies respond to
    // crises by mobilising more foragers (Gordon 2010, Ch. 5
    // discusses the "tactile" recruitment cascade triggered by
    // hungry workers' antennation rate). Boost forage rolls 3×
    // until the average recovers. Computed lazily per tick from
    // the same loop that already needed alive counts; effectively
    // free.
    let totalEnergy = 0, energyN = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i]!;
      if (s === STATE_DEAD || s === STATE_EGG || s === STATE_LARVA || s === STATE_QUEEN) continue;
      totalEnergy += colony.energy[i]!;
      energyN++;
    }
    const avgEnergy = energyN > 0 ? totalEnergy / energyN : 1;
    const starvationBoost = avgEnergy < 0.4 ? 3.0 : 1.0;
    // Greene & Gordon 2007 antennation-rate boost. Each recent
    // successful CARRY_FOOD return increments world.foragerReturnRate;
    // it decays multiplicatively each tick. A single recent return
    // gives ~2× boost, a busy session with several returns per
    // biological-second saturates around 5×. The signal is what
    // sustains forager outflow during an active patch — and lets
    // foraging cool down naturally when trips stop succeeding (the
    // colony "knows" the patch is depleted without anyone tracking
    // it explicitly).
    const inboundBoost = 1 + Math.min(4, world.foragerReturnRate * 0.5);
    // Founding-phase forage override (FIX A). The Greene & Gordon
    // antennation feedback loop bootstraps from successful returns —
    // but a colony with no returns yet (foragerReturnRate ≈ 0) gets
    // no boost from it. Combined with CARRY-state lock-in (workers
    // emerge → hit chamber wall → become CARRY → stay CARRY for
    // hundreds of ticks → never reach the surface to roll FORAGE),
    // the bootstrap NEVER happens. Headless monitoring showed zero
    // successful trips for 270k ticks despite 28 workers and visible
    // surface seeds. Force the issue: when the colony has workers
    // and food is in sight but no returns have succeeded, boost the
    // forage roll so SOMEONE leaves. The override goes away as soon
    // as the first trip lands — the inboundBoost takes over.
    //
    // Boost magnitude tuned at 10×: a follow-up monitoring run at
    // 50× sent every adult worker outside at once and 6 of the
    // first 9 emergents died on the surface before the queen could
    // raise replacements. 10× still bootstraps within a few ticks
    // of food becoming visible without depopulating the chamber.
    const foundingOverride =
      world.foragerReturnRate < 0.01 &&
      world.foodCountCached > 0 &&
      aliveWorkers > 0
        ? 10
        : 1;
    // Founding patroller bias (FIX E). In small colonies (<30
    // workers), everyone is a generalist — there's no nurse-vs-
    // forager caste yet (Wilson 1971 polyethism review). The
    // existing smallForageMult was a DAMPENER (0.05 at 5 workers)
    // that kept founding colonies from sending too many workers
    // outside. But in practice this stacks with CARRY-saturation
    // and produces the bootstrap deadlock from FIX A. Replace the
    // dampener: in small colonies, KEEP the base rate but add a
    // mild boost (×2) so freshly-emerged workers reliably reach
    // the surface before the dig pheromone routes them back. The
    // damper survives in the foundingPatrollerBoost cap (no infinite
    // amplification) and is bounded by smallForageMult itself.
    const foundingPatrollerBoost = isSmallColony ? 2 : 1;
    // Forage roll fires for both below-surface AND above-surface
    // WANDER ants (FIX J). Previously the gate required iy >=
    // naturalSurface (worker at or below the surface row), which
    // excluded any worker who'd already exited the chamber to drop
    // spoil. Headless monitoring showed surface workers in WANDER
    // permanently stuck above-ground — they couldn't roll forage,
    // had no food-sniff bias, and just random-walked indefinitely
    // far from the entrance. Above-surface workers ARE in foraging
    // position; let them commit to a search by transitioning to
    // FORAGE, where the food-sniff bias kicks in and pulls them
    // toward visible seeds. Foragers who started above-ground keep
    // the same heading (no need to reset to "head up" — they're
    // already up).
    if (stateIn === STATE_WANDER &&
        rng.next() < species.forageProb * forageActivity * forageMult * smallForageMult * foodVisibleBoost * starvationBoost * inboundBoost * foundingOverride * foundingPatrollerBoost) {
      colony.setState(i, STATE_FORAGE);
      colony.collisionCount[i] = 0;
      // Heading: if below surface, head UP to start the trip; if
      // already above, keep the current heading and let the food-
      // sniff bias steer the search.
      if (iy >= world.naturalSurface[ix]!) {
        colony.heading[i] = -Math.PI / 2 + rng.range(-0.3, 0.3);
      }
      continue;
    }

    // WANDER ants overloaded by collisions enter REST. CARRY ants
    // are committed to deposit and ignore the agitation signal —
    // real laden foragers don't drop their cargo to rest.
    if (stateIn === STATE_WANDER && colony.collisionCount[i]! > colony.restThreshold[i]!) {
      colony.setState(i, STATE_REST);
      continue;
    }

    // (1) Correlated random walk — Gaussian heading perturbation.
    h += rng.gauss() * colony.turnNoise[i]!;

    // (2) Stigmergy — bias toward the gradient of the field for our
    // current state. WANDER follows dig pheromone (recruit to active
    // dig sites); CARRY follows build pheromone (recruit to existing
    // mounds for deposit). Alarm pheromone, when present and
    // strong enough, OVERRIDES the routine field for WANDER ants —
    // a buried-entrance distress signal beats the normal dig
    // recruitment and pulls workers to the obstruction.
    const field = stateIn === STATE_WANDER ? digField : buildField;
    let routedByAlarm = false;
    if (stateIn === STATE_WANDER && alarmField) {
      const aLocal = alarmField.sample(ix, iy);
      const aGrad = alarmField.gradient(ix, iy);
      const aMag = Math.hypot(aGrad.dx, aGrad.dy);
      // Threshold tuned so casual chamber-wall bumps (which deposit
      // small-and-decay-fast amounts) don't divert the colony, but
      // a sustained distress source builds enough local concentration
      // to override.
      if (aLocal > 0.08 && aMag > 1e-5) {
        const want = Math.atan2(aGrad.dy, aGrad.dx);
        // Stronger weight than routine stigmergy: alarm response is
        // urgent (Hölldobler & Wilson 1990 Ch. 7).
        h += wrapAngle(want - h) * Math.min(1, colony.stigmergy[i]! * 1.8);
        routedByAlarm = true;
      }
    }
    if (!routedByAlarm) {
      const grad = field.gradient(ix, iy);
      const gMag = Math.hypot(grad.dx, grad.dy);
      if (gMag > 1e-6) {
        const want = Math.atan2(grad.dy, grad.dx);
        h += wrapAngle(want - h) * colony.stigmergy[i]!;
      }
    }

    // Nurse pull toward the queen pheromone gradient. Layered on top
    // of the routine stigmergy bias rather than overriding it: a
    // young WANDER worker who's also responding to a dig front still
    // gets some queen-ward bias, just not as strongly as a nurse
    // sitting in the broodpile. Older workers (forager caste, ageFrac
    // ≥ 0.5) normally ignore the field — they have other jobs.
    //
    // Small-colony override: when fewer than SMALL_COLONY workers
    // are alive, ALL workers participate in attendance regardless
    // of age. Wilson's polyethism research: small colonies don't
    // have specialised castes — every worker is a generalist.
    // Without this override the queen sits alone in failing
    // colonies because the few remaining workers happen to be old
    // and "specialised" out of nurse duty.
    // Brood attendance gate. Real Pogonomyrmex polyethism is gradual,
    // not stepped — Mirenda & Vinson 1981 show middle-aged workers
    // (ageFrac 0.5-0.8) still drop in on the broodpile occasionally
    // before transitioning fully to forager. Gate now includes a
    // probabilistic mid-age component: 80% pass at ageFrac=0.5,
    // 20% pass at 0.7, ~0 at ageFrac >= 0.8. Below 0.5 always
    // attends. Small colonies (already a separate gate) override
    // this entirely and put all workers on attendance duty.
    const midAgeAttend = ageFrac >= 0.5 && ageFrac < 0.8
      && rng.next() < (0.8 - (ageFrac - 0.5) * 2.6);
    const queenAttend = stateIn === STATE_WANDER && (isSmallColony || ageFrac < 0.5 || midAgeAttend);
    if (queenAttend && queenField) {
      const qGrad = queenField.gradient(ix, iy);
      const qMag = Math.hypot(qGrad.dx, qGrad.dy);
      if (qMag > 1e-6) {
        const want = Math.atan2(qGrad.dy, qGrad.dx);
        // Linear ramp from ageFrac=0 to 0.5. Small-colony floor at
        // 0.6 keeps old generalist workers attending firmly.
        const nurseWeight = isSmallColony
          ? Math.max(0.6, 1 - ageFrac * 2)
          : 1 - ageFrac * 2;
        h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.6 * nurseWeight;
      }
    }
    // Brood pheromone — same nurse-only pull as the queen field. A
    // nurse sandwiched between the queen (above) and the migrated
    // brood pile (deeper at noon) gets a vector sum of the two; the
    // result is attendant traffic toward whichever signal is
    // strongest locally. Ensures larvae receive trophallaxis even
    // when their thermoregulation has carried them far from the
    // queen's chamber. Small-colony override applies the same way.
    if (queenAttend && broodField) {
      const bGrad = broodField.gradient(ix, iy);
      const bMag = Math.hypot(bGrad.dx, bGrad.dy);
      if (bMag > 1e-6) {
        const want = Math.atan2(bGrad.dy, bGrad.dx);
        const nurseWeight = isSmallColony
          ? Math.max(0.6, 1 - ageFrac * 2)
          : 1 - ageFrac * 2;
        h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.6 * nurseWeight;
      }
    }
    // Necromone — Wilson, Durlach & Roth 1958. Bias necrophoresis-
    // capable WANDER ants up the gradient toward corpse cells, so
    // bodies get found and hauled even when the nest is a tangle
    // of chambers and a worker would otherwise wander past one
    // three cells away without ever stepping on it. The contact-
    // adjacent pickup logic still does the actual recruitment to
    // STATE_NECRO_CARRY; this is just the steering that brings the
    // ant within contact range.
    if (
      stateIn === STATE_WANDER && necroField &&
      species.necrophoresisProb > 0
    ) {
      const nGrad = necroField.gradient(ix, iy);
      const nMag = Math.hypot(nGrad.dx, nGrad.dy);
      if (nMag > 1e-5) {
        const want = Math.atan2(nGrad.dy, nGrad.dx);
        h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.4;
      }
    }
    // No-entry pheromone — Robinson, Jackson, Holcombe & Ratnieks
    // 2005 (Pharaoh ants). Workers who repeatedly explored a
    // tunnel branch without finding anything left a "skip me" mark
    // at the choice point. Other workers' WANDER stigmergy is
    // biased AWAY from the gradient (downhill rather than uphill),
    // so they preferentially explore unmarked territory.
    if (stateIn === STATE_WANDER && noEntryField) {
      const eGrad = noEntryField.gradient(ix, iy);
      const eMag = Math.hypot(eGrad.dx, eGrad.dy);
      if (eMag > 1e-5) {
        // Negative sign: away from the marked area.
        const want = Math.atan2(-eGrad.dy, -eGrad.dx);
        h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.5;
      }
    }

    // (4) Geotaxis. Three flavours:
    //   - CARRY (laden, returning to mound): UP, full strength.
    //   - WANDER above natural surface: DOWN, full strength (entrance
    //     funnel — surface-walking workers don't loiter, they re-
    //     enter the nest; FORAGE handles outbound trips separately).
    //   - WANDER below natural surface: DOWN, weak strength — the
    //     unladen-worker bias toward chamber floor where fresh dig
    //     opportunities are. Constant strength rather than age-
    //     modulated; the age modulation was reverted because monotone
    //     aging without brood replenishment collapsed dig throughput.
    if (stateIn === STATE_CARRY) {
      h += wrapAngle(-Math.PI / 2 - h) * geotaxis;
    } else if (stateIn === STATE_WANDER) {
      if (iy < world.naturalSurface[ix]!) {
        h += wrapAngle(Math.PI / 2 - h) * geotaxis;
      } else {
        // Below-surface depth-bias scaled by age caste: nurses
        // (young) get the strongest pull toward the brood pile,
        // foragers (old) get a much weaker one because they're
        // staging near the entrance to leave.
        h += wrapAngle(Math.PI / 2 - h) * species.belowGeotaxis * geoMult;
      }
    }
    h = wrapAngle(h);
    colony.heading[i] = h;

    // Movement, sub-stepped at <=1 cell per probe so soil contacts
    // aren't skipped at any walking speed. tryStep is an env primitive
    // that enforces the no-fly-through-solid rule.
    let nx = colony.posX[i]!;
    let ny = colony.posY[i]!;
    let hitSoil = false;
    for (let s = 0; s < subSteps; s++) {
      const dx = Math.cos(h) * stepLen;
      const dy = Math.sin(h) * stepLen;
      const r = tryStep(world, nx, ny, dx, dy);
      nx = r.x;
      ny = r.y;
      if (r.hitSoil) {
        hitSoil = true;
        // Bounce off the soil surface so the ant doesn't keep
        // pressing into the same spot every sub-step.
        h = wrapAngle(h + Math.PI * (0.5 + rng.next() * 0.5));
        colony.heading[i] = h;
      }
    }
    colony.posX[i] = nx;
    colony.posY[i] = ny;
    // Stuck-tick tracking + give-up bail for CARRY workers. Same
    // semantics as the CARRY_FOOD case above: increment when we
    // hit soil and didn't actually change cell this tick; bail
    // after STUCK_GIVE_UP_TICKS (60 ≈ 7 sec biological) by
    // dropping the grain at an adjacent AIR cell and transitioning
    // to WANDER. WANDER ants don't track stuckness — bouncing
    // around in exploration isn't "stuck" the way a CARRY worker
    // who can't reach her deposit site is. Reset for non-CARRY
    // ants so a worker who finished a CARRY trip starts fresh.
    const newAxC = nx | 0;
    const newAyC = ny | 0;
    if (stateIn === STATE_CARRY) {
      // Same asymmetric counter as the CARRY_FOOD block — see the
      // longer comment there. +2 on stuck, -1 on progress.
      const stuckThisTickC =
        hitSoil && newAxC === ix && newAyC === iy;
      if (stuckThisTickC) {
        colony.stuckTicks[i] = Math.min(255, colony.stuckTicks[i]! + 2);
      } else if (colony.stuckTicks[i]! > 0) {
        colony.stuckTicks[i]!--;
      }
      const STUCK_GIVE_UP_TICKS = 60;
      // Long-CARRY bail (FIX I). The stuckTicks accumulator only
      // bumps on hitSoil+no-cell-change ticks; a worker walking back
      // and forth in a narrow shaft section can stay in CARRY for
      // thousands of ticks without ever accumulating stuckTicks.
      // Headless monitoring at t=180k showed 11/13 CARRY workers
      // stuck >2000 ticks unable to deposit. Extra bail on
      // stateTicks: 4000 ticks in CARRY (~50 sim-minutes biological
      // at 100× compression) → drop cargo at the first available
      // neighbour, bail to WANDER. Releases the workforce so it can
      // forage / re-dig instead of treadmilling.
      if (colony.stuckTicks[i]! >= STUCK_GIVE_UP_TICKS || colony.stateTicks[i]! >= 4000) {
        const wW = world.width;
        const cargoMoves = colony.carryMoves[i]!;
        const offsetsC: ReadonlyArray<readonly [number, number]> = [
          [0, 1], [0, -1], [1, 0], [-1, 0],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ];
        for (const [dxx, dyy] of offsetsC) {
          const px = newAxC + dxx;
          const py = newAyC + dyy;
          if (px < 0 || py < 0 || px >= wW || py >= world.height) continue;
          const pIdx = py * wW + px;
          if (world.cells[pIdx] !== CELL_AIR) continue;
          // placeGrain handles the grain-cascade settle if needed.
          if (placeGrain(world, px, py, rng, cargoMoves + 1) !== null) break;
        }
        colony.carryMoves[i] = 0;
        colony.stuckTicks[i] = 0;
        colony.setState(i, STATE_WANDER);
        colony.heading[i] = rng.range(0, Math.PI * 2);
        continue;
      }
    } else {
      colony.stuckTicks[i] = 0;
    }
    // Trapped-worker alarm. A CARRY ant that hits soil while still
    // below the natural surface is being denied access to the
    // mound (e.g. a tunnel or shaft has caved in around her).
    // Same emission as the CARRY_FOOD case above but on the
    // underground side; the alarm diffuses upward through soil and
    // pulls surface ants down to dig her out. WANDER bumps don't
    // emit — those are just exploration.
    if (hitSoil && alarmField && stateIn === STATE_CARRY) {
      const ax2 = nx | 0;
      const ay2 = ny | 0;
      if (ay2 >= world.naturalSurface[ax2]!) {
        alarmField.deposit(ax2, ay2, 0.05);
      }
    }

    const ax = nx | 0;
    const ay = ny | 0;

    // Claustrophobia: an ant whose four cardinal cells are all
    // non-air is genuinely entombed — typically because grain
    // cascade closed off a one-cell pocket while it stood there.
    // It has no way to generate a hitSoil contact event because
    // tryStep blocks every direction, so the normal Sudd roll
    // never fires and the ant would be stuck for tens of thousands
    // of ticks. Real ants in this situation chew their way out
    // immediately; we let the ant roll dig (and pickup, below)
    // every tick by treating "entombed" as an implicit contact.
    const wW = world.width;
    let cardAir = 0;
    if (ax > 0 && world.cells[ay * wW + (ax - 1)] === CELL_AIR) cardAir++;
    if (ax < wW - 1 && world.cells[ay * wW + (ax + 1)] === CELL_AIR) cardAir++;
    if (ay > 0 && world.cells[(ay - 1) * wW + ax] === CELL_AIR) cardAir++;
    if (ay < world.height - 1 && world.cells[(ay + 1) * wW + ax] === CELL_AIR) cardAir++;
    const entombed = cardAir === 0;

    // Stranded surface ant. Walking on intact natural surface with
    // solid soil directly below — no tunnel here, no way to find an
    // existing entrance. hitSoil rarely triggers on the surface
    // because lateral walks step into AIR, so without an implicit
    // contact-trigger here the colony has no recovery from a sealed
    // entrance: workers dance on top while the queen suffocates
    // below. We let stranded trigger the dig roll the same way
    // `entombed` does, but throttled by a small multiplier (see
    // STRANDED_DIG_MULT below) so we get slow background drilling
    // rather than the surface turning into Swiss cheese.
    //
    // Crucially: if there's already an open shaft within a small
    // radius, suppress stranded — the colony has access nearby
    // and the existing dig-pheromone gradient (diffusing up through
    // the shaft and laterally through the sky) should pull the
    // ant there. Without this gate, every surface ant drills its
    // own parallel shaft and the colony ends up with a dozen
    // disconnected pits instead of one consolidated entrance.
    const surfHere = world.naturalSurface[ax]!;
    let stranded =
      ay < surfHere
      && ay + 1 < world.height
      && world.cells[(ay + 1) * wW + ax] === CELL_SOIL;
    // Suppress stranded-drill if ANY open shaft exists anywhere in
    // the world. Workers walking on the surface should find the
    // existing entrance via random walk + dig-pheromone gradient,
    // not drill fresh pits in unrelated columns. Only when the
    // entire surface is sealed (no AIR within the top 5 rows of
    // any column) does the recovery drill fire. Cached at world
    // level — see openShaftCount refresh below.
    if (stranded && world.openShaftCount > 0) stranded = false;

    // Sanctum partition maintenance. Real Pogonomyrmex workers
    // actively keep galleries open by chipping at any 1-cell-thick
    // soil partition that walls them off from the brood/queen
    // chamber (Tschinkel 2004 J. Insect Sci. 4:21; Gordon 2010
    // colony behaviour). The existing physics treats SOIL as rigid,
    // so without an active behavioural rule the queen's chamber
    // slowly seals off as workers occasionally drop spoil in
    // adjacent cells over many hours.
    //
    // Trigger: WANDER worker, with a SOIL cell directly adjacent
    // (cardinal) AND an AIR cell two-away in the same direction
    // (= 1-cell-thick partition geometry), AND high queen/brood
    // pheromone on the OTHER side of the partition (the AIR cell
    // two-away). Queen and brood fields are permeable, so the
    // signal carries through the partition; checking the far
    // air cell's pheromone confirms the queen is on the other
    // side, not just somewhere in the same chamber.
    //
    // Generalised over all 4 cardinals because the queen can be
    // walled off above/below/either side — e.g. when the colony
    // builds spoil pillars between adjacent chambers, or when a
    // floor between the queen's chamber and one above pinches.
    if (stateIn === STATE_WANDER && (queenField || broodField)) {
      // Sample own-cell queen/brood pheromone once. Used to (a) gate
      // the 4-direction sanctum probe (cheap thin-partition fix) and
      // (b) drive the roof-breach rule (heavy thick-cap escape).
      const ownQ = queenField ? queenField.sample(ax, ay) : 0;
      const ownB = broodField ? broodField.sample(ax, ay) : 0;
      const wW = world.width;
      let didMaintenance = false;
      // Probe gate: a worker far from the queen has no chance of
      // finding the partition signal in any cardinal direction. Skip
      // the 4-probe loop (not the rest of the WANDER block — earlier
      // versions used `continue` here, which silently skipped Sudd
      // dig and grain pickup for every worker outside the queen's
      // chemical halo and stalled colony expansion).
      if (ownQ >= 0.3 || ownB >= 0.3) {
        for (const [dx, dy] of SANCTUM_DIRS) {
          if (didMaintenance) break;
          const sx = ax + dx;
          const sy = ay + dy;
          const ox2 = ax + dx * 2;
          const oy2 = ay + dy * 2;
          if (sx < 0 || sy < 0 || sx >= wW || sy >= world.height) continue;
          if (ox2 < 0 || oy2 < 0 || ox2 >= wW || oy2 >= world.height) continue;
          if (world.cells[sy * wW + sx] !== CELL_SOIL) continue;
          if (world.cells[oy2 * wW + ox2] !== CELL_AIR) continue;
          const farQ = queenField ? queenField.sample(ox2, oy2) : 0;
          const farB = broodField ? broodField.sample(ox2, oy2) : 0;
          // Higher threshold than the in-chamber sanctum check (0.3)
          // because permeable diffusion makes EVERY nearby air cell
          // carry some signal. 1.0 specifically targets "an attended
          // chamber on the other side of this thin wall".
          if (farQ > 1.0 || farB > 1.0) {
            if (rng.next() < colony.digProb[i]!) {
              if (digCell(world, sx, sy, rng)) {
                colony.setState(i, STATE_CARRY);
                colony.carryMoves[i] = 0;
                colony.heading[i] = Math.atan2(dy, dx);
                if (particles) {
                  for (let k = 0; k < 2; k++) {
                    const a = rng.range(-Math.PI, 0);
                    const sp = rng.range(0.04, 0.14);
                    particles.spawn(
                      sx + 0.5, sy + 0.3,
                      Math.cos(a) * sp, Math.sin(a) * sp - 0.04,
                      24 + ((rng.next() * 12) | 0),
                    );
                  }
                }
                didMaintenance = true;
              }
            }
          }
        }
        if (didMaintenance) continue;
      }
      // Roof-breach. Sanctum maintenance handles 1-cell partitions
      // (AIR is two cells away with queen/brood signal beyond), but
      // a real cave-in / steady spoil settlement / surface storm
      // can leave a brood chamber under 5+ cells of solid soil with
      // no AIR-two-away to trigger the probe. Workers in such a
      // sealed chamber would otherwise just bump the walls until
      // they starve, which is exactly the failure mode we keep
      // observing — eggs and larvae mature into wanderers inside
      // the crypt and die en masse without breaking the cap.
      //
      // Trigger: WANDER worker, near-queen pheromone in own cell
      // (the worker IS in the brood chamber), SOIL directly above,
      // AND zero AIR cells in the column from the worker's row up
      // to the natural surface (= no lateral access to surface via
      // this column at all). The column-sealed gate keeps the rule
      // from firing whenever a worker happens to walk past the
      // queen — only a fully buried column triggers escape digging.
      if (
        !didMaintenance &&
        (ownQ > 0.5 || ownB > 0.5) &&
        ay > 0 &&
        world.cells[(ay - 1) * wW + ax] === CELL_SOIL
      ) {
        let columnSealed = true;
        const surfHere = world.naturalSurface[ax]!;
        for (let yy = ay - 1; yy >= surfHere && columnSealed; yy--) {
          if (world.cells[yy * wW + ax] === CELL_AIR) columnSealed = false;
        }
        if (columnSealed) {
          // 3× boost — escape from a sealed chamber is the only
          // survival action available; routine digProb (1–2% per
          // tick) would take hours to chew through a 5-cell cap
          // even with multiple workers rolling each tick.
          if (rng.next() < colony.digProb[i]! * 3.0) {
            if (digCell(world, ax, ay - 1, rng)) {
              colony.setState(i, STATE_CARRY);
              colony.carryMoves[i] = 0;
              colony.heading[i] = -Math.PI / 2;
              world.digsByDir[0]!++;
              digField.deposit(ax, ay - 1, digDeposit * 0.5);
              digField.deposit(ax, ay, digDeposit * 1.0);
              if (alarmField) alarmField.deposit(ax, ay, 0.2);
              if (particles) {
                for (let k = 0; k < 2; k++) {
                  const a = rng.range(-Math.PI, 0);
                  const sp = rng.range(0.04, 0.14);
                  particles.spawn(
                    ax + 0.5, ay - 0.5,
                    Math.cos(a) * sp, Math.sin(a) * sp - 0.04,
                    28 + ((rng.next() * 12) | 0),
                  );
                }
              }
              continue;
            }
          }
        }
      }
    }

    // (3) Sudd contact-triggered digging. Per soil contact, P(dig) =
    // params.digProb. If the dig fires, ask the env to remove the
    // soil cell; the env handles any granular cascade. Drop dig
    // pheromone at the new air cell so other ants are recruited.
    if (stateIn === STATE_WANDER && (hitSoil || entombed || stranded)) {
      // Enclosure gate. Sudd 1970 measured per-contact dig rates on
      // isolated workers in EXCAVATION CONTEXTS — tubes, dishes,
      // partially-built chambers — not on open ground. An ant that
      // happens to step on flat soil with sky above isn't in a real
      // dig context, and applying the contact-trigger roll there
      // produces non-physical "surface scraping" (the colony eats
      // the ground horizontally instead of tunnelling). Gate the
      // roll on the ant having ≥2 cardinal SOIL neighbours, i.e.
      // it's wedged into a tunnel, pocket, or wall corner.
      //
      // We deliberately do NOT also gate on iy>=naturalSurface: that
      // would block widening the pinhole entrance into a crater
      // (real founding colonies enlarge a 1-cell hole into a 5–10
      // cell entrance over the first hours), which is necessary for
      // a 100-ant colony to actually flow through.
      let neighbourSoil = 0;
      if (ax > 0 && world.cells[ay * wW + (ax - 1)] === CELL_SOIL) neighbourSoil++;
      if (ax < wW - 1 && world.cells[ay * wW + (ax + 1)] === CELL_SOIL) neighbourSoil++;
      if (ay > 0 && world.cells[(ay - 1) * wW + ax] === CELL_SOIL) neighbourSoil++;
      if (ay < world.height - 1 && world.cells[(ay + 1) * wW + ax] === CELL_SOIL) neighbourSoil++;
      // Alarm bypass. The Sudd gate exists to stop surface ants
      // gnawing at flat ground, but a buried entrance signals
      // distress (CARRY/CARRY_FOOD ants bouncing into it deposit
      // alarm pheromone above the obstruction). When an ant is
      // standing in a strong local alarm field, drop the gate so
      // outside-in dig response can actually fire. Without this,
      // surface ants near a buried entrance bounce until they
      // starve. Threshold matches the WANDER follow trigger so the
      // ant that gets routed to alarm is also the one that can dig.
      const alarmHere = alarmField ? alarmField.sample(ax, ay) : 0;
      const alarmBypass = alarmHere > 0.08;
      // Surface-stranded bypass. The `stranded` flag was computed
      // above as a third trigger for the dig roll; here it also
      // bypasses the enclosure gate and forces the dig target to
      // be directly below the ant (see target override). Without
      // both, hitSoil rarely fires on the surface AND the gate
      // would block the roll even when it does.
      //
      // Intact-ground surface guard. A worker who happens to be
      // standing at the natural-surface row in a column that has
      // never been excavated shouldn't trigger Sudd — the wave
      // perturbation in the surface row can leave such workers
      // with neighbourSoil ≥ 2 (one below + one lateral wave step),
      // passing the enclosure gate and producing the "ants venture
      // far away and dig random pits" behaviour. Skip dig unless
      // there's an actual reason (alarm signal, stranded trigger,
      // or worker is below the surface — i.e. inside an existing
      // chamber / tunnel).
      const intactGroundSurface =
        ay <= world.naturalSurface[ax]! &&
        world.cells[world.naturalSurface[ax]! * world.width + ax] !== CELL_AIR;
      if (
        (neighbourSoil < 2 || intactGroundSurface) &&
        !alarmBypass && !stranded
      ) {
        // Not enclosed — skip dig (and the Khuong roll). Grain
        // pickup is still allowed below; that's a different
        // behaviour and works fine on open ground.
      } else {
      // Khuong et al. 2016 topochemistry: ants are MORE LIKELY to
      // dig at a site that's already been "marked" by construction
      // activity in the immediate vicinity. Local build pheromone
      // signals "the colony's already working here, stay and dig
      // outward." Without this, every new dig site competes from
      // scratch with the dominant front; with it, lateral
      // expansion next to existing mounds becomes self-reinforcing
      // and tunnels can branch off into side chambers.
      //
      //   Khuong, A., Gautrais, J., Perna, A., et al. (2016).
      //   Stigmergic construction and topochemical information
      //   shape ant nest architecture. PNAS 113(5): 1303–1308.
      const local = buildField.sample(ax, ay);
      const khuongBoost = 1 + Math.min(1.5, local * 1.5);
      // Substrate compaction (Tschinkel 2004): bulk density of soil
      // increases with depth, so dig probability decreases. Linear
      // ramp from 1.0 at surface down to species.compactionFloor at
      // species.compactionDepth cells, flat below that. Real
      // P. barbatus still digs deep, just slower than at the surface.
      const depthBelowSurf = Math.max(0, ay - world.naturalSurface[ax]!);
      const compactionFactor = Math.max(
        species.compactionFloor,
        1 - depthBelowSurf / species.compactionDepth,
      );
      // Tunnel-tip vs chamber-wall (geometric) AND direction-of-
      // extension differentiation. Tschinkel (2004) mapped
      // Pogonomyrmex nests as predominantly vertical galleries with
      // chambers branching at intervals, so dig outcomes that
      // EXTEND a vertical air structure should out-rate ones that
      // EXTEND a lateral structure.
      //
      // tipBonus by cardinal-soil-count of the ant's CELL:
      //   4 (entombed) or 3 (tunnel tip): 1.0
      //   2 (chamber wall corner):        0.3
      // The 0.3 doesn't apply to claustrophobia entombment (which
      // has 4 soil neighbours by definition).
      const tipBonus = neighbourSoil >= 3 ? 1.0 : 0.3;
      // Direction-of-extension bonus: examine the dig target's
      // OWN air-neighbour pattern. If the target sits below a
      // single air cell (above), digging it extends DOWN — boost.
      // If the target sits beside an air cell (left/right), digging
      // it extends laterally — penalty.
      //
      // For the surface-stranded bypass we force the target to be
      // directly below the ant: heading on the surface is usually
      // horizontal (random walk along the surface), so adjacentSoil
      // would pick a lateral mound cell most of the time. The whole
      // point of the bypass is to drill DOWN through intact ground,
      // so we override.
      const target = stranded && neighbourSoil < 2
        ? { x: ax, y: ay + 1 }
        : adjacentSoil(world, ax, ay, h);
      if (target !== null) {
        const tW = world.width;
        const tx = target.x;
        const ty = target.y;
        const airAbove = ty > 0 && world.cells[(ty - 1) * tW + tx] === CELL_AIR ? 1 : 0;
        const airBelow = ty < world.height - 1 && world.cells[(ty + 1) * tW + tx] === CELL_AIR ? 1 : 0;
        const airLeft = tx > 0 && world.cells[ty * tW + (tx - 1)] === CELL_AIR ? 1 : 0;
        const airRight = tx < tW - 1 && world.cells[ty * tW + (tx + 1)] === CELL_AIR ? 1 : 0;
        const vAir = airAbove + airBelow;
        const lAir = airLeft + airRight;
        // Direction-of-extension bonus.
        //   vertical extension (target sits below an air cell):     1.5×
        //   equal / fresh ground (no neighbouring air):              1.0×
        //   lateral extension (target sits beside an air cell):      0.7×
        // The lateral penalty was 0.3× originally — the stated goal
        // was Tschinkel's "vertical galleries with chambers branching
        // off" — but at 0.3× chambers never actually form. Long runs
        // produced colonies of pencil-thin parallel shafts with the
        // queen alone in one of them and no path to brood / food /
        // workers in the others. 0.7× still favours vertical extension
        // (galleries push down ~2× faster than they widen) but lets
        // chambers and lateral connections actually develop, and the
        // Khuong boost on build-pheromone-marked walls amplifies
        // chamber growth into proper lobes once one starts.
        // Depth-modulated lateral bonus. Surface and shallow tunnels
        // should stay vertical-biased (gallery shaft, no chambers
        // near surface where they'd weaken the entrance). Past
        // ~15 cells below surface the lateral penalty lifts to
        // 1.0 so chambers can grow at depth — which is where
        // Tschinkel 2004 mapped Pogonomyrmex chambers (regularly
        // spaced lobes off a vertical gallery, mostly between
        // 15-50 cells deep).
        const dirDepth = Math.max(0, ay - world.naturalSurface[ax]!);
        const lateralPenalty = dirDepth >= 15 ? 1.0 : (0.7 + 0.3 * dirDepth / 15);
        const dirBonus = vAir > lAir ? 1.5 : (lAir > vAir ? lateralPenalty : 1.0);
        // Alarm boost. Strong local alarm pheromone signals "dig
        // here, fast" — multiplies the dig roll by up to 3× when
        // saturated. This is what produces the visible mass
        // response: a buried entrance accumulates alarm, surface
        // ants pile in and excavate through.
        const alarmBoost = 1 + Math.min(2, alarmHere * 8);
        // Stranded throttle. The stranded trigger fires every WANDER
        // tick on the surface (not just on hitSoil), so the per-tick
        // dig probability would be ~50× higher than a normal contact
        // event without dampening. 0.02 brings the effective surface
        // dig rate down to a few cells per second wall at 8× speed —
        // enough for the colony to recover from a sealed entrance,
        // not so much that the surface turns into Swiss cheese.
        const strandedMult = stranded && !hitSoil && !entombed ? 0.02 : 1.0;
        // Founding boost. Real foundress colonies excavate their
        // claustral chamber within hours of nuptial flight (Tschinkel
        // 2006). Without help our 5-ant scenario produced 3 cells of
        // dug nest in 30K ticks. Bump dig probability while the
        // colony is below SMALL_COLONY so the chamber opens up
        // before workers age into foragers and abandon excavation.
        const foundingBoost = isSmallColony ? 3.0 : 1.0;
        // Hungry-colony dig suppression (FIX B). When average worker
        // energy is low, real ants down-regulate excavation and re-
        // allocate effort to foraging — chambers can wait, food
        // can't (Gordon 2010, Ch. 5: "task allocation responds to
        // need"). Without this, the existing dig-pheromone gradient
        // routes every WANDER ant to dig before they can reach the
        // surface to forage. Multiplier ramps from 1.0 at avgEnergy
        // ≥ 0.4 down to 0.1 at avgEnergy ≤ 0.2; below that, dig is
        // effectively suspended so the workforce frees up for
        // emergency foraging.
        //
        // EXCEPTION: ants that are entombed or stranded NEED to
        // dig — they're buried/stuck and dig is their only escape.
        // Without this exception, hungry buried workers can't break
        // out of the chambers they got walled into; they just
        // starve underground. The post-fix monitoring run showed
        // 4/12 workers trapped in buried chambers after the
        // dig-suppression went into effect.
        const hungerDigMul = (entombed || stranded) ? 1.0
          : avgEnergy >= 0.4
            ? 1.0
            : avgEnergy <= 0.2
              ? 0.1
              : 0.1 + 0.9 * ((avgEnergy - 0.2) / 0.2);
        if (rng.next() < colony.digProb[i]! * khuongBoost * compactionFactor * tipBonus * dirBonus * digMult * alarmBoost * strandedMult * foundingBoost * carrySaturation * hungerDigMul) {
          if (digCell(world, target.x, target.y, rng)) {
            // Track dig direction relative to the digger's cell, so
            // the diag can surface a vertical-vs-lateral histogram.
            // Order [N, S, E, W] = [-y, +y, +x, -x] from (ax, ay) to
            // (target.x, target.y).
            const ddx = target.x - ax;
            const ddy = target.y - ay;
            if (ddy < 0) world.digsByDir[0]!++;        // N (up)
            else if (ddy > 0) world.digsByDir[1]!++;   // S (down)
            else if (ddx > 0) world.digsByDir[2]!++;   // E
            else if (ddx < 0) world.digsByDir[3]!++;   // W
            // Ant body stays put — mandibles do the reaching. A
            // teleport into target+0.5 produced renderer artefacts
            // (interpolated path through impossible space) and was
            // never required by the cited mechanics: real diggers
            // chip the wall from where they stand and back away with
            // the load. The CARRY state's own movement (with negative
            // geotaxis) carries the ant away from the new void.
            colony.setState(i, STATE_CARRY);
            // Fresh material — never moved before. The next deposit
            // will set the placed cell's grainMoves to 1.
            colony.carryMoves[i] = 0;
            // Direction-of-extension dig-pheromone deposit. The bulk of
            // the recruitment signal is laid ONE CELL BEYOND the dug
            // cell, in the direction the digger was reaching — so the
            // gradient pulls subsequent diggers ALONG THE GROWING
            // EDGE rather than always downward.
            //
            // Depth-modulated:
            //   above ~15 cells deep: pure vertical bias (80% below
            //     the dug cell, 20% at-cell). Surface and shallow
            //     trunks should stay as straight gallery shafts.
            //   at chamber depth (≥15): bias along the digger's
            //     direction of extension (60% in the continuation
            //     cell, 20% directly below as a residual trunk-pull,
            //     20% at-cell). A laterally-extending chamber edge
            //     pulls the next dig laterally; a downward-extending
            //     trunk tip keeps pulling down. This is the same
            //     "deeper-pheromone-lasts-longer" directional
            //     persistence Tschinkel 2004 ascribed to the
            //     vertical-gallery-with-lateral-chambers architecture
            //     of Pogonomyrmex badius.
            const depositDepth = Math.max(0, target.y - world.naturalSurface[target.x]!);
            if (depositDepth < 15) {
              digField.deposit(target.x, target.y, digDeposit * 0.2);
              if (target.y + 1 < world.height) {
                digField.deposit(target.x, target.y + 1, digDeposit * 0.8);
              }
            } else {
              // Continuation cell = one beyond the dug cell, in the
              // direction the digger was reaching. Falls back to
              // straight-down for fresh-ground digs (ddx=ddy=0 is
              // impossible since target is adjacent to source, but
              // a vertical-down dig has ddy=+1 → continuation is
              // target.y+1, identical to the surface branch).
              //
              // Hunger gate. The continuation-cell pheromone is what
              // pulls subsequent diggers along a lateral chamber's
              // growing edge — so when avgEnergy is high enough the
              // colony can afford to grow chambers, but when workers
              // are hungry that pull diverts diggers from the
              // surface-mound forage path (the cascade observed in
              // the unmodulated 5e04e7d run). Linear ramp:
              //   avgEnergy ≤ 0.5: chamberMul = 0  → pure trunk-pull
              //                                      (identical to
              //                                      surface branch)
              //   avgEnergy ≥ 0.75: chamberMul = 1  → full lateral
              //                                       persistence
              // The redirected weight goes to "row below dug cell"
              // when chamberMul < 1, so total deposit stays 1.0 ×
              // digDeposit and trunk extension is preserved through
              // hungry windows. Healthy windows let chambers grow.
              const chamberMul = Math.max(0, Math.min(1, (avgEnergy - 0.5) / 0.25));
              const cx = target.x + ddx;
              const cy = target.y + ddy;
              digField.deposit(target.x, target.y, digDeposit * 0.2);
              const lateralWeight = 0.6 * chamberMul;
              const trunkWeight = 0.8 - lateralWeight;
              if (lateralWeight > 0 && cx >= 0 && cx < world.width && cy >= 0 && cy < world.height) {
                digField.deposit(cx, cy, digDeposit * lateralWeight);
              }
              if (trunkWeight > 0 && target.y + 1 < world.height) {
                digField.deposit(target.x, target.y + 1, digDeposit * trunkWeight);
              }
            }
            // Stranded surface beacon. The deposits above are deep
            // in the new shaft and barely reach surface ants by
            // gradient diffusion — that's why a fresh stranded
            // dig used to spawn parallel shafts. Drop a strong
            // pulse of dig pheromone in the surface AIR cell where
            // the ant stands so other surface ants laterally pulled
            // toward this column instead of starting their own
            // recovery shaft. Alarm too: alarmBypass triggers the
            // dig roll for bystanders that arrive, so they actually
            // help excavate rather than mill at the rim.
            if (stranded && alarmField) {
              digField.deposit(ax, ay, digDeposit * 2.0);
              alarmField.deposit(ax, ay, 0.3);
            }
            colony.heading[i] = -Math.PI / 2 + rng.range(-0.3, 0.3);
            // Spawn a small puff of dust from the dig site so the
            // event is visible. Three particles drifting up + away
            // from the wall, lifetime ~30 ticks.
            if (particles) {
              for (let k = 0; k < 3; k++) {
                const a = rng.range(-Math.PI, 0);
                const sp = rng.range(0.05, 0.18);
                particles.spawn(
                  target.x + 0.5,
                  target.y + 0.3,
                  Math.cos(a) * sp,
                  Math.sin(a) * sp - 0.05,
                  28 + ((rng.next() * 16) | 0),
                );
              }
            }
          }
        }
      }
      }
    }

    // (3b) Theraulaz construction model: WANDER ants pick up grain
    // from cells they're adjacent to, with probability pickProb per
    // tick of contact. Combined with placeGrain, this makes deposited
    // material a fluid resource — mounds reshape, walls smooth, and
    // (in the original termite-construction model) emergent walls
    // and pillars form. Pickup is restricted to ants who didn't
    // already become CARRY this tick (one transition per tick).
    if (colony.state[i] === STATE_WANDER) {
      const target = adjacentGrain(world, ax, ay, rng);
      if (target !== null && rng.next() < colony.pickProb[i]!) {
        const pickedMoves = pickGrain(world, target.x, target.y, rng);
        if (pickedMoves >= 0) {
          // No teleport — same reasoning as digCell above: the ant's
          // body stays at its current cell, mandibles reach into the
          // adjacent grain. Avoids a prev→pos straight-line jump
          // through air during the renderer's interpolation.
          colony.setState(i, STATE_CARRY);
          // Carry forward the grain's existing move count. Next
          // deposit will store carryMoves + 1 in the placed cell.
          colony.carryMoves[i] = pickedMoves;
          // Picked-up grain isn't a fresh dig — don't deposit dig
          // pheromone; instead leave a small mark on the build
          // field (the act of disturbing a pile is itself a
          // construction-pheromone signal in the Theraulaz model).
          buildField.deposit(target.x, target.y, buildDeposit * 0.5);
          // Tiny dust puff at the disturbed grain — fewer/shorter
          // than a fresh dig because nothing's being broken loose.
          if (particles) {
            for (let k = 0; k < 2; k++) {
              const a = rng.range(-Math.PI, 0);
              const sp = rng.range(0.04, 0.10);
              particles.spawn(
                target.x + 0.5, target.y + 0.3,
                Math.cos(a) * sp, Math.sin(a) * sp - 0.03,
                18 + ((rng.next() * 10) | 0),
              );
            }
          }
        }
      }
    }

    // CARRY → place grain. Two-tier deposit decision:
    //   1. Surface mound (above surface, intact ground): always
    //      deposit. Tschinkel 2004 (J. Insect Sci. 4:21) directly
    //      observed Pogonomyrmex spoil mounds at the entrance.
    //   2. In-chamber, pheromone-thresholded: deposit at probability
    //      = local build pheromone (capped at 1) when local > 0.10.
    //      Khuong et al. 2016 (PNAS 113:1303) sigmoid response —
    //      deposits cluster at high-pheromone sites that have
    //      already been built up, producing pillar/wall morphology
    //      near the mound. The threshold suppresses random deep-
    //      chamber refill (pheromone evaporates faster than it
    //      diffuses there).
    //
    // Use stateIn so ants who BECAME CARRY this tick wait a tick
    // before depositing.
    if (stateIn === STATE_CARRY) {
      const px = colony.posX[i]! | 0;
      const py = colony.posY[i]! | 0;
      const idx = world.index(px, py);
      const surf = world.naturalSurface[px]!;
      const cellIsAir = world.cells[idx] === CELL_AIR;
      const aboveSurface = py < surf;
      const groundIsIntact = world.cells[world.index(px, surf)] !== CELL_AIR;

      // Traffic-driven wall erosion. Hölldobler & Wilson (1990, Ch. 3,
      // "Nest construction"): "Workers passing through soil-walled
      // passages erode the walls over time"; Tschinkel (2004) attributes
      // the visible entrance crater of mature Pogonomyrmex nests to
      // cumulative outbound CARRY traffic. A laden worker bumping the
      // narrow shaft sides chips small amounts of soil with mandibles.
      // Modelled as a small per-tick wear probability for in-transit
      // CARRY ants, applied to a randomly chosen cardinal SOIL
      // neighbour. Without this, the 1-cell starter pinhole remains a
      // perpetual choke for 50+ ants and the colony starves on the
      // length of the round trip.
      // 2× the previous 0.001/tick to widen entrance shafts faster.
      // Earlier value left visible CARRY clusters at the choke; doubling
      // halves the time to a sustainable crater geometry.
      // Compaction also slows wall erosion at depth — same biology
      // as the dig-roll factor. Compacted soil is harder to chip.
      const wearDepth = Math.max(0, py - surf);
      const wearCompaction = Math.max(
        species.compactionFloor,
        1 - wearDepth / species.compactionDepth,
      );
      const WEAR_PROB = 0.002 * wearCompaction;
      if (!aboveSurface && cellIsAir && rng.next() < WEAR_PROB) {
        const wW = world.width;
        const candidates: Array<[number, number]> = [];
        if (px > 0 && world.cells[py * wW + (px - 1)] === CELL_SOIL) candidates.push([px - 1, py]);
        if (px < wW - 1 && world.cells[py * wW + (px + 1)] === CELL_SOIL) candidates.push([px + 1, py]);
        // Gate wear to narrow vertical passages — both lateral
        // neighbours must be SOIL (so the ant is squeezed in a
        // 1-cell-wide vertical shaft). Hölldobler & Wilson 1990
        // Ch. 3 describes shaft erosion specifically, not chamber
        // erosion. Chamber edges have one lateral air + one lateral
        // soil (asymmetric); requiring length === 2 rejects them.
        // The diag's dig-direction histogram revealed that without
        // this gate, wear fires at every chamber wall in every
        // direction, producing ~70% lateral digs overall —
        // overwhelming the Sudd vertical bias and creating the
        // horizontal-gallery architecture the user kept seeing.
        if (candidates.length === 2) {
          const pick = candidates[(rng.next() * candidates.length) | 0]!;
          if (digCell(world, pick[0], pick[1], rng)) {
            // Wear is by definition lateral (left/right wall chipping
            // only). Track in the dig-direction histogram so the diag
            // shows the FULL picture — Sudd vertical/lateral plus
            // wear lateral. Without this, the histogram suggested
            // wide vertical bias even though wear was dumping lots
            // of lateral activity that dominated the visual outcome.
            if (pick[0] > px) world.digsByDir[2]!++;       // E
            else world.digsByDir[3]!++;                    // W
            // The chipped soil isn't large enough to cohere as a
            // grain — real ants pulverise wall material with their
            // mandibles and the dust is shed during the trip
            // (Hölldobler & Wilson 1990 Ch. 3 describes the same
            // behaviour as creating "fine soil" that doesn't end up
            // in the spoil mound). Track in world.wearLost so grain-
            // conservation diagnostics stay honest.
            world.wearLost++;
          }
        }
      }

      // Khuong threshold dropped 0.30 → 0.10 so fresh chambers can
      // bootstrap pillar-building from cold without needing path-1
      // (above-surface) deposits to seed the field first. Combined
      // with the corner-targeting bonus below, in-chamber deposits
      // now self-start at modest pheromone levels, which means
      // CARRY ants can offload spoil at chamber walls instead of
      // queueing for the surface.
      const PILLAR_THRESHOLD = 0.10;
      const supportedBelow =
        py + 1 < world.height &&
        world.cells[world.index(px, py + 1)] !== CELL_AIR;
      // Corner bonus. A cell with 2+ SOIL cardinal neighbours sits
      // at a chamber-wall corner — exactly where real workers
      // place reinforcement (Tschinkel 2004 mapped Pogonomyrmex
      // chambers as predominantly corner-thickened, not centre-
      // filled). Boost the deposit probability there so chambers
      // grow walls before they grow pillars.
      const wW2 = world.width;
      let cornerSoil = 0;
      if (px > 0 && world.cells[py * wW2 + (px - 1)] === CELL_SOIL) cornerSoil++;
      if (px < wW2 - 1 && world.cells[py * wW2 + (px + 1)] === CELL_SOIL) cornerSoil++;
      if (py > 0 && world.cells[(py - 1) * wW2 + px] === CELL_SOIL) cornerSoil++;
      if (py < world.height - 1 && world.cells[(py + 1) * wW2 + px] === CELL_SOIL) cornerSoil++;
      const cornerBoost = cornerSoil >= 2 ? 2.0 : 1.0;
      let pDeposit = 0;
      if (aboveSurface && groundIsIntact && cellIsAir) {
        // Mound height taper. Real Pogonomyrmex spoil mounds are
        // BROAD humps (Tschinkel 2004 measured P. badius nests at
        // 5–15 cm tall × 30–50 cm wide), not single-cell-wide
        // pillars. Without a cap, the build-pheromone gradient
        // pulls every CARRY worker to the existing peak and
        // pDeposit=1 fires unconditionally, producing the thin
        // 8–10 cell vertical spires we kept seeing at active
        // entrances.
        //
        // A HARD cap (refuse outright above some height) leaves
        // workers spinning when every nearby column is already
        // capped — they can't deposit anywhere and have to wait
        // for the slow deadlock fallback (≥500 ticks overdue).
        // Use a linear taper instead so short columns are strongly
        // preferred, tall columns still accept grain at low
        // probability, and the colony self-organises into a wide
        // hump rather than a needle. Floor at 0.02 prevents the
        // total-saturation deadlock.
        //
        // Taper steepened from `1 − m × 0.2` (floor 0.05) to
        // `1 − m × 0.3` (floor 0.02) after monitoring showed
        // mounds still climbed to height 12 — at the prior taper,
        // height 4 still accepted grain at 20% per tick which let
        // the Khuong gradient outpace the spread mechanic. New
        // values: height 0=1.0, height 2=0.4, height 3=0.1,
        // height 4=0.02 (floored). 5× drop in deposit rate at the
        // peak vs the prior taper.
        const m = world.mound[px]!;
        pDeposit = Math.max(0.02, 1 - m * 0.3);
      } else if (!aboveSurface && supportedBelow && cellIsAir) {
        // Brood/queen exclusion. Real workers keep the queen's
        // chamber and the broodpile clean — they don't backfill
        // them with spoil. Without this guard the Khuong pillar-
        // build feedback runs at the queen's cell whenever build
        // pheromone happens to be high there, gradually walling
        // her in. queenField and broodField are both permeable
        // (diffuse through soil) so they reach nearby tunnels;
        // a 0.3 threshold matches active-attendance density and
        // keeps the exclusion zone at roughly the chamber
        // boundary, not way out into the galleries.
        const queenHere = queenField ? queenField.sample(px, py) : 0;
        const broodHere = broodField ? broodField.sample(px, py) : 0;
        const inSanctum = queenHere > 0.3 || broodHere > 0.3;
        // Choke-point exclusion. A 1-cell-wide vertical passage
        // (both lateral neighbours are SOIL/GRAIN, vertical
        // neighbours are AIR) is a gallery shaft connecting
        // chambers — depositing here pinches the colony's lifeline
        // and over time can seal the queen's chamber off from the
        // surface. Real ants keep galleries clear of spoil. Skip
        // deposit if the cell is shaft-shaped: lateral both
        // non-AIR AND at least one vertical neighbour AIR (so we're
        // in a passage, not a corner pocket).
        const wW3 = world.width;
        const leftNonAir = px > 0 && world.cells[py * wW3 + (px - 1)] !== CELL_AIR;
        const rightNonAir = px < wW3 - 1 && world.cells[py * wW3 + (px + 1)] !== CELL_AIR;
        const aboveAir = py > 0 && world.cells[(py - 1) * wW3 + px] === CELL_AIR;
        const belowAir = py < world.height - 1 && world.cells[(py + 1) * wW3 + px] === CELL_AIR;
        const isVerticalShaft = leftNonAir && rightNonAir && (aboveAir || belowAir);
        if (!inSanctum && !isVerticalShaft) {
          const localBuild = buildField.sample(px, py);
          if (localBuild > PILLAR_THRESHOLD) {
            pDeposit = Math.min(1, localBuild * cornerBoost); // Khuong + corner
          }
        }
      }
      // Carry-deadlock relief. A worker who's been carrying spoil
      // for a while without finding a deposit site drops the load
      // anywhere it can. Probability ramps with overdue time so
      // a barely-overdue carrier is unlikely to drop on the floor
      // randomly, but a very-overdue one almost certainly will.
      //   stateTicks <  500: pDeposit unchanged (use the normal
      //                       Khuong/surface paths only)
      //   500 → 2000: linear ramp 0 → 0.5
      //   ≥ 2000:     pDeposit = 0.5 floor (50% per tick)
      // Lowered from the previous flat 2000-tick gate because the
      // colony was tipping into starvation before the relief
      // fired — long-run scenarios showed CARRY accumulating to
      // 90%+ of the workforce, energy crashing, then ~20% of
      // workers dying off before the system rebalanced. The ramp
      // gives carriers an exit valve early enough that the
      // workforce stays balanced, paired with carry-saturation on
      // the dig side (which throttles the inflow).
      let depositedViaDeadlock = false;
      if (pDeposit === 0 && supportedBelow && cellIsAir) {
        // Same choke-point check as above: a deadlock-fallback
        // dump in a 1-cell shaft pinches the gallery, eventually
        // sealing the queen off. Carriers wait longer instead.
        const wW4 = world.width;
        const leftNonAir = px > 0 && world.cells[py * wW4 + (px - 1)] !== CELL_AIR;
        const rightNonAir = px < wW4 - 1 && world.cells[py * wW4 + (px + 1)] !== CELL_AIR;
        const aboveAir = py > 0 && world.cells[(py - 1) * wW4 + px] === CELL_AIR;
        const belowAir = py < world.height - 1 && world.cells[(py + 1) * wW4 + px] === CELL_AIR;
        const isVerticalShaft = leftNonAir && rightNonAir && (aboveAir || belowAir);
        // Queen/brood sanctum exclusion. Same threshold as the
        // Khuong path. The Khuong route already protects sanctum
        // cells, but the deadlock fallback didn't — so a carrier
        // overdue for 500+ ticks who happens to be in the queen's
        // chamber would dump grain right next to her, gradually
        // burying the brood pile. queenField and broodField are
        // both permeable so the exclusion zone reaches a couple
        // cells out from the actual chamber boundary, matching
        // active-attendance density without locking carriers out
        // of the rest of the gallery.
        const queenHere = queenField ? queenField.sample(px, py) : 0;
        const broodHere = broodField ? broodField.sample(px, py) : 0;
        const inSanctum = queenHere > 0.3 || broodHere > 0.3;
        const overdue = colony.stateTicks[i]!;
        if (!isVerticalShaft && !inSanctum && overdue >= 500) {
          const ramp = Math.min(1, (overdue - 500) / 1500);
          pDeposit = ramp * 0.5;
          // Apply the same above-surface mound taper that gates the
          // routine deposit path — without it, overdue carriers
          // bypass the height cap entirely and pile grain into a
          // single column until it spires 15+ cells high. Multiplied
          // (not replaced) so the deadlock-relief intent still holds:
          // even at height 4 the carrier can drop at 0.5 × 0.02 = 1%
          // per tick, which clears the queue eventually without
          // building a tower.
          if (aboveSurface) {
            const m = world.mound[px]!;
            const taper = Math.max(0.02, 1 - m * 0.3);
            pDeposit *= taper;
          }
          depositedViaDeadlock = true;
        }
      }
      if (pDeposit > 0 && rng.next() < pDeposit) {
        // The grain has now been moved one more time. Stamp the
        // placed cell (and any cascade destination) with the
        // updated count so the renderer can fade it.
        const newMoves = colony.carryMoves[i]! + 1;
        const placed = placeGrain(world, px, py, rng, newMoves);
        if (placed !== null) {
          // Deadlock-fallback drops route to REST so the worker
          // takes a forced cool-off before being eligible to dig
          // again. Without this, ants who exit via the fallback
          // immediately re-dig in the next tick and re-fill the
          // CARRY queue — the saturation never breaks.
          colony.setState(i, depositedViaDeadlock ? STATE_REST : STATE_WANDER);
          colony.carryMoves[i] = 0;
          // Khuong 2016 wall-pillar feedback: a build site's local
          // pheromone concentration AMPLIFIES the deposit left by the
          // next grain placed there. This is the positive-feedback
          // half of the stigmergic loop (the gradient-following bias
          // is the negative half — it just steers ants there). Without
          // the amplification, every column accumulates at the same
          // rate and you get a smooth ridge; with it, columns that get
          // a head-start lock in, and the spaces between them stay
          // un-deposited. The result is the discrete pillar/wall
          // morphology Khuong et al. observed in Lasius niger.
          //   Khuong, A., Gautrais, J., Perna, A., et al. (2016).
          //   Stigmergic construction and topochemical information
          //   shape ant nest architecture. PNAS 113(5): 1303–1308.
          // Cap the gain so a saturated site can't outrun evaporation
          // and freeze the field.
          const local = buildField.sample(placed.x, placed.y);
          const khuongGain = 1 + Math.min(1.5, local * 1.5);
          buildField.deposit(placed.x, placed.y, buildDeposit * khuongGain);
          // Reorient downward so we head back into the nest.
          colony.heading[i] = Math.PI / 2 + rng.range(-0.3, 0.3);
        }
      }
    }
  }

  // Per-ant gravity (env). Runs after all per-ant decisions and any
  // grain cascades so an ant whose footing was just dug out falls
  // properly.
  for (let i = 0; i < colony.count; i++) {
    const sG = colony.state[i];
    if (sG === STATE_DEAD || sG === STATE_QUEEN || sG === STATE_EGG
        || sG === STATE_LARVA || sG === STATE_PUPA) continue;
    const sx = colony.posX[i]! | 0;
    const sy = colony.posY[i]! | 0;
    const settled = settle(world, sx, sy);
    // Shift posY by the cell delta the settle picked, preserving
    // the sub-cell fractional part. Snapping to settled+0.5 used to
    // produce visible "jumps" in the renderer interpolation when an
    // ant fell from near the top of a cell into the middle of the
    // next one (delta could exceed gravity's 1-cell budget by up to
    // ~0.5 cells).
    if (settled !== sy) colony.posY[i] = colony.posY[i]! + (settled - sy);
  }
}
