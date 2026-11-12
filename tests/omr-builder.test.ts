// End to end on the fixture maps: the full post-processing port must write the same MusicXML as oemer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMusicXml } from '../src/omr/oemer/builder';
import { extractNoteGroups } from '../src/omr/oemer/noteGroup';
import { extractNoteheads } from '../src/omr/oemer/notehead';
import { extractRhythm } from '../src/omr/oemer/rhythm';
import { extractStaffs } from '../src/omr/oemer/staffline';
import { extractSymbols } from '../src/omr/oemer/symbols';
import { loadContext } from './omr-staffline.test';
import { loadSvm } from './omr-symbols.test';

const expected = readFileSync(join(__dirname, 'fixtures', 'omr', 'oemer-reference.musicxml'), 'utf8').replace(/\r\n/g, '\n');

describe('oemer system-building port', () => {
  it('writes the same MusicXML as oemer', () => {
    const ctx = loadContext();
    const { staffs, zones } = extractStaffs(ctx);
    const notes = extractNoteheads(ctx, staffs, zones);
    const { groups, groupMap, noteIdMap } = extractNoteGroups(ctx, notes, staffs);
    const sym = extractSymbols(ctx, loadSvm(), staffs, zones, notes, groupMap, noteIdMap);
    extractRhythm(ctx, staffs, notes, groups, groupMap, noteIdMap, sym.barlines);
    const xml = buildMusicXml({ staffs, notes, groups, ...sym }, 'Aura Lee');
    const a = xml.split('\n');
    const b = expected.split('\n');
    const first = a.findIndex((l, i) => l !== b[i]);
    expect(first === -1 ? 'identical' : `line ${first + 1}: got ${JSON.stringify(a[first])} expected ${JSON.stringify(b[first])}`).toBe('identical');
    expect(xml).toBe(expected);
  }, 60000);
});
