// StaffLens refinements on top of the oemer port. oemer's own steps stay byte-for-byte faithful (see the
// fidelity tests); these passes run after them and fix errors measured on the test pages
// (docs/PHASE2_PLAN.md, "Refinement"):
//   - rests oemer drops (its area filter removes whole/half rests and thin eighth rests),
//   - the key signature (flats are split across model layers and get lost; flats read as sharps on photos),
//   - a barline found inside the clef / key / time-signature area (the stroke of a "4"),
//   - notes far outside the staff with no ledger lines (the note of a tempo mark),
//   - flats and naturals in front of notes (oemer finds only sharps there),
//   - half notes whose hollow head the model marks too faintly for oemer,
//   - augmentation dots, using the bar length as a constraint.
// Everything works from the model maps and oemer's intermediate results, so it is testable on the fixtures.

import { label4, raster, type BBox } from './oemer/cv';
import type { OemerContext } from './oemer/context';
import { NoteGroup } from './oemer/noteGroup';
import { genNotes, NoteType, type NoteHead } from './oemer/notehead';
import type { Staff } from './oemer/staffline';
import { RestType, SfnType, type Barline, type Clef, type Rest, type Sfn } from './oemer/symbols';
import { findClosestStaffs } from './oemer/utils';

export interface Symbols {
  barlines: Barline[];
  clefs: Clef[];
  sfns: Sfn[];
  rests: Rest[];
}

export interface RefineReport {
  removedBarlines: BBox[];
  rests: { bbox: BBox; label: string; replaced: boolean }[];
  keys: { group: number; fifths: number; shapes: string[] }[];
  droppedNotes: number[];
  accidentals: { note: number; label: string }[];
  addedNotes: { note: number; pos: number; bbox: BBox }[];
  dots: { what: string; x: number; dot: boolean }[];
  /** per "group:track": x where clef, key and time signature end */
  headers: Record<string, number>;
  /** The note of a tempo mark (♩ = 96) above the first system, if one was dropped: the number is to its right. */
  tempoNote: BBox | null;
}

interface Comp {
  box: BBox; // x1, y1, x2, y2 (exclusive)
  area: number;
  /** pixels per column, left to right */
  cols: number[];
  /** pixels in the lower half / all */
  lowShare: number;
}

const w_ = (b: BBox) => b[2] - b[0];
const h_ = (b: BBox) => b[3] - b[1];
const overlaps = (a: BBox, b: BBox, pad = 0) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;

/** y of staff line `i` (0 = top) at x. */
function lineY(st: Staff, i: number, x: number): number {
  const l = st.lines[i];
  return l.yCenter + l.slope * (x - l.xCenter);
}

/** Staff position of y: 0 = bottom line, 1 = first space, … 8 = top line (half staff spaces). */
function staffPos(st: Staff, x: number, y: number): number {
  return (lineY(st, 4, x) - y) / (st.unitSize / 2);
}

/** Connected pieces of `mask` inside `rect`, with small gaps (≤ gap px) bridged. */
export function components(mask: Uint8Array, width: number, rect: BBox, gap: number): Comp[] {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const sub = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sub.data[y * w + x] = mask[(y0 + y) * width + x0 + x];
  const { labels, count } = label4(sub);
  const boxes = Array.from({ length: count + 1 }, () => [Infinity, Infinity, -1, -1, 0]);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = boxes[l];
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x + 1);
    b[3] = Math.max(b[3], y + 1);
    b[4]++;
  }
  // bridge small gaps (the model often breaks a symbol into pieces)
  let merged = boxes.slice(1).filter((b) => b[2] > 0).map((b) => [...b]);
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++)
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i];
        const b = merged[j];
        if (a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap) {
          merged[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]), a[4] + b[4]];
          merged.splice(j, 1);
          changed = true;
          break outer;
        }
      }
  }
  merged = merged.filter((b) => b[4] > 0);
  return merged.map((b) => {
    const box: BBox = [b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0];
    const cols = new Array(w_(box)).fill(0);
    let low = 0;
    let all = 0;
    const midY = (box[1] + box[3]) / 2;
    for (let y = box[1]; y < box[3]; y++)
      for (let x = box[0]; x < box[2]; x++)
        if (mask[y * width + x]) {
          cols[x - box[0]]++;
          all++;
          if (y >= midY) low++;
        }
    return { box, area: all, cols, lowShare: all ? low / all : 0 };
  });
}

// ------------------------------------------------------------------ rests

