// Port of oemer/rhythm_extraction.py (oemer 0.1.8, MIT): dots, beams and flags → note values.

import { dilate, ellipseKernel, erode, findContours, label4, morphClose, morphOpen, raster, rectKernel, type BBox, type Raster } from './cv';
import { pyRound, type OemerContext } from './context';
import type { NoteGroup } from './noteGroup';
import { NoteType, type NoteHead } from './notehead';
import { PySet } from './pyport';
import { contourArea, fillPoly, minAreaRect, type Pt } from './rotated';
import { getCenter, type Staff } from './staffline';
import type { Barline } from './symbols';
import { getUnitSize } from './utils';

/** numpy slice bounds a[start:stop] for an axis of length n. */
function npSlice(start: number, stop: number, n: number): [number, number] {
  const norm = (v: number) => (v < 0 ? Math.max(0, v + n) : Math.min(v, n));
  const a = norm(start);
  return [a, Math.max(a, norm(stop))];
}

// ------------------------------------------------------------------ dots

function scanDot(noStem: Raster, noteIdMap: Int32Array, bbox: BBox, unit: number, minCount: number, maxCount: number): boolean {
  const { width: w, height: h } = noStem;
  let right = bbox[2] + 1;
  const startY = bbox[1] - pyRound(unit / 2);
  for (;;) {
    const col = Math.trunc(right);
    if (col >= w || col < -w) break; // numpy IndexError
    const c = col < 0 ? col + w : col;
    const [ya, yb] = npSlice(Math.trunc(startY), Math.trunc(bbox[3]), h);
    let found = false;
    for (let y = ya; y < yb; y++) if (noteIdMap[y * w + c] !== -1) found = true;
    if (found) break;
    right++;
    if (right >= bbox[2] + unit) break;
  }
  const left = bbox[2] + pyRound(unit * 0.4);
  const [ya, yb] = npSlice(Math.trunc(startY), Math.trunc(bbox[3]), h);
  const [xa, xb] = npSlice(Math.trunc(left), Math.trunc(right), w);
  let pixels = 0;
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) pixels += noStem.data[y * w + x];
  return minCount <= pixels && pixels <= maxCount;
}

function parseDot(ctx: OemerContext, groups: NoteGroup[], notes: NoteHead[], noteIdMap: Int32Array, flat: Staff[], minAreaRatio = 0.08, maxAreaRatio = 0.2): void {
  const { width: w, height: h } = ctx;
  let noStem = raster(w, h);
  for (let i = 0; i < w * h; i++) noStem.data[i] = ctx.symbolsPred.data[i] - ctx.stemsRestsPred.data[i] - ctx.clefsKeysPred.data[i] > 0 ? 1 : 0;
  const ker = ellipseKernel(4, 4);
  noStem = dilate(erode(noStem, ker), ker);
  for (const g of groups) {
    const gbox = g.bbox;
    const unit = getUnitSize(flat, ...getCenter(gbox));
    const minCount = pyRound(unit ** 2 * minAreaRatio);
    const maxCount = pyRound(unit ** 2 * maxAreaRatio);
    const dots: boolean[] = [];
    for (const nid of g.noteIds) {
      const b = notes[nid].bbox;
      const d = scanDot(noStem, noteIdMap, [b[0], b[1], Math.max(b[2], gbox[2]), b[3]], unit, minCount, maxCount);
      dots.push(d);
      notes[nid].hasDot = d;
    }
    const all = dots.every(Boolean);
    const any = dots.some(Boolean);
    const allSame = !(all !== any);
    if (g.stemUp !== null && !allSame) {
      const t = dots.filter(Boolean).length;
      const toDot = t >= dots.length - t;
      for (const nid of g.noteIds) notes[nid].hasDot = toDot;
    }
  }
}

// ------------------------------------------------------------------ beams

