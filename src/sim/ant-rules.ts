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
  STATE_FORAGE, STATE_LARVA, STATE_NECRO_CARRY, STATE_QUEEN,
  STATE_REST, STATE_WANDER, type AntState,
} from './colony';
import type { ParticleSystem } from './particles';
import { Pheromone } from './pheromone';
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
  digDeposit: 1.0,
  buildDeposit: 1.0,
  // Beshers & Fewell 2001: per-ant individual-threshold mean ~8
  // recent collisions before behavioural withdrawal.
  restThreshold: 8.0,
  // Aina et al. 2023: collision-driven REST lasts on the order of
  // minutes in real ants. 800 ticks ≈ 1.6 min biological — at the
  // low end of the cited range; the higher 1500 left ants visibly
  // stuck in clusters.
  restDuration: 800,
};

/** Distance below which two ants count as colliding. ≈ 1 body length
 *  (6 mm at our 3 mm/cell scale = 2 cells). Scales with cell size:
 *  COLLISION_RADIUS × cellMM = 6 mm constant. */
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
    // current metabolic demand (in seed-equivalent units), capped at
    // 10× the original-population's worker demand (world.foodCap is
    // the cap expressed in equivalent worker count). Whenever the
    // accumulator crosses the clumpSize threshold a clump fires.
    //
    // The cap prevents the food rate from running away as the colony
    // grows toward maxColonySize; with the cap, a fully-populated
    // (1000-ant) colony still receives the same drop rate as a
    // 10×-original-pop "saturated" colony rather than scaling
    // unboundedly. Outside the cap, smaller colonies get
    // proportionally less so 10 starter ants don't see a windfall
    // they can't possibly process.
    let demand = 0;
    for (let i = 0; i < colony.count; i++) {
      const s = colony.state[i];
      if (s === STATE_DEAD || s === STATE_EGG) continue;
      if (s === STATE_LARVA) {
        demand += species.larvaMetabolism;
      } else if (s === STATE_QUEEN) {
        demand += species.metabolism * 0.5;
      } else {
        demand += species.metabolism;
      }
    }
    const capDemand = world.foodCap * species.metabolism;
    const targetEnergyPerTick = Math.min(demand * 1.10, capDemand);
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
  digField.step();
  buildField.step();
  if (trailField) trailField.step();
  if (alarmField) alarmField.step();
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
  if (queenField && slowStep) queenField.step();
  if (broodField && slowStep) broodField.step();
  if (necroField && slowStep) necroField.step();
  if (noEntryField && slowStep) noEntryField.step();
  if (granaryField && slowStep) granaryField.step();
  if (trunkField && slowStep) trunkField.step();
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
            const stationaryI = stI === STATE_QUEEN || stI === STATE_LARVA;
            const stationaryJ = stJ === STATE_QUEEN || stJ === STATE_LARVA;
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
                donorE > species.trophallaxisDonorThreshold;
              const recipOk =
                recipState !== STATE_DEAD &&
                recipState !== STATE_EGG &&
                recipE < species.trophallaxisRecipientThreshold;
              if (donorOk && recipOk) {
                const want = species.maxEnergy - recipE;
                const surplus = donorE - species.trophallaxisDonorThreshold;
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
            // one with at least one lateral non-SOIL neighbour, so
            // shaft cells (SOIL on both sides) are rejected. Without
            // this, eggs follow the daylight target straight up the
            // shaft to within a few cells of the surface.
            const wW = world.width;
            const leftIsSoil =
              ex > 0 && world.cells[newY * wW + (ex - 1)] === CELL_SOIL;
            const rightIsSoil =
              ex < wW - 1 && world.cells[newY * wW + (ex + 1)] === CELL_SOIL;
            const isChamber = !leftIsSoil || !rightIsSoil;
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
          broodField.deposit(lx, ly, 0.05);
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
            // one with at least one lateral non-SOIL neighbour, so
            // shaft cells (SOIL on both sides) are rejected. Without
            // this, eggs follow the daylight target straight up the
            // shaft to within a few cells of the surface.
            const wW = world.width;
            const leftIsSoil =
              ex > 0 && world.cells[newY * wW + (ex - 1)] === CELL_SOIL;
            const rightIsSoil =
              ex < wW - 1 && world.cells[newY * wW + (ex + 1)] === CELL_SOIL;
            const isChamber = !leftIsSoil || !rightIsSoil;
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
      // Maturation: enough fed-and-growing time → adult worker.
      if (colony.stateTicks[i]! >= species.larvaMatureTicks) {
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
      colony.energy[i]! -= species.metabolism * 0.05;
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
    const geoMult = Math.max(0.3, 1.0 - 0.7 * ageFrac);
    const forageMult = Math.max(0.1, Math.min(1.5, 1.5 * ageFrac));
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
      if (
        colony.stateTicks[i]! >= species.forageDuration ||
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
      // Granary attraction. Once the ant is below the surface,
      // bias toward the granary-marker gradient — established
      // granaries pull subsequent deposits toward them, producing
      // the consistent-depth seed caches Tschinkel observed.
      if (granaryField && iy >= world.naturalSurface[ix]!) {
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
      if (colony.stuckTicks[i]! >= STUCK_GIVE_UP_TICKS) {
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
    // a long time". 5000 ticks = 10 min biological. Other workers'
    // WANDER stigmergy biases AWAY from the gradient (handled in
    // the stigmergy block above), so dead ends gradually clear of
    // traffic.
    if (
      stateIn === STATE_WANDER && noEntryField &&
      colony.stateTicks[i]! > 5000 &&
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
    if (stateIn === STATE_WANDER && iy >= world.naturalSurface[ix]! &&
        rng.next() < species.forageProb * forageActivity * forageMult) {
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
    // ≥ 0.5) ignore the field entirely — they have other jobs.
    // Result is the broodpile crowd that real Pogonomyrmex queens
    // are surrounded by, and reliable trophallaxis-driven queen
    // feeding without needing explicit attendant orientation code.
    if (
      stateIn === STATE_WANDER && queenField &&
      ageFrac < 0.5
    ) {
      const qGrad = queenField.gradient(ix, iy);
      const qMag = Math.hypot(qGrad.dx, qGrad.dy);
      if (qMag > 1e-6) {
        const want = Math.atan2(qGrad.dy, qGrad.dx);
        // Linear ramp: full strength at ageFrac=0, zero at 0.5.
        const nurseWeight = 1 - ageFrac * 2;
        h += wrapAngle(want - h) * colony.stigmergy[i]! * 0.6 * nurseWeight;
      }
    }
    // Brood pheromone — same nurse-only pull as the queen field. A
    // nurse sandwiched between the queen (above) and the migrated
    // brood pile (deeper at noon) gets a vector sum of the two; the
    // result is attendant traffic toward whichever signal is
    // strongest locally. Ensures larvae receive trophallaxis even
    // when their thermoregulation has carried them far from the
    // queen's chamber.
    if (
      stateIn === STATE_WANDER && broodField &&
      ageFrac < 0.5
    ) {
      const bGrad = broodField.gradient(ix, iy);
      const bMag = Math.hypot(bGrad.dx, bGrad.dy);
      if (bMag > 1e-6) {
        const want = Math.atan2(bGrad.dy, bGrad.dx);
        const nurseWeight = 1 - ageFrac * 2;
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
      if (colony.stuckTicks[i]! >= STUCK_GIVE_UP_TICKS) {
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
      if (neighbourSoil < 2 && !alarmBypass) {
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
      const target = adjacentSoil(world, ax, ay, h);
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
        const dirBonus = vAir > lAir ? 1.5 : (lAir > vAir ? 0.3 : 1.0);
        // Alarm boost. Strong local alarm pheromone signals "dig
        // here, fast" — multiplies the dig roll by up to 3× when
        // saturated. This is what produces the visible mass
        // response: a buried entrance accumulates alarm, surface
        // ants pile in and excavate through.
        const alarmBoost = 1 + Math.min(2, alarmHere * 8);
        if (rng.next() < colony.digProb[i]! * khuongBoost * compactionFactor * tipBonus * dirBonus * digMult * alarmBoost) {
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
    if (sG === STATE_DEAD || sG === STATE_QUEEN || sG === STATE_EGG || sG === STATE_LARVA) continue;
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
