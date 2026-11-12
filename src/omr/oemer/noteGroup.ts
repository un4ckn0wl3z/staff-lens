// Port of oemer/note_group_extraction.py (oemer 0.1.8, MIT): groups noteheads that share a stem
// (chords, beamed notes' heads) and works out stem direction.

import { dilate, label4, rectKernel, type BBox } from './cv';
import { mean, type OemerContext } from './context';
import type { NoteHead } from './notehead';
import { PySet } from './pyport';
import { getCenter, type Staff } from './staffline';
import { findClosestStaffs, getUnitSize } from './utils';
import { pyRound } from './context';

export class NoteGroup {
  id = 0;
  bbox: BBox = [0, 0, 0, 0];
  noteIds: number[] = [];
  topNoteIds: number[] = [];
  bottomNoteIds: number[] = [];
  stemUp: boolean | null = null;
  hasStem: boolean | null = null;
  allSameType: boolean | null = null;
  group: number | null = null;
  track: number | null = null;
  get xCenter(): number {
    return (this.bbox[0] + this.bbox[2]) / 2;
  }
}

/** numpy slice bounds for a[start:stop] on an axis of length n. */
function npSlice(start: number, stop: number, n: number): [number, number] {
  const norm = (v: number) => (v < 0 ? Math.max(0, v + n) : Math.min(v, n));
  const a = norm(start);
  const b = norm(stop);
  return [a, Math.max(a, b)];
}

/** register_note_id (ete.py): a per-pixel map of note ids over each note's symbol pixels. */
export function registerNoteId(ctx: OemerContext, notes: NoteHead[]): Int32Array {
  const { width: w, height: h } = ctx;
  const map = new Int32Array(w * h).fill(-1);
  const sym = ctx.symbolsPred.data;
  notes.forEach((n, idx) => {
    const [x1, y1, x2, y2] = n.bbox;
    const [ya, yb] = npSlice(y1, y2, h);
    const [xa, xb] = npSlice(x1, x2, w);
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) if (sym[y * w + x] > 0) map[y * w + x] = idx;
    n.id = idx;
  });
  return map;
}

/** A label raster whose labels can be renamed cheaply (oemer does `arr[arr == a] = b` on the whole image). */
class LabelMap {
  readonly alias: Int32Array;
  private readonly box: Int32Array; // per raw label: minX, minY, maxX, maxY
  constructor(
    readonly raw: Int32Array,
    count: number,
    readonly width: number,
  ) {
    this.alias = new Int32Array(count + 1);
    for (let i = 0; i <= count; i++) this.alias[i] = i;
    this.box = new Int32Array((count + 1) * 4);
    for (let l = 0; l <= count; l++) this.box.set([Infinity, Infinity, -1, -1].map((v) => (v === Infinity ? 2 ** 30 : v)), l * 4);
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i];
      const x = i % width;
      const y = (i - x) / width;
      const o = l * 4;
      if (x < this.box[o]) this.box[o] = x;
      if (y < this.box[o + 1]) this.box[o + 1] = y;
      if (x > this.box[o + 2]) this.box[o + 2] = x;
      if (y > this.box[o + 3]) this.box[o + 3] = y;
    }
  }
  at(i: number): number {
    return this.alias[this.raw[i]];
  }
  rename(from: number, to: number): void {
    if (from === to) return;
    for (let v = 0; v < this.alias.length; v++) if (this.alias[v] === from) this.alias[v] = to;
  }
  /** np.where(map == g) → (min x, min y, max x, max y), or null if absent. */
  bboxOf(g: number): BBox | null {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (let v = 1; v < this.alias.length; v++) {
      if (this.alias[v] !== g || this.box[v * 4 + 2] < 0) continue;
      const o = v * 4;
      x1 = Math.min(x1, this.box[o]);
      y1 = Math.min(y1, this.box[o + 1]);
      x2 = Math.max(x2, this.box[o + 2]);
      y2 = Math.max(y2, this.box[o + 3]);
    }
    return x1 === Infinity ? null : [x1, y1, x2, y2];
  }
  uniqueIn(ya: number, yb: number, xa: number, xb: number): number[] {
    const s = new Set<number>();
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) s.add(this.at(y * this.width + x));
    return [...s].sort((a, b) => a - b);
  }
}

