// Compares the notehead-extraction port with oemer's own output on the Aura Lee page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractNoteheads, NoteType } from '../src/omr/oemer/notehead';
import { extractStaffs } from '../src/omr/oemer/staffline';
import { loadContext } from './omr-staffline.test';

const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'omr', 'reference.json'), 'utf8'));

describe('oemer notehead extraction port', () => {
  const ctx = loadContext();
  const { staffs, zones } = extractStaffs(ctx);
  const notes = extractNoteheads(ctx, staffs, zones);

  it('finds the same noteheads in the same order', () => {
    const expected = ref.notes_after_extract;
    expect(notes.map((n) => n.bbox)).toEqual(expected.map((e: { bbox: number[] }) => e.bbox));
    notes.forEach((n, i) => {
      const e = expected[i];
      const where = `note ${i} ${JSON.stringify(e.bbox)}`;
      expect(n.points, where).toBe(e.points);
      expect(n.track, where).toBe(e.track);
      expect(n.group, where).toBe(e.group);
      expect(n.staffLinePos, where).toBe(e.staff_line_pos);
      expect(n.stemRight, where).toBe(e.stem_right);
      expect(n.rawLabel === null ? null : NoteType[n.rawLabel], where).toBe(e.label);
    });
  });
});