/** Rule-based rest shape from size and position on the staff (u = staff space). */
export function classifyRest(c: { box: BBox; area: number }, st: Staff): RestType | null {
  const u = st.unitSize;
  const bw = w_(c.box) / u;
  const bh = h_(c.box) / u;
  const fill = c.area / Math.max(1, w_(c.box) * h_(c.box));
  const cx = (c.box[0] + c.box[2]) / 2;
  if (bh >= 0.3 && bh <= 0.85 && bw >= 0.8 && bw <= 2 && fill >= 0.6) {
    // a block: whole rests hang from the 2nd line, half rests sit on the middle line
    const top = c.box[1];
    const bottom = c.box[3];
    if (Math.abs(top - lineY(st, 1, cx)) <= 0.35 * u) return RestType.WHOLE;
    if (Math.abs(bottom - lineY(st, 2, cx)) <= 0.35 * u) return RestType.HALF;
    return null;
  }
  // inside the staff, roughly centred on it
  const mid = staffPos(st, cx, (c.box[1] + c.box[3]) / 2);
  if (mid < 1 || mid > 7) return null;
  if (bw >= 0.55 && bw <= 1.4 && bh >= 2.2 && bh <= 3.4 && fill >= 0.2) return RestType.QUARTER;
  if (bw >= 0.5 && bw <= 1.4 && bh >= 1.3 && bh < 2.2 && fill >= 0.15) return RestType.EIGHTH;
  return null;
}

function refineRests(ctx: OemerContext, flat: Staff[], groupMap: Int32Array, notes: NoteHead[], sym: Symbols, headerEnd: Map<string, number>, report: RefineReport): void {
  const { width: w, height: h } = ctx;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++)
    if (groupMap[i] === -1 && (ctx.stemsRestsPred.data[i] || ctx.noteheadPred.data[i] || ctx.symbolsPred.data[i])) mask[i] = 1;
  const blocked = [...sym.barlines.map((b) => b.bbox), ...sym.clefs.map((c) => c.bbox), ...sym.sfns.map((s) => s.bbox)];
  for (const st of flat) {
    const u = st.unitSize;
    const rect: BBox = [Math.max(0, Math.round(st.xLeft)), Math.max(0, Math.round(st.yUpper - u)), Math.min(w, Math.round(st.xRight)), Math.min(h, Math.round(st.yLower + u))];
    // skip the clef / key / time-signature area at the start of the staff
    const start = headerEnd.get(`${st.group}:${st.track}`) ?? rect[0];
    const heads = notes.filter((n) => !n.invalid && n.group === st.group).map((n) => n.bbox);
    for (const c of components(mask, w, rect, Math.max(1, Math.round(u * 0.15)))) {
      if (c.box[0] < start) continue;
      // part of a note, or an accidental right in front of one
      if (heads.some((b) => overlaps(b, c.box))) continue;
      if (heads.some((b) => b[0] >= c.box[2] - 0.2 * u && b[0] - c.box[2] < 0.8 * u && b[1] < c.box[3] && c.box[1] < b[3])) continue;
      if ((c.box[1] + c.box[3]) / 2 < st.yUpper - 0.6 * u || (c.box[1] + c.box[3]) / 2 > st.yLower + 0.6 * u) continue;
      if (blocked.some((b) => overlaps(b, c.box))) continue;
      const label = classifyRest(c, st);
      if (label === null) continue;
      const existing = sym.rests.findIndex((r) => overlaps(r.bbox, c.box, u * 0.3));
      const rest: Rest = { bbox: c.box, hasDot: false, track: st.track, group: st.group, label };
      if (existing >= 0) {
        if (sym.rests[existing].label !== label) {
          sym.rests[existing] = { ...sym.rests[existing], label };
          report.rests.push({ bbox: c.box, label: RestType[label], replaced: true });
        }
        continue;
      }
      sym.rests.push(rest);
      report.rests.push({ bbox: c.box, label: RestType[label], replaced: false });
    }
  }
}

// ------------------------------------------------------------------ key signature

const SHARP_POS = [8, 5, 9, 6, 3, 7]; // treble: F5 C5 G5 D5 A4 E5 (staff positions, 0 = bottom line E4)
const FLAT_POS = [4, 7, 3, 6, 2, 5]; //        B4 E5 A4 D5 G4 C5

/** Vertical strokes of a component: runs of columns at least `share` of its height tall, with their extent. */
function strokes(c: Comp, mask: Uint8Array, width: number, share: number): { top: number; bottom: number }[] {
  const hgt = h_(c.box);
  const out: { top: number; bottom: number }[] = [];
  let i = 0;
  while (i < c.cols.length) {
    if (c.cols[i] < hgt * share) {
      i++;
      continue;
    }
    let j = i;
    let top = Infinity;
    let bottom = -1;
    while (j < c.cols.length && c.cols[j] >= hgt * share) {
      for (let y = c.box[1]; y < c.box[3]; y++)
        if (mask[y * width + c.box[0] + j]) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      j++;
    }
    out.push({ top, bottom });
    i = j;
  }
  return out;
}

