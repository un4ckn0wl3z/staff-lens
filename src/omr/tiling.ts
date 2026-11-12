// Sliding-window tiling for oemer's segmentation models (pure; used by the inference worker).
// oemer runs each model on square windows (256 px for the 1st model, 288 px for the 2nd) moved in
// steps of 128 px, sums the per-pixel class scores of overlapping windows, and takes the argmax.

export interface ModelSpec {
  file: string;
  /** Window (input) size in pixels. */
  window: number;
  /** Number of output classes. */
  classes: number;
}

/** oemer's two models. Class 0 is background in both. */
export const OEMER_MODELS: ModelSpec[] = [
  { file: '1st_model.onnx', window: 256, classes: 3 }, // 1 staff lines, 2 symbols
  { file: '2nd_model.onnx', window: 288, classes: 4 }, // 1 stems/rests, 2 noteheads, 3 clefs/keys
];

export type Quality = 'fast' | 'accurate';

/** oemer uses a 128 px step (heavy overlap). "fast" overlaps windows by only 32 px. */
export function stepFor(window: number, quality: Quality): number {
  return quality === 'accurate' ? 128 : window - 32;
}

/** Start offsets along one axis, last window clamped to the edge, duplicates removed. */
export function windowStarts(size: number, window: number, step: number): number[] {
  if (size <= window) return [0];
  const out: number[] = [];
  for (let p = 0; p < size; p += step) {
    const s = Math.min(p, size - window);
    if (out[out.length - 1] !== s) out.push(s);
    if (s === size - window) break;
  }
  return out;
}

export interface Tile {
  x: number;
  y: number;
}

export function tiles(width: number, height: number, window: number, step: number): Tile[] {
  const out: Tile[] = [];
  for (const y of windowStarts(height, window, step)) for (const x of windowStarts(width, window, step)) out.push({ x, y });
  return out;
}

/**
 * Copies a window of an RGBA image into `out` as BGR uint8 (oemer reads images with OpenCV,
 * so its models were fed BGR). Pixels outside the image are white.
 */
export function fillWindowBGR(rgba: Uint8ClampedArray, width: number, height: number, tile: Tile, window: number, out: Uint8Array, offset = 0): void {
  let o = offset;
  for (let y = 0; y < window; y++) {
    const sy = tile.y + y;
    for (let x = 0; x < window; x++) {
      const sx = tile.x + x;
      if (sx < width && sy < height) {
        const i = (sy * width + sx) * 4;
        out[o] = rgba[i + 2];
        out[o + 1] = rgba[i + 1];
        out[o + 2] = rgba[i];
      } else {
        out[o] = out[o + 1] = out[o + 2] = 255;
      }
      o += 3;
    }
  }
}

/** Sums class scores of overlapping windows; argmax of the sum equals argmax of the average. */
export class ScoreAccumulator {
  readonly sum: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly classes: number,
  ) {
    this.sum = new Float32Array(width * height * classes);
  }

  /** `pred` holds window × window × classes scores (NHWC) starting at `offset`. */
  add(tile: Tile, window: number, pred: Float32Array, offset = 0): void {
    const C = this.classes;
    for (let y = 0; y < window; y++) {
      const sy = tile.y + y;
      if (sy >= this.height) break;
      for (let x = 0; x < window; x++) {
        const sx = tile.x + x;
        if (sx >= this.width) continue;
        const d = (sy * this.width + sx) * C;
        const s = offset + (y * window + x) * C;
        for (let c = 0; c < C; c++) this.sum[d + c] += pred[s + c];
      }
    }
  }

  /** Per-pixel class index (0..classes-1). */
  argmax(): Uint8Array {
    const C = this.classes;
    const out = new Uint8Array(this.width * this.height);
    for (let p = 0, d = 0; p < out.length; p++, d += C) {
      let best = 0;
      let bv = this.sum[d];
      for (let c = 1; c < C; c++) {
        if (this.sum[d + c] > bv) {
          bv = this.sum[d + c];
          best = c;
        }
      }
      out[p] = best;
    }
    return out;
  }
}