function groupNoteheads(ctx: OemerContext, noteIdMap: Int32Array): { groups: Map<number, number[]>; map: LabelMap } {
  const { width: w, height: h } = ctx;
  const ext = dilate(ctx.stemsRestsPred, rectKernel(3, 2));
  const mix = new Uint8Array(w * h);
  for (let i = 0; i < mix.length; i++) mix[i] = ctx.noteheadPred.data[i] || ext.data[i] ? 1 : 0;
  const { labels, count } = label4({ width: w, height: h, data: mix });
  const map = new LabelMap(labels, count, w);

  // bounding box of each note id in the note-id map
  const idBox = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < noteIdMap.length; i++) {
    const id = noteIdMap[i];
    if (id < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = idBox.get(id);
    if (!b) idBox.set(id, [x, y, x, y]);
    else {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  const nids = new PySet([...new Set([-1, ...idBox.keys()])].sort((a, b) => a - b));
  nids.discard(-1);
  const groups = new Map<number, number[]>();
  for (const nid of nids.values()) {
    const [minX, minY, maxX, maxY] = idBox.get(nid)!;
    const [ya, yb] = npSlice(minY - 3, maxY + 3, h);
    const [xa, xb] = npSlice(minX, maxX, w);
    const labelsSet = new PySet(map.uniqueIn(ya, yb, xa, xb));
    labelsSet.discard(0);
    if (labelsSet.size === 0) continue;
    let label: number;
    if (labelsSet.size > 1) {
      const inter = labelsSet.intersection(new PySet(groups.keys()));
      if (inter.size === 0) label = labelsSet.pop();
      else if (inter.size === 1) label = inter.pop();
      else {
        label = inter.pop();
        const tmp = groups.get(label)!;
        for (const k of inter.values()) {
          tmp.push(...groups.get(k)!);
          groups.delete(k);
        }
        groups.set(label, tmp);
      }
      for (const ll of labelsSet.values()) map.rename(ll, label);
    } else label = labelsSet.pop();
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(nid);
  }
  // labels that ended up without notes are cleared
  const keep = new Set(groups.keys());
  const present = new Set<number>();
  for (let v = 0; v < map.alias.length; v++) present.add(map.alias[v]);
  for (const ll of present) if (ll !== 0 && !keep.has(ll)) map.rename(ll, 0);
  return { groups, map };
}

function possibleNearbyGid(note: NoteHead, map: LabelMap, flat: Staff[], w: number, scanRangeRatio = 5): number | null {
  const b = note.bbox;
  const [cx, cy] = getCenter(b);
  const curGid = map.at(cy * w + cx);
  const unit = getUnitSize(flat, cx, cy);
  const bw = b[2] - b[0] + 4;
  const startX = b[0] - pyRound(bw / 2);
  const endX = Math.min(startX + bw, w);
  const [xa, xb] = npSlice(Math.trunc(startX), Math.trunc(endX), w);
  const search = (curY: number, yBound: number, step: number): [number, number] | null => {
    for (;;) {
      if (step > 0 && curY >= yBound) break;
      if (step < 0 && curY < yBound) break;
      const row = Math.trunc(curY);
      const counts = new Map<number, number>();
      for (let x = xa; x < xb; x++) {
        const v = map.at(row * w + x);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const gids = new PySet([...counts.keys()].sort((a, c) => a - c));
      gids.discard(0);
      gids.discard(curGid);
      if (gids.size > 0) {
        if (gids.size > 1) {
          const reg = gids.values().map((g) => ({ g, n: counts.get(g)! }));
          const sorted = reg.map((r, i) => ({ ...r, i })).sort((a, c) => a.n - c.n || a.i - c.i);
          return [sorted[sorted.length - 1].g, curY];
        }
        return [gids.pop(), curY];
      }
      curY += step;
    }
    return null;
  };
  const [st1, st2] = findClosestStaffs(flat, cx, cy);
  const yUpper = Math.min(st1.yUpper, st2.yUpper);
  const yLower = Math.max(st1.yLower, st2.yLower);
  let curY = b[1] - 1;
  const top = search(curY, Math.max(curY - scanRangeRatio * unit, yUpper), -1);
  curY = b[3] + 1;
  const bottom = search(curY, Math.min(curY + scanRangeRatio * unit, yLower), 1);
  if (top && bottom) return Math.abs(cy - top[1]) < Math.abs(cy - bottom[1]) ? top[0] : bottom[0];
  if (top) return top[0];
  if (bottom) return bottom[0];
  return null;
}

function checkValidNewGroup(ori: number, tar: number | null, map: LabelMap, flat: Staff[], maxXDiffRatio = 0.5): boolean {
  if (tar === null) return true;
  const ob = map.bboxOf(ori)!;
  const tb = map.bboxOf(tar)!;
  const [ox, oy] = getCenter(ob);
  const [tx] = getCenter(tb);
  return Math.abs(tx - ox) < getUnitSize(flat, ox, oy) * maxXDiffRatio;
}

function noteBox(notes: NoteHead[], nids: number[]): BBox {
  return [
    Math.min(...nids.map((n) => notes[n].bbox[0])),
    Math.min(...nids.map((n) => notes[n].bbox[1])),
    Math.max(...nids.map((n) => notes[n].bbox[2])),
    Math.max(...nids.map((n) => notes[n].bbox[3])),
  ];
}

function parseStemDirection(groups: Map<number, number[]>, map: LabelMap, notes: NoteHead[], flat: Staff[], w: number, toleranceRatio = 0.2, maxXDiffRatio = 0.5): Map<number, number[]> {
  const temp = new Map<number, boolean>();
  for (const [gp, nids] of groups) {
    const gbox = map.bboxOf(gp)!;
    const nbox = noteBox(notes, nids);
    const nh = mean(nids.map((n) => notes[n].bbox[3] - notes[n].bbox[1]));
    const tol = nh * toleranceRatio;
    const higher = gbox[1] < nbox[1] - tol;
    const lower = gbox[3] > nbox[3] + tol;
    if (higher && !lower) {
      temp.set(gp, true);
      for (const n of nids) notes[n].stemUp = true;
      continue;
    }
    if (!higher && lower) {
      temp.set(gp, false);
      for (const n of nids) notes[n].stemUp = false;
      continue;
    }
    if (nids.length === 1) {
      const nid = nids[0];
      const ng = possibleNearbyGid(notes[nid], map, flat, w);
      if (ng !== null && checkValidNewGroup(gp, ng, map, flat, maxXDiffRatio)) {
        if (temp.has(ng)) notes[nid].stemUp = temp.get(ng)!;
        map.rename(gp, ng);
        groups.get(ng)!.push(nid);
        const list = groups.get(gp)!;
        list.splice(list.indexOf(nid), 1);
      }
    }
  }
  return new Map([...groups].filter(([, v]) => v.length > 0));
}

function genGroups(groups: Map<number, number[]>, map: LabelMap, notes: NoteHead[], flat: Staff[], n: number): { groups: NoteGroup[]; groupMap: Int32Array } {
  const out: NoteGroup[] = [];
  const idxOf = new Map<number, number>();
  let idx = 0;
  for (const [gid, nids] of groups) {
    const ng = new NoteGroup();
    ng.id = idx;
    ng.noteIds = nids;
    const gbox = map.bboxOf(gid)!;
    const nbox = noteBox(notes, nids);
    ng.bbox = gbox;
    for (const nid of nids) notes[nid].noteGroupId = idx;
    const first = notes[nids[0]];
    if (first.stemUp === null) {
      const nh = mean(nids.map((x) => notes[x].bbox[3] - notes[x].bbox[1]));
      ng.hasStem = Math.abs(gbox[3] - gbox[1] - (nbox[3] - nbox[1])) > Math.floor(nh / 5);
    } else {
      ng.stemUp = first.stemUp;
      ng.hasStem = true;
    }
    const types = nids.map((x) => notes[x].label);
    ng.allSameType = types.every((t) => t === types[0]);
    let track = first.track;
    let group = first.group;
    const same = nids.every((x) => notes[x].track === track) && nids.every((x) => notes[x].group === group);
    if (!same) {
      const [st] = findClosestStaffs(flat, (gbox[0] + gbox[2]) / 2, (gbox[1] + gbox[3]) / 2);
      track = st.track;
      group = st.group;
      for (const x of nids) {
        notes[x].track = st.track;
        notes[x].group = st.group;
      }
    }
    ng.track = track;
    ng.group = group;
    idxOf.set(gid, idx);
    out.push(ng);
    idx++;
  }
  const groupMap = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const g = map.at(i);
    const k = idxOf.get(g);
    if (k !== undefined) groupMap[i] = k;
  }
  return { groups: out, groupMap };
}

export interface NoteGroupResult {
  groups: NoteGroup[];
  /** Per pixel: note-group index, or -1. */
  groupMap: Int32Array;
  noteIdMap: Int32Array;
}

export function extractNoteGroups(ctx: OemerContext, notes: NoteHead[], staffs: Staff[][]): NoteGroupResult {
  const flat = staffs.flat();
  const noteIdMap = registerNoteId(ctx, notes);
  const { groups, map } = groupNoteheads(ctx, noteIdMap);
  const parsed = parseStemDirection(groups, map, notes, flat, ctx.width);
  const res = genGroups(parsed, map, notes, flat, ctx.width * ctx.height);
  return { ...res, noteIdMap };
}
