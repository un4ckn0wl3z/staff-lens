// oemer's symbol classifiers: Pillow's bicubic resize to 40×70 followed by an RBF SVM
// (scikit-learn SVC / libsvm one-vs-one voting). Models are exported by tools/export_oemer_svm.py.

export interface SvmModelJson {
  w: number;
  h: number;
  classMap: Record<string, string>;
  classes: number[];
  gamma: number;
  nSupport: number[];
  dualCoef: number[][];
  intercept: number[];
  features: number;
  svOffset: number;
  svCount: number;
}

export interface SvmBundleJson {
  models: Record<string, SvmModelJson>;
}

export interface SvmModel extends SvmModelJson {
  sv: Uint8Array;
  svNorm: Float64Array;
}

export type SvmBundle = Record<string, SvmModel>;

export function loadSvmBundle(meta: SvmBundleJson, svBytes: Uint8Array): SvmBundle {
  const out: SvmBundle = {};
  for (const [name, m] of Object.entries(meta.models)) {
    const sv = svBytes.subarray(m.svOffset, m.svOffset + m.svCount * m.features);
    const svNorm = new Float64Array(m.svCount);
    for (let k = 0; k < m.svCount; k++) {
      let s = 0;
      for (let f = 0; f < m.features; f++) s += sv[k * m.features + f] ** 2;
      svNorm[k] = s;
    }
    out[name] = { ...m, sv, svNorm };
  }
  return out;
}

// ------------------------------------------------------------------ Pillow resize (mode "L", BICUBIC)

const PRECISION_BITS = 32 - 8 - 2;

function bicubic(x: number): number {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

function coeffs(inSize: number, outSize: number): { ksize: number; bounds: Int32Array; kk: Int32Array } {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const tmp = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    tmp.fill(0);
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      tmp[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) if (ww !== 0) tmp[x] /= ww;
    for (let x = 0; x < ksize; x++) {
      const v = tmp[x];
      kk[xx * ksize + x] = Math.trunc(v * (1 << PRECISION_BITS) + (v < 0 ? -0.5 : 0.5));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v: number) => (v >= 1 << PRECISION_BITS << 8 ? 255 : v <= 0 ? 0 : v >> PRECISION_BITS);

function passH(src: Uint8Array, w: number, rows: number, rowOffset: number, outW: number, c: ReturnType<typeof coeffs>): Uint8Array {
  const out = new Uint8Array(outW * rows);
  for (let yy = 0; yy < rows; yy++) {
    for (let xx = 0; xx < outW; xx++) {
      const xmin = c.bounds[xx * 2];
      const xmax = c.bounds[xx * 2 + 1];
      let ss = 1 << (PRECISION_BITS - 1);
      for (let x = 0; x < xmax; x++) ss += src[(yy + rowOffset) * w + x + xmin] * c.kk[xx * c.ksize + x];
      out[yy * outW + xx] = clip8(ss);
    }
  }
  return out;
}

function passV(src: Uint8Array, w: number, rowOffset: number, outH: number, c: ReturnType<typeof coeffs>): Uint8Array {
  const out = new Uint8Array(w * outH);
  for (let yy = 0; yy < outH; yy++) {
    const ymin = c.bounds[yy * 2] - rowOffset;
    const ymax = c.bounds[yy * 2 + 1];
    for (let xx = 0; xx < w; xx++) {
      let ss = 1 << (PRECISION_BITS - 1);
      for (let y = 0; y < ymax; y++) ss += src[(y + ymin) * w + xx] * c.kk[yy * c.ksize + y];
      out[yy * w + xx] = clip8(ss);
    }
  }
  return out;
}

/**
 * PIL.Image.fromarray(gray).resize((outW, outH)) with the default BICUBIC filter (Pillow 13).
 * Pillow runs the pass that gives the smaller intermediate image first.
 */
export function pilResize(src: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  const horiz = coeffs(w, outW);
  const vert = coeffs(h, outH);
  const needH = outW !== w;
  const needV = outH !== h;
  if (!needH && !needV) return src.slice();
  if (!needV) return passH(src, w, h, 0, outW, horiz);
  if (!needH) return passV(src, w, 0, outH, vert);
  if (outH < h && w * outH < outW * h) {
    // vertical first: only the columns the horizontal pass needs
    const tmp = passV(src, w, 0, outH, vert);
    return passH(tmp, w, outH, 0, outW, horiz);
  }
  const yFirst = vert.bounds[0];
  const yLast = vert.bounds[outH * 2 - 2] + vert.bounds[outH * 2 - 1];
  const tmp = passH(src, w, yLast - yFirst, yFirst, outW, horiz);
  return passV(tmp, outW, yFirst, outH, vert);
}

// ------------------------------------------------------------------ SVM

/** sklearn SVC.predict (libsvm one-vs-one voting) on a 2800-feature vector; returns the class index. */
export function svmPredict(m: SvmModel, x: Uint8Array): number {
  const F = m.features;
  let xNorm = 0;
  for (let f = 0; f < F; f++) xNorm += x[f] * x[f];
  const kv = new Float64Array(m.svCount);
  for (let k = 0; k < m.svCount; k++) {
    let dot = 0;
    const o = k * F;
    for (let f = 0; f < F; f++) dot += x[f] * m.sv[o + f];
    // integer arithmetic, exact: ||x - sv||² = ||x||² + ||sv||² - 2·x·sv
    kv[k] = Math.exp(-m.gamma * (xNorm + m.svNorm[k] - 2 * dot));
  }
  const n = m.classes.length;
  const start: number[] = [];
  let acc = 0;
  for (const c of m.nSupport) {
    start.push(acc);
    acc += c;
  }
  const vote = new Array<number>(n).fill(0);
  let p = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sum = 0;
      const coef1 = m.dualCoef[j - 1];
      const coef2 = m.dualCoef[i];
      for (let k = 0; k < m.nSupport[i]; k++) sum += coef1[start[i] + k] * kv[start[i] + k];
      for (let k = 0; k < m.nSupport[j]; k++) sum += coef2[start[j] + k] * kv[start[j] + k];
      sum += m.intercept[p];
      if (sum > 0) vote[i]++;
      else vote[j]++;
      p++;
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (vote[i] > vote[best]) best = i;
  return m.classes[best];
}

/**
 * oemer.inference.predict(region, model_name): scales 0/1 regions to 0/255 (in place, like oemer),
 * resizes to the model size and returns the class name.
 */
export function predictRegion(bundle: SvmBundle, region: { w: number; h: number; data: Int32Array | Uint8Array }, name: string): string {
  const m = bundle[name];
  let max = -Infinity;
  for (const v of region.data) if (v > max) max = v;
  if (max === 1) for (let i = 0; i < region.data.length; i++) region.data[i] *= 255;
  const u8 = Uint8Array.from(region.data, (v) => v & 255);
  const x = pilResize(u8, region.w, region.h, m.w, m.h);
  return m.classMap[String(svmPredict(m, x))];
}
