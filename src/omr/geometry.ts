// Image geometry for scans and photos: rotation, skew detection, crop and perspective correction.
// Pure TypeScript on RGBA buffers (ImageData-compatible), so it runs in workers and in tests.

export interface Img {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major (same layout as ImageData.data). */
  data: Uint8ClampedArray;
}

export interface Pt {
  x: number;
  y: number;
}

export function createImg(width: number, height: number, fill = 255): Img {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Luminance 0..255 per pixel. */
export function toGray(img: Img): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return out;
}

/** Otsu's threshold on a grayscale buffer. */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Bilinear sample of one channel set at (x, y); outside pixels return `bg`. */
function sample(img: Img, x: number, y: number, out: Uint8ClampedArray, o: number, bg: number): void {
  const { width: w, height: h, data: d } = img;
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) {
    out[o] = out[o + 1] = out[o + 2] = bg;
    out[o + 3] = 255;
    return;
  }
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
    const bottom = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[o + c] = top * (1 - fy) + bottom * fy;
  }
  out[o + 3] = 255;
}

/** Rotates by a multiple of 90° clockwise (k = 1, 2, 3). */
export function rotate90(img: Img, k: number): Img {
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return { ...img, data: img.data.slice() };
  const { width: w, height: h, data: d } = img;
  const ow = q === 2 ? w : h;
  const oh = q === 2 ? h : w;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (q === 1) [nx, ny] = [h - 1 - y, x];
      else if (q === 2) [nx, ny] = [w - 1 - x, h - 1 - y];
      else [nx, ny] = [y, w - 1 - x];
      const si = (y * w + x) * 4;
      const di = (ny * ow + nx) * 4;
      out[di] = d[si];
      out[di + 1] = d[si + 1];
      out[di + 2] = d[si + 2];
      out[di + 3] = d[si + 3];
    }
  }
  return { width: ow, height: oh, data: out };
}

/**
 * Rotates by `deg` degrees (positive = clockwise on screen, y pointing down), enlarging the canvas
 * so nothing is cut off. A line at angle a becomes a line at angle a + deg.
 */
export function rotate(img: Img, deg: number, bg = 255): Img {
  if (Math.abs(deg) < 1e-6) return { ...img, data: img.data.slice() };
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const w = img.width;
  const h = img.height;
  const ow = Math.ceil(Math.abs(w * c) + Math.abs(h * s));
  const oh = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
  const out = new Uint8ClampedArray(ow * oh * 4);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const ocx = (ow - 1) / 2;
  const ocy = (oh - 1) / 2;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const dx = x - ocx;
      const dy = y - ocy;
      // inverse rotation: source = R(-deg) · destination
      const sx = c * dx + s * dy + cx;
      const sy = -s * dx + c * dy + cy;
      sample(img, sx, sy, out, (y * ow + x) * 4, bg);
    }
  }
  return { width: ow, height: oh, data: out };
}

export function crop(img: Img, x: number, y: number, w: number, h: number): Img {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const cw = Math.max(1, Math.min(img.width - x0, Math.round(w)));
  const ch = Math.max(1, Math.min(img.height - y0, Math.round(h)));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const src = ((y0 + row) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/** Resizes with bilinear sampling (area-averaged when shrinking a lot is not needed for OMR inputs). */
export function resize(img: Img, width: number, height: number): Img {
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, out, (y * width + x) * 4, 255);
  }
  return { width, height, data: out };
}

/** oemer resizes every page to roughly 3.0–4.35 megapixels before inference. */
export function oemerTargetSize(width: number, height: number): { width: number; height: number } {
  const pixels = width * height;
  const lb = 3_000_000 / pixels;
  const ub = 4_350_000 / pixels;
  const ratio = Math.sqrt((lb + ub) / 2);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/**
 * Estimates the angle (degrees) of the dominant horizontal lines, e.g. staff lines.
 * Lines follow y = x·tan(angle) + c (y pointing down). Deskew with rotate(img, -angle).
 */
export function estimateSkew(img: Img, maxAngle = 10): number {
  // Work on a downscaled copy for speed.
  const scale = Math.min(1, 900 / Math.max(img.width, img.height));
  const small = scale < 1 ? resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale))) : img;
  const gray = toGray(small);
  const th = otsuThreshold(gray);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      if (gray[y * small.width + x] <= th) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 20) return 0;
  const score = (deg: number): number => {
    const r = (deg * Math.PI) / 180;
    const s = Math.sin(r);
    const c = Math.cos(r);
    const offset = small.width + small.height;
    const hist = new Float64Array(2 * offset + 2);
    for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] * c - xs[i] * s) + offset]++;
    let acc = 0;
    for (const v of hist) acc += v * v;
    return acc;
  };
  const search = (from: number, to: number, step: number): number => {
    let best = from;
    let bestScore = -Infinity;
    for (let a = from; a <= to + 1e-9; a += step) {
      const sc = score(a);
      // ties go to the smaller angle (straight pages stay at 0)
      if (sc > bestScore * (1 + 1e-9) || (sc >= bestScore * (1 - 1e-9) && Math.abs(a) < Math.abs(best))) {
        bestScore = sc;
        best = a;
      }
    }
    return best;
  };
  const coarse = search(-maxAngle, maxAngle, 0.5);
  const fine = search(coarse - 0.5, coarse + 0.5, 0.05);
  return Math.round(fine * 100) / 100;
}

/** 3×3 homography (row-major, h[8] = 1) mapping each src[i] to dst[i]. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(A, b), 1];
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('degenerate quadrilateral');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyHomography(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size for a quad given as [top-left, top-right, bottom-right, bottom-left]. */
export function quadSize(q: Pt[]): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2])))),
    height: Math.max(1, Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])))),
  };
}

/** Straightens the quadrilateral `quad` (TL, TR, BR, BL in source pixels) into a rectangle. */
export function warpPerspective(img: Img, quad: Pt[], size = quadSize(quad)): Img {
  const { width, height } = size;
  const rect: Pt[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const h = homography(rect, quad); // destination -> source
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyHomography(h, { x, y });
      sample(img, p.x, p.y, out, (y * width + x) * 4, 255);
    }
  }
  return { width, height, data: out };
}

/** True when the quad is the full image (no perspective change needed). */
export function isFullQuad(q: Pt[], w: number, h: number, tol = 1): boolean {
  const full: Pt[] = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  return q.every((p, i) => dist(p, full[i]) <= tol);
}
