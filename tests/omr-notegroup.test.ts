// Compares the note-group port with oemer's own output on the Aura Lee page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractNoteGroups } from '../src/omr/oemer/noteGroup';
import { extractNoteheads } from '../src/omr/oemer/notehead';
import { extractStaffs } from '../src/omr/oemer/staffline';
import { loadContext } from './omr-staffline.test';

const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'omr', 'reference.json'), 'utf8'));

describe('oemer note-group port', () => {
  const ctx = loadContext();
  const { staffs, zones } = extractStaffs(ctx);
  const notes = extractNoteheads(ctx, staffs, zones);
  const { groups } = extractNoteGroups(ctx, notes, staffs);

  it('builds the same groups', () => {
    expect(groups.length).toBe(ref.groups.length);
    groups.forEach((g, i) => {
      const e = ref.groups[i];
      const where = `group ${i}`;
      expect(g.id, where).toBe(e.id);
      expect(g.bbox, where).toEqual(e.bbox);
      expect(g.noteIds, where).toEqual(e.note_ids);
      expect(g.stemUp, where).toBe(e.stem_up);
      expect(g.hasStem, where).toBe(e.has_stem);
      expect(g.allSameType, where).toBe(e.all_same_type);
      expect(g.group, where).toBe(e.group);
      expect(g.track, where).toBe(e.track);
    });
  });
});
