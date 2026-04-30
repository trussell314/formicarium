// WebGL2 terrain + pheromone-overlay renderer.
//
// The previous Canvas2D path computed colour per pixel in JS:
//   - sky lerp (per row)
//   - tunnel lerp (depth fade + dig glow)
//   - soil lerp (depth fog + per-cell hash noise)
//   - food / corpse / sprout overrides
//   - 10 alpha-blended pheromone overlays
//   - per-sub-cell luminance perturbation
// At 280×140 with SUB=2 that's ~157 K pixel-ops per frame at 60 Hz,
// the largest single CPU consumer in the render loop. Moving it
// onto the GPU drops the cost to a few hundred microseconds of
// texture upload + a fullscreen-quad fragment shader.
//
// The shader output matches the Canvas2D output bit-for-bit (or
// close to it; sRGB rounding may differ by ±1 in the LSB on some
// GPUs). All terrain logic lives in one fragment shader so the
// per-pixel computation stays branchless on the AIR/SOIL/GRAIN
// case selector.
//
// Sub-cell variation: the framebuffer is sized to (w*SUB) × (h*SUB)
// and the fragment shader hashes the soilNoise byte with the sub-
// cell index to reproduce the same intra-cell texture the CPU
// path used. The output canvas is then blitted to the visible
// 2D canvas via drawImage; ants/celestial/mini-map continue as
// vector primitives on Canvas2D.

