// Port of oemer/symbol_extraction.py (oemer 0.1.8, MIT): barlines, clefs, key signatures /
// accidentals (sharp, flat, natural) and rests.

import { predictRegion, type SvmBundle } from './classifier';
import { dilate, drawLine8, erode, findContourBoxes, label4, raster, type BBox, type Raster } from './cv';
import { mean, pyRound, type OemerContext } from './context';
import type { NoteHead } from './notehead';
import { getCenter, findLines, type Staff, type Zone } from './staffline';
import { filterOutOfRangeBbox, filterOutSmallArea, findClosestStaffs, getGlobalUnitSize, getUnitSize, mergeNearbyBbox, rmMergeOverlapBbox } from './utils';

export enum ClefType {
  G_CLEF = 1,
  F_CLEF = 2,
}
export enum SfnType {
  FLAT = 1,
  SHARP = 2,
  NATURAL = 3,
}
export enum RestType {
  WHOLE_HALF = 1,
  QUARTER = 2,
  EIGHTH = 3,
  SIXTEENTH = 4,
  THIRTY_SECOND = 5,
  SIXTY_FOURTH = 6,
  WHOLE = 7,
  HALF = 8,
}

export interface Barline {
  bbox: BBox;
  group: number | null;
}
export interface Clef {
  bbox: BBox;
  track: number | null;
  group: number | null;
  label: ClefType;
}
export interface Sfn {
  bbox: BBox;
  noteId: number | null;
  isKey: boolean | null;
  track: number | null;
  group: number | null;
  label: SfnType;
}
export interface Rest {
  bbox: BBox;
  hasDot: boolean | null;
  track: number | null;
  group: number | null;
  label: RestType;
}

const xCenter = (b: BBox) => (b[0] + b[2]) / 2;
export const symbolXCenter = xCenter;

function zoneRange(zones: Zone[]): [number, number] {
  return [zones[0].start, zones[zones.length - 1].stop - 1];
}

function filterBarlines(lines: BBox[], flat: Staff[], zones: Zone[], minHeightUnitRatio: number): BBox[] {
  const [minX, maxX] = zoneRange(zones);
  let ls = filterOutOfRangeBbox(lines, minX, maxX);
  ls = rmMergeOverlapBbox(ls, 'merge', 0);
  if (ls.length === 0) return [];
  let unit = 0; // oemer reuses the unit size of the last line examined
  const valid: BBox[] = [];
  for (const l of ls) {
    const [cx, cy] = getCenter(l);
    unit = getUnitSize(flat, cx, cy);
    const deg = (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI;
    if (Math.abs(deg) < 75) continue;
    valid.push(l);
  }
  if (valid.length === 0) return [];
  const maxXl = Math.max(...valid.map((v) => v[2]));
  const maxYl = Math.max(...valid.map((v) => v[3]));
  const canvas = raster(maxXl + 10, maxYl + 10);
  for (const v of valid) drawLine8(canvas, v[0], v[1], v[2], v[3], 1);
  let boxes = findContourBoxes(canvas).filter((b) => !(b[3] - b[1] < unit * minHeightUnitRatio));
  boxes = boxes.map((b, i) => ({ b, i })).sort((a, c) => a.b[3] - a.b[1] - (c.b[3] - c.b[1]) || a.i - c.i).map((e) => e.b);
  if (boxes.length === 0) return [];
  const heights = boxes.map((b) => b[3] - b[1]);
  const top5 = mean(heights.slice(-5));
  return boxes.filter((_, i) => heights[i] / top5 > 0.5);
}

function parseBarlines(ctx: OemerContext, groupMap: Int32Array, flat: Staff[], zones: Zone[], minHeightUnitRatio: number): BBox[] {
  const { width: w, height: h } = ctx;
  const n = w * h;
  const cand = new Uint8Array(n);
  const noNote = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (groupMap[i] !== -1) continue;
    if (ctx.stemsRestsPred.data[i]) cand[i] = 1;
    if (ctx.symbolsPred.data[i]) noNote[i] = 1;
  }
  const bar = label4({ width: w, height: h, data: cand });
  const sym = label4({ width: w, height: h, data: noNote });
  const touching = new Uint8Array(sym.count + 1);
  for (let i = 0; i < n; i++) if (bar.labels[i] && sym.labels[i]) touching[sym.labels[i]] = 1;
  const map = raster(w, h);
  for (let i = 0; i < n; i++) if (touching[sym.labels[i]] && sym.labels[i]) map.data[i] = noNote[i];
  return filterBarlines(findLines(map), flat, zones, minHeightUnitRatio);
}

