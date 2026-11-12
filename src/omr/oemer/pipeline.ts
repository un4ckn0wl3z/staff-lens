// oemer post-processing pipeline: model maps → MusicXML (byte-identical to oemer 0.1.8 without dewarp).

import { buildMusicXml } from './builder';
import { loadSvmBundle, type SvmBundle, type SvmBundleJson } from './classifier';
import { mapsFromSegmentation, OemerContext } from './context';
import { extractNoteGroups } from './noteGroup';
import { extractNoteheads } from './notehead';
import { extractRhythm } from './rhythm';
import { extractStaffs } from './staffline';
import { extractSymbols } from './symbols';

export interface PostprocessResult {
  musicxml: string;
  notes: number;
  bars: number;
  staves: number;
}

export function runPostprocess(width: number, height: number, maps: Uint8Array[], svm: SvmBundle, title: string, onStage?: (stage: string) => void): PostprocessResult {
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
  onStage?.('build');
  const musicxml = buildMusicXml({ staffs, notes, groups, ...sym }, title);
  return {
    musicxml,
    notes: (musicxml.match(/<note>/g) ?? []).length,
    bars: (musicxml.match(/<measure /g) ?? []).length,
    staves: staffs[0]?.length ?? 0,
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
