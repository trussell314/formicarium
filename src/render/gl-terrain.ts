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

in vec2 vUv;
out vec4 fragColor;

// World grid metadata
uniform float uW;
uniform float uH;
uniform int uTick;
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
  ivec2 sub = ivec2(uv * vec2(uW * 2.0, uH * 2.0));
  ivec2 cell = sub / 2;
  ivec2 subOff = sub - cell * 2; // 0..1 in each axis

  if (cell.x < 0 || cell.x >= wi || cell.y < 0 || cell.y >= hi) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  int k = sampleU8(uCells, cell);
  // surfRow is per-column. Stored as a 1-row-tall R16UI texture.
  int surf = sampleU16(uSurf, ivec2(cell.x, 0));
  int noiseByte = sampleU8(uSoilNoise, cell);

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
    } else {
      // Tunnel: depth fade + dig-glow tint for recently excavated.
      float depth = clamp(float(cell.y - surf) / max(1.0, uH - float(surf)), 0.0, 1.0);
      col = mix(TUNNEL_NEAR, TUNNEL_DEEP, clamp(depth * 1.4, 0.0, 1.0));
      int age = uTick - sampleI32(uDigTick, cell);
      if (age >= 0 && age < 120) {
        float t = 1.0 - float(age) / 120.0;
        col = mix(col, FRESH_DIG, 0.5 * t);
      }
    }
  } else {
    // Soil or grain: identical palette (real spoil mounds are the
    // same earth as undisturbed substrate). Per-cell noise +
    // depth-fog darkening below 55%.
    float depth = clamp(float(cell.y - surf) / max(1.0, uH - float(surf)), 0.0, 1.0);
    col = mix(SOIL_TOP, SOIL_BOT, depth);
    float n = (float(noiseByte) / 255.0 - 0.5) * 0.18;
    col *= (1.0 + n);
    if (depth > 0.55) {
      float f = (depth - 0.55) / 0.45;
      col *= (1.0 - 0.55 * f);
    }
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

  // Per-sub-cell luminance variation — same hash as the JS path.
  int subI = subOff.y * 2 + subOff.x;
  int subBase = (noiseByte + subI * 67) & 0xff;
  float subN = float(subBase) / 255.0 - 0.5;
  col *= (1.0 + subN * 0.10);

  // Pheromone overlay (additive composition).
  if (uShowPhero > 0.5) {
    float W = 0.55;
    vec4 p0 = texelFetch(uPPack0, cell, 0);
    vec4 p1 = texelFetch(uPPack1, cell, 0);
    vec4 p2 = texelFetch(uPPack2, cell, 0);
    float dv  = clamp(p0.r / 0.5,  0.0, 1.0);
    float bv  = clamp(p0.g / 0.5,  0.0, 1.0);
    float tv  = clamp(p0.b / 0.5,  0.0, 1.0);
    float av  = clamp(p0.a / 0.15, 0.0, 1.0);
    float qv  = clamp(p1.r / 4.0,  0.0, 1.0);
    float brv = clamp(p1.g / 1.5,  0.0, 1.0);
    float nv  = clamp(p1.b / 0.8,  0.0, 1.0);
    float xv  = clamp(p1.a / 2.0,  0.0, 1.0);
    float gv  = clamp(p2.r / 4.0,  0.0, 1.0);
    float tkv = clamp(p2.g / 5.0,  0.0, 1.0);
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
      'uW', 'uH', 'uTick', 'uShowPhero', 'uDaylight',
      'uCells', 'uSoilNoise', 'uSurf', 'uFood', 'uFoodMoves', 'uCorpse',
      'uSprout', 'uSproutTick', 'uDigTick',
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
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Bind sampler uniforms to texture units.
    const u = this.uniforms;
    gl.uniform1f(u.uW!, w);
    gl.uniform1f(u.uH!, h);
    gl.uniform1i(u.uTick!, world.tick);
    gl.uniform1f(u.uShowPhero!, showPheromones && pheromones ? 1.0 : 0.0);
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
