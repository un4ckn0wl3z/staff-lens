// Port of oemer/notehead_extraction.py (oemer 0.1.8, MIT): finds notehead boxes, splits merged ones,
// tells solid from hollow heads, and places each head on its staff (staff_line_pos).

import { dilate, ellipseKernel, erode, label4, rectKernel, type BBox, type Raster } from './cv';
import { pyRound, type OemerContext } from './context';
import { cpythonSetPop } from './pyport';
import type { Staff, Zone } from './staffline';
import { getCenter } from './staffline';
import { findClosestStaffs, getBbox, getGlobalUnitSize, getUnitSize, mergeNearbyBbox, rmMergeOverlapBbox } from './utils';

export enum NoteType {
  WHOLE = 0,
  HALF = 1,
  QUARTER = 2,
  EIGHTH = 3,
  SIXTEENTH = 4,
  THIRTY_SECOND = 5,
  SIXTY_FOURTH = 6,
  TRIPLET = 7,
  OTHERS = 8,
  HALF_OR_WHOLE = 9,
}

export const NHC = {
  NOTEHEAD_MORPH_WIDTH_FACTOR: 0.5,
  NOTEHEAD_MORPH_HEIGHT_FACTOR: 0.4,
  NOTEHEAD_SIZE_RATIO: 1.285714,
  STEM_WIDTH_UNIT_RATIO: 0.272727,
  STEM_HEIGHT_UNIT_RATIO: 4,
  CLEF_ZONE_WIDTH_UNIT_RATIO: 4.5406916,
  CLEF_WIDTH_UNIT_RATIO: 3.2173913,
  SMALL_CLEF_WIDTH_UNIT_RATIO: 2.4347826,
  STAFFLINE_WIDTH_UNIT_RATIO: 0.261,
};

export class NoteHead {
  points = 0;
  pitch: number | null = null;
  hasDot = false;
  bbox: BBox = [0, 0, 0, 0];
  stemUp: boolean | null = null;
  stemRight: boolean | null = null;
  track: number | null = null;
  group: number | null = null;
  staffLinePos = 0;
  invalid = false;
  id: number | null = null;
  noteGroupId: number | null = null;
  sfn: unknown = null;
  private _label: NoteType | null = null;

  get label(): NoteType | null {
    return this.invalid ? null : this._label;
  }
  /** Like oemer: only the first assignment sticks. */
  set label(l: NoteType | null) {
    if (this._label !== null) return;
    this._label = l;
  }
  forceSetLabel(l: NoteType): void {
    this._label = l;
  }
  /** Raw label even when invalid (for comparisons with oemer's dump). */
  get rawLabel(): NoteType | null {
    return this._label;
  }
}

function crop(r: Raster, b: BBox): { w: number; h: number; data: Uint8Array } {
  const x0 = Math.max(0, b[0]);
  const y0 = Math.max(0, b[1]);
  const x1 = Math.min(r.width, b[2]);
  const y1 = Math.min(r.height, b[3]);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = r.data[(y0 + y) * r.width + x0 + x];
  return { w, h, data };
}

export function morphNotehead(pred: Raster, unitSize: number): Raster {
  const small = Math.trunc(pyRound(unitSize / 3));
  const sk = ellipseKernel(small, small);
  let img = erode(dilate(pred, sk), sk);
  const size: [number, number] = [Math.trunc(pyRound(unitSize * NHC.NOTEHEAD_MORPH_WIDTH_FACTOR)), Math.trunc(pyRound(unitSize * NHC.NOTEHEAD_MORPH_HEIGHT_FACTOR))];
  img = erode(img, ellipseKernel(size[0], size[1]));
  return dilate(img, ellipseKernel(size[0] + 1, size[1] + 1));
}

function adjustBbox(b: BBox, noteheads: Raster): BBox | null {
  const r = crop(noteheads, b);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++)
      if (r.data[y * r.w + x] > 0) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (minY === Infinity) return null;
  return [b[0], minY + b[1] - 1, b[2], maxY + b[1] + 1];
}

