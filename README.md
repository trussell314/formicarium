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
| `?seed=` | integer | Reproducible run (any integer; default time-seeded) |
| `?width=` | integer | World width in cells (default 200) |
| `?height=` | integer | World height in cells (default 100) |
| `?ants=` | integer | Initial ant count (default 100) |
| `?speed=` | integer | Sim sub-steps per render frame (default 8) |

## Keyboard

- **space** — pause / resume
- **+** / **-** — faster / slower (sub-steps per frame, doubles/halves)
- **r** — reseed and rebuild the world
- **f** — toggle fullscreen
- **0** — reset zoom + pan
- **p** — toggle pheromone overlay (cyan = dig, magenta = build)
- **?** — show / hide help panel

## Mouse / touch

- **Wheel / pinch** — zoom (1× to 6×) anchored at the cursor / midpoint
- **Drag** — pan (only when zoomed in)

## On-screen controls

A button cluster at the bottom of the viewport mirrors every keyboard
binding, so the simulation is fully usable on devices without a
keyboard (iOS in particular).

## How it works

See [SPEC.md](./SPEC.md) for the full architecture, scientific model, and
phased implementation plan. The short version:

- **Stigmergy** — ants drop a short-lived dig pheromone that recruits more
  diggers to the same site. Positive feedback concentrates excavation,
  producing tunnels rather than uniform erosion. (Grassé 1959)
- **Contact-based agitation** — collisions push ants into a brief REST state.
  This self-throttles crowded sites and reproduces the multi-stage
  excavation dynamics. (Aguilar et al. 2018; Aina et al. 2023)
- **Per-ant heterogeneity** — each ant samples its dig probability,
  pickup probability, stigmergy strength, turn noise, and rest
  threshold from a Gaussian around the colony mean. (Beshers & Fewell
  2001)
- **Topochemistry** — local construction pheromone boosts the dig
  probability when an ant is next to existing spoil. Each mound
  becomes a hub for radiating tunnels. (Khuong et al. 2016)
- **Granular dynamics** — excavated grains follow a Bak/Tang/Wiesenfeld
  sandpile cascade (fall straight down through air, slump diagonally
  on slopes). Angle-of-repose is emergent, not a hardcoded check.
  Ants both deposit AND pick up grain, per the Theraulaz construction
  model (1998).

The simulation is deterministic for any given `?seed=` — handy for tests
and reproducible bugs.

## Performance notes

- Default: 200×100 grid, 100 ants, 30 Hz logical sim with 8 sim
  sub-steps per render frame.
- Pheromone field uses a 5-point diffusion stencil with explicit
  micro-zero clamping; sparse neighbourhoods stay sparse.
- Renderer uses a single `putImageData` per frame at sim resolution,
  scaled to viewport with nearest-neighbour. Ants are drawn in vector
  pass on top so they stay crisp at any window size.

## Status

Currently shipped: per-ant Beshers-Fewell heterogeneity, Sudd
contact-triggered dig, Theraulaz pickup, Khuong topochemistry, Aguilar/
Aina collision-driven REST, sandpile granular settling, in-app zoom +
pan, on-screen controls. Foraging, day/night, multiple queens, and
caste are out of scope.

## License

MIT — see `LICENSE`.