/** Sharp, flat or natural in front of a note, from the shape. */
export function noteAccidentalShape(c: Comp, mask: Uint8Array, width: number): 'sharp' | 'flat' | 'natural' | null {
  const hgt = h_(c.box);
  const st = strokes(c, mask, width, 0.5);
  if (st.length >= 2) {
    const [l, r] = [st[0], st[st.length - 1]];
    // natural: the left stroke starts higher, the right one ends lower
    if (r.top - l.top > 0.2 * hgt && r.bottom - l.bottom > 0.2 * hgt) return 'natural';
    if (Math.abs(r.top - l.top) <= 0.2 * hgt) return 'sharp';
    return null;
  }
  if (st.length === 1 && c.lowShare >= 0.58) return 'flat';
  return null;
}

/** Flat or sharp from the shape: a sharp has two tall strokes and is balanced, a flat one stem and a low bowl. */
export function accidentalShape(c: Comp): 'sharp' | 'flat' | null {
  const hgt = h_(c.box);
  const tall = c.cols.filter((v) => v >= hgt * 0.55);
  // count separate runs of tall columns
  let runs = 0;
  for (let i = 0; i < c.cols.length; i++) if (c.cols[i] >= hgt * 0.55 && !(i > 0 && c.cols[i - 1] >= hgt * 0.55)) runs++;
  if (tall.length === 0) return null;
  if (runs >= 2 && c.lowShare < 0.62) return 'sharp';
  if (runs === 1 && c.lowShare >= 0.55) return 'flat';
  return c.lowShare >= 0.6 ? 'flat' : c.lowShare <= 0.55 ? 'sharp' : null;
}

/**
 * Key signature after each clef; returns, per "group:track", where the staff header (clef, key, time signature) ends.
 */