function parseBeams(ctx: OemerContext, groupMap: Int32Array, flat: Staff[], minAreaRatio = 0.07, minTpRatio = 0.4, minWidthRatio = 0.2): Raster {
  const { width: w, height: h } = ctx;
  const n = w * h;
  const gp = (i: number) => (groupMap[i] > -1 ? 1 : 0);
  // polish_symbols
  const beamsInStaff = morphOpen(ctx.staffPred, rectKernel(5, 1));
  let mix = raster(w, h);
  for (let i = 0; i < n; i++) {
    const v = ctx.symbolsPred.data[i] + beamsInStaff.data[i] - gp(i) - ctx.stemsRestsPred.data[i] - ctx.clefsKeysPred.data[i];
    mix.data[i] = v > 0 ? 1 : 0;
  }
  mix = morphOpen(mix, rectKernel(2, 3));
  const extStems = morphClose(ctx.stemsRestsPred, rectKernel(5, 1));
  const beams = raster(w, h);
  for (let i = 0; i < n; i++) {
    const b = Math.min(1, mix.data[i] + extStems.data[i] + gp(i));
    const v = b - gp(i) - ctx.stemsRestsPred.data[i];
    beams.data[i] = v > 0 ? v : 0;
  }
  // rotated boxes of beam candidates
  const black = Uint8Array.from(beams.data, (v) => (v > 0 ? 1 : 0)); // poly_map, 1 = black
  const scratch = raster(w, h);
  const valid: number[][] = [];
  for (const c of findContours(beams)) {
    const rb = minAreaRect(c.points);
    if (rb.corners.some(([x, y]) => x < 0 || y < 0)) continue;
    const cnt: Pt[] = rb.corners.map(([x, y]) => [Math.trunc(x), Math.trunc(y)]);
    const cx = (cnt[0][0] + cnt[1][0] + cnt[2][0] + cnt[3][0]) / 4;
    const cy = (cnt[0][1] + cnt[1][1] + cnt[2][1] + cnt[3][1]) / 4;
    const unit = getUnitSize(flat, pyRound(cx), pyRound(cy));
    const area = contourArea(cnt);
    // pixels of the filled polygon
    fillPoly(scratch, cnt, 1);
    const x0 = Math.max(0, Math.min(...cnt.map((p) => p[0])) - 1);
    const x1 = Math.min(w - 1, Math.max(...cnt.map((p) => p[0])) + 1);
    const y0 = Math.max(0, Math.min(...cnt.map((p) => p[1])) - 1);
    const y1 = Math.min(h - 1, Math.max(...cnt.map((p) => p[1])) + 1);
    const poly: number[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (scratch.data[y * w + x]) {
          poly.push(y * w + x);
          scratch.data[y * w + x] = 0;
        }
    if (area < unit ** 2 * minAreaRatio) {
      for (const i of poly) black[i] = 0;
      continue;
    }
    const meta = poly.filter((i) => beams.data[i] > 0);
    if (Math.min(...rb.size) < unit * minWidthRatio || meta.length / (poly.length + 1e-8) < minTpRatio) {
      for (const i of meta) black[i] = 0;
      continue;
    }
    valid.push(meta);
  }
  for (const meta of valid) for (const i of meta) black[i] = 1;
  return { width: w, height: h, data: black };
}

interface RegInfo {
  bbox: BBox;
  gids: Set<number>;
}

function parseBeamOverlapRegions(ctx: OemerContext, polyMap: Raster, groupMap: Int32Array, barlines: Barline[]): { outMap: Raster; mapInfo: Map<number, RegInfo> } {
  const { width: w, height: h } = ctx;
  const n = w * h;
  const k3 = rectKernel(3, 3);
  let mix = raster(w, h);
  for (let i = 0; i < n; i++) mix.data[i] = polyMap.data[i] + ctx.symbolsPred.data[i];
  mix = dilate(erode(mix, k3), k3);
  const poly = dilate(erode(polyMap, k3), k3);
  for (const bl of barlines) {
    const [x1, y1, x2, y2] = bl.bbox;
    for (let y = Math.max(0, y1); y < Math.min(h, y2); y++)
      for (let x = Math.max(0, x1); x < Math.min(w, x2); x++) {
        mix.data[y * w + x] = 0;
        poly.data[y * w + x] = 0;
      }
  }
  for (let i = 0; i < n; i++) if (mix.data[i] > 1) mix.data[i] = 1;
  const reg = label4(poly);
  const sym = label4(mix);
  // per symbol label: bbox and the note groups it touches
  const symBox = new Map<number, BBox>();
  const symGids = new Map<number, Set<number>>();
  const regSyms = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const s = sym.labels[i];
    if (s) {
      const x = i % w;
      const y = (i - x) / w;
      const b = symBox.get(s);
      if (!b) symBox.set(s, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
      const g = groupMap[i];
      if (g !== -1) {
        let set = symGids.get(s);
        if (!set) symGids.set(s, (set = new Set()));
        set.add(g);
      }
    }
    const r = reg.labels[i];
    if (r) {
      let set = regSyms.get(r);
      if (!set) regSyms.set(r, (set = new Set()));
      set.add(s);
    }
  }
  const outMap = raster(w, h);
  const mapInfo = new Map<number, RegInfo>();
  const keepReg = new Uint8Array(reg.count + 1);
  for (let idx = 1; idx <= reg.count; idx++) {
    const labels = new PySet([...(regSyms.get(idx) ?? [])].sort((a, b) => a - b));
    labels.discard(0);
    const gids = new Set<number>();
    let box: BBox | null = null;
    for (const l of labels) {
      for (const g of symGids.get(l) ?? []) gids.add(g);
      const b = symBox.get(l)!;
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b];
    }
    if (gids.size === 0 || !box) continue;
    keepReg[idx] = 1;
    for (const l of labels.values()) {
      const prev = mapInfo.get(l);
      if (prev) {
        for (const g of prev.gids) gids.add(g);
        const bb = prev.bbox;
        box = [Math.min(bb[0], box[0]), Math.min(bb[1], box[1]), Math.max(bb[2], box[2]), Math.max(bb[3], box[3])];
      }
      mapInfo.set(l, { bbox: box, gids }); // the same gids set is shared, as in oemer
    }
  }
  for (let i = 0; i < n; i++) if (keepReg[reg.labels[i]] && reg.labels[i]) outMap.data[i] = 1;
  return { outMap: erode(dilate(outMap, k3), k3), mapInfo };
}

