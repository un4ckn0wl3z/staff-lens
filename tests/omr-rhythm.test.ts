// Compares the rhythm-extraction port (dots, beams, flags → note values) with oemer's own output.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractNoteGroups } from '../src/omr/oemer/noteGroup';
import { extractNoteheads, NoteType } from '../src/omr/oemer/notehead';
import { extractRhythm } from '../src/omr/oemer/rhythm';
import { extractStaffs } from '../src/omr/oemer/staffline';
import { extractSymbols } from '../src/omr/oemer/symbols';
import { loadContext } from './omr-staffline.test';
import { loadSvm } from './omr-symbols.test';

const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'omr', 'reference.json'), 'utf8'));

describe('oemer rhythm port', () => {
  const ctx = loadContext();
  const { staffs, zones } = extractStaffs(ctx);
  const notes = extractNoteheads(ctx, staffs, zones);
  const { groups, groupMap, noteIdMap } = extractNoteGroups(ctx, notes, staffs);
  const sym = extractSymbols(ctx, loadSvm(), staffs, zones, notes, groupMap, noteIdMap);
  extractRhythm(ctx, staffs, notes, groups, groupMap, noteIdMap, sym.barlines);

  it('gives every note the same value, dot, stem and validity as oemer', () => {
    expect(notes.length).toBe(ref.notes.length);
    notes.forEach((n, i) => {
      const e = ref.notes[i];
      const where = `note ${i} ${JSON.stringify(e.bbox)}`;
      expect(n.rawLabel === null ? null : NoteType[n.rawLabel], where).toBe(e.label);
      expect(n.hasDot, where).toBe(e.has_dot);
      expect(n.stemUp, where).toBe(e.stem_up);
      expect(n.invalid, where).toBe(e.invalid);
      expect(n.noteGroupId, where).toBe(e.note_group_id);
      expect(n.sfn === null ? null : n.sfn, where).toBe(e.sfn);
    });
  });

  it('fills top/bottom note ids of groups like oemer', () => {
    groups.forEach((g, i) => {
      const e = ref.groups_after_rhythm[i];
      expect([g.topNoteIds, g.bottomNoteIds], `group ${i}`).toEqual([e.top_note_ids, e.bottom_note_ids]);
    });
  });
});
