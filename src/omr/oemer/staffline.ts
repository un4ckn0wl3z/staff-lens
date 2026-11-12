// Port of oemer/staffline_extraction.py (oemer 0.1.8, MIT): finds 5-line staves per vertical zone,
// aligns them across zones, and infers how many tracks (staves per system) the page has.

import { dilate, erode, findContourBoxes, findPeaks, houghLinesP, olsSlope, raster, rectKernel, type BBox, type Raster } from './cv';
import { mean, pyRound, std, type OemerContext } from './context';

export class Line {
  readonly ys: number[] = [];
  readonly xs: number[] = [];
  label: number | null = null;

  addPoint(y: number, x: number): void {
    this.ys.push(y);
    this.xs.push(x);
  }
  get size(): number {
    return this.ys.length;
  }
  get yCenter(): number {
    return mean(this.ys);
  }
  get yUpper(): number {
    return Math.min(...this.ys);
  }
  get yLower(): number {
    return Math.max(...this.ys);
  }
  get xCenter(): number {
    return mean(this.xs);
  }
  get xLeft(): number {
    return Math.min(...this.xs);
  }
  get xRight(): number {
    return Math.max(...this.xs);
  }
  get slope(): number {
    return olsSlope(this.xs, this.ys);
  }
}

export class Staff {
  readonly lines: Line[] = [];
  track: number | null = null;
  group: number | null = null;
  isInterp = false;
  private cache = new Map<string, number>();
  private override = new Map<string, number>();

  addLine(l: Line): void {
    this.lines.push(l);
    this.cache.clear();
    this.override.clear();
  }
  private get(key: string, f: () => number): number {
    if (this.override.has(key)) return this.override.get(key)!;
    if (!this.cache.has(key)) this.cache.set(key, f());
    return this.cache.get(key)!;
  }
  /** oemer assigns some of these later (e.g. after interpolation). */
  set(key: 'yCenter' | 'yUpper' | 'yLower' | 'xCenter' | 'xLeft' | 'xRight', v: number): void {
    this.override.set(key, v);
  }
  get yCenter(): number {
    return this.get('yCenter', () => mean(this.lines.map((l) => l.yCenter)));
  }
  get yUpper(): number {
    return this.get('yUpper', () => Math.min(...this.lines.map((l) => l.yUpper)));
  }
  get yLower(): number {
    return this.get('yLower', () => Math.max(...this.lines.map((l) => l.yLower)));
  }
  get xCenter(): number {
    return this.get('xCenter', () => mean(this.lines.map((l) => l.xCenter)));
  }
  get xLeft(): number {
    return this.get('xLeft', () => Math.min(...this.lines.map((l) => l.xLeft)));
  }
  get xRight(): number {
    return this.get('xRight', () => Math.max(...this.lines.map((l) => l.xRight)));
  }
  get unitSize(): number {
    return this.get('unitSize', () => {
      const c = this.lines.map((l) => l.yCenter);
      const gaps: number[] = [];
      for (let i = 1; i < c.length; i++) gaps.push(c[i] - c[i - 1]);
      return mean(gaps);
    });
  }
  get slope(): number {
    return this.get('slope', () => mean(this.lines.map((l) => l.slope)));
  }
  get incomplete(): boolean {
    return this.lines.length !== 5;
  }
  duplicate(xOffset = 0, yOffset = 0): Staff {
    const st = new Staff();
    for (const l of this.lines) {
      const nl = new Line();
      for (let i = 0; i < l.size; i++) nl.addPoint(l.ys[i] + yOffset, l.xs[i] + xOffset);
      st.addLine(nl);
    }
    return st;
  }
}

export interface Zone {
  start: number;
  stop: number;
}