function refineKeys(ctx: OemerContext, flat: Staff[], groupMap: Int32Array, notes: NoteHead[], sym: Symbols, report: RefineReport): Map<string, number> {
  const headerEnd = new Map<string, number>();
  const { width: w, height: h } = ctx;
  const mask = new Uint8Array(w * h);
  // all ink, notes included: oemer sometimes makes a note out of a time-signature figure
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (!(ctx.symbolsPred.data[i] || ctx.noteheadPred.data[i] || ctx.clefsKeysPred.data[i])) continue;
    ink[i] = 1;
    if (groupMap[i] === -1) mask[i] = 1;
  }
  for (const clef of sym.clefs) {
    const first = sym.clefs.filter((c) => c.group === clef.group && c.track === clef.track).sort((a, b) => a.bbox[0] - b.bbox[0])[0];
    if (first !== clef) continue; // only the clef that opens the staff
    const st = findClosestStaffs(flat, (clef.bbox[0] + clef.bbox[2]) / 2, (clef.bbox[1] + clef.bbox[3]) / 2)[0];
    const u = st.unitSize;
    const id = `${clef.group}:${clef.track}`;
    headerEnd.set(id, clef.bbox[2]);
    // first note or rest of the staff limits the search
    const firstNote = Math.min(
      ...notes.filter((n) => !n.invalid && n.group === st.group && n.track === st.track).map((n) => n.bbox[0]),
      ...sym.rests.filter((r) => r.group === st.group && r.track === st.track).map((r) => r.bbox[0]),
      st.xRight,
    );
    const rect: BBox = [clef.bbox[2], Math.max(0, Math.round(st.yUpper - 1.6 * u)), Math.min(w, Math.round(Math.min(firstNote, clef.bbox[2] + 8 * u))), Math.min(h, Math.round(st.yLower + 1.6 * u))];
    const comps = components(mask, w, rect, Math.max(1, Math.round(u * 0.12)))
      .sort((a, b) => a.box[0] - b.box[0])
      .filter((c) => h_(c.box) >= 1.7 * u && h_(c.box) <= 3.4 * u && w_(c.box) >= 0.45 * u && w_(c.box) <= 1.35 * u);
    // accidentals of a key signature follow each other closely
    const key: Comp[] = [];
    for (const c of comps) {
      const prevEnd = key.length ? key[key.length - 1].box[2] : clef.bbox[2];
      if (c.box[0] - prevEnd > 1.6 * u) break;
      key.push(c);
      if (key.length === 6) break;
    }
    let end = key.length ? key[key.length - 1].box[2] : clef.bbox[2];
    const sigRect: BBox = [Math.round(end), rect[1], Math.min(w, Math.round(end + 4 * u)), rect[3]];
    const all = components(ink, w, sigRect, Math.max(1, Math.round(u * 0.12)));
    // a time signature: two stacked figures, one in each half of the staff, right after the key
    const sig = all.filter((c) => c.box[0] >= end - 0.2 * u && c.box[0] - end < 2.5 * u && h_(c.box) >= 1.4 * u && h_(c.box) <= 2.4 * u && w_(c.box) >= 0.7 * u);
    const top = sig.find((c) => (c.box[1] + c.box[3]) / 2 < st.yCenter);
    const bottom = sig.find((c) => (c.box[1] + c.box[3]) / 2 > st.yCenter && top && c.box[0] < top.box[2] && top.box[0] < c.box[2]);
    if (top && bottom) end = Math.max(top.box[2], bottom.box[2]);
    else {
      // the two figures run together into one staff-high shape
      // (wide in both halves of the staff, unlike a note with its stem)
      const wideIn = (c: Comp, y0: number, y1: number) => {
        let best = 0;
        for (let y = Math.max(c.box[1], Math.round(y0)); y < Math.min(c.box[3], Math.round(y1)); y++) {
          let lo = Infinity;
          let hi = -1;
          for (let x = c.box[0]; x < c.box[2]; x++)
            if (ink[y * w + x]) {
              lo = Math.min(lo, x);
              hi = Math.max(hi, x);
            }
          best = Math.max(best, hi - lo + 1);
        }
        return best >= 0.8 * u;
      };
      const whole = all.find(
        (c) =>
          c.box[0] - end < 2.5 * u &&
          h_(c.box) >= 3.4 * u &&
          h_(c.box) <= 4.6 * u &&
          w_(c.box) >= 0.9 * u &&
          w_(c.box) <= 2.4 * u &&
          Math.abs((c.box[1] + c.box[3]) / 2 - st.yCenter) < 0.6 * u &&
          wideIn(c, c.box[1], st.yCenter - 0.3 * u) &&
          wideIn(c, st.yCenter + 0.3 * u, c.box[3]),
      );
      if (whole) end = whole.box[2];
    }
    headerEnd.set(id, end);
    if (key.length === 0) continue;
    const shapes = key.map(accidentalShape);
    // positions: a sharp's centre, a flat's bowl (lower part) sits on the key's note
    const posSharp = key.map((c) => Math.round(staffPos(st, (c.box[0] + c.box[2]) / 2, (c.box[1] + c.box[3]) / 2)));
    const posFlat = key.map((c) => Math.round(staffPos(st, (c.box[0] + c.box[2]) / 2, c.box[3] - 0.65 * u)));
    let sharpScore = 0;
    let flatScore = 0;
    key.forEach((_, i) => {
      if (shapes[i] === 'sharp') sharpScore += 1;
      if (shapes[i] === 'flat') flatScore += 1;
      if (Math.abs(posSharp[i] - SHARP_POS[i]) <= 1) sharpScore += 1;
      if (Math.abs(posFlat[i] - FLAT_POS[i]) <= 1) flatScore += 1;
    });
    if (sharpScore === flatScore) continue;
    const label = sharpScore > flatScore ? SfnType.SHARP : SfnType.FLAT;
    // replace oemer's key accidentals of this staff with these
    sym.sfns = sym.sfns.filter((s) => !(s.noteId === null && s.group === clef.group && s.track === clef.track && s.bbox[0] < rect[2] && s.bbox[2] > rect[0]));
    for (const c of key) sym.sfns.push({ bbox: c.box, noteId: null, isKey: true, track: clef.track, group: clef.group, label });
    report.keys.push({ group: clef.group ?? 0, fifths: label === SfnType.SHARP ? key.length : -key.length, shapes: shapes.map((s) => s ?? '?') });
  }
  return headerEnd;
}

// ------------------------------------------------------------------ barlines and stray notes

