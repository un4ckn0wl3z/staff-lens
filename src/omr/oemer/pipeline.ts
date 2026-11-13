// oemer post-processing pipeline: model maps → MusicXML (byte-identical to oemer 0.1.8 without dewarp when
// `refine` is off; with it, StaffLens's corrections in ../refine.ts run before the MusicXML is written).

import { buildMusicXml, type TimelineEntry } from './builder';
import { loadSvmBundle, type SvmBundle, type SvmBundleJson } from './classifier';
import { mapsFromSegmentation, OemerContext } from './context';
import { extractNoteGroups } from './noteGroup';
import { extractNoteheads } from './notehead';
import { extractRhythm } from './rhythm';
import { extractStaffs } from './staffline';
import { extractSymbols } from './symbols';
import { refine as refineSymbols, type RefineReport } from '../refine';

export interface SystemLayout {
  group: number;
  /** Top of the system's first staff, page-image pixels. */
  top: number;
  left: number;
  right: number;
  unit: number;
}

export interface PostprocessResult {
  musicxml: string;
  timeline: TimelineEntry[];
  systems: SystemLayout[];
  notes: number;
  bars: number;
  staves: number;
  /** What the refinement changed (null when it did not run). */
  refined: RefineReport | null;
}

export function runPostprocess(
  width: number,
  height: number,
  maps: Uint8Array[],
  svm: SvmBundle,
  title: string,
  onStage?: (stage: string) => void,
  opts: { refine?: boolean } = {},
): PostprocessResult {
  const ctx = new OemerContext(mapsFromSegmentation(width, height, maps[0], maps[1]));
  onStage?.('staffs');
  const { staffs, zones } = extractStaffs(ctx);
  onStage?.('noteheads');
  const notes = extractNoteheads(ctx, staffs, zones);
  onStage?.('groups');
  const { groups, groupMap, noteIdMap } = extractNoteGroups(ctx, notes, staffs);
  onStage?.('symbols');
  const sym = extractSymbols(ctx, svm, staffs, zones, notes, groupMap, noteIdMap);
  onStage?.('rhythm');
  extractRhythm(ctx, staffs, notes, groups, groupMap, noteIdMap, sym.barlines);
  const refined = opts.refine === false ? null : refineSymbols(ctx, staffs, notes, groups, groupMap, sym);
  onStage?.('build');
  const timeline: TimelineEntry[] = [];
  const musicxml = buildMusicXml({ staffs, notes, groups, ...sym }, title, 90, timeline);
  const systems = new Map<number, SystemLayout>();
  for (const st of staffs.flat()) {
    if (st.group === null) continue;
    const s = systems.get(st.group);
    if (!s) systems.set(st.group, { group: st.group, top: st.yUpper, left: st.xLeft, right: st.xRight, unit: st.unitSize });
    else {
      s.top = Math.min(s.top, st.yUpper);
      s.left = Math.min(s.left, st.xLeft);
      s.right = Math.max(s.right, st.xRight);
    }
  }
  return {
    musicxml,
    timeline,
    systems: [...systems.values()].sort((a, c) => a.group - c.group),
    notes: (musicxml.match(/<note>/g) ?? []).length,
    bars: (musicxml.match(/<measure /g) ?? []).length,
    staves: staffs[0]?.length ?? 0,
    refined,
  };
}

/** Loads oemer's SVM classifiers exported to `${base}omr/`. */
export async function fetchSvmBundle(base: string): Promise<SvmBundle> {
  const [meta, bin] = await Promise.all([
    fetch(`${base}omr/oemer-svm.json`).then((r) => {
      if (!r.ok) throw new Error(`classifiers not found (${r.status})`);
      return r.json() as Promise<SvmBundleJson>;
    }),
    fetch(`${base}omr/oemer-svm.bin.gz`).then(async (r) => {
      if (!r.ok) throw new Error(`classifiers not found (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  ]);
  // Some servers send .gz files with Content-Encoding: gzip (already unpacked by the browser), others as-is.
  const expected = Object.values(meta.models).reduce((n, m) => n + m.svCount * m.features, 0);
  let data = bin;
  if (bin.length !== expected) {
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    data = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (data.length !== expected) throw new Error('classifier data is incomplete');
  return loadSvmBundle(meta, data);
}
