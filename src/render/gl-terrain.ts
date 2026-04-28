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

// Per-cell scalar fields (all u8 textures except surfRow).
uniform sampler2D uCells;       // 0=AIR, 1=SOIL, 2=GRAIN
uniform sampler2D uSoilNoise;   // u8 per-cell hash
uniform sampler2D uSurf;        // u16 per-column natural surface (stored in R16UI)
uniform sampler2D uFood;        // u8 per-cell food count
uniform sampler2D uFoodMoves;   // u8 per-cell move counter
uniform sampler2D uCorpse;      // u8 per-cell corpse marker
uniform sampler2D uSprout;      // u8 per-cell sprout marker
uniform sampler2D uSproutTick;  // i32 per-cell sprout tick (R32I)
uniform sampler2D uDigTick;     // i32 per-cell dig tick (R32I)

// Pheromone fields. All Float32 single-channel (R32F).
uniform sampler2D uPDig;
uniform sampler2D uPBuild;
uniform sampler2D uPTrail;
uniform sampler2D uPAlarm;
uniform sampler2D uPQueen;
uniform sampler2D uPBrood;
uniform sampler2D uPNecro;
uniform sampler2D uPNoEntry;
uniform sampler2D uPGranary;
uniform sampler2D uPTrunk;

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

// Sample a u8 single-channel texture with nearest filtering at
// integer cell coords. The texture format is R8 normalized to [0,1];
// multiply by 255 for the integer value.
int sampleU8(sampler2D s, ivec2 c) {
  return int(texelFetch(s, c, 0).r * 255.0 + 0.5);
}
int sampleU16(sampler2D s, ivec2 c) {
  // R16UI is integer-typed, so we use texelFetch returning uvec4.
  return int(texelFetch(s, c, 0).r);
}
int sampleI32(sampler2D s, ivec2 c) {
  return int(texelFetch(s, c, 0).r);
}
float sampleF32(sampler2D s, ivec2 c) {
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
    float dv  = clamp(sampleF32(uPDig,     cell) / 0.5,  0.0, 1.0);
    float bv  = clamp(sampleF32(uPBuild,   cell) / 0.5,  0.0, 1.0);
    float tv  = clamp(sampleF32(uPTrail,   cell) / 0.5,  0.0, 1.0);
    float av  = clamp(sampleF32(uPAlarm,   cell) / 0.15, 0.0, 1.0);
    float qv  = clamp(sampleF32(uPQueen,   cell) / 4.0,  0.0, 1.0);
    float brv = clamp(sampleF32(uPBrood,   cell) / 1.5,  0.0, 1.0);
    float nv  = clamp(sampleF32(uPNecro,   cell) / 0.8,  0.0, 1.0);
    float xv  = clamp(sampleF32(uPNoEntry, cell) / 2.0,  0.0, 1.0);
    float gv  = clamp(sampleF32(uPGranary, cell) / 4.0,  0.0, 1.0);
    float tkv = clamp(sampleF32(uPTrunk,   cell) / 5.0,  0.0, 1.0);
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
      'uPDig', 'uPBuild', 'uPTrail', 'uPAlarm', 'uPQueen',
      'uPBrood', 'uPNecro', 'uPNoEntry', 'uPGranary', 'uPTrunk',
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
    // Pheromone textures (R32F).
    for (const name of ['pDig', 'pBuild', 'pTrail', 'pAlarm', 'pQueen',
      'pBrood', 'pNecro', 'pNoEntry', 'pGranary', 'pTrunk']) {
      addSlot(name, gl.R32F, gl.RED, gl.FLOAT);
    }
    // Initialise every texture with a 1×1 zero so samplers don't read
    // from uninitialised memory before the first uploadGrid call.
    // After the first frame the real data overwrites these.
    const zeroU8 = new Uint8Array(1);
    const zeroI32 = new Int32Array(1);
    const zeroU16 = new Uint16Array(1);
    const zeroF32 = new Float32Array(1);
    for (const name of Object.keys(this.slots)) {
      const slot = this.slots[name]!;
      gl.activeTexture(gl.TEXTURE0 + slot.unit);
      gl.bindTexture(gl.TEXTURE_2D, slot.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      let data: ArrayBufferView;
      switch (slot.type) {
        case gl.INT: data = zeroI32; break;
        case gl.UNSIGNED_SHORT: data = zeroU16; break;
        case gl.FLOAT: data = zeroF32; break;
        default: data = zeroU8;
      }
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
      this.uploadGrid('pDig', pheromones.dig, w, h);
      this.uploadGrid('pBuild', pheromones.build, w, h);
      this.uploadGrid('pTrail', pheromones.trail, w, h);
      this.uploadGrid('pAlarm', pheromones.alarm, w, h);
      this.uploadGrid('pQueen', pheromones.queen, w, h);
      this.uploadGrid('pBrood', pheromones.brood, w, h);
      this.uploadGrid('pNecro', pheromones.necro, w, h);
      this.uploadGrid('pNoEntry', pheromones.noEntry, w, h);
      this.uploadGrid('pGranary', pheromones.granary, w, h);
      this.uploadGrid('pTrunk', pheromones.trunk, w, h);
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
    this.bindSampler('uPDig', 'pDig');
    this.bindSampler('uPBuild', 'pBuild');
    this.bindSampler('uPTrail', 'pTrail');
    this.bindSampler('uPAlarm', 'pAlarm');
    this.bindSampler('uPQueen', 'pQueen');
    this.bindSampler('uPBrood', 'pBrood');
    this.bindSampler('uPNecro', 'pNecro');
    this.bindSampler('uPNoEntry', 'pNoEntry');
    this.bindSampler('uPGranary', 'pGranary');
    this.bindSampler('uPTrunk', 'pTrunk');

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