function refineBarlines(flat: Staff[], notes: NoteHead[], sym: Symbols, headerEnd: Map<string, number>, report: RefineReport): void {
  sym.barlines = sym.barlines.filter((b) => {
    const st = findClosestStaffs(flat, (b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2)[0];
    const clef = sym.clefs.filter((c) => c.group === b.group).sort((a, c) => a.bbox[0] - c.bbox[0])[0];
    if (!clef) return true;
    const gap = b.bbox[0] - clef.bbox[2];
    if (gap < 0) return true;
    const inHeader = [...headerEnd].some(([k, end]) => k.startsWith(`${b.group}:`) && b.bbox[2] <= end + 0.3 * st.unitSize);
    if (!inHeader && gap > 6 * st.unitSize) return true;
    const between = notes.some((n) => !n.invalid && n.group === b.group && n.bbox[0] > clef.bbox[2] && n.bbox[2] < b.bbox[0]) || sym.rests.some((r) => r.group === b.group && r.bbox[0] > clef.bbox[2] && r.bbox[2] < b.bbox[0]);
    if (between) return true;
    report.removedBarlines.push(b.bbox);
    return false;
  });
}

/** True when the staff map shows a ledger line through or near the note at staff position `pos`. */
function hasLedger(ctx: OemerContext, st: Staff, n: NoteHead, pos: number): boolean {
  const u = st.unitSize;
  const cx = Math.round((n.bbox[0] + n.bbox[2]) / 2);
  const half = Math.round(0.9 * u);
  // the ledger line next to the staff for notes above (pos 10) or below (pos -2)
  const ledgerPos = pos > 8 ? 10 : -2;
  const y = Math.round(lineY(st, 4, cx) - (ledgerPos * u) / 2);
  let best = 0;
  for (let dy = -Math.round(0.25 * u); dy <= Math.round(0.25 * u); dy++) {
    let run = 0;
    const yy = y + dy;
    if (yy < 0 || yy >= ctx.height) continue;
    for (let x = cx - half; x <= cx + half; x++) if (x >= 0 && x < ctx.width && (ctx.staffPred.data[yy * ctx.width + x] || ctx.symbolsPred.data[yy * ctx.width + x])) run++;
    best = Math.max(best, run);
  }
  return best >= 1.2 * u;
}

/** Notes inside the staff header (clef, key, time signature) are parts of those symbols. */
function refineHeaderNotes(notes: NoteHead[], headerEnd: Map<string, number>, report: RefineReport): void {
  notes.forEach((n, i) => {
    if (n.invalid) return;
    const end = headerEnd.get(`${n.group}:${n.track}`);
    if (end === undefined || (n.bbox[0] + n.bbox[2]) / 2 >= end) return;
    n.invalid = true;
    report.droppedNotes.push(i);
  });
}

function refineStrayNotes(ctx: OemerContext, flat: Staff[], notes: NoteHead[], groups: NoteGroup[], report: RefineReport): void {
  notes.forEach((n, i) => {
    if (n.invalid) return;
    const cx = (n.bbox[0] + n.bbox[2]) / 2;
    const cy = (n.bbox[1] + n.bbox[3]) / 2;
    const st = findClosestStaffs(flat, cx, cy)[0];
    const pos = staffPos(st, cx, cy);
    // positions 10 and above / -2 and below need ledger lines (9 and -1 sit just outside the staff)
    if (pos < 9.5 && pos > -1.5) return;
    if (hasLedger(ctx, st, n, pos)) return;
    n.invalid = true;
    report.droppedNotes.push(i);
    // above the first system: the note of a tempo mark (the leftmost one if there are several)
    const first = Math.min(...flat.map((s) => s.group ?? 0));
    if (pos > 9.5 && st.group === first && (!report.tempoNote || n.bbox[0] < report.tempoNote[0])) report.tempoNote = n.bbox;
  });
  void groups;
}

// ------------------------------------------------------------------ accidentals in front of notes

function refineAccidentals(ctx: OemerContext, flat: Staff[], groupMap: Int32Array, notes: NoteHead[], sym: Symbols, report: RefineReport): void {
  const { width: w, height: h } = ctx;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (groupMap[i] === -1 && (ctx.symbolsPred.data[i] || ctx.clefsKeysPred.data[i] || ctx.noteheadPred.data[i])) mask[i] = 1;
  notes.forEach((n, id) => {
    if (n.invalid || n.sfn !== null) return;
    const cx = (n.bbox[0] + n.bbox[2]) / 2;
    const cy = (n.bbox[1] + n.bbox[3]) / 2;
    const st = findClosestStaffs(flat, cx, cy)[0];
    const u = st.unitSize;
    const rect: BBox = [Math.max(0, Math.round(n.bbox[0] - 1.8 * u)), Math.max(0, Math.round(cy - 2 * u)), Math.max(0, n.bbox[0]), Math.min(h, Math.round(cy + 1.6 * u))];
    const cands = components(mask, w, rect, Math.max(1, Math.round(u * 0.12))).filter(
      (c) =>
        n.bbox[0] - c.box[2] <= 0.7 * u &&
        h_(c.box) >= 1.6 * u &&
        h_(c.box) <= 3.3 * u &&
        w_(c.box) >= 0.35 * u &&
        w_(c.box) <= 1.3 * u &&
        c.box[1] < cy &&
        c.box[3] > cy &&
        !sym.sfns.some((s) => overlaps(s.bbox, c.box)) &&
        !sym.rests.some((r) => overlaps(r.bbox, c.box)),
    );
    const c = cands.sort((a, b) => b.box[2] - a.box[2])[0];
    if (!c) return;
    const shape = noteAccidentalShape(c, mask, w);
    if (!shape) return;
    // a flat's bowl, a natural's or sharp's middle sits at the note
    const at = shape === 'flat' ? c.box[3] - 0.55 * u : (c.box[1] + c.box[3]) / 2;
    if (Math.abs(at - cy) > 0.6 * u) return;
    const label = shape === 'flat' ? SfnType.FLAT : shape === 'sharp' ? SfnType.SHARP : SfnType.NATURAL;
    n.sfn = label;
    sym.sfns.push({ bbox: c.box, noteId: id, isKey: false, track: n.track, group: n.group, label });
    report.accidentals.push({ note: id, label: shape });
  });
}

// ------------------------------------------------------------------ hollow (half) noteheads

/** The longest run of rows of `c` whose ink spans at least 0.85 staff spaces, as a component. */
function headBand(c: Comp, mask: Uint8Array, width: number, u: number): { box: BBox; area: number } | null {
  let best: [number, number] | null = null;
  let runStart = -1;
  const spans: [number, number][] = [];
  for (let y = c.box[1]; y < c.box[3]; y++) {
    let lo = Infinity;
    let hi = -1;
    for (let x = c.box[0]; x < c.box[2]; x++)
      if (mask[y * width + x]) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    spans.push([lo, hi]);
    const wide = hi - lo + 1 >= 0.85 * u;
    if (wide && runStart < 0) runStart = y;
    if ((!wide || y === c.box[3] - 1) && runStart >= 0) {
      const end = wide ? y + 1 : y;
      if (!best || end - runStart > best[1] - best[0]) best = [runStart, end];
      runStart = -1;
    }
  }
  if (!best) return null;
  let x0 = Infinity;
  let x1 = -1;
  let area = 0;
  for (let y = best[0]; y < best[1]; y++) {
    const [lo, hi] = spans[y - c.box[1]];
    x0 = Math.min(x0, lo);
    x1 = Math.max(x1, hi + 1);
    for (let x = lo; x <= hi; x++) if (mask[y * width + x]) area++;
  }
  return { box: [x0, best[0], x1, best[1]], area };
}

function refineHollowHeads(ctx: OemerContext, flat: Staff[], groupMap: Int32Array, notes: NoteHead[], groups: NoteGroup[], sym: Symbols, headerEnd: Map<string, number>, report: RefineReport): void {
  const { width: w, height: h } = ctx;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (groupMap[i] === -1 && (ctx.noteheadPred.data[i] || ctx.symbolsPred.data[i]) && !ctx.stemsRestsPred.data[i]) mask[i] = 1;
  // a stem is a thin vertical line of ink; the model labels parts of it "stem" and parts "symbol"
  const ink = (i: number) => ctx.stemsRestsPred.data[i] || ctx.symbolsPred.data[i];
  /** Longest vertical run of ink in columns [x0, x1) starting within [y0, y1], going up (-1) or down (+1); gaps of 2 px are bridged. */
  const stemRun = (x0: number, x1: number, y0: number, y1: number, dir: number): number => {
    let best = 0;
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++)
      for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
        if (!ctx.stemsRestsPred.data[y * w + x]) continue;
        let len = 0;
        let miss = 0;
        for (let yy = y; yy >= 0 && yy < h; yy += dir) {
          if (ink(yy * w + x) || ink(yy * w + x + 1) || ink(yy * w + x - 1)) {
            len += miss + 1;
            miss = 0;
          } else if (++miss > 2) break;
        }
        best = Math.max(best, len);
      }
    return best;
  };
  const taken = [...notes.filter((n) => !n.invalid).map((n) => n.bbox), ...sym.rests.map((r) => r.bbox), ...sym.sfns.map((s) => s.bbox), ...sym.clefs.map((c) => c.bbox), ...sym.barlines.map((b) => b.bbox)];
  for (const st of flat) {
    const u = st.unitSize;
    const rect: BBox = [Math.max(0, Math.round(st.xLeft)), Math.max(0, Math.round(st.yUpper - 3.5 * u)), Math.min(w, Math.round(st.xRight)), Math.min(h, Math.round(st.yLower + 3.5 * u))];
    const start = headerEnd.get(`${st.group}:${st.track}`) ?? rect[0];
    for (const piece of components(mask, w, rect, Math.max(1, Math.round(u * 0.1)))) {
      // the model often joins part of the stem to the head: keep the band of rows wide enough to be a head
      const c = headBand(piece, mask, w, u);
      if (!c) continue;
      const bw = w_(c.box) / u;
      const bh = h_(c.box) / u;
      if (c.box[0] < start || bw < 0.95 || bw > 1.7 || bh < 0.7 || bh > 1.3) continue;
      // ring-like: not a filled blob
      const fill = c.area / (w_(c.box) * h_(c.box));
      if (fill > 0.8 || fill < 0.25) continue;
      // hollow: the middle of the head is not notehead ink (a filled head here is a missed black note)
      const [mx0, my0, mx1, my1] = [c.box[0] + 0.3 * w_(c.box), c.box[1] + 0.3 * h_(c.box), c.box[2] - 0.3 * w_(c.box), c.box[3] - 0.3 * h_(c.box)].map(Math.round);
      let solid = 0;
      let all = 0;
      for (let y = my0; y < my1; y++)
        for (let x = mx0; x < mx1; x++) {
          all++;
          if (ctx.noteheadPred.data[y * w + x]) solid++;
        }
      if (all && solid / all > 0.5) continue;
      // …but its rim is partly marked as notehead (a stem with its flag can also look like a ring)
      let rim = 0;
      for (let y = c.box[1]; y < c.box[3]; y++) for (let x = c.box[0]; x < c.box[2]; x++) if (ctx.noteheadPred.data[y * w + x]) rim++;
      if (rim < 0.03 * c.area) continue;
      if (taken.some((b) => overlaps(b, c.box))) continue;
      const cy = (c.box[1] + c.box[3]) / 2;
      const pos = staffPos(st, (c.box[0] + c.box[2]) / 2, cy);
      if (pos < -4.5 || pos > 12.5) continue;
      // a half note's stem: down from the left side, or up from the right side
      const down = stemRun(c.box[0] - Math.round(0.25 * u), c.box[0] + Math.round(0.3 * u), Math.round(cy - 0.3 * u), Math.round(cy + 0.5 * u), 1);
      const up = stemRun(c.box[2] - Math.round(0.3 * u), c.box[2] + Math.round(0.25 * u), Math.round(cy - 0.5 * u), Math.round(cy + 0.3 * u), -1);
      const stemUp = up >= down;
      if (Math.max(up, down) < 2.3 * u) continue;
      const [note] = genNotes([c.box], ctx.symbolsPred, flat);
      if (note.group !== st.group) continue;
      note.forceSetLabel(NoteType.HALF);
      note.stemUp = stemUp;
      note.stemRight = stemUp;
      note.id = notes.length;
      note.noteGroupId = groups.length;
      const g = new NoteGroup();
      g.id = groups.length;
      g.noteIds = [note.id];
      g.topNoteIds = [note.id];
      g.bottomNoteIds = [note.id];
      g.stemUp = stemUp;
      g.hasStem = true;
      g.allSameType = true;
      g.group = note.group;
      g.track = note.track;
      const len = Math.max(up, down);
      g.bbox = stemUp ? [c.box[0], Math.round(cy - len), c.box[2], c.box[3]] : [c.box[0], c.box[1], c.box[2], Math.round(cy + len)];
      notes.push(note);
      groups.push(g);
      taken.push(c.box);
      report.addedNotes.push({ note: note.id, pos: note.staffLinePos, bbox: c.box });
    }
  }
}