export function checkBboxSize(b: BBox, noteheads: Raster, unitSize: number): BBox[] {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const [cx] = getCenter(b);
  const noteW = NHC.NOTEHEAD_SIZE_RATIO * unitSize;
  let out: BBox[] = [];
  if (Math.abs(w - noteW) > Math.abs(w - noteW * 2)) {
    const left = adjustBbox([b[0], b[1], cx, b[3]], noteheads);
    const right = adjustBbox([cx, b[1], b[2], b[3]], noteheads);
    if (left) out.push(...checkBboxSize(left, noteheads, unitSize));
    if (right) out.push(...checkBboxSize(right, noteheads, unitSize));
  }
  if (out.length > 0) {
    const tmp: BBox[] = [];
    for (const box of out) tmp.push(...checkBboxSize(box, noteheads, unitSize));
    out = tmp;
  } else {
    const num = Math.trunc(pyRound(h / unitSize));
    if (num > 0) {
      const subH = Math.floor(h / num);
      for (let i = 0; i < num; i++) out.push([b[0], pyRound(b[1] + i * subH), b[2], pyRound(b[1] + (i + 1) * subH)]);
    }
  }
  return out;
}

function filterNoteheadBbox(boxes: BBox[], notehead: Raster, flat: Staff[], zones: Zone[], o: Required<NoteheadOptions>): BBox[] {
  const minX = zones[0].start;
  const maxX = zones[zones.length - 1].stop - 1;
  return boxes.filter((b) => {
    const [cx, cy] = getCenter(b);
    const unit = getUnitSize(flat, cx, cy);
    if (cx < minX + NHC.CLEF_ZONE_WIDTH_UNIT_RATIO * unit || cx > maxX) return false;
    const h = b[3] - b[1];
    const w = b[2] - b[0];
    if (h < unit * o.minHRatio || h > unit * o.maxHRatio) return false;
    if (w < unit * o.minWRatio * NHC.NOTEHEAD_SIZE_RATIO || w > unit * o.maxWRatio * NHC.NOTEHEAD_SIZE_RATIO) return false;
    const r = crop(notehead, b);
    let count = 0;
    for (const v of r.data) if (v > 0) count++;
    return !(count < h * w * o.minAreaRatio);
  });
}

export interface NoteheadOptions {
  minHRatio?: number;
  maxHRatio?: number;
  minWRatio?: number;
  maxWRatio?: number;
  minAreaRatio?: number;
  maxWholeNoteWidthFactor?: number;
  yDistFactor?: number;
  hollowFilledRatioTh?: number;
}

export function getNoteheadBbox(pred: Raster, globalUnit: number, flat: Staff[], zones: Zone[], o: Required<NoteheadOptions>): BBox[] {
  const note = morphNotehead(pred, globalUnit);
  const boxes = rmMergeOverlapBbox(getBbox(note));
  const result: BBox[] = [];
  for (const box of boxes) {
    const [cx, cy] = getCenter(box);
    result.push(...checkBboxSize(box, pred, getUnitSize(flat, cx, cy)));
  }
  return filterNoteheadBbox(result, note, flat, zones, o);
}

/** fill_hole (including oemer's column pass nested inside the row loop). */
export function fillHole(region: { w: number; h: number; data: Uint8Array }): Uint8Array {
  const { w, h } = region;
  const tar = region.data.slice();
  for (let yi = 0; yi < h; yi++) {
    let cur = 0;
    const cand: number[] = [];
    while (cur < w && !(tar[yi * w + cur] > 0)) cur++;
    while (cur < w && tar[yi * w + cur] !== 0) cur++;
    while (cur < w && !(tar[yi * w + cur] > 0)) {
      cand.push(yi * w + cur);
      cur++;
    }
    if (cur < w) for (const i of cand) tar[i] = 1;
    for (let xi = 0; xi < w; xi++) {
      let c = 0;
      const cc: number[] = [];
      while (c < h && !(tar[c * w + xi] > 0)) c++;
      while (c < h && tar[c * w + xi] !== 0) c++;
      while (c < h && !(tar[c * w + xi] > 0)) {
        cc.push(c * w + xi);
        c++;
      }
      if (c < h) for (const i of cc) tar[i] = 1;
    }
  }
  return tar;
}

