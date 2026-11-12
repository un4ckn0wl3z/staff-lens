import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  createImg,
  crop,
  estimateSkew,
  homography,
  oemerTargetSize,
  otsuThreshold,
  quadSize,
  rotate,
  rotate90,
  toGray,
  warpPerspective,
  type Img,
} from '../src/omr/geometry';
import { clearEdgeBands, quadAspect, rectifiedSize } from '../src/omr/geometry';

function setDark(img: Img, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
}

/** A fake page with 3 five-line staves, drawn at `angle` degrees. */
function staffPage(angle: number, w = 600, h = 400): Img {
  const img = createImg(w, h);
  const t = Math.tan((angle * Math.PI) / 180);
  for (const top of [60, 170, 280]) {
    for (let line = 0; line < 5; line++) {
      const c = top + line * 10;
      for (let x = 40; x < w - 40; x++) {
        const y = Math.round(c + (x - w / 2) * t);
        setDark(img, x, y);
        setDark(img, x, y + 1);
      }
    }
  }
  return img;
}

const pixel = (img: Img, x: number, y: number) => img.data[(y * img.width + x) * 4];

describe('omr geometry', () => {
  it('thresholds with Otsu', () => {
    const g = new Uint8ClampedArray([10, 12, 15, 11, 240, 245, 250, 238]);
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(15);
    expect(t).toBeLessThan(238);
  });

  it('estimates skew of staff lines', () => {
    expect(estimateSkew(staffPage(0))).toBeCloseTo(0, 1);
    expect(estimateSkew(staffPage(3))).toBeCloseTo(3, 0);
    expect(estimateSkew(staffPage(-4.5))).toBeCloseTo(-4.5, 0);
  });

  it('deskews by rotating the other way', () => {
    const page = staffPage(2.5);
    const fixed = rotate(page, -estimateSkew(page));
    expect(Math.abs(estimateSkew(fixed))).toBeLessThan(0.3);
    expect(fixed.width).toBeGreaterThanOrEqual(page.width);
  });

  it('rotates by quarter turns', () => {
    const img = createImg(3, 2);
    setDark(img, 0, 0); // top-left
    const r = rotate90(img, 1); // clockwise: top-left -> top-right
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(pixel(r, 1, 0)).toBe(0);
    const r2 = rotate90(img, 2);
    expect(pixel(r2, 2, 1)).toBe(0);
    const r3 = rotate90(img, 3);
    expect(pixel(r3, 0, 2)).toBe(0);
  });

  it('crops', () => {
    const img = createImg(10, 10);
    setDark(img, 5, 6);
    const c = crop(img, 4, 4, 3, 3);
    expect([c.width, c.height]).toEqual([3, 3]);
    expect(pixel(c, 1, 2)).toBe(0);
  });

  it('solves homographies', () => {
    const src = [
      { x: 10, y: 20 },
      { x: 200, y: 5 },
      { x: 220, y: 180 },
      { x: 0, y: 160 },
    ];
    const dst = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    const h = homography(src, dst);
    src.forEach((p, i) => {
      const q = applyHomography(h, p);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it('straightens a tilted quadrilateral', () => {
    // draw a dark dot at the centre of a skewed quad; after warping it should be in the middle
    const img = createImg(300, 300);
    const quad = [
      { x: 50, y: 40 },
      { x: 260, y: 70 },
      { x: 240, y: 260 },
      { x: 30, y: 230 },
    ];
    const h = homography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      quad,
    );
    const centre = applyHomography(h, { x: 0.5, y: 0.5 });
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setDark(img, Math.round(centre.x) + dx, Math.round(centre.y) + dy);
    const size = quadSize(quad);
    const out = warpPerspective(img, quad, size);
    expect([out.width, out.height]).toEqual([size.width, size.height]);
    const g = toGray(out);
    expect(g[Math.round(size.height / 2) * size.width + Math.round(size.width / 2)]).toBeLessThan(80);
    expect(g[5 * size.width + 5]).toBeGreaterThan(200);
  });

  it('matches oemer target size', () => {
    const s = oemerTargetSize(2480, 3508); // A4 at 300 dpi
    const mp = s.width * s.height;
    expect(mp).toBeGreaterThan(3_000_000);
    expect(mp).toBeLessThan(4_350_000);
    expect(s.width / s.height).toBeCloseTo(2480 / 3508, 2);
  });
});

describe('rectangle aspect ratio from a perspective photo', () => {
  // project a 3:1 rectangle with a pinhole camera (focal 1500 px, principal point at the image centre)
  const project = (yaw: number, pitch: number) => {
    const [W, H, f] = [2000, 1300, 1500];
    const pts = [[-1.5, -0.5], [1.5, -0.5], [1.5, 0.5], [-1.5, 0.5]].map(([x, y]) => {
      // rotate about y (yaw) then x (pitch), push 5 units away
      const x1 = x * Math.cos(yaw);
      const z1 = -x * Math.sin(yaw);
      const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch) + 5;
      return { x: W / 2 + (f * x1) / z2, y: H / 2 + (f * y2) / z2 };
    });
    return { pts, W, H };
  };

  it.each([
    [0, 0],
    [0.3, 0],
    [0, 0.5],
    [0.35, -0.45],
  ])('recovers 3:1 at yaw %f, pitch %f', (yaw, pitch) => {
    const { pts, W, H } = project(yaw, pitch);
    expect(quadAspect(pts, W, H)).toBeCloseTo(3, 2);
    const s = rectifiedSize(pts, W, H);
    expect(s.width / s.height).toBeCloseTo(3, 1);
  });
});


describe('edge bands', () => {
  // white page, five staff lines, a barline 2 px from the right edge, a 3 px dark band on the right and a top row band
  const W = 400;
  const H = 200;
  const img = createImg(W, H, 230);
  const set = (x: number, y: number, v: number) => {
    const o = (y * W + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
  };
  for (let l = 0; l < 5; l++) for (let x = 0; x < W; x++) set(x, 60 + l * 10, 20);
  for (let y = 60; y <= 100; y++) set(W - 6, y, 20); // barline
  for (let y = 0; y < H; y++) for (let k = 1; k <= 3; k++) set(W - k, y, k === 1 ? 60 : k === 2 ? 110 : 150);
  for (let x = 0; x < W; x++) set(x, 0, 70);
  const out = clearEdgeBands(img);
  const at = (x: number, y: number) => out.data[(y * W + x) * 4];

  it('whitens the dark band and the blended edge', () => {
    expect([at(W - 1, 150), at(W - 2, 150), at(W - 3, 150)]).toEqual([255, 255, 255]);
    expect(at(200, 0)).toBe(255);
  });

  it('keeps staff lines and a barline next to the edge', () => {
    expect(at(W - 6, 80)).toBe(20);
    expect(at(200, 60)).toBe(20);
    expect(at(W - 10, 70)).toBe(20);
    expect(at(0, 150)).toBe(230); // nothing to clear on the left
  });
});