function refineMapInfo(mapInfo: Map<number, RegInfo>, groups: NoteGroup[], groupMap: Int32Array, w: number, h: number): Map<number, RegInfo> {
  const out = new Map<number, RegInfo>();
  const rev = new Map<number, number>();
  for (const [reg, info] of mapInfo) {
    const boxes = [...[...info.gids].map((g) => groups[g].bbox), info.bbox];
    const bbox: BBox = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    out.set(reg, { bbox, gids: new Set() });
    const [ya, yb] = npSlice(bbox[1], bbox[3], h);
    const [xa, xb] = npSlice(bbox[0], bbox[2], w);
    const present = new Set<number>();
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) present.add(groupMap[y * w + x]);
    const gids = new PySet([...present].sort((a, b) => a - b));
    gids.discard(-1);
    for (const gid of gids.values()) {
      if (!rev.has(gid)) {
        out.get(reg)!.gids.add(gid);
        rev.set(gid, reg);
        continue;
      }
      const ori = rev.get(gid)!;
      if (ori === reg) continue;
      const o = out.get(ori)!;
      const nb: BBox = [Math.min(o.bbox[0], bbox[0]), Math.min(o.bbox[1], bbox[1]), Math.max(o.bbox[2], bbox[2]), Math.max(o.bbox[3], bbox[3])];
      o.gids.add(gid);
      for (const g of o.gids) out.get(reg)!.gids.add(g);
      out.get(reg)!.bbox = nb;
      rev.set(gid, reg);
      out.delete(ori);
      for (const g of o.gids) rev.set(g, reg);
    }
  }
  return out;
}

// ------------------------------------------------------------------ beam / flag counting

