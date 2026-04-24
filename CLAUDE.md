# Claude Code guidance for Formicarium

## Project context
2D ant nest simulation, cross-section view, runs as desktop wallpaper and
screensaver via third-party runtimes (Lively on Windows, Plash and
WebViewScreenSaver on macOS, xwinwrap on Linux). See SPEC.md for the
full architecture; this file captures recurring rules.

## Invariants — do not violate
1. **Seeded determinism.** All randomness in `src/sim/**` must go through
   `src/sim/rng.ts`. `Math.random()` is banned in sim code and enforced by
   ESLint. Tests rely on this.
2. **No render-time sim mutation.** Renderer reads sim state; never writes
   to it. If you find yourself mutating world/colony in a render pass,
   that is a bug.
3. **Pheromone ping-pong.** Never sample and write the same texture in one
   shader pass. The CPU field update reads from `current` and writes to
   `scratch`, then swaps. Same convention will apply when porting to GPU.
4. **Agent positions are continuous, world is discrete.** Agents store
   floating-point positions; we floor to grid coordinates only when
   reading/writing the world grid.
5. **SoA agent storage.** Never introduce `class Ant { x, y, ... }` with
   an array-of-objects layout. All agent attributes are parallel
   TypedArrays in `Colony`.
6. **Grain conservation.** `world.initialSoilCells === currentSoil +
   currentGrains + currentCarriers` at all times. Tests guard this.
   Don't transition CARRY → WANDER without depositing.
7. **No embedded ants.** Ants must never end up at a grid position whose
   cell is `CELL_SOIL`. `tryStep` enforces this for movement; deposits
   must too (only place grains where placement does not put the ant
   inside a wall).

## Performance budgets
- Sim tick: ≤1 ms CPU at MEDIUM quality (500 ants, 480×270 grid)
- Render frame: ≤2 ms CPU, aim for vsync-limited GPU
- If a change regresses these beyond 20%, it needs a comment explaining why

## Dependency policy
Runtime dependencies are on a whitelist: none currently. WebGL ports may
add `gl-matrix`. Anything else requires explicit justification. Dev
dependencies (Vite, Vitest, ESLint, Prettier) are fine to add as needed.

## Testing expectations
- New pure functions in `src/sim/` should have unit tests
- Invariant tests (grain conservation, no-embedded-agents, determinism)
  must continue to pass
- Rendering code is exempt from unit tests but should be smoke-tested
  by running the dev server

## Code style
- TypeScript strict mode, no `any` except at WebGL API boundaries
- Prefer `readonly` on arrays and function params that aren't mutated
- Comments explain *why*, not *what* — the code says what

## Commit conventions
Conventional Commits: `feat(sim):`, `fix(render):`, `perf:`, `test:`, etc.
Reference the phase from SPEC.md when relevant:
`feat(sim): phase-3 agent dig state machine`

## When unsure
Read SPEC.md, especially §6 (simulation rules) and §5 (data structures).
Those are the source of truth for behavior and layout.