// ------------------------------------------------------------------ dots and bar lengths

const NOTE_BEATS: Partial<Record<NoteType, number>> = {
  [NoteType.WHOLE]: 4,
  [NoteType.HALF]: 2,
  [NoteType.HALF_OR_WHOLE]: 2, // written as a half by the builder
  [NoteType.QUARTER]: 1,
  [NoteType.EIGHTH]: 0.5,
  [NoteType.SIXTEENTH]: 0.25,
  [NoteType.THIRTY_SECOND]: 0.125,
};
const REST_BEATS: Partial<Record<RestType, number>> = {
  [RestType.WHOLE]: 4,
  [RestType.HALF]: 2,
  [RestType.WHOLE_HALF]: 2,
  [RestType.QUARTER]: 1,
  [RestType.EIGHTH]: 0.5,
  [RestType.SIXTEENTH]: 0.25,
  [RestType.THIRTY_SECOND]: 0.125,
};

interface Ev {
  x: number;
  base: number;
  dot: boolean;
  /** dot visible on the page */
  seen: boolean;
  set: (dot: boolean) => void;
  name: string;
}

/** A small round blob just right of `box` (an augmentation dot). */
function dotNear(ctx: OemerContext, groupMap: Int32Array, box: BBox, u: number): boolean {
  const { width: w, height: h } = ctx;
  const cy = (box[1] + box[3]) / 2;
  const rect: BBox = [Math.min(w, box[2]), Math.max(0, Math.round(cy - 0.75 * u)), Math.min(w, Math.round(box[2] + 1.1 * u)), Math.min(h, Math.round(cy + 0.35 * u))];
  const mask = new Uint8Array(w * h);
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) if (groupMap[y * w + x] === -1 && ctx.symbolsPred.data[y * w + x]) mask[y * w + x] = 1;
  return components(mask, w, rect, 1).some((c) => w_(c.box) >= 0.2 * u && w_(c.box) <= 0.65 * u && h_(c.box) >= 0.2 * u && h_(c.box) <= 0.65 * u && c.area >= 0.5 * w_(c.box) * h_(c.box));
}

