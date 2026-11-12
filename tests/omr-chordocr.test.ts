// Chord OCR on the Aura Lee fixture: oemer layout + Tesseract.js (local English data) → chords per bar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTesseractEngine, lastWords, normalizeChordText, placeChords, recognizeChords } from '../src/omr/chordOcr';
import { mapsFromPacked } from '../src/omr/oemer/context';
import { runPostprocess } from '../src/omr/oemer/pipeline';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { loadSvm } from './omr-symbols.test';
import { AURA_LEE_CHORDS } from './fixtures/auraLee';

const dir = join(__dirname, 'fixtures', 'omr');
const ref = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'));

describe('chord-symbol OCR', () => {
  it('normalises OCR words', () => {
    expect(normalizeChordText('G7')).toBe('G7');
    expect(normalizeChordText('[Verse]')).toBeNull();
    expect(normalizeChordText('Cmaj7,')).toBe('Cmaj7');
    expect(normalizeChordText('F♯m')).toBe('F#m');
    expect(normalizeChordText('Aura')).toBeNull();
    expect(normalizeChordText('=92')).toBeNull();
    expect(normalizeChordText('em')).toBe('Em');
  });

  it('snaps words to the beat below and keeps the most confident one', () => {
    const systems = [{ group: 0, top: 100, left: 0, right: 1000, unit: 20 }];
    const timeline = [
      { group: 0, measure: 0, x: 105, tick: 0 },
      { group: 0, measure: 0, x: 200, tick: 960 },
      { group: 0, measure: 1, x: 400, tick: 0 },
    ];
    const w = (text: string, x0: number, conf = 90) => ({ text, confidence: conf, group: 0, bbox: { x0, y0: 40, x1: x0 + 25, y1: 60 } });
    expect(placeChords([w('G', 98), w('D7', 195), w('Am', 392), w('Bm', 393, 60), w('Verse', 300)], timeline, systems)).toEqual([
      { measure: 0, tick: 0, text: 'G', confidence: 90 },
      { measure: 0, tick: 960, text: 'D7', confidence: 90 },
      { measure: 1, tick: 0, text: 'Am', confidence: 90 },
    ]);
  });

  it('reads the chord symbols of the Aura Lee page', async () => {
    const packed = new Uint8Array(gunzipSync(readFileSync(join(dir, 'maps.u8.gz'))));
    const m = mapsFromPacked(ref.width, ref.height, packed);
    const toSeg = () => {
      const a = new Uint8Array(m.staff.length);
      const b = new Uint8Array(m.staff.length);
      for (let i = 0; i < a.length; i++) {
        a[i] = m.staff[i] ? 1 : m.symbols[i] ? 2 : 0;
        b[i] = m.stemsRests[i] ? 1 : m.notehead[i] ? 2 : m.clefsKeys[i] ? 3 : 0;
      }
      return [a, b];
    };
    const res = runPostprocess(ref.width, ref.height, toSeg(), loadSvm(), 'Aura Lee');
    const png = readFileSync(join(dir, 'aura-lee-staff.png'));
    const engine = await createTesseractEngine(png, {
      workerPath: undefined as unknown as string,
      corePath: undefined as unknown as string,
      langPath: join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
    });
    try {
      const img = PNG.sync.read(png);
      const gray = new Uint8Array(img.width * img.height);
      for (let i = 0; i < gray.length; i++) gray[i] = (img.data[i * 4] * 299 + img.data[i * 4 + 1] * 587 + img.data[i * 4 + 2] * 114) / 1000;
      const scale = img.width / ref.width; // fixture PNG is the original, maps are oemer's resized page
      const chords = await recognizeChords(engine, gray, img.width, img.height, res.systems, res.timeline, scale);
      const byBar = Array.from({ length: 12 }, (_, i) => chords.filter((c) => c.measure === i).map((c) => c.text));
      // compare per bar; OCR may miss a symbol, but must not invent wrong ones
      let found = 0;
      byBar.forEach((got, i) => {
        for (const g of got) expect(AURA_LEE_CHORDS[i], `bar ${i + 1} ${lastWords.map((w) => `${w.text}(${Math.round(w.confidence)})@${Math.round(w.bbox.x0)}/g${w.group}`).join(' ')}`).toContain(g);
        found += got.length;
      });
      expect(byBar).toEqual(AURA_LEE_CHORDS); // all 13 chord symbols, in the right bars
      expect(chords.filter((c) => c.measure === 9).map((c) => [c.text, c.tick])).toEqual([
        ['E7', 0],
        ['A7', 1920],
      ]);
    } finally {
      await engine.terminate();
    }
  }, 120000);
});
