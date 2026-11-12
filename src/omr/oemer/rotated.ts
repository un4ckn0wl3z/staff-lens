// Rotated boxes and polygon filling as oemer uses them for beams:
// cv2.minAreaRect → cv2.boxPoints → .astype(np.uint64) → cv2.contourArea / cv2.fillPoly.

import { drawLine8, type Raster } from './cv';

export type Pt = [number, number];

/** Andrew's monotone chain; returns hull vertices counter-clockwise, without duplicates. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface RotatedBox {
  /** Four corners (float32 precision, like cv2.boxPoints). */
  corners: Pt[];
  /** Side lengths (width, height). */
  size: [number, number];
  center: Pt;
}

/** Minimum-area enclosing rectangle (rotating calipers over the hull edges). */
export function minAreaRect(points: Pt[]): RotatedBox {
  const f = Math.fround;
  const hull = convexHull(points);
  if (hull.length === 0) return { corners: [[0, 0], [0, 0], [0, 0], [0, 0]], size: [0, 0], center: [0, 0] };
  if (hull.length === 1) {
    const p: Pt = [f(hull[0][0]), f(hull[0][1])];
    return { corners: [p, p, p, p], size: [0, 0], center: p };
  }
  if (hull.length === 2) {
    const [a, b] = hull;
    const c: Pt = [f((a[0] + b[0]) / 2), f((a[1] + b[1]) / 2)];
    return { corners: [[f(a[0]), f(a[1])], [f(b[0]), f(b[1])], [f(b[0]), f(b[1])], [f(a[0]), f(a[1])]], size: [f(Math.hypot(b[0] - a[0], b[1] - a[1])), 0], center: c };
  }
  let best: { area: number; corners: Pt[]; size: [number, number]; center: Pt } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0) continue;
    const ux = (q[0] - p[0]) / len;
    const uy = (q[1] - p[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const h of hull) {
      const u = h[0] * ux + h[1] * uy;
      const v = -h[0] * uy + h[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) {
      const at = (u: number, v: number): Pt => [u * ux - v * uy, u * uy + v * ux];
      const corners = [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)];
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { area, corners, size: [maxU - minU, maxV - minV], center: at(cu, cv) };
    }
  }
  const b = best!;
  return {
    corners: b.corners.map(([x, y]) => [f(x), f(y)] as Pt),
    size: [f(b.size[0]), f(b.size[1])],
    center: [f(b.center[0]), f(b.center[1])],
  };
}

/** cv2.contourArea (non-oriented shoelace). */
export function contourArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const XY_SHIFT = 16;
const XY_ONE = 1 << XY_SHIFT;

interface PolyEdge {
  y0: number;
  y1: number;
  x: number;
  dx: number;
  next: PolyEdge | null;
}

/** cv2.fillPoly(img, [pts], value) for one integer polygon (8-connected, shift 0): OpenCV's edge-collection fill. */
export function fillPoly(img: Raster, pts: Pt[], value = 1): void {
  const W = img.width;
  const H = img.height;
  const edges: PolyEdge[] = [];
  const n = pts.length;
  // Integer math in units of 1/65536 pixel; values stay far below 2^53.
  let pt0: Pt = [pts[n - 1][0] * XY_ONE, pts[n - 1][1]];
  for (let i = 0; i < n; i++) {
    const pt1: Pt = [pts[i][0] * XY_ONE, pts[i][1]];
    const t0: Pt = [(pt0[0] + (XY_ONE >> 1)) / XY_ONE | 0, pt0[1]];
    const t1: Pt = [(pt1[0] + (XY_ONE >> 1)) / XY_ONE | 0, pt1[1]];
    t0[0] = Math.floor((pt0[0] + (XY_ONE >> 1)) / XY_ONE);
    t1[0] = Math.floor((pt1[0] + (XY_ONE >> 1)) / XY_ONE);
    drawLine8(img, t0[0], t0[1], t1[0], t1[1], value);
    const p0c: Pt = [pt0[0] + (XY_ONE >> 1), pt0[1]];
    const p1c: Pt = [pt1[0] + (XY_ONE >> 1), pt1[1]];
    if (pt0[1] !== pt1[1]) {
      const dx = Math.trunc((p1c[0] - p0c[0]) / (p1c[1] - p0c[1]));
      if (pt0[1] < pt1[1]) edges.push({ y0: pt0[1], y1: pt1[1], x: p0c[0] + (pt0[1] - p0c[1]) * dx, dx, next: null });
      else edges.push({ y0: pt1[1], y1: pt0[1], x: p1c[0] + (pt1[1] - p1c[1]) * dx, dx, next: null });
    }
    pt0 = pt1;
  }
  if (edges.length < 2) return;
  let yMax = -Infinity;
  for (const e of edges) yMax = Math.max(yMax, e.y1);
  edges.sort((a, b) => a.y0 - b.y0 || a.x - b.x || a.dx - b.dx);
  const total = edges.length;
  const sentinel: PolyEdge = { y0: Number.MAX_SAFE_INTEGER, y1: 0, x: 0, dx: 0, next: null };
  edges.push(sentinel);
  const tmp: PolyEdge = { y0: 0, y1: 0, x: 0, dx: 0, next: null };
  let i = 0;
  let e = edges[0];
  yMax = Math.min(yMax, H);
  for (let y = e.y0; y < yMax; y++) {
    let draw = 0;
    const clip = y < 0;
    let prelast: PolyEdge = tmp;
    let last: PolyEdge | null = tmp.next;
    while (last || e.y0 === y) {
      if (last && last.y1 === y) {
        prelast.next = last.next;
        last = last.next;
        continue;
      }
      const keep = prelast;
      if (last && (e.y0 > y || last.x < e.x)) {
        prelast = last;
        last = last.next;
      } else if (i < total) {
        prelast.next = e;
        e.next = last;
        prelast = e;
        e = edges[++i];
      } else break;
      if (draw) {
        if (!clip) {
          let x1: number;
          let x2: number;
          if (keep.x > prelast.x) {
            x1 = Math.floor((prelast.x + XY_ONE - 1) / XY_ONE);
            x2 = Math.floor(keep.x / XY_ONE);
          } else {
            x1 = Math.floor((keep.x + XY_ONE - 1) / XY_ONE);
            x2 = Math.floor(prelast.x / XY_ONE);
          }
          if (x1 < W && x2 >= 0) {
            x1 = Math.max(0, x1);
            x2 = Math.min(W - 1, x2);
            for (let x = x1; x <= x2; x++) img.data[y * W + x] = value;
          }
        }
        keep.x += keep.dx;
        prelast.x += prelast.dx;
      }
      draw ^= 1;
    }
    // bubble-sort the active edges by x
    let keepPre: PolyEdge | null = null;
    for (;;) {
      prelast = tmp;
      last = tmp.next;
      let lastExchange: PolyEdge | null = null;
      while (last !== keepPre && last && last.next) {
        const te: PolyEdge = last.next;
        if (last.x > te.x) {
          prelast.next = te;
          last.next = te.next;
          te.next = last;
          prelast = te;
          lastExchange = prelast;
        } else {
          prelast = last;
          last = te;
        }
      }
      if (!lastExchange) break;
      keepPre = lastExchange;
      if (keepPre === tmp.next || keepPre === tmp) break;
    }
  }
}
