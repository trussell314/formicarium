// AssemblyScript source for the SIMD-accelerated pheromone
// diffusion kernel. Compiled to src/wasm/pheromone.wasm by the
// `npm run build:wasm` script. The TypeScript sim wraps this and
// falls back to a scalar JS implementation when WASM/SIMD isn't
// available.
//
// Math is identical to src/sim/pheromone.ts step():
//   v = (1 - f) * src[i] + (f/4) * sum(AIR neighbours of src[i])
//   v *= e
//   if cells[i] != AIR: v = 0
//   if v < 1e-6: v = 0
//   if v > cap:  v = cap
//
// Layout: a single linear memory holds all pheromone fields
// back-to-back; the JS wrapper hands us pointers.

const FLOOR: f32 = 1e-6;

// Build a v128 of {1.0, 1.0, 1.0, 1.0} where the corresponding cell
// byte is 0 (AIR), and 0.0 otherwise. We load 4 bytes via load32_zero
// (zero-extending the rest of the v128), expand them up to four
// 32-bit lanes, compare each lane to 0, then bitwise-AND the
// all-ones mask with a splat of 1.0 to convert the boolean mask
// into a 1.0/0.0 multiplier.
@inline function airMask4(cellsPtr: usize): v128 {
  const bytes = v128.load32_zero(cellsPtr);
  const i16Ext = i16x8.extend_low_i8x16_u(bytes);
  const i32Ext = i32x4.extend_low_i16x8_u(i16Ext);
  const isAir = i32x4.eq(i32Ext, i32x4.splat(0));
  return v128.and(isAir, f32x4.splat(1.0));
}

// Scalar helper for boundary cells and the per-row tail. Same math
// as the SIMD path but cell-by-cell.
@inline function stepCell(
  srcPtr: usize, dstPtr: usize, cellsPtr: usize,
  w: i32, h: i32, x: i32, y: i32,
  m: f32, f4: f32, e: f32, cap: f32,
): void {
  const i = y * w + x;
  const cellsI = cellsPtr + i;
  if (load<u8>(cellsI) != 0) {
    store<f32>(dstPtr + (i << 2), 0);
    return;
  }
  let sum: f32 = 0;
  // kOut counts directions where outflow leaves the cell — in-grid
  // AIR neighbours (which absorb it via inflow) plus out-of-grid
  // directions (which absorb it as the world boundary). In-grid
  // SOIL/GRAIN reflects: outflow stays put.
  let kOut: i32 = 0;
  if (x > 0) {
    if (load<u8>(cellsI - 1) == 0) { sum += load<f32>(srcPtr + ((i - 1) << 2)); kOut++; }
  } else { kOut++; }
  if (x < w - 1) {
    if (load<u8>(cellsI + 1) == 0) { sum += load<f32>(srcPtr + ((i + 1) << 2)); kOut++; }
  } else { kOut++; }
  if (y > 0) {
    if (load<u8>(cellsI - w) == 0) { sum += load<f32>(srcPtr + ((i - w) << 2)); kOut++; }
  } else { kOut++; }
  if (y < h - 1) {
    if (load<u8>(cellsI + w) == 0) { sum += load<f32>(srcPtr + ((i + w) << 2)); kOut++; }
  } else { kOut++; }
  const mEff: f32 = 1.0 - (kOut as f32) * f4;
  let v = mEff * load<f32>(srcPtr + (i << 2)) + f4 * sum;
  v *= e;
  if (v < FLOOR) v = 0;
  else if (v > cap) v = cap;
  store<f32>(dstPtr + (i << 2), v);
}

/**
 * Step one pheromone field one tick — tile-aware.
 *
 * srcPtr / dstPtr point to two Float32 buffers of length w*h.
 * cellsPtr points to a Uint8 buffer of the same length (0 = AIR).
 * dirtyPtr points to a Uint8 bitmap of length tilesX*tilesY; the
 *   kernel processes only tiles where dirty[t] != 0 and skips the
 *   rest. The JS wrapper builds this bitmap as the dilation of the
 *   true "has content" set, so cells in skipped tiles are
 *   guaranteed-zero in BOTH buffers (invariant maintained on the
 *   JS side); the kernel can leave dst untouched there and the
 *   ping-pong stays correct.
 *
 * For tiles that ARE processed: the interior of each tile uses the
 * SIMD 4-lane body (16 cells per row = exactly 4 SIMD groups);
 * tile rows that coincide with the world boundary, or tile columns
 * that coincide with the world's left/right edge, fall back to the
 * scalar `stepCell` form (which handles out-of-grid neighbours).
 */
