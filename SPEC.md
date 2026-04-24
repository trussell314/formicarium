# Formicarium — Architecture & Implementation Plan

A scientifically-flavored 2D ant nest simulation that runs as a desktop wallpaper and screensaver across Windows, macOS, and Linux. Single web-based codebase, wrapped by established third-party runtimes on each platform.

---

## 1. Goals and non-goals

### Goals
- **Emergent nest architecture**: shafts and chambers appear from local agent rules, without scripted templates
- **Scientifically plausible**: grounded in stigmergy (Grassé) and contact-based excavation models (Goldman et al.; Mahadevan et al.)
- **Energy-frugal**: target <2% CPU and minimal GPU on modest modern hardware
- **Cross-platform**: single codebase ships to Windows wallpaper, macOS wallpaper, macOS screensaver, Linux wallpaper, Linux screensaver
- **Minimally interactive**: optional mouse/keyboard as disturbance input or RNG seed; works fully autonomously
- **Deterministic when seeded**: for testing and reproducibility

### Non-goals
- Rigorous myrmecological accuracy — this is ambient art informed by science
- Real-time multiplayer or networking
- 3D rendering — a 2D cross-section is the target aesthetic (the ant-farm-between-glass metaphor)
- Above-ground foraging (possible later phase, not MVP)
- Native per-OS implementations — we leverage wrapper runtimes
- Monetization, user accounts, cloud anything

---

## 2. Scientific model (simplified)

The simulation is a 2D vertical cross-section showing air above and soil below. Ants excavate soil, creating a shaft-and-chamber nest. Three mechanisms drive emergence:

### 2.1 Stigmergy (Grassé 1959; Bonabeau/Theraulaz/Deneubourg 1998)
Ants deposit a short-lived **dig pheromone** when they excavate. Other ants are attracted to high dig-pheromone areas, creating positive feedback that concentrates digging at active sites and leaves quiet areas undug.

### 2.2 Contact-based agitation (Aguilar et al. 2018; Aina et al. 2023)
An ant's likelihood to remain active scales with its recent collision rate. Crowded sites self-throttle; sparse active sites retain their diggers.

### 2.3 Grain deposition with positive feedback (Theraulaz construction model)
Excavated grains are carried to disposal sites. Deposition is biased toward existing piles via a **construction pheromone**.

### 2.4 Emergent vertical structure (Tschinkel empirical casts)
A weak downward bias plus a chamber-widening rule (lateral digging when local exposure time exceeds a threshold) reproduces shaft-and-chamber cross-sections.

---

## 3. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | Catches grid-indexing bugs; AI-assisted dev is sharper with types |
| Build | Vite | Fast HMR, ES modules, zero config |
| Rendering | Canvas 2D (MVP) → WebGL2 (planned) | Canvas keeps the dependency surface tiny; WebGL2 is the planned upgrade for HIGH quality |
| Field compute | CPU TypedArrays (MVP) → GPU FBO ping-pong | CPU diffusion is fast enough at MEDIUM. GPU port reuses the same `PheromoneField` interface |
| Agent compute | CPU (TypeScript) | Hundreds of agents; branching state machines are awkward in shaders |
| Dependencies | Zero runtime deps | Minimize attack surface and load time |
| Testing | Vitest | Vite-native, fast |

---

## 4. High-level architecture

```
main.ts ─▶ World, Colony, Fields ─▶ Loop ─▶ stepSimulation (CPU) + Renderer (Canvas2D)
```

### Decoupled sim and render
- Sim at fixed simHz (default 20) — see `runtime/loop.ts`
- Render at display vsync
- Agent positions interpolated between ticks using stored `prevX`/`prevY`

---

## 5. Data structures

### 5.1 World grid
- Default 480×270 (medium); 320×180 (low); 720×405 (high)
- Per cell: `Uint8` — `0=air, 1=soil, 2=boundary, 3=grain_pile`
- Coordinate convention: origin top-left, y increases downward

### 5.2 Pheromone fields
- Two scalar `Float32Array`s (current + scratch, ping-ponged each diffusion step)
- Two fields: `dig` (short-lived) and `construction` (longer-lived)

### 5.3 Agents (Struct-of-Arrays)
```ts
class Colony {
  count: number;
  posX, posY, prevX, prevY, heading: Float32Array;
  state, stateTimer, age: Uint*Array;
  collisionCount: Float32Array;
}
```