export function initZones(staffPred: Raster, splits: number): { zones: Zone[]; left: number; right: number; bottom: number } {
  const { width: w, height: h, data } = staffPred;
  const accum = new Float64Array(w);
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[y * w + x] > 0) {
        accum[x] += data[y * w + x];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        maxY = y;
      }
  const m = mean(accum);
  for (let i = 0; i < w; i++) accum[i] /= m;
  const half = pyRound(w / 2);
  let right = Math.min(maxX + 50, w);
  let left = Math.max(minX - 50, 0);
  for (let i = half + 10; i < w; i++) {
    if (mean(accum.subarray(i - 10, i)) < 0.1) {
      right = i;
      break;
    }
  }
  for (let i = half - 10; i > 0; i--) {
    if (mean(accum.subarray(i, i + 10)) < 0.1) {
      left = i;
      break;
    }
  }
  const bottom = Math.min(maxY + 100, h);
  const step = pyRound((right - left) / splits);
  const zones: Zone[] = [];
  for (let start = left; start < right; start += step) {
    let end = start + step;
    if (right - end < step) {
      end = right;
      zones.push({ start, stop: end });
      break;
    }
    zones.push({ start, stop: end });
  }
  return { zones, left, right, bottom };
}

/** filter_line_peaks: keep peaks that form groups of exactly five lines. */
export function filterLinePeaks(peaks: number[], norm: ArrayLike<number>, maxGapRatio = 1.5): { valid: boolean[]; groups: number[] } {
  const valid = peaks.map((p) => !(norm[p] > 15));
  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  const count = Math.max(5, pyRound(peaks.length * 0.2));
  const approxUnit = mean([...gaps].sort((a, b) => a - b).slice(0, count));
  const maxGap = approxUnit * maxGapRatio;
  const ext = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let group = -1;
  for (let i = 1; i < ext.length; i++) {
    if (ext[i] - ext[i - 1] > maxGap) group++;
    groups.push(group);
  }
  groups.push(groups[groups.length - 1] + 1);
  let cur = groups[0];
  let cnt = 1;
  for (let idx = 1; idx < groups.length; idx++) {
    const g = groups[idx];
    if (g === cur) {
      cnt++;
      continue;
    }
    if (cnt < 5) for (let k = idx - cnt; k < idx; k++) valid[k] = false;
    else if (cnt > 5) {
      const cand = peaks.slice(idx - cnt, idx);
      const head = cand.slice(0, 5).reduce((s, p) => s + norm[p], 0);
      const tail = cand.slice(-5).reduce((s, p) => s + norm[p], 0);
      if (head > tail) for (let k = idx - cnt + 5; k < idx; k++) valid[k] = false;
      else for (let k = idx - cnt; k < idx - 5; k++) valid[k] = false;
    }
    cur = g;
    cnt = 1;
  }
  return { valid, groups: groups.slice(0, -1) };
}

/** extract_line on the columns [x0, x1) of the staff prediction. */
export function extractLine(pred: Raster, x0: number, x1: number, lineThreshold = 0.8): Line[] {
  const { width: w, height: h, data } = pred;
  const count = new Float64Array(h + 2);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (data[y * w + x] > 0) c++;
    count[y + 1] = c;
  }
  const m = mean(count);
  const s = std(count);
  const normExt = Array.from(count, (v) => (v - m) / s);
  const centers = findPeaks(normExt, { height: lineThreshold, distance: 8, prominence: 1 }).map((c) => c - 1);
  const norm = normExt.slice(1, -1);
  if (centers.length === 0) return [];
  const { valid, groups } = filterLinePeaks(centers, norm);
  const cc = centers.filter((_, i) => valid[i]);
  const ccGaps: number[] = [];
  for (let i = 1; i < cc.length; i++) ccGaps.push(cc[i] - cc[i - 1]);
  const maxGap = mean(ccGaps.sort((a, b) => a - b).slice(0, 3));
  const lines = centers.map(() => new Line());
  const th = Math.min(lineThreshold, 1.2);
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      if (!(data[y * w + x] > 0)) continue;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < centers.length; k++) {
        const d = Math.abs(centers[k] - y);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (valid[best] && norm[y] > th && Math.abs(y - centers[best]) < maxGap) lines[best].addPoint(y, x);
    }
  }
  // Label valid lines 0..4 within each group (original order is already sorted by height).
  let lastGroup = groups[0];
  let cur = 0;
  for (let k = 0; k < lines.length; k++) {
    if (!valid[k]) continue;
    if (groups[k] !== lastGroup) {
      cur = 0;
      lastGroup = groups[k];
    }
    lines[k].label = cur++;
  }
  return lines.filter((_, k) => valid[k]);
}

