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
  STATE_FORAGE, STATE_QUEEN, STATE_REST, STATE_WANDER, type AntState,
} from './colony';
import type { ParticleSystem } from './particles';
import { Pheromone } from './pheromone';
import { digCell, pickGrain, placeGrain, settle, tryStep } from './physics';
import type { RNG } from './rng';
import { type AntSpecies, HARVESTER } from './species';
import { CELL_AIR, CELL_GRAIN, CELL_SOIL, World } from './world';

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
  // 0.6 cells/tick × 6 mm/cell ÷ 120 ms/tick = 30 mm/sec — matches
  // Gordon (1989) Pogonomyrmex foraging speed.
  walkSpeed: 0.6,
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
  digDeposit: 1.0,
  buildDeposit: 1.0,
  // Beshers & Fewell 2001: per-ant individual-threshold mean ~8
  // recent collisions before behavioural withdrawal.
  restThreshold: 8.0,
  // Aina et al. 2023: collision-driven REST lasts ~minutes in real
  // ants. 1500 ticks ≈ 3 min biological. (Original 30 ticks = 3.6 sec
  // was a hand-tune for visual flow that didn't match the cited paper.)
  restDuration: 1500,
};

/** Distance below which two ants count as colliding. ≈ 1 body length. */
const COLLISION_RADIUS = 1.0;
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
): void {
  world.tick++;

  // Surface seed rain. Stochastic deposition of food items onto
  // intact natural-surface rows — the wind/plant-fall/animal-scat
  // process that a granivore colony's foraging is built around
  // (Crist & MacMahon 1992 measured wind-driven seed delivery in
  // arid soils). Skipped entirely for non-granivorous species.
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

  // Environmental dynamics: pheromone fields advance one tick;
  // dust particle ringbuffer ages and gravity-falls one tick.
  digField.step();
  buildField.step();
  if (particles) particles.step();

  // walkSpeed, geotaxis, and the deposit amounts stay as colony-wide
  // constants; the per-ant heterogeneity (digProb, pickProb,
  // stigmergy, turnNoise) is sampled at spawn into Colony arrays.
  const { walkSpeed, geotaxis, digDeposit, buildDeposit } = params;
  const subSteps = Math.max(2, Math.ceil(walkSpeed));
  const stepLen = walkSpeed / subSteps;

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
  for (let i = 0; i < colony.count; i++) {
    const sB = colony.state[i];
    if (sB === STATE_DEAD || sB === STATE_QUEEN || sB === STATE_EGG) {
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
    if (sP === STATE_DEAD || sP === STATE_QUEEN || sP === STATE_EGG) continue;
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
            colony.collisionCount[i]! += 1;
            colony.collisionCount[j]! += 1;
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
      if (colony.stateTicks[i]! >= species.eggMatureTicks) {
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
    // colony growth). She drains energy at half the worker rate
    // (real queens are well-fed via trophallaxis — that mechanic
    // lands later; for now treat metabolism as small enough that
    // founding-queen claustral survival is preserved).
    if (stateNow === STATE_QUEEN) {
      colony.prevX[i] = colony.posX[i]!;
      colony.prevY[i] = colony.posY[i]!;
      colony.energy[i]! -= species.metabolism * 0.5;
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
        colony.energy[i]! > 0.4 &&
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

    // Per-ant aging. The age field is updated for future use (brood-
    // production-driven polyethism, where young workers continuously
    // replace foragers). The age-derived behavioural modulations from
    // Mersch et al. 2013 were tried (forage-rate scaling, deeper-
    // diving nurses) and reverted — without brood, all workers age
    // monotonically into foragers and dig productivity collapses.
    // We keep the age data so the polyethism layer can be added back
    // once brood is in.
    colony.age[i]!++;

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
      if (colony.stateTicks[i]! >= species.forageDuration) {
        colony.setState(i, STATE_WANDER);
        colony.collisionCount[i] = 0;
        colony.heading[i] = rng.range(0, Math.PI * 2);
      } else {
        h += rng.gauss() * colony.turnNoise[i]!;
        // Below natural surface: hard upward bias toward exit. Above
        // surface: pure random walk on the open ground.
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
        // Food contact: any cardinal-or-self food cell triggers a
        // pickup. Discrete grab — no probability, foragers actively
        // collect on contact (Gordon 2010, Ch. 4).
        const fx = nx | 0;
        const fy = ny | 0;
        const wW = world.width;
        let fIdx = -1;
        if (fx >= 0 && fy >= 0 && fx < wW && fy < world.height && world.food[fy * wW + fx]! > 0) {
          fIdx = fy * wW + fx;
        } else {
          if (fx > 0 && world.food[fy * wW + (fx - 1)]! > 0) fIdx = fy * wW + (fx - 1);
          else if (fx < wW - 1 && world.food[fy * wW + (fx + 1)]! > 0) fIdx = fy * wW + (fx + 1);
          else if (fy > 0 && world.food[(fy - 1) * wW + fx]! > 0) fIdx = (fy - 1) * wW + fx;
          else if (fy < world.height - 1 && world.food[(fy + 1) * wW + fx]! > 0) fIdx = (fy + 1) * wW + fx;
        }
        if (fIdx >= 0) {
          colony.carryMoves[i] = world.foodMoves[fIdx]!;
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
        colony.carryMoves[i] = 0;
        colony.setState(i, STATE_WANDER);
        colony.heading[i] = rng.range(0, Math.PI * 2);
      }
      continue;
    }

    // WANDER ants underground roll the foraging-trip transition.
    // Above-surface WANDER ants are already on the way back into
    // the nest (positive geotaxis below) so we don't pull them
    // back out immediately. Probability is constant per Mersch et
    // al.; the age-modulation was reverted (see comment at age++
    // above).
    if (stateIn === STATE_WANDER && iy >= world.naturalSurface[ix]! &&
        rng.next() < species.forageProb) {
      colony.setState(i, STATE_FORAGE);
      colony.collisionCount[i] = 0;
      // Heading reset toward the surface so the trip starts in the
      // right direction.
      colony.heading[i] = -Math.PI / 2 + rng.range(-0.3, 0.3);
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
    // mounds for deposit).
    const field = stateIn === STATE_WANDER ? digField : buildField;
    const grad = field.gradient(ix, iy);
    const gMag = Math.hypot(grad.dx, grad.dy);
    if (gMag > 1e-6) {
      const want = Math.atan2(grad.dy, grad.dx);
      h += wrapAngle(want - h) * colony.stigmergy[i]!;
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
        h += wrapAngle(Math.PI / 2 - h) * species.belowGeotaxis;
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

    // (3) Sudd contact-triggered digging. Per soil contact, P(dig) =
    // params.digProb. If the dig fires, ask the env to remove the
    // soil cell; the env handles any granular cascade. Drop dig
    // pheromone at the new air cell so other ants are recruited.
    if (stateIn === STATE_WANDER && (hitSoil || entombed)) {
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
      if (neighbourSoil < 2) {
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
      if (rng.next() < colony.digProb[i]! * khuongBoost) {
        const target = adjacentSoil(world, ax, ay, h);
        if (target !== null) {
          if (digCell(world, target.x, target.y, rng)) {
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
            // Asymmetric dig-pheromone deposit: bulk of the recruitment
            // signal is laid ONE ROW BELOW the actual dug cell, so the
            // gradient pulls subsequent diggers DOWN into virgin soil
            // rather than along the row that was just dug. Without
            // this, every dig laterally lays pheromone at the same
            // depth, the gradient pulls the next ant the same direction,
            // and chambers drift into long horizontal galleries (the
            // opposite of the vertical-gallery + horizontal-chamber
            // architecture Tschinkel 2004 mapped in Pogonomyrmex
            // badius). Real ant alarm/recruitment pheromones do show
            // directional persistence — convection at the surface
            // disperses them faster than the still air at depth, so
            // the equivalent biological phenomenon (deeper-pheromone-
            // lasts-longer) maps onto the same gradient asymmetry.
            // 80% of the signal goes below the dug cell, 20% at the
            // dug cell itself for in-place recruitment continuity.
            digField.deposit(target.x, target.y, digDeposit * 0.2);
            if (target.y + 1 < world.height) {
              digField.deposit(target.x, target.y + 1, digDeposit * 0.8);
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
      const WEAR_PROB = 0.001;
      if (!aboveSurface && cellIsAir && rng.next() < WEAR_PROB) {
        const wW = world.width;
        const candidates: Array<[number, number]> = [];
        if (px > 0 && world.cells[py * wW + (px - 1)] === CELL_SOIL) candidates.push([px - 1, py]);
        if (px < wW - 1 && world.cells[py * wW + (px + 1)] === CELL_SOIL) candidates.push([px + 1, py]);
        if (candidates.length > 0) {
          const pick = candidates[(rng.next() * candidates.length) | 0]!;
          if (digCell(world, pick[0], pick[1], rng)) {
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

      const PILLAR_THRESHOLD = 0.30;
      const supportedBelow =
        py + 1 < world.height &&
        world.cells[world.index(px, py + 1)] !== CELL_AIR;
      let pDeposit = 0;
      if (aboveSurface && groundIsIntact && cellIsAir) {
        pDeposit = 1; // surface-mound bootstrap (Tschinkel)
      } else if (!aboveSurface && supportedBelow && cellIsAir) {
        const localBuild = buildField.sample(px, py);
        if (localBuild > PILLAR_THRESHOLD) {
          pDeposit = Math.min(1, localBuild); // Khuong pillar response
        }
      }
      if (pDeposit > 0 && rng.next() < pDeposit) {
        // The grain has now been moved one more time. Stamp the
        // placed cell (and any cascade destination) with the
        // updated count so the renderer can fade it.
        const newMoves = colony.carryMoves[i]! + 1;
        const placed = placeGrain(world, px, py, rng, newMoves);
        if (placed !== null) {
          colony.setState(i, STATE_WANDER);
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
    if (sG === STATE_DEAD || sG === STATE_QUEEN || sG === STATE_EGG) continue;
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