### 5.4 RNG
Seeded mulberry32 in `src/sim/rng.ts`. **No `Math.random()` in `src/sim/**`** — enforced by ESLint.

---

## 6. Simulation rules

All rules operate on the world and colony state each tick. Parameters live in `src/config.ts` and are tuned empirically.

### 6.1 Wandering
Sample dig pheromone in a forward arc; bias heading toward higher concentration. Add small downward bias for empty-handed ants. Step. If hit soil, maybe transition to DIG (probability scales with local pheromone, falls with collision count).

### 6.2 Digging
Pick a soil neighbour (forward-biased; if the cell has been "exposed" long enough, prefer lateral). Convert to air, drop dig pheromone, transition to CARRY.

### 6.3 Carrying
Head up. On reaching the column's surface, deposit a grain (growing the entrance mound) and transition back to WANDER. Drops only happen at the column's surface, never inside a tunnel — this prevents embedding the carrier under a chamber ceiling and keeps the pile visible.

### 6.4 Field update
Each tick, both pheromone fields advance by:
```
new = ((1 - f) * center + f/4 * (N + S + E + W)) * evap
```
with sub-1e-4 values clamped to zero so empty regions stay sparse.

### 6.5 Chamber widening
A `Float32Array` `exposure` field per cell counts up while the cell is soil with at least one air neighbour. Once a cell's exposure exceeds the threshold, lateral digging is preferred over advancing — this lobs out chambers from pencil shafts.

### 6.6 Agitation
Floating-point `collisionCount` per ant grows on ant-vs-ant overlap (binned by cell, so O(N) average). When it crosses the agitation threshold, the ant enters REST for `agitationRestTicks`.

### 6.7 Disturbance (mouse poke)
Mark cells within `disturbanceRadius` as agitated; ants in the radius get a collision boost and a heading kick away from the centre. Boost dig pheromone with a small Gaussian — recruits investigators.

---

## 7. Performance and energy strategy

### 7.1 Render budget
- Target ≤16.7 ms per frame (60 Hz), ≤2 ms CPU
- Strategies: single `putImageData` per frame at sim resolution, vector overlay for ants

### 7.2 Simulation budget
- Target ≤1 ms CPU per sim tick at MEDIUM
- Pheromone diffusion ≈ O(W·H) per field per tick
- Agent update O(N) where N ≈ 500

### 7.3 Pause hooks
`document.visibilitychange` pauses the loop; resume on visible.

### 7.4 Quality tiers
URL parameter `?quality=low|medium|high`. Each tier sets gridWidth, gridHeight, antCount, simHz.

### 7.5 Battery mode
If `navigator.getBattery()` reports not-charging, slow the sim multiplier. Best-effort.

---

## 8. Deployment targets

The `dist/` directory is a static site. Wrap it for each platform:

- **GitHub Pages** (current host): GitHub Actions workflow at `.github/workflows/deploy.yml` builds and deploys on push to the development branch.
- **Lively Wallpaper (Windows)**: zip `dist/` with `LivelyInfo.json`; drag-drop into Lively. Same `.zip` doubles as a screensaver.
- **Plash (macOS)**: serve `dist/` over loopback or paste a `file://` URL.
- **WebViewScreenSaver (macOS)**: install the `.saver` and point it at `file:///path/to/dist/index.html`.
- **Linux X11**: `xwinwrap -ni -fs -- chromium --app=file:///path/to/dist/index.html --kiosk WID`.
- **XScreenSaver (Linux)**: hack entry that launches chromium kiosk.

---

## 9. Phased implementation plan

| Phase | Status | Notes |
|---|---|---|
| 0 — Scaffolding | ✅ done | `package.json`, `tsconfig`, `vite.config.ts`, ESLint with sim-only no-Math.random rule |
| 1 — Static substrate | ✅ done | `world.ts` generates a wavy soil surface with a starter divot |
| 2 — Wandering agents | ✅ done | SoA `Colony`, seeded RNG, wander state |
| 3 — Excavation + CPU pheromone | ✅ done | DIG/CARRY/REST states, conservation invariants |
| 4 — GPU pheromone | ⏸ deferred | CPU is fast enough at MEDIUM; port when HIGH starts dropping frames |
| 5 — Chambers + construction pheromone | ✅ done | Exposure-based lateral-dig bias; construction pheromone drives mound growth |
| 6 — Polish | ✅ done | Dev overlay, interpolated rendering, quality tiers |
| 7 — Interaction | ✅ done | Mouse poke, keyboard bindings, visibility-pause, battery-aware speed |
| 8 — Packaging | ✳ partial | GitHub Pages workflow shipped; Lively/Plash/WebViewScreenSaver recipes documented but not built |
| 9 — Stretch | ✗ todo | Age stratification, foraging, day/night, multi-queen |

