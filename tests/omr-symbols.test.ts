// Compares the symbol-extraction port (barlines, clefs, accidentals, rests) with oemer's own output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadSvmBundle } from '../src/omr/oemer/classifier';
import { extractNoteGroups } from '../src/omr/oemer/noteGroup';
import { extractNoteheads } from '../src/omr/oemer/notehead';
import { extractStaffs } from '../src/omr/oemer/staffline';
import { ClefType, extractSymbols, RestType, SfnType } from '../src/omr/oemer/symbols';
import { loadContext } from './omr-staffline.test';

const root = join(__dirname, '..');
const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'omr', 'reference.json'), 'utf8'));

export function loadSvm() {
  const meta = JSON.parse(readFileSync(join(root, 'public', 'omr', 'oemer-svm.json'), 'utf8'));
  return loadSvmBundle(meta, new Uint8Array(gunzipSync(readFileSync(join(root, 'public', 'omr', 'oemer-svm.bin.gz')))));
}

describe('oemer symbol-extraction port', () => {
  const ctx = loadContext();
  const { staffs, zones } = extractStaffs(ctx);
  const notes = extractNoteheads(ctx, staffs, zones);
  const { groupMap, noteIdMap } = extractNoteGroups(ctx, notes, staffs);
  const res = extractSymbols(ctx, loadSvm(), staffs, zones, notes, groupMap, noteIdMap);

  it('finds the same barlines', () => {
    expect(res.barlines.map((b) => [b.bbox, b.group])).toEqual(ref.barlines.map((b: { bbox: number[]; group: number }) => [b.bbox, b.group]));
  });
  it('finds the same clefs', () => {
    expect(res.clefs.map((c) => [c.bbox, c.track, c.group, ClefType[c.label]])).toEqual(
      ref.clefs.map((c: { bbox: number[]; track: number; group: number; label: string }) => [c.bbox, c.track, c.group, c.label]),
    );
  });
  it('finds the same sharps/flats/naturals', () => {
    expect(res.sfns.map((s) => [s.bbox, s.noteId, s.isKey, s.track, s.group, SfnType[s.label]])).toEqual(
      ref.sfns.map((s: { bbox: number[]; note_id: number | null; is_key: boolean | null; track: number; group: number; label: string }) => [s.bbox, s.note_id, s.is_key, s.track, s.group, s.label]),
    );
  });
  it('finds the same rests', () => {
    expect(res.rests.map((r) => [r.bbox, RestType[r.label], r.hasDot])).toEqual(ref.rests.map((r: { bbox: number[]; label: string; has_dot: boolean | null }) => [r.bbox, r.label, r.has_dot]));
  });
});
