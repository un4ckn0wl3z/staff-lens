// @vitest-environment happy-dom
// End to end per test page: oemer's model maps → the TypeScript post-processing → MusicXML, which must be
// byte-identical to what oemer itself writes, then note accuracy against the score the page was rendered from.
// Maps and oemer's output come from tools/oemer_reference.py (see docs/PHASE2_PLAN.md, M6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { quadSize, rectifiedSize, toGray, warpPerspective, type Img } from '../src/omr/geometry';
import { mapsFromPacked } from '../src/omr/oemer/context';
import { runPostprocess } from '../src/omr/oemer/pipeline';
import { accuracy, barDiff, scoreFromMusicXml, type Accuracy } from './helpers/omrAccuracy';
import { loadSvm } from './omr-symbols.test';

const omr = join(__dirname, 'fixtures', 'omr');
const read = (...p: string[]) => readFileSync(join(omr, ...p));

interface Page {
  name: string;
  dir: string;
  title: string;
  truth: string;
  /** measured accuracy, kept as a floor so regressions show up */
  min: { events: number; pitches: number };
}

const PAGES: Page[] = [
  { name: 'Aura Lee (rendered page)', dir: '.', title: 'Aura Lee', truth: join(__dirname, '..', 'public', 'samples', 'aura-lee.musicxml'), min: { events: 0.91, pitches: 0.91 } },
  { name: 'Rhythm Study (rendered page)', dir: 'rhythm', title: 'Rhythm Study', truth: join(omr, 'rhythm-study.musicxml'), min: { events: 0.66, pitches: 0.79 } },
  { name: 'Rhythm Study (phone photo)', dir: 'rhythm-photo', title: 'Rhythm Study', truth: join(omr, 'rhythm-study.musicxml'), min: { events: 0.64, pitches: 0.74 } },
];

export function recognise(dir: string, title: string) {
  const ref = JSON.parse(read(dir, 'reference.json').toString('utf8'));
  const m = mapsFromPacked(ref.width, ref.height, new Uint8Array(gunzipSync(read(dir, 'maps.u8.gz'))));
  const a = new Uint8Array(m.staff.length);
  const b = new Uint8Array(m.staff.length);
  for (let i = 0; i < a.length; i++) {
    a[i] = m.staff[i] ? 1 : m.symbols[i] ? 2 : 0;
    b[i] = m.stemsRests[i] ? 1 : m.notehead[i] ? 2 : m.clefsKeys[i] ? 3 : 0;
  }
  return runPostprocess(ref.width, ref.height, [a, b], loadSvm(), title);
}

const results: { page: string; acc: Accuracy }[] = [];

describe.each(PAGES)('OMR end to end: $name', (page) => {
  let cached: ReturnType<typeof recognise> | undefined;
  const result = () => (cached ??= recognise(page.dir, page.title));

  it('writes the same MusicXML as oemer', () => {
    const expected = read(page.dir, 'oemer-reference.musicxml').toString('utf8').replace(/\r\n/g, '\n');
    const a = result().musicxml.split('\n');
    const b = expected.split('\n');
    const first = a.findIndex((l, i) => l !== b[i]);
    expect(first === -1 && a.length === b.length ? 'identical' : `line ${first + 1}: got ${JSON.stringify(a[first])} expected ${JSON.stringify(b[first])}`).toBe('identical');
  });

  it('reaches its recorded note accuracy', () => {
    const truth = scoreFromMusicXml(readFileSync(page.truth, 'utf8'));
    const got = scoreFromMusicXml(result().musicxml);
    const acc = accuracy(truth, got);
    results.push({ page: page.name, acc });
    console.log(`${page.name}: events ${(acc.events * 100).toFixed(1)}%, pitches ${(acc.pitches * 100).toFixed(1)}%, notes ${acc.foundNotes}/${acc.truthNotes}, bars ${acc.bars[0]}/${acc.bars[1]}
  truth  |  recognised
${barDiff(truth, got)}`);
    expect(acc.events).toBeGreaterThanOrEqual(page.min.events);
    expect(acc.pitches).toBeGreaterThanOrEqual(page.min.pitches);
  });
}, 60000);

describe('phone-photo geometry', () => {
  it('straightens the photo back to the page', () => {
    const meta = JSON.parse(read('rhythm-photo', 'photo.json').toString('utf8'));
    const j = jpeg.decode(read('rhythm-photo', 'photo.jpg'), { useTArray: true });
    const photo: Img = { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) };
    const quad = (meta.corners as number[][]).map(([x, y]) => ({ x, y }));
    const [pw, ph] = meta.paper as number[];
    // edge lengths alone make the page too tall (foreshortening); the camera-model estimate recovers the paper's shape
    const edges = quadSize(quad);
    expect(Math.abs(edges.width / edges.height / (pw / ph) - 1)).toBeGreaterThan(0.05);
    const size = rectifiedSize(quad, j.width, j.height);
    expect(Math.abs(size.width / size.height / (pw / ph) - 1)).toBeLessThan(0.04);
    expect(Math.abs((size.width * size.height) / (edges.width * edges.height) - 1)).toBeLessThan(0.02); // same resolution
    const flat = toGray(warpPerspective(photo, quad, { width: pw, height: ph }));
    const png = PNG.sync.read(read('rhythm-study.png'));
    const orig = toGray({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
    // normalised cross-correlation of the page area with the original rendering
    const mg = meta.margin as number;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = 0; y < png.height; y += 2)
      for (let x = 0; x < png.width; x += 2) {
        const a = flat[(y + mg) * pw + x + mg];
        const b = orig[y * png.width + x];
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
      }
    const r = (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
    expect(r).toBeGreaterThan(0.8);
  });
});