function refineDots(ctx: OemerContext, flat: Staff[], groupMap: Int32Array, notes: NoteHead[], groups: NoteGroup[], sym: Symbols, report: RefineReport): void {
  const tracks = new Set(flat.map((s) => s.track));
  if (tracks.size !== 1) return; // bar arithmetic below assumes one voice per system
  const u = flat.reduce((a, s) => a + s.unitSize, 0) / flat.length;
  const bars: Ev[][] = [];
  const systems = [...new Set(flat.map((s) => s.group))].sort((a, b) => (a ?? 0) - (b ?? 0));
  for (const grp of systems) {
    const evs: Ev[] = [];
    for (const g of groups) {
      const ids = g.noteIds.filter((i) => !notes[i].invalid && notes[i].group === grp);
      if (!ids.length) continue;
      const lead = notes[ids[0]];
      const base = NOTE_BEATS[lead.label as NoteType];
      if (base === undefined) continue;
      const box = lead.bbox;
      evs.push({ x: (box[0] + box[2]) / 2, base, dot: lead.hasDot, seen: dotNear(ctx, groupMap, box, u), set: (d) => ids.forEach((i) => (notes[i].hasDot = d)), name: `note ${ids[0]}` });
    }
    for (const r of sym.rests) {
      if (r.group !== grp) continue;
      const base = REST_BEATS[r.label];
      if (base === undefined) continue;
      evs.push({ x: (r.bbox[0] + r.bbox[2]) / 2, base, dot: !!r.hasDot, seen: dotNear(ctx, groupMap, r.bbox, u), set: (d) => (r.hasDot = d), name: `rest ${RestType[r.label]}` });
    }
    const lines = sym.barlines.filter((b) => b.group === grp).map((b) => (b.bbox[0] + b.bbox[2]) / 2).sort((a, b) => a - b);
    const cuts = [-Infinity, ...lines, Infinity];
    for (let i = 0; i < cuts.length - 1; i++) {
      const bar = evs.filter((e) => e.x > cuts[i] && e.x < cuts[i + 1]).sort((a, b) => a.x - b.x);
      if (bar.length) bars.push(bar);
    }
  }
  const len = (e: Ev) => (e.dot ? e.base * 1.5 : e.base);
  const total = (bar: Ev[]) => Math.round(bar.reduce((a, e) => a + len(e), 0) * 32) / 32;
  const counts = new Map<number, number>();
  for (const b of bars) if (!(b.length === 1 && b[0].name === 'rest WHOLE')) counts.set(total(b), (counts.get(total(b)) ?? 0) + 1);
  const [target, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (n < 2) return;
  for (const bar of bars) {
    const diff = target - total(bar);
    if (Math.abs(diff) < 1e-6) continue;
    // single dot toggles that make the bar the right length
    const fits = bar.filter((e) => Math.abs((e.dot ? -e.base / 2 : e.base / 2) - diff) < 1e-6);
    let pick: Ev | undefined;
    if (fits.length === 1) pick = fits[0];
    else {
      const agree = fits.filter((e) => e.seen === !e.dot);
      if (agree.length === 1) pick = agree[0];
    }
    if (!pick) continue;
    pick.dot = !pick.dot;
    pick.set(pick.dot);
    report.dots.push({ what: pick.name, x: Math.round(pick.x), dot: pick.dot });
  }
}

/** Runs all refinements in place. */
export function refine(ctx: OemerContext, staffs: Staff[][], notes: NoteHead[], groups: NoteGroup[], groupMap: Int32Array, sym: Symbols): RefineReport {
  const flat = staffs.flat();
  const report: RefineReport = { removedBarlines: [], rests: [], keys: [], droppedNotes: [], accidentals: [], addedNotes: [], dots: [], headers: {}, tempoNote: null };
  refineStrayNotes(ctx, flat, notes, groups, report);
  const headerEnd = refineKeys(ctx, flat, groupMap, notes, sym, report);
  report.headers = Object.fromEntries(headerEnd);
  refineHeaderNotes(notes, headerEnd, report);
  refineBarlines(flat, notes, sym, headerEnd, report);
  refineHollowHeads(ctx, flat, groupMap, notes, groups, sym, headerEnd, report);
  refineRests(ctx, flat, groupMap, notes, sym, headerEnd, report);
  refineAccidentals(ctx, flat, groupMap, notes, sym, report);
  refineDots(ctx, flat, groupMap, notes, groups, sym, report);
  return report;
}