export function extractPart(pred: Raster, x0: number, x1: number, lineThreshold = 0.8): Staff[] | null {
  const lines = extractLine(pred, x0, x1, lineThreshold);
  if (lines.length < 5) return null;
  const staffs: Staff[] = [];
  let buf: Line[] = [];
  lines.forEach((line, idx) => {
    if (idx % 5 === 0 && buf.length) {
      const st = new Staff();
      buf.forEach((l) => st.addLine(l));
      staffs.push(st);
      buf = [];
    }
    buf.push(line);
  });
  const st = new Staff();
  buf.forEach((l) => st.addLine(l));
  staffs.push(st);
  return staffs;
}

/** align_staffs: fill missing staves in zones that found fewer than the others. Returns grid[zone][row]. */
export function alignStaffs(staffs: Staff[][], maxDistRatio = 3): Staff[][] {
  const lens = new Set(staffs.map((s) => s.length));
  if (lens.size === 1) return staffs.map((s) => [...s]);
  const maxLen = Math.max(...lens);
  const grid: (Staff | null)[][] = staffs.map((part) => (part.length === maxLen ? [...part] : new Array<Staff | null>(maxLen).fill(null)));
  const nearby = (j: number, col: (Staff | null)[]) => {
    const idxs = col.map((_, idx) => idx).sort((a, b) => Math.abs(a - j) - Math.abs(b - j) || a - b);
    const out: [number, Staff][] = [];
    for (const i of idxs) {
      const s = col[i];
      if (s) out.push([i, s]);
      if (out.length >= 2) break;
    }
    return out;
  };
  const nearestOri = (ref: Staff, ori: Staff[]) => {
    const maxDist = ref.unitSize * maxDistRatio;
    for (const st of ori) if (Math.abs(st.yCenter - ref.yCenter) < maxDist) return st;
    return null;
  };
  for (let i = 0; i < maxLen; i++) {
    const col = grid.map((row) => row[i]);
    col.forEach((obj, j) => {
      if (obj) return;
      const sts = nearby(j, col);
      const ori = nearestOri(sts[0][1], staffs[j]);
      if (ori) {
        grid[j][i] = ori;
        return;
      }
      let ns: Staff;
      if (sts.length === 1) {
        const [refIdx, ref] = sts[0];
        ns = ref.duplicate((ref.xRight - ref.xLeft) * (j - refIdx));
      } else {
        let [[idx1, ref1], [idx2, ref2]] = sts;
        if (idx1 > idx2) [idx1, ref1, idx2, ref2] = [idx2, ref2, idx1, ref1];
        if (j < idx1) {
          const r = (idx1 - j) / (idx2 - idx1);
          ns = ref1.duplicate(-(ref2.xCenter - ref1.xCenter) * r, -(ref2.yCenter - ref1.yCenter) * r);
        } else if (j < idx2) {
          const r = (j - idx1) / (idx2 - idx1);
          ns = ref1.duplicate((ref2.xCenter - ref1.xCenter) * r, (ref2.yCenter - ref1.yCenter) * r);
        } else {
          const r = (j - idx2) / (idx2 - idx1);
          ns = ref2.duplicate((ref2.xCenter - ref1.xCenter) * r, (ref2.yCenter - ref1.yCenter) * r);
        }
      }
      ns.isInterp = true;
      grid[j][i] = ns;
      col[j] = ns;
    });
  }
  return grid as Staff[][];
}

/** find_lines: HoughLinesP segments as (top_x, top_y, bottom_x, bottom_y). */
export function findLines(data: Raster, minLen = 10, maxGap = 20): BBox[] {
  return houghLinesP(data, 1, Math.PI / 180, 50, minLen, maxGap).map(([x1, y1, x2, y2]) => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] as BBox);
}

export function getCenter(b: BBox): [number, number] {
  return [pyRound((b[0] + b[2]) / 2), pyRound((b[1] + b[3]) / 2)];
}