const VERT_SRC = `#version 300 es
// Fullscreen quad. Emits clip-space coords for a triangle strip
// covering [-1, +1]^2; the fragment shader does all the work.
const vec2 POSITIONS[4] = vec2[](
  vec2(-1.0, -1.0), vec2( 1.0, -1.0),
  vec2(-1.0,  1.0), vec2( 1.0,  1.0)
);
out vec2 vUv;
void main() {
  vec2 p = POSITIONS[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
  // UV in [0,1]: (0,0) at top-left, (1,1) at bottom-right. Y-flipped
  // because GL's NDC origin is bottom-left but we sample textures
  // top-down to match the JS row-major layout.
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
// Integer samplers (used below for the per-column natural-surface
// row and the per-cell sprout/dig tick fields) MUST have an explicit
// precision in GLSL ES 3.0 fragment shaders — there's no default.
// On Chromium/V8 (Linux + headless variants, plus a number of mobile
// and WebView environments) the shader compile fails with
// "No precision specified" if these are omitted, the GLTerrainRenderer
// constructor throws, the renderer catches it, and we fall back to the
// CPU pixel-loop path. At 300×300 the CPU path with the pheromone
// overlay on does ~50 ms / frame just on the terrain ImageData write
// plus ~30 ms / frame on the overlay composite — slow enough to read
// as "the sim locks the moment I click the overlay button".
precision highp usampler2D;
precision highp isampler2D;

in vec2 vUv;
out vec4 fragColor;

// World grid metadata
uniform float uW;
uniform float uH;
uniform int uTick;
uniform int uSub;       // sub-cell scale (SUB×SUB pixels per cell)
uniform float uShowPhero;

// Per-cell scalar fields. Integer textures (R16UI / R32I) MUST be
// sampled with usampler2D / isampler2D respectively; using a plain
// sampler2D returns implementation-defined garbage in WebGL2.
uniform sampler2D uCells;        // R8: 0=AIR, 1=SOIL, 2=GRAIN
uniform sampler2D uSoilNoise;    // R8: per-cell hash
uniform usampler2D uSurf;        // R16UI: per-column natural surface
uniform sampler2D uFood;         // R8: per-cell food count
uniform sampler2D uFoodMoves;    // R8: per-cell move counter
uniform sampler2D uCorpse;       // R8: per-cell corpse marker
uniform sampler2D uSprout;       // R8: per-cell sprout marker
uniform isampler2D uSproutTick;  // R32I: per-cell sprout tick
uniform isampler2D uDigTick;     // R32I: per-cell dig tick
uniform sampler2D uPlant;        // R8: per-column plant kind (1..3)
uniform usampler2D uPlantHeight; // R16UI: per-column current height in cells

// Pheromone fields packed into 3 RGBA32F textures so the total
// sampler count stays under MAX_TEXTURE_IMAGE_UNITS (WebGL2
// guarantees ≥ 16; we had 19 with one sampler per field). Layout:
//   uPPack0: dig(r),  build(g), trail(b),  alarm(a)
//   uPPack1: queen(r), brood(g), necro(b),  noEntry(a)
//   uPPack2: granary(r), trunk(g), unused, unused
uniform sampler2D uPPack0;
uniform sampler2D uPPack1;
uniform sampler2D uPPack2;

// Palette stops mirror the Canvas2D constants in renderer.ts so
// the visual output matches frame-for-frame.
const vec3 SKY_TOP_NIGHT = vec3(10.0, 14.0, 28.0) / 255.0;
const vec3 SKY_BOT_NIGHT = vec3(22.0, 22.0, 36.0) / 255.0;
const vec3 SKY_TOP_DAY   = vec3(120.0, 145.0, 180.0) / 255.0;
const vec3 SKY_BOT_DAY   = vec3(185.0, 195.0, 215.0) / 255.0;
const vec3 TUNNEL_NEAR   = vec3(148.0, 110.0,  78.0) / 255.0;
const vec3 TUNNEL_DEEP   = vec3( 42.0,  28.0,  20.0) / 255.0;
const vec3 SOIL_TOP      = vec3( 70.0,  44.0,  22.0) / 255.0;
const vec3 SOIL_BOT      = vec3( 42.0,  24.0,  12.0) / 255.0;
const vec3 FRESH_DIG     = vec3( 78.0,  56.0,  38.0) / 255.0;
const vec3 FOOD_FRESH    = vec3( 90.0, 220.0,  70.0) / 255.0;
const vec3 FOOD_WORN     = vec3( 30.0,  80.0,  24.0) / 255.0;
const float MOVE_COLOUR_CAP = 30.0;

uniform float uDaylight;

// Sample helpers. R8 textures are normalized to [0,1] — multiply by
// 255 for the original integer value. R16UI / R32I are integer-typed
// and need usampler2D / isampler2D variants of texelFetch.
int sampleU8(sampler2D s, ivec2 c) {
  return int(texelFetch(s, c, 0).r * 255.0 + 0.5);
}
int sampleU16(usampler2D s, ivec2 c) {
  return int(texelFetch(s, c, 0).r);
}
int sampleI32(isampler2D s, ivec2 c) {
  return texelFetch(s, c, 0).r;
}

void main() {
  // Sub-cell coords. The framebuffer is (w*SUB) × (h*SUB); to recover
  // (x, y) in cell space we divide by SUB. The sub-cell index is
  // used for per-sub-cell luminance perturbation.
  vec2 uv = vUv;
  int wi = int(uW);
  int hi = int(uH);
  // Pixel coord in the framebuffer (sub-cell space).
  ivec2 sub = ivec2(uv * vec2(uW * float(uSub), uH * float(uSub)));
  ivec2 cell = sub / uSub;
  ivec2 subOff = sub - cell * uSub; // 0..uSub-1 in each axis

  if (cell.x < 0 || cell.x >= wi || cell.y < 0 || cell.y >= hi) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  int k = sampleU8(uCells, cell);
  // surfRow is per-column. Stored as a 1-row-tall R16UI texture.
  int surf = sampleU16(uSurf, ivec2(cell.x, 0));
  int noiseByte = sampleU8(uSoilNoise, cell);

  // Multi-octave soil noise (#5). Three hashed bands at different
  // spatial frequencies sum to a believable rocky/sedimentary
  // texture instead of uniform white-noise speckle. Cheap because
  // they're all pure integer hashes per pixel.
  int hashA = noiseByte;
  int hashB = sampleU8(uSoilNoise, ivec2(cell.x / 2, cell.y / 2));
  int hashC = sampleU8(uSoilNoise, ivec2(cell.x / 4, cell.y / 6));
  float n1 = (float(hashA) / 255.0 - 0.5);
  float n2 = (float(hashB) / 255.0 - 0.5);
  float n3 = (float(hashC) / 255.0 - 0.5);
  float multiNoise = (n1 * 0.10 + n2 * 0.06 + n3 * 0.04);

  // Cell-neighbour samples for rim-light + AO (#6, #7). Cheap:
  // 4 extra texelFetches.
  int kU = cell.y > 0 ? sampleU8(uCells, ivec2(cell.x, cell.y - 1)) : 1;
  int kD = cell.y < hi - 1 ? sampleU8(uCells, ivec2(cell.x, cell.y + 1)) : 1;
  int kL = cell.x > 0 ? sampleU8(uCells, ivec2(cell.x - 1, cell.y)) : 1;
  int kR = cell.x < wi - 1 ? sampleU8(uCells, ivec2(cell.x + 1, cell.y)) : 1;
  int airNbrs = (kU == 0 ? 1 : 0) + (kD == 0 ? 1 : 0) + (kL == 0 ? 1 : 0) + (kR == 0 ? 1 : 0);

  vec3 col;
  // Sky vs tunnel vs soil vs grain branches. Mirrors the JS terrain
  // pass exactly. The "fresh dig glow" tints AIR cells dug recently.
  if (k == 0) {
    if (cell.y < surf) {
      // Sky: lerp by daylight then by row depth.
      vec3 skyTop = mix(SKY_TOP_NIGHT, SKY_TOP_DAY, uDaylight);
      vec3 skyBot = mix(SKY_BOT_NIGHT, SKY_BOT_DAY, uDaylight);
      float skyT = clamp(float(cell.y) / max(1.0, uH * 0.5), 0.0, 1.0);
      col = mix(skyTop, skyBot, skyT);
      // Surface vegetation. plantKind ∈ {1,2,3} = grass/shrub/tree
      // selects the silhouette character (width, taper, palette);
      // plantHeight is the current cell-count height, growing from 1
      // to PLANT_MAX_HEIGHT[kind] over many ticks. Both render
      // branches modulate by daylight so plants read dark at night.
      int plantKind = sampleU8(uPlant, ivec2(cell.x, 0));
      int plantH = sampleU16(uPlantHeight, ivec2(cell.x, 0));
      int plantBase = surf - 1;
      int plantTop = surf - plantH;
      if (plantKind > 0 && plantH > 0 && cell.y >= plantTop && cell.y <= plantBase) {
        int hashP = sampleU8(uSoilNoise, ivec2(cell.x, max(cell.y, 0)));
        // Trunk proportions per kind. Grass = 1-cell stem (real
        // grasses have no woody trunk — leaves spring from a basal
        // crown). Shrubs = 2-cell woody base, leafy canopy above
        // (creosote bushes out near the ground). Trees = ~quarter-
        // height trunk, rest canopy (mesquite trunk ~1 m, canopy
        // ~3-4 m). At the visible crop these read as: grass tufts,
        // shrub canopies on the surface, brown trunks rising off-
        // screen for trees.
        int trunkCells =
          (plantKind == 1) ? 1 :
          ((plantKind == 2) ? 2 : max(1, plantH / 4));
        bool isTrunkRow = (cell.y > plantBase - trunkCells);
        // distFromTop counts up from the canopy crown (0 = topmost
        // cell of the plant), used to taper canopy width.
        int distFromTop = cell.y - plantTop;
        int subEdge = (uSub - 1);
        bool inSilhouette = true;
        if (isTrunkRow) {
          // Trunk: centre sub-cells. Width by kind — grass is a
          // single sub-cell stem, shrubs 2-3, trees up to ~half SUB.
          int trunkHalf = (plantKind == 1) ? 0 : (plantKind == 2 ? 1 : max(1, uSub / 4));
          int stemCenter = uSub / 2;
          int dxs = subOff.x - stemCenter;
          if (dxs < -trunkHalf || dxs > trunkHalf) inSilhouette = false;
        } else {
          // Canopy: tapered. At the very top the silhouette pinches
          // in; at the trunk shoulder it bulges out. Tree canopies
          // are wider than shrubs which are wider than grass tufts.
          int kindWidth = (plantKind == 1) ? 0 : (plantKind == 2 ? 1 : 2);
          int kindMargin = subEdge - kindWidth;
          int taperMargin = (distFromTop == 0) ? max(kindMargin, subEdge / 2)
                                              : ((hashP & 3) > 1 ? max(0, kindMargin - 1) : kindMargin);
          int margin = max(0, taperMargin / 2);
          if (subOff.x < margin || subOff.x > subEdge - margin) inSilhouette = false;
        }
        if (inSilhouette) {
          vec3 trunkCol = vec3(82.0, 60.0, 30.0) / 255.0;
          vec3 canopyCol = vec3(70.0, 130.0, 55.0) / 255.0;
          // Shrubs and trees get a slightly darker, more saturated
          // canopy than grass.
          if (plantKind >= 2) canopyCol = vec3(56.0, 110.0, 48.0) / 255.0;
          if (plantKind >= 3) canopyCol = vec3(44.0, 90.0, 42.0) / 255.0;
          // Tree trunks are a slightly darker bark than the woody
          // stems of shrub/grass.
          if (plantKind >= 3) trunkCol = vec3(64.0, 44.0, 22.0) / 255.0;
          vec3 plantC = isTrunkRow ? trunkCol : canopyCol;
          // Per-pixel hash variation (±10% luminance) and night dim.
          float vJitter = (float(hashP & 31) / 31.0 - 0.5) * 0.20;
          plantC *= (1.0 + vJitter);
          plantC *= mix(0.45, 1.0, uDaylight);
          col = plantC;
        }
      }
    } else {
      // Tunnel: depth fade + dig-glow tint for recently excavated.
      float depth = clamp(float(cell.y - surf) / max(1.0, uH - float(surf)), 0.0, 1.0);
      col = mix(TUNNEL_NEAR, TUNNEL_DEEP, clamp(depth * 1.4, 0.0, 1.0));
      int age = uTick - sampleI32(uDigTick, cell);
      if (age >= 0 && age < 120) {
        float t = 1.0 - float(age) / 120.0;
        col = mix(col, FRESH_DIG, 0.5 * t);
      }
      // Sunlight cone (#9). When the column above this AIR cell
      // remains open all the way to the surface, daylight reaches
      // down. Approximate by checking surf — if cell.y is just
      // below surf, give a vertical brightening that fades with
      // depth and with daylight. Cheap: no ray-march, just a
      // distance-from-surface factor.
      int colSurf = sampleU16(uSurf, ivec2(cell.x, 0));
      float depthFromSurf = float(cell.y - colSurf);
      float coneDepth = clamp(1.0 - depthFromSurf / 8.0, 0.0, 1.0);
      // Only apply if the surface row at this column has been
      // dug (i.e. there's an entrance above us).
      int surfCell = sampleU8(uCells, ivec2(cell.x, colSurf));
      if (surfCell == 0) {
        float coneAmt = coneDepth * uDaylight * 0.4;
        col = mix(col, vec3(1.0, 0.95, 0.78), coneAmt);
      }
      // AO at chamber corners (#7). Cells with FEW air neighbours
      // (1-2 = chamber corner pocket) get a subtle dark halo;
      // open chambers (3-4 air nbrs) get neutral. Reads as
      // self-shadowing in concave geometry.
      float aoFactor = airNbrs <= 1 ? 0.85 : (airNbrs == 2 ? 0.93 : 1.0);
      col *= aoFactor;
      // Localized brood/queen lighting (#10). At night, lit
      // chambers glow softly. Sample the same packed pheromones
      // we'll use for the overlay below.
      vec4 p1Light = texelFetch(uPPack1, cell, 0);
      float queenLight = clamp(p1Light.r / 4.0, 0.0, 1.0);
      float broodLight = clamp(p1Light.g / 1.0, 0.0, 1.0);
      float darkness = 1.0 - uDaylight;
      col += vec3(0.7, 0.5, 0.3) * (queenLight + broodLight) * 0.18 * darkness;
    }
  } else {
    // Soil or grain: identical palette (real spoil mounds are the
    // same earth as undisturbed substrate). Multi-octave noise +
    // depth-fog darkening below 55%.
    float depth = clamp(float(cell.y - surf) / max(1.0, uH - float(surf)), 0.0, 1.0);
    col = mix(SOIL_TOP, SOIL_BOT, depth);
    col *= (1.0 + multiNoise);
    if (depth > 0.55) {
      float f = (depth - 0.55) / 0.45;
      col *= (1.0 - 0.55 * f);
    }
    // Rim light (#6). A SOIL cell adjacent to AIR above gets a
    // brighter top edge — simulates ambient sky-light bouncing
    // off the chamber ceiling. Pure shader logic; no extra cost
    // beyond the existing kU sample above.
    if (kU == 0) {
      // Brighten the upper sub-cell rows of this cell. subOff.y=0
      // is the top half of the SUB×SUB block; biggest tint there.
      float rimT = subOff.y == 0 ? 0.18 : 0.06;
      col = mix(col, col * 1.4, rimT);
    }
    // Time-of-day color grading (#8). Soil takes a warm tint at
    // low daylight (sunset) and a cool blue at high daylight, with
    // neutral at midday. Subtle — just shifts the hue slightly.
    vec3 tintWarm = vec3(1.05, 0.95, 0.85);
    vec3 tintCool = vec3(0.92, 0.96, 1.05);
    float dayBlend = smoothstep(0.0, 1.0, uDaylight);
    vec3 todTint = mix(tintWarm, tintCool, dayBlend);
    col *= mix(vec3(1.0), todTint, 0.35);
  }

  // Food overlay — always over AIR/SOIL.
  int foodCount = sampleU8(uFood, cell);
  if (foodCount > 0) {
    int moves = sampleU8(uFoodMoves, cell);
    float t = clamp(float(moves) / MOVE_COLOUR_CAP, 0.0, 1.0);
    col = mix(FOOD_FRESH, FOOD_WORN, t);
  }
  // Corpse marker.
  int corpse = sampleU8(uCorpse, cell);
  if (corpse > 0) {
    col = vec3(90.0, 70.0, 92.0) / 255.0;
  }
  // Sprout marker.
  int sprout = sampleU8(uSprout, cell);
  if (sprout > 0) {
    int age = uTick - sampleI32(uSproutTick, cell);
    float t = clamp(float(age) / 1000.0, 0.4, 1.0);
    col = vec3(70.0 * t, 230.0 * t, 50.0 * t) / 255.0;
  }

  // Per-sub-cell luminance variation. Hash uses subOff packed into
  // a single index that's stable across SUB values. Only applied to
  // SOIL/GRAIN — on AIR (sky and tunnel) the perturbation has no
  // material to texture and shows up as a paper-grain speckle that's
  // particularly visible against the bright daytime sky.
  if (k != 0) {
    int subI = subOff.y * uSub + subOff.x;
    int subBase = (noiseByte + subI * 67) & 0xff;
    float subN = float(subBase) / 255.0 - 0.5;
    col *= (1.0 + subN * 0.10);
  }

  // Pheromone overlay (additive composition).
  if (uShowPhero > 0.5) {
    float W = 0.55;
    // Edge-fade halos (#16). Box-blur the packed pheromones across
    // the 3×3 cell neighbourhood so trails read as fuzzy chemical
    // clouds rather than the cell-grid mosaic produced by raw
    // texelFetch. 9 reads per pack × 3 packs = 27 reads; trivial
    // GPU cost. Only runs when overlay is on.
    vec4 p0 = vec4(0.0), p1 = vec4(0.0), p2 = vec4(0.0);
    float wTot = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        int sx = clamp(cell.x + dx, 0, wi - 1);
        int sy = clamp(cell.y + dy, 0, hi - 1);
        // Centre-weighted: 4 / 2 / 1 falloff (corners get 1).
        float w = (dx == 0 && dy == 0) ? 4.0 : ((dx == 0 || dy == 0) ? 2.0 : 1.0);
        ivec2 sc = ivec2(sx, sy);
        p0 += texelFetch(uPPack0, sc, 0) * w;
        p1 += texelFetch(uPPack1, sc, 0) * w;
        p2 += texelFetch(uPPack2, sc, 0) * w;
        wTot += w;
      }
    }
    p0 /= wTot; p1 /= wTot; p2 /= wTot;
    // Non-linear (sqrt) mapping. Linear value/divisor mapping
    // hides low concentrations: at high sim speeds deposits smear
    // across more cells per wall-frame, peak values drop, and a
    // linear ramp pushes them below visibility. sqrt boosts contrast
    // at the low end.
    float dv  = sqrt(clamp(p0.r / 0.25,  0.0, 1.0));
    float bv  = sqrt(clamp(p0.g / 0.25,  0.0, 1.0));
    float tv  = sqrt(clamp(p0.b / 0.25,  0.0, 1.0));
    float av  = sqrt(clamp(p0.a / 0.075, 0.0, 1.0));
    // Pulsing alarm (#17). Multiply alarm contribution by
    // 0.7 + 0.3 sin(uTick * 0.2) so active alarm visibly throbs
    // rather than reading as static colouring. Real alarm is a
    // burst response, not a steady signal.
    av *= 0.7 + 0.3 * sin(float(uTick) * 0.2);
    float qv  = sqrt(clamp(p1.r / 2.0,   0.0, 1.0));
    float brv = sqrt(clamp(p1.g / 0.75,  0.0, 1.0));
    float nv  = sqrt(clamp(p1.b / 0.4,   0.0, 1.0));
    float xv  = sqrt(clamp(p1.a / 1.0,   0.0, 1.0));
    float gv  = sqrt(clamp(p2.r / 2.0,   0.0, 1.0));
    float tkv = sqrt(clamp(p2.g / 2.5,   0.0, 1.0));
    // Heat-distortion at saturation (#19). When any field is at
    // its display peak, jitter the colour slightly with a
    // tick-driven sine — reads as a chemical haze rippling at
    // high concentration. The peakAny check keeps quiet fields
    // smooth and reserves the effect for visible saturation.
    float peakAny = max(max(max(dv, bv), max(qv, brv)), max(av, gv));
    if (peakAny > 0.85) {
      float wobble = sin(float(uTick) * 0.3 + float(cell.x) * 0.4 + float(cell.y) * 0.4) * 0.04 * (peakAny - 0.85);
      col += vec3(wobble);
    }
    col += (vec3(0.0,   220.0, 220.0) / 255.0 - col) * dv  * W;
    col += (vec3(220.0, 0.0,   220.0) / 255.0 - col) * bv  * W;
    col += (vec3(240.0, 220.0, 60.0)  / 255.0 - col) * tv  * W;
    col += (vec3(255.0, 30.0,  30.0)  / 255.0 - col) * av  * 0.75;
    col += (vec3(110.0, 70.0,  200.0) / 255.0 - col) * qv  * W;
    col += (vec3(255.0, 180.0, 180.0) / 255.0 - col) * brv * W;
    col += (vec3(140.0, 130.0, 50.0)  / 255.0 - col) * nv  * W;
    col += (vec3(140.0, 150.0, 170.0) / 255.0 - col) * xv  * W;
    col += (vec3(255.0, 160.0, 60.0)  / 255.0 - col) * gv  * W;
    col += (vec3(200.0, 170.0, 30.0)  / 255.0 - col) * tkv * W;
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export interface GLTerrainState {
  cells: Uint8Array;
  soilNoise: Uint8Array;
  naturalSurface: Uint16Array;
  food: Uint8Array;
  foodMoves: Uint8Array;
  corpse: Uint8Array;
  sprout: Uint8Array;
  sproutTick: Int32Array;
  digTick: Int32Array;
  plant: Uint8Array;
  plantHeight: Uint16Array;
  tick: number;
  width: number;
  height: number;
}

export interface GLPheromones {
  dig: Float32Array;
  build: Float32Array;
  trail: Float32Array;
  alarm: Float32Array;
  queen: Float32Array;
  brood: Float32Array;
  necro: Float32Array;
  noEntry: Float32Array;
  granary: Float32Array;
  trunk: Float32Array;
}

interface TextureSlot {
  tex: WebGLTexture;
  unit: number;
  internalFormat: GLenum;
  format: GLenum;
  type: GLenum;
}

export class GLTerrainRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private width: number;
  private height: number;
  private readonly SUB: number;
  private slots: Record<string, TextureSlot>;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  /** Interleave scratch for the 3 RGBA32F pheromone packs. Allocated
   *  once at the size of the world × 4; reused every frame so we
   *  don't churn GC. Sized lazily on first uploadPheromones() call. */
  private pheroPack0?: Float32Array;
  private pheroPack1?: Float32Array;
  private pheroPack2?: Float32Array;
  /** True once at least one frame has uploaded real pheromone packs.
   *  Lets us keep `uShowPhero=1` on throttled frames where the
   *  caller doesn't pass new data — we render against the cached
   *  GPU textures rather than flickering the overlay off. */
  private pPackUploaded = false;

  constructor(width: number, height: number, SUB: number) {
    this.width = width;
    this.height = height;
    this.SUB = SUB;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width * SUB;
    this.canvas.height = height * SUB;
    const gl = this.canvas.getContext('webgl2', {
      // We re-render every frame so we don't need the swap-chain
      // contents to persist; auto-clear is fine. drawImage(canvas)
      // reads the front buffer right after rendering, before any
      // GL command can have cleared it.
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    // Compile and link the terrain program once. Both shaders are
    // tiny; failures here are programmer errors, not user-facing.
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    this.program = prog;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    this.uniforms = {};
    for (const name of [
      'uW', 'uH', 'uTick', 'uSub', 'uShowPhero', 'uDaylight',
      'uCells', 'uSoilNoise', 'uSurf', 'uFood', 'uFoodMoves', 'uCorpse',
      'uSprout', 'uSproutTick', 'uDigTick', 'uPlant', 'uPlantHeight',
      'uPPack0', 'uPPack1', 'uPPack2',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(prog, name);
    }
    // Texture slots. Each terrain texture gets a fixed unit so we
    // can bind them once at first frame and keep them across frames.
    this.slots = {};
    let unit = 0;
    const addSlot = (name: string, internalFormat: GLenum, format: GLenum, type: GLenum): void => {
      const tex = gl.createTexture();
      if (!tex) throw new Error('createTexture failed');
      this.slots[name] = { tex, unit, internalFormat, format, type };
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      unit++;
    };
    // Grid textures (width × height). U8 single-channel for most;
    // R16UI for naturalSurface (height up to 65k); R32I for tick
    // counters which need negative initial values.
    addSlot('cells', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('soilNoise', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('food', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('foodMoves', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('corpse', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('sprout', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('sproutTick', gl.R32I, gl.RED_INTEGER, gl.INT);
    addSlot('digTick', gl.R32I, gl.RED_INTEGER, gl.INT);
    addSlot('surf', gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
    addSlot('plant', gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    addSlot('plantHeight', gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT);
    // Pheromone textures: 4 fields per RGBA32F texture, 3 textures
    // for 10 fields. Keeping 19 single-channel samplers exceeded
    // the WebGL2 minimum guarantee (MAX_TEXTURE_IMAGE_UNITS = 16).
    addSlot('pPack0', gl.RGBA32F, gl.RGBA, gl.FLOAT);
    addSlot('pPack1', gl.RGBA32F, gl.RGBA, gl.FLOAT);
    addSlot('pPack2', gl.RGBA32F, gl.RGBA, gl.FLOAT);
    // Initialise every texture with a 1×1 zero so samplers don't read
    // from uninitialised memory before the first uploadGrid call.
    // The RGBA32F pheromone packs need 4 channels of data, even at
    // 1×1, so they get a 4-element zero buffer; everything else is
    // single-channel and a 1-element zero suffices.
    const zeroU8 = new Uint8Array(4);
    const zeroI32 = new Int32Array(1);
    const zeroU16 = new Uint16Array(1);
    const zero1F = new Float32Array(1);
    const zero4F = new Float32Array(4);
    for (const name of Object.keys(this.slots)) {
      const slot = this.slots[name]!;
      gl.activeTexture(gl.TEXTURE0 + slot.unit);
      gl.bindTexture(gl.TEXTURE_2D, slot.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      let data: ArrayBufferView;
      if (slot.format === gl.RGBA) data = zero4F;
      else if (slot.type === gl.INT) data = zeroI32;
      else if (slot.type === gl.UNSIGNED_SHORT) data = zeroU16;
      else if (slot.type === gl.FLOAT) data = zero1F;
      else data = zeroU8;
      gl.texImage2D(gl.TEXTURE_2D, 0, slot.internalFormat, 1, 1, 0,
        slot.format, slot.type, data);
    }
  }

  render(world: GLTerrainState, daylight: number, showPheromones: boolean,
    pheromones: GLPheromones | null): void {
    const gl = this.gl;
    const w = world.width;
    const h = world.height;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w * this.SUB;
      this.canvas.height = h * this.SUB;
    }

    // Upload textures. texSubImage2D would be nominally faster than
    // texImage2D, but the world dims are static across reseed and
    // texImage2D is the simpler call. At 280×140 the upload total
    // is ~250 KB per frame across all textures — bandwidth-trivial.
    this.uploadGrid('cells', world.cells, w, h);
    this.uploadGrid('soilNoise', world.soilNoise, w, h);
    this.uploadGrid('food', world.food, w, h);
    this.uploadGrid('foodMoves', world.foodMoves, w, h);
    this.uploadGrid('corpse', world.corpse, w, h);
    this.uploadGrid('sprout', world.sprout, w, h);
    this.uploadGrid('sproutTick', world.sproutTick, w, h);
    this.uploadGrid('digTick', world.digTick, w, h);
    this.uploadGrid('surf', world.naturalSurface, w, 1);
    this.uploadGrid('plant', world.plant, w, 1);
    this.uploadGrid('plantHeight', world.plantHeight, w, 1);
    if (pheromones) {
      // Interleave 4 single-channel Float32 fields into an RGBA
      // buffer per packed texture. We hold the scratch buffers as
      // class fields so we don't allocate every frame.
      const cells = w * h;
      if (!this.pheroPack0 || this.pheroPack0.length !== cells * 4) {
        this.pheroPack0 = new Float32Array(cells * 4);
        this.pheroPack1 = new Float32Array(cells * 4);
        this.pheroPack2 = new Float32Array(cells * 4);
      }
      packFour(this.pheroPack0, pheromones.dig, pheromones.build,
        pheromones.trail, pheromones.alarm, cells);
      packFour(this.pheroPack1!, pheromones.queen, pheromones.brood,
        pheromones.necro, pheromones.noEntry, cells);
      packFour(this.pheroPack2!, pheromones.granary, pheromones.trunk,
        null, null, cells);
      this.uploadGrid('pPack0', this.pheroPack0, w, h);
      this.uploadGrid('pPack1', this.pheroPack1!, w, h);
      this.uploadGrid('pPack2', this.pheroPack2!, w, h);
      this.pPackUploaded = true;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Bind sampler uniforms to texture units.
    const u = this.uniforms;
    gl.uniform1f(u.uW!, w);
    gl.uniform1f(u.uH!, h);
    gl.uniform1i(u.uSub!, this.SUB);
    gl.uniform1i(u.uTick!, world.tick);
    // showPheromones AND we've uploaded real packs at least once
    // — frames where the caller throttles `pheromones` to null
    // re-use the last packs that did get uploaded.
    gl.uniform1f(u.uShowPhero!, showPheromones && this.pPackUploaded ? 1.0 : 0.0);
    gl.uniform1f(u.uDaylight!, daylight);
    this.bindSampler('uCells', 'cells');
    this.bindSampler('uSoilNoise', 'soilNoise');
    this.bindSampler('uSurf', 'surf');
    this.bindSampler('uFood', 'food');
    this.bindSampler('uFoodMoves', 'foodMoves');
    this.bindSampler('uCorpse', 'corpse');
    this.bindSampler('uSprout', 'sprout');
    this.bindSampler('uSproutTick', 'sproutTick');
    this.bindSampler('uDigTick', 'digTick');
    this.bindSampler('uPlant', 'plant');
    this.bindSampler('uPlantHeight', 'plantHeight');
    this.bindSampler('uPPack0', 'pPack0');
    this.bindSampler('uPPack1', 'pPack1');
    this.bindSampler('uPPack2', 'pPack2');

    // Fullscreen triangle strip — vertex shader emits the corners.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindSampler(uniformName: string, slotName: string): void {
    const slot = this.slots[slotName];
    if (!slot) return;
    const loc = this.uniforms[uniformName];
    if (loc) this.gl.uniform1i(loc, slot.unit);
  }

  private uploadGrid(name: string, data: ArrayBufferView,
    w: number, h: number): void {
    const slot = this.slots[name];
    if (!slot) throw new Error(`unknown texture slot: ${name}`);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + slot.unit);
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      slot.internalFormat,
      w, h, 0,
      slot.format, slot.type,
      data,
    );
  }
}

/** Interleave up to 4 single-channel Float32 fields into an RGBA
 *  buffer. Channels with no source field get zeroed. The dst buffer
 *  must be pre-allocated to length 4 × cells. */
function packFour(
  dst: Float32Array,
  r: Float32Array,
  g: Float32Array | null,
  b: Float32Array | null,
  a: Float32Array | null,
  cells: number,
): void {
  for (let i = 0; i < cells; i++) {
    const o = i << 2;
    dst[o] = r[i] ?? 0;
    dst[o + 1] = g ? (g[i] ?? 0) : 0;
    dst[o + 2] = b ? (b[i] ?? 0) : 0;
    dst[o + 3] = a ? (a[i] ?? 0) : 0;
  }
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    throw new Error(`shader compile failed: ${log}\n--- src ---\n${src}`);
  }
  return sh;
}