export function genNotes(boxes: BBox[], symbols: Raster, flat: Staff[]): NoteHead[] {
  return boxes.map((b) => {
    const nn = new NoteHead();
    nn.bbox = b;
    const r = crop(symbols, b);
    for (const v of r.data) if (v > 0) nn.points++;
    const [cx, cy] = getCenter(b);
    const [st1, st2] = findClosestStaffs(flat, cx, cy);
    let master: Staff;
    if (st1.yCenter === st2.yCenter || (st1.yUpper <= cy && cy <= st1.yLower)) master = st1;
    else {
      const [up, lo] = st1.yCenter < st2.yCenter ? [st1, st2] : [st2, st1];
      master = cy < (up.yCenter + lo.yCenter) / 2 ? up : lo;
    }
    nn.group = master.group;
    nn.track = master.track;
    const step = master.unitSize / 2;
    let pos = master.lines.map((l) => l.yCenter).reverse();
    const inter: number[] = [];
    for (let i = 0; i < pos.length - 1; i++) inter.push((pos[i] + pos[i + 1]) / 2);
    inter.forEach((v, i) => pos.splice(i * 2 + 1, 0, v));
    pos = [pos[0] + step, ...pos, pos[pos.length - 1] - step];
    let idx = 0;
    let bd = Infinity;
    pos.forEach((p, i) => {
      const d = Math.abs(p - cy);
      if (d < bd) {
        bd = d;
        idx = i;
      }
    });
    if (idx > 0 && idx < pos.length - 1) nn.staffLinePos = idx;
    else if (idx === 0) nn.staffLinePos = -pyRound(Math.abs(pos[0] - cy) / step) + 0; // + 0 avoids -0
    else nn.staffLinePos = pyRound(Math.abs(pos[pos.length - 1] - cy) / step) + pos.length - 1;
    return nn;
  });
}

export function parseStemInfo(notes: NoteHead[], stems: Raster): void {
  const enhanced = dilate(stems, rectKernel(3, 2));
  const { labels, count } = label4(enhanced);
  const w = stems.width;
  const sumX = new Float64Array(count + 1);
  const cnt = new Float64Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l) {
      sumX[l] += i % w;
      cnt[l]++;
    }
  }
  for (const note of notes) {
    const b = note.bbox;
    const seen = new Set<number>();
    for (let y = Math.max(0, b[1]); y < Math.min(stems.height, b[3]); y++)
      for (let x = Math.max(0, b[0]); x < Math.min(w, b[2]); x++) seen.add(labels[y * w + x]);
    const label = cpythonSetPop([...seen].sort((a, c) => a - c));
    if (label === undefined) continue;
    note.stemRight = sumX[label] / cnt[label] > (b[0] + b[2]) / 2;
  }
}

export function extractNoteheads(ctx: OemerContext, staffs: Staff[][], zones: Zone[], opts: NoteheadOptions = {}): NoteHead[] {
  const o: Required<NoteheadOptions> = {
    minHRatio: 0.4,
    maxHRatio: 5,
    minWRatio: 0.3,
    maxWRatio: 3,
    minAreaRatio: 0.5,
    maxWholeNoteWidthFactor: 1.5,
    yDistFactor: 5,
    hollowFilledRatioTh: 1.3,
    ...opts,
  };
  const flat = staffs.flat();
  const unit = getGlobalUnitSize(flat);
  const boxes = getNoteheadBbox(ctx.noteheadPred, unit, flat, zones, o);
  const merged = mergeNearbyBbox(boxes, unit * o.maxWholeNoteWidthFactor, 1, o.yDistFactor);
  const solid: BBox[] = [];
  const hollow: BBox[] = [];
  for (const m of merged) {
    const box: BBox = [m[0] - 1, m[1] - 1, m[2] - 1, m[3] - 1];
    const region = crop(ctx.symbolsPred, box);
    let count = 0;
    for (const v of region.data) if (v > 0) count++;
    if (count === 0) continue;
    let fCount = 0;
    for (const v of fillHole(region)) if (v > 0) fCount++;
    if (fCount / count > o.hollowFilledRatioTh) hollow.push(box);
    else solid.push(box);
  }
  const solidNotes = genNotes(solid, ctx.symbolsPred, flat);
  const hollowNotes = genNotes(hollow, ctx.symbolsPred, flat);
  for (const n of hollowNotes) n.label = NoteType.HALF_OR_WHOLE;
  const notes = [...solidNotes, ...hollowNotes];
  parseStemInfo(notes, ctx.stemsRestsPred);
  return notes;
}