function naiveUnitSize(flat: Staff[], x: number, y: number): number {
  let best = flat[0];
  let bd = Infinity;
  for (const st of flat) {
    const d = (st.xCenter - x) ** 2 + (st.yCenter - y) ** 2;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  return best.unitSize;
}

export function furtherInferTrackNums(ctx: OemerContext, staffs: Staff[][], minDegree = 75): number {
  const { width: w, height: h } = ctx;
  const sym = ctx.symbolsPred.data;
  const mix = raster(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = sym[i] - ctx.stemsRestsPred.data[i] - ctx.noteheadPred.data[i] - ctx.clefsKeysPred.data[i];
    mix.data[i] = v > 0 ? v : 0;
  }
  const flat = staffs.flat();
  let minY = Infinity;
  let minX = Infinity;
  let maxY = 0;
  let maxX = 0;
  for (const st of flat) {
    minY = Math.min(minY, st.yUpper);
    minX = Math.min(minX, st.xLeft);
    maxY = Math.max(maxY, st.yLower);
    maxX = Math.max(maxX, st.xRight);
  }
  const lines = findLines(mix).filter((l) => {
    const deg = (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI;
    if (deg < minDegree) return false;
    return !(l[1] < minY || l[3] > maxY || l[0] < minX || l[2] > maxX);
  });
  const bmap = raster(w, h);
  for (const b of lines) {
    const x2 = b[2] - b[0] === 0 ? b[2] + 1 : b[2];
    for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < x2; x++) if (sym[y * w + x]) bmap.data[y * w + x] = 1;
  }
  for (let i = 0; i < w * h; i++) if (ctx.stemsRestsPred.data[i]) bmap.data[i] = 1;
  const ker = rectKernel(5, 2);
  const ext = erode(dilate(bmap, ker), ker);
  const ratios: number[] = [];
  for (const box of findContourBoxes(ext)) {
    const hh = box[3] - box[1];
    const [cx, cy] = getCenter(box);
    const unit = naiveUnitSize(flat, cx, cy);
    if (hh > unit) ratios.push(hh / unit);
  }
  let numTrack = 1;
  const rows = staffs[0]?.length ?? 0;
  for (let i = 1; i < 10; i++) {
    const valid = ratios.filter((r) => r > 10 * i).length;
    if (valid * (i + 1) > rows) numTrack++;
    else break;
  }
  return numTrack;
}

export interface StafflineResult {
  /** staffs[zone][row] */
  staffs: Staff[][];
  zones: Zone[];
  numTrack: number;
}

export function extractStaffs(
  ctx: OemerContext,
  opts: { splits?: number; lineThreshold?: number; horizontalDiffTh?: number; unitSizeDiffTh?: number; barlineMinDegree?: number } = {},
): StafflineResult {
  const { splits = 8, lineThreshold = 0.8, horizontalDiffTh = 0.1, unitSizeDiffTh = 0.1, barlineMinDegree = 75 } = opts;
  const pred = ctx.staffPred;
  const { zones } = initZones(pred, splits);
  const all: Staff[][] = [];
  for (const z of zones) {
    const part = extractPart(pred, z.start, z.stop, lineThreshold);
    if (part) all.push(part);
  }
  if (all.length === 0) throw new Error('no staff lines found');
  const aligned = alignStaffs(all);
  const numTrack = furtherInferTrackNums(ctx, aligned, barlineMinDegree);
  for (const col of aligned) {
    col.forEach((st, idx) => {
      st.track = idx % numTrack;
      st.group = Math.floor(idx / numTrack);
    });
  }
  const norm = (a: number[]) => {
    const m = mean(a);
    return a.map((v) => Math.abs(v / m - 1));
  };
  const rows = aligned[0].length;
  const validRows: Staff[][] = [];
  for (let r = 0; r < rows; r++) {
    const sts = aligned.map((col) => col[r]);
    if (new Set(sts.map((s) => s.lines.length)).size !== 1) continue;
    if (!norm(sts.map((s) => s.yCenter)).every((v) => v < horizontalDiffTh)) continue;
    if (!norm(sts.map((s) => s.unitSize)).every((v) => v < unitSizeDiffTh)) continue;
    validRows.push(sts);
  }
  // back to [zone][row]
  const staffs = aligned.map((_, z) => validRows.map((row) => row[z]));
  return { staffs, zones, numTrack };
}
