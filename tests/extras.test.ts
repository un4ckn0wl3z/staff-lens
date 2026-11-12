// @vitest-environment happy-dom
// MXL (zip) harmony reading, chord-tone labelling on the chord-study fixture, staff positions, inversions.
import * as alphaTab from '@coderline/alphatab';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { staffPositionText } from '../src/explain/panels';
import { setLang } from '../src/i18n';
import { fromAlphaTab } from '../src/model/fromAlphaTab';
import { parseMusicXmlHarmony } from '../src/model/musicxmlHarmony';
import { readMxlScoreXml } from '../src/model/mxl';
import { chordAt, notesInOrder } from '../src/model/score';
import { chordToneRole, classifyNonChordTone } from '../src/theory/chord';
import { intervalBetween, invertInterval } from '../src/theory/interval';
import { mod, parseSpn, spn } from '../src/theory/pitch';

const sample = (f: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'public', 'samples', f)));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Builds a zip; `deflate` compresses entries with deflate-raw. */
async function makeZip(files: Record<string, string>, deflate: boolean): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate
      ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      : raw;
    const nameBytes = enc.encode(name);
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);
    const offset = local.length;
    local.push(...le(0x04034b50, 4), ...le(20, 2), ...le(0, 2), ...le(method, 2), ...le(0, 4), ...le(crc, 4), ...le(data.length, 4), ...le(raw.length, 4), ...le(nameBytes.length, 2), ...le(0, 2), ...nameBytes, ...data);
    central.push(
      ...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0, 2), ...le(method, 2), ...le(0, 4), ...le(crc, 4), ...le(data.length, 4), ...le(raw.length, 4),
      ...le(nameBytes.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...nameBytes,
    );
    count++;
  }
  const eocd = [...le(0x06054b50, 4), ...le(0, 4), ...le(count, 2), ...le(count, 2), ...le(central.length, 4), ...le(local.length, 4), ...le(0, 2)];
  return new Uint8Array([...local, ...central, ...eocd]);
}

describe('MXL', () => {
  const xml = new TextDecoder().decode(sample('aura-lee.musicxml')).replace(
    '<harmony><root><root-step>G</root-step></root><kind text="">major</kind></harmony>',
    '<harmony><root><root-step>G</root-step></root><kind text="">major</kind><bass><bass-step>B</bass-step></bass></harmony>',
  );
  const container = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/aura.xml"/></rootfiles></container>';

  for (const deflate of [false, true]) {
    it(`reads the root score and slash chords (${deflate ? 'deflated' : 'stored'})`, async () => {
      const zip = await makeZip({ 'META-INF/container.xml': container, 'score/aura.xml': xml }, deflate);
      const text = await readMxlScoreXml(zip);
      expect(text).toBe(xml);
      const at = alphaTab.importer.ScoreLoader.loadScoreFromBytes(zip);
      const model = fromAlphaTab(at, { kind: 'mxl', fileName: 'a.mxl' }, parseMusicXmlHarmony(text!));
      expect(model.parts[0].chords[0].text).toBe('G/B');
      expect(model.parts[0].chords[0].parsed!.bass).toEqual({ step: 'B', alter: 0 });
    });
  }

  it('returns null for non-zip data', async () => {
    expect(await readMxlScoreXml(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('chord-tone labelling (chord study fixture)', () => {
  const bytes = sample('chord-study.musicxml');
  const at = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
  const model = fromAlphaTab(at, { kind: 'musicxml', fileName: 'c.musicxml' }, parseMusicXmlHarmony(new TextDecoder().decode(bytes)));
  const part = model.parts[0];
  const ordered = notesInOrder(part);
  const label = (bar: number) =>
    ordered
      .filter((n) => n.measure === bar)
      .map((n) => {
        const chord = chordAt(part, n.absTick)!;
        const role = chordToneRole(mod(n.writtenMidi, 12), chord.parsed!);
        if (role) return `${spn(n.written, false)}:${role}`;
        const i = ordered.indexOf(n);
        return `${spn(n.written, false)}:${classifyNonChordTone(ordered[i - 1]?.writtenMidi ?? null, n.writtenMidi, ordered[i + 1]?.writtenMidi ?? null)}`;
      })
      .join(' ');

  it('labels chord tones and non-chord tones', () => {
    expect(label(0)).toBe('E4:3rd F4:passing G4:5th C5:root'); // over C
    expect(label(1)).toBe('G#4:3rd B4:5th D5:7th B4:5th'); // over E7
    expect(label(2)).toBe('A4:root C5:3rd E5:5th C5:3rd'); // over Am
    expect(label(3)).toBe('F#4:3rd A4:5th C5:7th A4:5th'); // over D7
    expect(label(4)).toBe('G4:root B4:3rd D5:5th F5:7th'); // over G7
  });
});

describe('detail helpers', () => {
  it('describes staff positions', () => {
    setLang('en');
    expect(staffPositionText(parseSpn('E4')!, 'treble')).toMatch(/line 1/);
    expect(staffPositionText(parseSpn('F5')!, 'treble')).toMatch(/line 5/);
    expect(staffPositionText(parseSpn('G4')!, 'treble')).toMatch(/line 2/);
    expect(staffPositionText(parseSpn('A4')!, 'treble')).toMatch(/space 2/);
    expect(staffPositionText(parseSpn('D4')!, 'treble')).toMatch(/Just below/);
    expect(staffPositionText(parseSpn('C4')!, 'treble')).toMatch(/ledger line 1/);
    expect(staffPositionText(parseSpn('C4')!, 'bass')).toMatch(/ledger line 1/);
    expect(staffPositionText(parseSpn('G2')!, 'bass')).toMatch(/line 1/);
  });

  it('inverts intervals', () => {
    expect(invertInterval(intervalBetween(parseSpn('D4')!, parseSpn('G4')!))).toEqual({ number: 5, quality: 'P' });
    expect(invertInterval(intervalBetween(parseSpn('C4')!, parseSpn('E4')!))).toEqual({ number: 6, quality: 'm' });
    expect(invertInterval(intervalBetween(parseSpn('F4')!, parseSpn('B4')!))).toEqual({ number: 5, quality: 'd' });
  });
});
