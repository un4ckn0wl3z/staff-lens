import { describe, expect, it } from 'vitest';
import { fillWindowBGR, ScoreAccumulator, stepFor, tiles, windowStarts } from '../src/omr/tiling';

describe('omr tiling', () => {
  it('places windows like oemer (step 128, last one clamped)', () => {
    expect(windowStarts(600, 256, 128)).toEqual([0, 128, 256, 344]);
    expect(windowStarts(256, 256, 128)).toEqual([0]);
    expect(windowStarts(200, 256, 128)).toEqual([0]);
    expect(windowStarts(512, 256, 128)).toEqual([0, 128, 256]);
    expect(stepFor(288, 'accurate')).toBe(128);
    expect(stepFor(288, 'fast')).toBe(256);
  });

  it('covers the whole image', () => {
    const w = 1000;
    const h = 700;
    for (const quality of ['fast', 'accurate'] as const) {
      const win = 288;
      const covered = new Uint8Array(w * h);
      for (const t of tiles(w, h, win, stepFor(win, quality))) {
        for (let y = t.y; y < Math.min(h, t.y + win); y++) for (let x = t.x; x < Math.min(w, t.x + win); x++) covered[y * w + x] = 1;
      }
      expect(covered.every((v) => v === 1)).toBe(true);
    }
    expect(tiles(1000, 700, 256, 128).length).toBeGreaterThan(tiles(1000, 700, 256, 224).length);
  });

  it('copies windows as BGR with white padding', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]); // 2×1 image
    const out = new Uint8Array(3 * 3 * 3);
    fillWindowBGR(rgba, 2, 1, { x: 0, y: 0 }, 3, out);
    expect(Array.from(out.slice(0, 6))).toEqual([30, 20, 10, 60, 50, 40]);
    expect(Array.from(out.slice(6, 9))).toEqual([255, 255, 255]);
  });

  it('averages overlapping windows and takes the argmax', () => {
    const acc = new ScoreAccumulator(4, 1, 2);
    // window 3 at x=0 says class 1, window 3 at x=1 says class 0 strongly
    const a = new Float32Array([0.1, 0.9, 0.1, 0.9, 0.1, 0.9]);
    const b = new Float32Array([0.95, 0.05, 0.95, 0.05, 0.95, 0.05]);
    acc.add({ x: 0, y: 0 }, 3, a);
    acc.add({ x: 1, y: 0 }, 3, b);
    // pixel 0: only a -> 1; pixel 1,2: a+b -> 0 (1.05 vs 0.95); pixel 3: only b -> 0
    expect(Array.from(acc.argmax())).toEqual([1, 0, 0, 0]);
  });
});