function cropRaster(r: Raster, b: BBox): { w: number; h: number; data: Int32Array } {
  const x0 = Math.max(0, b[0]);
  const y0 = Math.max(0, b[1]);
  const w = Math.max(0, Math.min(r.width, b[2]) - x0);
  const h = Math.max(0, Math.min(r.height, b[3]) - y0);
  const data = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = r.data[(y0 + y) * r.width + x0 + x];
  return { w, h, data };
}

function parseClefsKeys(ctx: OemerContext, svm: SvmBundle, unit: number, flat: Staff[], zones: Zone[], clefSizeRatio = 3.5, maxClefTpRatio = 0.45) {
  const rows = Math.floor(unit / 2);
  const ker = { rows, cols: 1, data: new Uint8Array(rows).fill(1) };
  const ck = erode(dilate(ctx.clefsKeysPred, ker), ker);
  const [minX, maxX] = zoneRange(zones);
  let boxes = filterOutOfRangeBbox(findContourBoxes(ck), minX, maxX);
  boxes = rmMergeOverlapBbox(boxes, 'merge', 0.3);
  boxes = filterOutSmallArea(boxes, flat, (u) => u ** 2);
  boxes = mergeNearbyBbox(boxes, unit * 1.2);
  const keyBox: BBox[] = [];
  let clefBox: BBox[] = [];
  for (const b of boxes) {
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const region = cropRaster(ck, b);
    const [cx, cy] = getCenter(b);
    const usize = getUnitSize(flat, cx, cy);
    let tp = 0;
    for (const v of region.data) if (v > 0) tp++;
    if ((w * h) / usize ** 2 > clefSizeRatio && tp / (w * h) < maxClefTpRatio) clefBox.push(b);
    else if (w > usize / 2 && h > usize / 2) keyBox.push(b);
  }
  clefBox = clefBox.filter((b) => {
    const [cx, cy] = getCenter(b);
    const u = getUnitSize(flat, cx, cy);
    if (b[2] - b[0] < u * 1.5 || b[3] - b[1] < u * 1.5) return false;
    const [st] = findClosestStaffs(flat, cx, cy);
    return !(cy < st.yUpper || cy > st.yLower);
  });
  const pred = (bs: BBox[], name: string) => bs.map((b) => predictRegion(svm, cropRaster(ck, b), name));
  return { clefBox, keyBox, clefLabel: pred(clefBox, 'clef'), keyLabel: pred(keyBox, 'sfn') };
}

function parseRests(ctx: OemerContext, svm: SvmBundle, groupMap: Int32Array, lineBox: BBox[], unit: number, flat: Staff[], zones: Zone[]): { boxes: BBox[]; labels: string[] } {
  const { width: w, height: h } = ctx;
  const n = w * h;
  const barMask = new Uint8Array(n);
  for (const [x1, y1, x2, y2] of lineBox) for (let y = Math.max(0, y1); y < Math.min(h, y2); y++) for (let x = Math.max(0, x1); x < Math.min(w, x2); x++) barMask[y * w + x] = 1;
  const rests: Raster & { data: Uint8Array } = raster(w, h);
  const restsI = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ctx.stemsRestsPred.data[i] - (groupMap[i] > -1 ? 1 : 0) - barMask[i];
    const c = v > 0 ? v : 0;
    rests.data[i] = c;
    restsI[i] = c;
  }
  const [minX, maxX] = zoneRange(zones);
  let boxes = filterOutOfRangeBbox(findContourBoxes(rests), minX, maxX);
  if (boxes.length === 0) return { boxes: [], labels: [] };
  boxes = mergeNearbyBbox(boxes, unit * 1.2);
  boxes = rmMergeOverlapBbox(boxes);
  boxes = filterOutSmallArea(boxes, flat, (u) => u ** 2 * 0.7);
  const outBoxes: BBox[] = [];
  const labels: string[] = [];
  for (const b of boxes) {
    if (b[3] - b[1] > unit * 3.5 || b[2] - b[0] < unit * 0.5) continue;
    // oemer passes a numpy view: scaling 0/1 to 0/255 inside predict() changes the rests map in place
    const x0 = Math.max(0, b[0]);
    const y0 = Math.max(0, b[1]);
    const rw = Math.max(0, Math.min(w, b[2]) - x0);
    const rh = Math.max(0, Math.min(h, b[3]) - y0);
    const region = { w: rw, h: rh, data: new Int32Array(rw * rh) };
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) region.data[y * rw + x] = restsI[(y0 + y) * w + x0 + x];
    let p = predictRegion(svm, region, 'rests');
    if (p.includes('8th')) p = predictRegion(svm, region, 'rests_above8');
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) restsI[(y0 + y) * w + x0 + x] = region.data[y * rw + x];
    outBoxes.push(b);
    labels.push(p);
  }
  return { boxes: outBoxes, labels };
}

