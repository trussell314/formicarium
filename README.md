# Formicarium

A 2D ant nest simulation. A vertical cross-section shows ants excavating soil
and building tunnels and chambers via stigmergy and contact-based agitation —
no scripted templates. Designed to run as a desktop wallpaper or screensaver,
but also plays in any browser.

**Live demo:** https://trussell314.github.io/formicarium/

## Run locally

```sh
npm install
npm run dev      # Vite dev server with HMR
npm test         # Vitest suite (RNG, fields, colony, world, sim invariants)
npm run build    # Production build → dist/
```

## URL parameters

| Parameter | Values | Effect |
|---|---|---|
| `?quality=` | `low` \| `medium` \| `high` | Grid resolution and ant count |
| `?seed=` | integer | Reproducible run (any integer; default time-seeded) |
| `?overlay=1` | flag | Show FPS + ant-state stats overlay |
| `?pheromones=1` | flag | Visualize the dig and construction pheromone fields |
| `?speed=` | float | Simulation speed multiplier (default 1) |

## Keyboard

- **space** — pause / resume
- **h** — toggle overlay
- **p** — toggle pheromone visualization
- **r** — reseed and rebuild the world
- **c** — clear the world (regenerate soil, keep RNG state)
- **n** — spawn a small burst of ants

## Mouse

- **Click** — disturbance (boosts dig pheromone and agitates nearby ants).

## How it works

See [SPEC.md](./SPEC.md) for the full architecture, scientific model, and
phased implementation plan. The short version:

- **Stigmergy** — ants drop a short-lived dig pheromone that recruits more
  diggers to the same site. Positive feedback concentrates excavation,
  producing tunnels rather than uniform erosion. (Grassé 1959)
- **Contact-based agitation** — collisions push ants into a brief REST state.
  This self-throttles crowded sites and reproduces the multi-stage
  excavation dynamics. (Aguilar et al. 2018; Aina et al. 2023)
- **Chamber widening** — once a soil cell has been adjacent to active
  pheromone for long enough, lateral digging is favoured over advancing.
  This is what bends pencil shafts into lobed chambers. (Tschinkel cast
  observations.)
- **Grain disposal** — excavated grains are dropped at the surface,
  building an entrance mound, biased by a longer-lived construction
  pheromone.

The simulation is deterministic for any given `?seed=` — handy for tests
and reproducible bugs.

## Performance notes

- Default (medium) tier: 480×270 grid, 500 ants, 20 Hz logical sim.
- The pheromone field uses a separable diffusion stencil with explicit
  micro-zero clamping; sparse neighbourhoods stay sparse.
- Renderer uses a single `putImageData` per frame at sim resolution,
  scaled to viewport with nearest-neighbour. Ants are drawn in vector pass
  on top so they stay crisp at any window size.

## Status / roadmap

The MVP covers SPEC §6 phases 0–3, 5–7. Notable deferrals:

- Phase 4 (GPU pheromone via WebGL2 ping-pong FBOs) is **not yet ported** —
  the CPU implementation is fast enough at default quality. Migrate when
  HIGH quality (720×405) starts dropping frames.
- Phase 8 packaging recipes (Lively / Plash / WebViewScreenSaver / xwinwrap)
  live in `packaging/` as documentation; the actual `.zip` for Lively can
  be produced with `scripts/package-lively.sh` after a build.
- Phase 9 stretch features (age stratification, foraging, day/night) are
  not implemented.

## License

MIT — see `LICENSE`.