export function step(
  srcPtr: usize, dstPtr: usize, cellsPtr: usize, dirtyPtr: usize,
  w: i32, h: i32, tilesX: i32, tilesY: i32,
  f: f32, e: f32, cap: f32,
): void {
  const f4 = f * 0.25;
  const m = (1.0 as f32) - f; // legacy: still passed to stepCell for ABI stability
  const f4Splat = f32x4.splat(f4);
  const eSplat = f32x4.splat(e);
  const capSplat = f32x4.splat(cap);
  const floorSplat = f32x4.splat(FLOOR);
  const zeroSplat = f32x4.splat(0.0);

  const TILE = 16;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (load<u8>(dirtyPtr + ty * tilesX + tx) == 0) continue;

      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const x1Raw = x0 + TILE;
      const y1Raw = y0 + TILE;
      const x1 = x1Raw < w ? x1Raw : w;
      const y1 = y1Raw < h ? y1Raw : h;

      for (let y = y0; y < y1; y++) {
        const yIsBoundary = (y == 0) || (y == h - 1);
        if (yIsBoundary) {
          // Top or bottom edge row: every cell goes through scalar
          // boundary path (kOut counts OOB as absorbing).
          for (let x = x0; x < x1; x++) {
            stepCell(srcPtr, dstPtr, cellsPtr, w, h, x, y, m, f4, e, cap);
          }
          continue;
        }
        // Interior row of an interior cell range. Handle the
        // possibly-boundary leftmost / rightmost columns with
        // scalar code, and the rest with SIMD.
        let x = x0;
        if (x == 0) {
          stepCell(srcPtr, dstPtr, cellsPtr, w, h, 0, y, m, f4, e, cap);
          x++;
        }
        const xRightInterior = (x1 == w) ? w - 1 : x1;
        // SIMD body: 4 cells per iteration while there's room.
        while (x + 4 <= xRightInterior) {
          const i = y * w + x;
          const srcByteI = srcPtr + (i << 2);
          const dstByteI = dstPtr + (i << 2);
          const cellsByteI = cellsPtr + i;
          const wBytes = w << 2;

          const cv = v128.load(srcByteI);
          const lv = v128.load(srcByteI - 4);
          const rv = v128.load(srcByteI + 4);
          const tv = v128.load(srcByteI - wBytes);
          const bv = v128.load(srcByteI + wBytes);

          const centerMask = airMask4(cellsByteI);
          const lMask = airMask4(cellsByteI - 1);
          const rMask = airMask4(cellsByteI + 1);
          const tMask = airMask4(cellsByteI - w);
          const bMask = airMask4(cellsByteI + w);

          const sum = f32x4.add(
            f32x4.add(f32x4.mul(lv, lMask), f32x4.mul(rv, rMask)),
            f32x4.add(f32x4.mul(tv, tMask), f32x4.mul(bv, bMask)),
          );
          const kAir = f32x4.add(
            f32x4.add(lMask, rMask),
            f32x4.add(tMask, bMask),
          );
          const mEff = f32x4.sub(f32x4.splat(1.0), f32x4.mul(kAir, f4Splat));
          let result = f32x4.add(f32x4.mul(mEff, cv), f32x4.mul(f4Splat, sum));
          result = f32x4.mul(result, eSplat);
          result = f32x4.mul(result, centerMask);
          const ltFloor = f32x4.lt(result, floorSplat);
          result = v128.bitselect(zeroSplat, result, ltFloor);
          const gtCap = f32x4.gt(result, capSplat);
          result = v128.bitselect(capSplat, result, gtCap);
          v128.store(dstByteI, result);
          x += 4;
        }
        // Scalar tail for any cells past the last SIMD group but
        // still inside the tile's interior column range.
        while (x < xRightInterior) {
          stepCell(srcPtr, dstPtr, cellsPtr, w, h, x, y, m, f4, e, cap);
          x++;
        }
        // Rightmost column of the world if the tile abuts it.
        if (x1 == w) {
          stepCell(srcPtr, dstPtr, cellsPtr, w, h, w - 1, y, m, f4, e, cap);
        }
      }
    }
  }
}
