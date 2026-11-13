// @vitest-environment happy-dom
// Real scanned pages (model maps stored, images not): regressions for refinement passes found on them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mapsFromPacked } from '../src/omr/oemer/context';
import { runPostprocess } from '../src/omr/oemer/pipeline';
import { loadSvm } from './omr-symbols.test';

const dir = join(__dirname, 'fixtures', 'omr');

function recognisePacked(sub: string, refine = true) {
  const page = JSON.parse(readFileSync(join(dir, sub, 'page.json'), 'utf8'));
  const m = mapsFromPacked(page.width, page.height, new Uint8Array(gunzipSync(readFileSync(join(dir, sub, 'maps.u8.gz')))));
  const a = new Uint8Array(m.staff.length);
  const b = new Uint8Array(m.staff.length);
  for (let i = 0; i < a.length; i++) {
    a[i] = m.staff[i] ? 1 : m.symbols[i] ? 2 : 0;
    b[i] = m.stemsRests[i] ? 1 : m.notehead[i] ? 2 : m.clefsKeys[i] ? 3 : 0;
  }
  return runPostprocess(page.width, page.height, [a, b], loadSvm(), 'x', undefined, { refine });
}

/** Pitched notes of a measure, e.g. "C5 B4 A4". */
function pitches(xml: string, measure: number): string {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const m = d.querySelectorAll('part > measure')[measure];
  return [...m.querySelectorAll('note')]
    .filter((n) => !n.querySelector('rest'))
    .map((n) => {
      const alter = n.querySelector('alter')?.textContent;
      return n.querySelector('step')!.textContent + (alter === '1' ? '#' : alter === '-1' ? 'b' : '') + n.querySelector('octave')!.textContent;
    })
    .join(' ');
}

describe('The Troopers (1900s scan, single-line guitar part)', () => {
  it('oemer alone reads it as a piano grand staff', () => {
    const raw = recognisePacked('troopers', false);
    expect(raw.musicxml).toContain('<staves>2</staves>');
  }, 120000);

  it('the refinement splits it back into single-staff systems', () => {
    const res = recognisePacked('troopers');
    expect(res.refined?.splitTracks).toBe(2);
    expect(res.musicxml).toContain('<staves>1</staves>');
    // first system as printed: | C r B A r G | … | B C C# D E D |
    expect(pitches(res.musicxml, 2)).toBe('C5 B4 A4 G4');
    expect(pitches(res.musicxml, 4)).toBe('B3 C4 C#4 D4 E4 D4');
  }, 120000);
});