function scanBeamFlag(poly: Raster, flat: Staff[], sx: number, sy: number, ex: number, ey: number, threshold = 0.1, minWidthRatio = 0.25, maxWidthRatio = 0.9): number {
  const { width: w } = poly;
  let startX = Math.trunc(sx);
  let startY = Math.trunc(sy);
  const endX = Math.trunc(ex);
  let endY = Math.trunc(ey);
  const counter = new Array<number>(Math.max(0, endX - startX)).fill(0);
  if (endY < startY) [startY, endY] = [endY, startY];
  const unit = getUnitSize(flat, startX, startY);
  const minWidth = unit * minWidthRatio;
  const maxWidth = unit * maxWidthRatio;
  const at = (y: number, x: number) => poly.data[y * w + x];
  // function-scope like Python: values persist between columns
  let hit = false;
  let width = 0;
  for (let idx = 0, x = startX; x < endX; idx++, x++) {
    let curY = startY;
    let lastVal = at(curY, x);
    while (curY < endY) {
      hit = false;
      width = 0;
      while (curY < endY) {
        const cur = at(curY, x);
        if (lastVal ^ cur) {
          hit = lastVal > cur;
          lastVal = cur;
          curY++;
          break;
        }
        curY++;
        width++;
      }
      if (hit && width >= minWidth) counter[idx] += Math.ceil(width / maxWidth);
    }
    if (lastVal === 1) counter[idx] += hit ? Math.ceil(width / maxWidth) : 1;
  }
  void startX;
  const stat = new Map<number, number>();
  for (const c of counter) stat.set(c, (stat.get(c) ?? 0) + 1);
  const sorted = [...stat].sort((a, b) => b[0] - a[0]);
  let accum = 0;
  const minNum = counter.length * threshold;
  for (const [c, num] of sorted) {
    accum += num;
    if (accum > minNum) return c;
  }
  return 0;
}

const NOTE_TYPE_MAP = [NoteType.QUARTER, NoteType.EIGHTH, NoteType.SIXTEENTH, NoteType.THIRTY_SECOND, NoteType.SIXTEENTH];

function stemX(gbox: BBox, nboxes: BBox[], unit: number, isRight: boolean): number {
  const allSameSide = nboxes.every((nb) => Math.abs(nb[2] - gbox[2]) < unit / 3);
  if (!allSameSide) return pyRound((gbox[0] + gbox[2]) / 2);
  return isRight ? gbox[2] : gbox[0];
}

function parseInnerGroups(poly: Raster, flat: Staff[], notes: NoteHead[], group: NoteGroup, setBox: BBox, halfScan: number, threshold: number): void {
  const nts = group.noteIds.map((id, i) => ({ n: notes[id], i })).sort((a, b) => b.n.staffLinePos - a.n.staffLinePos || a.i - b.i).map((e) => e.n);
  const getLabel = (nbox: BBox, up: boolean): NoteType => {
    const cx = up ? nbox[2] : nbox[0];
    const sy = up ? nbox[1] : nbox[3];
    const ey = up ? setBox[1] : setBox[3];
    const count = scanBeamFlag(poly, flat, Math.max(setBox[0], cx - halfScan), sy, Math.min(setBox[2], cx + halfScan), ey, threshold);
    return count >= NOTE_TYPE_MAP.length ? NOTE_TYPE_MAP[NOTE_TYPE_MAP.length - 1] : NOTE_TYPE_MAP[count];
  };
  if (nts.length === 2) {
    nts[0].forceSetLabel(getLabel(nts[0].bbox, true));
    nts[1].forceSetLabel(getLabel(nts[1].bbox, false));
    nts[0].stemUp = true;
    nts[1].stemUp = false;
    group.topNoteIds.push(nts[0].id!);
    group.bottomNoteIds.push(nts[1].id!);
  } else if (group.allSameType) {
    nts[0].label = getLabel(nts[0].bbox, true);
    nts[0].stemUp = true;
    group.topNoteIds.push(nts[0].id!);
    const bt = getLabel(nts[nts.length - 1].bbox, false);
    for (const nn of nts.slice(1)) {
      nn.label = bt;
      nn.stemUp = false;
      group.bottomNoteIds.push(nn.id!);
    }
  } else {
    let idx = 0;
    while (idx < nts.length && nts[0].label === nts[idx].label) idx++;
    if (nts[0].label === NoteType.HALF_OR_WHOLE) {
      for (const nn of nts.slice(0, idx)) {
        nn.forceSetLabel(NoteType.HALF);
        nn.stemUp = true;
        group.topNoteIds.push(nn.id!);
      }
      const bt = getLabel(nts[nts.length - 1].bbox, false);
      for (const nn of nts.slice(idx)) {
        nn.label = bt;
        nn.stemUp = false;
        group.bottomNoteIds.push(nn.id!);
      }
    } else {
      for (const nn of nts.slice(idx)) {
        nn.forceSetLabel(NoteType.HALF);
        nn.stemUp = false;
        group.bottomNoteIds.push(nn.id!);
      }
      const top = getLabel(nts[nts.length - 1].bbox, true);
      for (const nn of nts.slice(0, idx)) {
        nn.label = top;
        nn.stemUp = true;
        group.topNoteIds.push(nn.id!);
      }
    }
  }
}