---

## 10. Testing strategy

`npm test` runs Vitest over:
- `rng.test.ts` — determinism, range, reseed
- `world.test.ts` — generate, bounds, surfaceY
- `fields.test.ts` — deposit/sample, diffusion, decay-to-zero, clear
- `colony.test.ts` — spawn, state transitions, bookkeeping
- `invariants.test.ts` — long-run grain conservation, no-embedded-ants, agent-count stability, determinism, progress

Visual QA is manual: `npm run dev`, leave running, look for emergent shafts and lateral chambers.

---

## 11. File and directory structure

```
formicarium/
├── CLAUDE.md
├── README.md
├── SPEC.md
├── LICENSE
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .eslintrc.json
├── index.html
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── sim/
│   │   ├── rng.ts
│   │   ├── world.ts
│   │   ├── colony.ts
│   │   ├── fields.ts
│   │   └── ant-rules.ts
│   ├── render/
│   │   └── renderer.ts
│   ├── input/
│   │   └── input.ts
│   └── runtime/
│       ├── loop.ts
│       ├── visibility.ts
│       └── perf.ts
├── tests/
│   ├── rng.test.ts
│   ├── world.test.ts
│   ├── colony.test.ts
│   ├── fields.test.ts
│   └── invariants.test.ts
└── .github/workflows/deploy.yml
```

---

## 12. Tunable constants reference

See `src/config.ts`. Highlights:

| Constant | Default | Description |
|---|---|---|
| GRID (medium) | 480×270 | Sim grid |
| ANT_COUNT (medium) | 500 | Live ants |
| SIM_HZ (medium) | 20 | Logical tick rate |
| antSpeed | 1.6 | Cells per tick |
| digPheromoneEvap | 0.985 | Multiplicative per-tick |
| digPheromoneDiffuse | 0.18 | Fraction diffused to neighbours |
| chamberExposureThreshold | 90 | Ticks before lateral-dig bias kicks in |
| chamberLateralBias | 0.55 | Weight added to lateral neighbour weight |
| agitationThreshold | 4 | Collisions before REST |
| agitationRestTicks | 30 | REST duration |
| disturbanceRadius | 18 | Mouse poke radius (cells) |

---

## 13. URL parameter modes

- default — ambient
- `?overlay=1` — FPS + state stats
- `?pheromones=1` — visualize fields
- `?seed=N` — fixed RNG seed
- `?quality=low|medium|high` — quality tier
- `?speed=N` — sim speed multiplier

---

## 14. References

- Grassé, P-P. (1959). La reconstruction du nid et les coordinations inter-individuelles chez Bellicositermes natalensis et Cubitermes sp. *Insectes Sociaux*.
- Bonabeau, E., Theraulaz, G., Deneubourg, J-L. et al. (1998). A model for the emergence of pillars, walls and royal chambers in termite nests. *Phil. Trans. R. Soc. Lond. B* 353: 1561–1576.
- Camazine, S. et al. (2001). *Self-Organization in Biological Systems*. Princeton University Press.
- Tschinkel, W. R. (2004). The nest architecture of the Florida harvester ant, *Pogonomyrmex badius*. *J. Insect Sci.* 4: 21.
- Aguilar, J. et al. (2018). Collective clog control: Optimizing traffic flow in confined biological and robophysical excavation. *Science* 361: 672–677.
- Aina, K. et al. (2023). Agitated ants: regulation and self-organization of incipient nest excavation via collisional cues. *J. Roy. Soc. Interface* 20: 20220597.
- Lively Wallpaper — https://github.com/rocksdanister/lively
- Plash — https://github.com/sindresorhus/Plash
- WebViewScreenSaver — https://github.com/liquidx/webviewscreensaver
