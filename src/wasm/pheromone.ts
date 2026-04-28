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
  if (x > 0       && load<u8>(cellsI - 1) == 0) sum += load<f32>(srcPtr + ((i - 1) << 2));
  if (x < w - 1   && load<u8>(cellsI + 1) == 0) sum += load<f32>(srcPtr + ((i + 1) << 2));
  if (y > 0       && load<u8>(cellsI - w) == 0) sum += load<f32>(srcPtr + ((i - w) << 2));
  if (y < h - 1   && load<u8>(cellsI + w) == 0) sum += load<f32>(srcPtr + ((i + w) << 2));
  let v = m * load<f32>(srcPtr + (i << 2)) + f4 * sum;
  v *= e;
  if (v < FLOOR) v = 0;
  else if (v > cap) v = cap;
  store<f32>(dstPtr + (i << 2), v);
}

/**
 * Step one pheromone field one tick.
 *
 * srcPtr / dstPtr point to two Float32 buffers of length w*h.
 * cellsPtr points to a Uint8 buffer of the same length (0 = AIR).
 * After this call, dst contains the next-tick field.
 *
 * Boundary cells (top/bottom row, leftmost/rightmost column) are
 * processed by the scalar path because their neighbour set is
 * conditional. The interior runs the SIMD lane-of-4 loop and falls
 * back to the scalar tail when the row width modulo 4 leaves
 * leftovers.
 */
export function step(
  srcPtr: usize, dstPtr: usize, cellsPtr: usize,
  w: i32, h: i32,
  f: f32, e: f32, cap: f32,
): void {
  const f4 = f * 0.25;
  const m = (1.0 as f32) - f;
  const wm1 = w - 1;
  const hm1 = h - 1;
  const mSplat = f32x4.splat(m);
  const f4Splat = f32x4.splat(f4);
  const eSplat = f32x4.splat(e);
  const capSplat = f32x4.splat(cap);
  const floorSplat = f32x4.splat(FLOOR);
  const zeroSplat = f32x4.splat(0.0);

  if (w >= 2 && h >= 2) {
    for (let y = 1; y < hm1; y++) {
      const rowStart = y * w;
      let x = 1;
      // SIMD body: process 4 cells per iteration as long as 4 cells
      // fit before the right edge (x+4 <= wm1).
      while (x + 4 <= wm1) {
        const i = rowStart + x;
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

        let result = f32x4.add(f32x4.mul(mSplat, cv), f32x4.mul(f4Splat, sum));
        result = f32x4.mul(result, eSplat);
        // Zero non-AIR centers regardless of computed value.
        result = f32x4.mul(result, centerMask);
        // Clamp small to 0, large to cap. bitselect picks lane-by-lane:
        // bitselect(a, b, mask) = (a & mask) | (b & ~mask).
        const ltFloor = f32x4.lt(result, floorSplat);
        result = v128.bitselect(zeroSplat, result, ltFloor);
        const gtCap = f32x4.gt(result, capSplat);
        result = v128.bitselect(capSplat, result, gtCap);

        v128.store(dstByteI, result);
        x += 4;
      }
      // Scalar tail: handle 0..3 leftover cells.
      while (x < wm1) {
        stepCell(srcPtr, dstPtr, cellsPtr, w, h, x, y, m, f4, e, cap);
        x++;
      }
    }
  }

  // Boundary rows + columns. Scalar path; cost is 2*(w + h - 2) per
  // field per tick, dwarfed by the interior even at the smallest
  // worlds we render.
  if (h > 0) {
    for (let x = 0; x < w; x++) stepCell(srcPtr, dstPtr, cellsPtr, w, h, x, 0, m, f4, e, cap);
    if (h > 1) for (let x = 0; x < w; x++) stepCell(srcPtr, dstPtr, cellsPtr, w, h, x, h - 1, m, f4, e, cap);
  }
  if (w > 0) {
    for (let y = 1; y < h - 1; y++) stepCell(srcPtr, dstPtr, cellsPtr, w, h, 0, y, m, f4, e, cap);
    if (w > 1) for (let y = 1; y < h - 1; y++) stepCell(srcPtr, dstPtr, cellsPtr, w, h, w - 1, y, m, f4, e, cap);
  }
}
