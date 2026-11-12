// Port of oemer/utils.py and oemer/bbox.py helpers (oemer 0.1.8, MIT).

import { findContourBoxes, type BBox, type Raster } from './cv';
import { PySet, wardClusterLabels } from './pyport';
import type { Staff } from './staffline';

export const getBbox = (data: Raster): BBox[] => findContourBoxes(data);

/** Staff - [x, y]: Euclidean distance between the staff centre and a point. */
const staffDist = (st: Staff, x: number, y: number) => Math.sqrt((x - st.xCenter) ** 2 + (y - st.yCenter) ** 2);

/** find_closest_staffs: the closest staff and its neighbour on the side of the point. */
export function findClosestStaffs(flat: Staff[], x: number, y: number): [Staff, Staff] {
  const diffs = flat
    .map((st, i) => ({ st, d: staffDist(st, x, y), i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.st);
  if (diffs.length === 1) return [diffs[0], diffs[0]];
  if (diffs.length === 2) return [diffs[0], diffs[1]];
  const [first, second, third] = diffs;
  if (Math.abs(first.yLower - y) <= Math.abs(first.yUpper - y)) {
    if (second.yCenter > first.yCenter) return [first, second];
    if (third.yCenter > first.yCenter) return [first, third];
    return [first, first];
  }
  if (second.yCenter < first.yCenter) return [first, second];
  if (third.yCenter < first.yCenter) return [first, third];
  return [first, first];
}

export function getUnitSize(flat: Staff[], x: number, y: number): number {
  const [st1, st2] = findClosestStaffs(flat, x, y);
  if (st1.yCenter === st2.yCenter) return st1.unitSize;
  if (st1.yUpper <= y && y <= st1.yLower) return st1.unitSize;
  const d1 = Math.abs(y - st1.yCenter);
  const d2 = Math.abs(y - st2.yCenter);
  return (d1 / (d1 + d2)) * st1.unitSize + (d2 / (d1 + d2)) * st2.unitSize;
}

/** Python sum(list) / len(list) (sequential summation). */
export function getGlobalUnitSize(flat: Staff[]): number {
  let s = 0;
  for (const st of flat) s += st.unitSize;
  return s / flat.length;
}

/** merge_nearby_bbox: Ward-cluster box centres, merge each cluster into one box. */
export function mergeNearbyBbox(boxes: BBox[], distance: number, xFactor = 1, yFactor = 1): BBox[] {
  if (boxes.length === 0) return [];
  const centers = boxes.map((b) => [((b[0] + b[2]) / 2) * xFactor, ((b[1] + b[3]) / 2) * yFactor] as [number, number]);
  const labels = wardClusterLabels(centers, distance);
  const uniq = [...new Set(labels)].sort((a, b) => a - b);
  return uniq.map((label) => {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    labels.forEach((l, i) => {
      if (l !== label) return;
      const b = boxes[i];
      x1 = Math.min(x1, b[0], b[2]);
      x2 = Math.max(x2, b[0], b[2]);
      y1 = Math.min(y1, b[1], b[3]);
      y2 = Math.max(y2, b[1], b[3]);
    });
    return [x1, y1, x2, y2] as BBox;
  });
}

/** rm_merge_overlap_bbox: drop (or merge) boxes overlapping a larger box by more than `overlapRatio`. */
export function rmMergeOverlapBbox(boxes: BBox[], mode: 'remove' | 'merge' = 'remove', overlapRatio = 0.5): BBox[] {
  if (boxes.length === 0) return [];
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  const mask = new Uint16Array(maxX * maxY);
  const infos = boxes
    .map((bbox) => ({ bbox, area: (bbox[3] - bbox[1]) * (bbox[2] - bbox[0]) }))
    .map((info, i) => ({ ...info, i }))
    .sort((a, b) => b.area - a.area || a.i - b.i);
  const records = new Map<number, { bbox: BBox; area: number }>();
  const paint = (b: BBox, v: number) => {
    for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) mask[y * maxX + x] = v;
  };
  infos.forEach((info, idx) => {
    const b = info.bbox;
    const counts = new Map<number, number>();
    for (let y = b[1]; y < b[3]; y++)
      for (let x = b[0]; x < b[2]; x++) {
        const v = mask[y * maxX + x];
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    if (counts.size === 0) {
      records.set(idx + 1, { bbox: b, area: info.area });
      paint(b, idx + 1);
      return;
    }
    let valid = true;
    // iterate like `set(np.unique(region)) - {0}` in CPython
    for (const val of new PySet([...counts.keys()].sort((a, c) => a - c)).values()) {
      const tar = records.get(val)!;
      const ratio = counts.get(val)! / info.area;
      if (ratio > overlapRatio) {
        if (mode === 'merge') {
          const t = tar.bbox;
          tar.bbox = [Math.min(b[0], t[0]), Math.min(b[1], t[1]), Math.max(b[2], t[2]), Math.max(b[3], t[3])];
        }
        valid = false;
        break;
      }
    }
    if (valid) {
      records.set(idx + 1, { bbox: b, area: info.area });
      paint(b, idx + 1);
    }
  });
  return [...records.values()].map((r) => r.bbox);
}

/** general_filtering_rules.filter_out_of_range_bbox: keep boxes whose centre x lies within the zones. */
export function filterOutOfRangeBbox<T extends BBox>(boxes: T[], minX: number, maxX: number): T[] {
  return boxes.filter((b) => {
    const cx = pyRoundLocal((b[0] + b[2]) / 2);
    return !(cx > maxX || cx < minX);
  });
}

/** general_filtering_rules.filter_out_small_area with an area function of the local unit size. */
export function filterOutSmallArea(boxes: BBox[], flat: Staff[], areaOf: (unit: number) => number): BBox[] {
  return boxes.filter((b) => {
    const [cx, cy] = [pyRoundLocal((b[0] + b[2]) / 2), pyRoundLocal((b[1] + b[3]) / 2)];
    return (b[2] - b[0]) * (b[3] - b[1]) > areaOf(getUnitSize(flat, cx, cy));
  });
}

function pyRoundLocal(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