function parseRhythm(beamMap: Raster, mapInfo: Map<number, RegInfo>, groups: NoteGroup[], notes: NoteHead[], flat: Staff[], agreeTh: number): void {
  const rev = new Map<number, { reg: number; bbox: BBox }>();
  for (const [reg, info] of mapInfo) for (const gid of info.gids) rev.set(gid, { reg, bbox: info.bbox });
  const bin: Raster = { width: beamMap.width, height: beamMap.height, data: Uint8Array.from(beamMap.data, (v) => (v > 0 ? 1 : 0)) };
  groups.forEach((group, gid) => {
    let gbox = group.bbox;
    const regBox = rev.get(gid)?.bbox ?? gbox;
    let unit = getUnitSize(flat, ...getCenter(gbox));
    const halfScan = pyRound(unit / 2);
    if (group.stemUp === null) {
      if (!group.hasStem) {
        for (const nid of group.noteIds) {
          if (notes[nid].label !== NoteType.HALF_OR_WHOLE) {
            notes[nid].invalid = true;
            continue;
          }
          notes[nid].forceSetLabel(NoteType.WHOLE);
        }
      } else parseInnerGroups(bin, flat, notes, group, regBox, halfScan, agreeTh);
      return;
    }
    // most common label (ties: first seen; oemer's order there depends on Python's hash seed)
    const counts = new Map<NoteType | null, number>();
    for (const nid of group.noteIds) counts.set(notes[nid].label, (counts.get(notes[nid].label) ?? 0) + 1);
    const label = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    if (label === NoteType.HALF_OR_WHOLE) {
      for (const nid of group.noteIds) notes[nid].forceSetLabel(NoteType.HALF);
      return;
    }
    if (!rev.has(gid)) {
      for (const nid of group.noteIds) notes[nid].label = NoteType.QUARTER;
      return;
    }
    gbox = [gbox[0], Math.min(gbox[1], regBox[1]), gbox[2], Math.max(gbox[3], regBox[3])];
    const nbox = group.noteIds.map((nid) => notes[nid].bbox);
    unit = getUnitSize(flat, ...getCenter(gbox));
    let cx: number;
    let sy: number;
    let ey: number;
    if (group.stemUp) {
      cx = stemX(gbox, nbox, unit, true);
      sy = Math.min(...nbox.map((b) => b[1]));
      ey = gbox[1];
    } else {
      cx = stemX(gbox, nbox, unit, false);
      sy = Math.max(...nbox.map((b) => b[3]));
      ey = gbox[3];
    }
    const count = scanBeamFlag(bin, flat, Math.max(regBox[0], cx - halfScan), sy, Math.min(regBox[2], cx + halfScan), ey, agreeTh);
    for (const nid of group.noteIds) {
      if (notes[nid].label === null) {
        if (count in NOTE_TYPE_MAP) notes[nid].label = NOTE_TYPE_MAP[count];
        else notes[nid].invalid = true;
      }
    }
  });
}

export function extractRhythm(
  ctx: OemerContext,
  staffs: Staff[][],
  notes: NoteHead[],
  groups: NoteGroup[],
  groupMap: Int32Array,
  noteIdMap: Int32Array,
  barlines: Barline[],
  opts: { dotMinAreaRatio?: number; dotMaxAreaRatio?: number; beamMinAreaRatio?: number; agreeTh?: number } = {},
): void {
  const { dotMinAreaRatio = 0.08, dotMaxAreaRatio = 0.2, beamMinAreaRatio = 0.07, agreeTh = 0.15 } = opts;
  const flat = staffs.flat();
  parseDot(ctx, groups, notes, noteIdMap, flat, dotMinAreaRatio, dotMaxAreaRatio);
  const polyMap = parseBeams(ctx, groupMap, flat, beamMinAreaRatio);
  const { outMap, mapInfo } = parseBeamOverlapRegions(ctx, polyMap, groupMap, barlines);
  const refined = refineMapInfo(mapInfo, groups, groupMap, ctx.width, ctx.height);
  parseRhythm(outMap, refined, groups, notes, flat, agreeTh);
}