function nearbyNoteId(b: BBox, noteIdMap: Int32Array, w: number, h: number, flat: Staff[]): number | null {
  const [cx, cy] = getCenter(b);
  const unit = Math.trunc(pyRound(getUnitSize(flat, cx, cy)));
  for (let x = b[2]; x < b[2] + unit; x++) {
    if (!(cy >= 0 && cy < h && x >= 0 && x < w)) continue;
    const v = noteIdMap[cy * w + x];
    if (v !== -1) return v;
  }
  return null;
}

const SFN_NAMES: Record<string, SfnType> = { sharp: SfnType.SHARP, flat: SfnType.FLAT, natural: SfnType.NATURAL };
const CLEF_NAMES: Record<string, ClefType> = { gclef: ClefType.G_CLEF, fclef: ClefType.F_CLEF };
const REST_NAMES: Record<string, RestType> = {
  rest_whole: RestType.WHOLE_HALF,
  rest_quarter: RestType.QUARTER,
  rest_8th: RestType.EIGHTH,
  rest_16th: RestType.SIXTEENTH,
  rest_32nd: RestType.THIRTY_SECOND,
  rest_64th: RestType.SIXTY_FOURTH,
};

export interface SymbolResult {
  barlines: Barline[];
  clefs: Clef[];
  sfns: Sfn[];
  rests: Rest[];
}

export function extractSymbols(
  ctx: OemerContext,
  svm: SvmBundle,
  staffs: Staff[][],
  zones: Zone[],
  notes: NoteHead[],
  groupMap: Int32Array,
  noteIdMap: Int32Array,
  minBarlineHUnitRatio = 3.75,
): SymbolResult {
  const flat = staffs.flat();
  const { width: w, height: h } = ctx;
  const lineBox = parseBarlines(ctx, groupMap, flat, zones, minBarlineHUnitRatio);
  const barlines = lineBox.map((b) => ({ bbox: b, group: findClosestStaffs(flat, ...getCenter(b))[0].group }));
  const unit = getGlobalUnitSize(flat);
  const ck = parseClefsKeys(ctx, svm, unit, flat, zones);
  const clefs: Clef[] = ck.clefBox.map((b, i) => {
    const [st] = findClosestStaffs(flat, ...getCenter(b));
    return { bbox: b, label: CLEF_NAMES[ck.clefLabel[i]], track: st.track, group: st.group };
  });
  const sfns: Sfn[] = ck.keyBox.map((b, i) => {
    const [st] = findClosestStaffs(flat, ...getCenter(b));
    const ss: Sfn = { bbox: b, label: SFN_NAMES[ck.keyLabel[i]], noteId: nearbyNoteId(b, noteIdMap, w, h, flat), isKey: null, track: st.track, group: st.group };
    if (ss.noteId !== null) {
      const note = notes[ss.noteId];
      if (ss.track !== note.track || ss.group !== note.group) note.invalid = true;
      else {
        note.sfn = ss.label;
        ss.isKey = false;
      }
    }
    return ss;
  });
  const rr = parseRests(ctx, svm, groupMap, lineBox, unit, flat, zones);
  const sym = ctx.symbolsPred;
  const rests: Rest[] = rr.boxes.map((b, i) => {
    const [st] = findClosestStaffs(flat, ...getCenter(b));
    const r: Rest = { bbox: b, label: REST_NAMES[rr.labels[i]], track: st.track, group: st.group, hasDot: null };
    const u = Math.trunc(pyRound(getUnitSize(flat, ...getCenter(b))));
    let sum = 0;
    for (let y = Math.max(0, b[1]); y < Math.min(h, b[3]); y++) for (let x = b[2] + 1; x < Math.min(b[2] + u, w - 1); x++) sum += sym.data[y * w + x];
    if (sum > 0 && sum < u ** 2 / 7) r.hasDot = true;
    return r;
  });
  return { barlines, clefs, sfns, rests };
}
