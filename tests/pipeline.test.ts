// @vitest-environment happy-dom
// End-to-end: MusicXML sample -> alphaTab -> StaffLens model -> arrangement -> render score / GP5 / ASCII.
import * as alphaTab from '@coderline/alphatab';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportAscii, exportGp5 } from '../src/export/exporters';
import { arrange, DEFAULT_TAB_SETTINGS } from '../src/model/arrangement';
import { fromAlphaTab } from '../src/model/fromAlphaTab';
import { parseMusicXmlHarmony } from '../src/model/musicxmlHarmony';
import { buildRenderScore } from '../src/model/toAlphaTab';
import { midiOf, parseSpn, spn } from '../src/theory/pitch';
import { playOrder } from '../src/theory/repeats';
import { EXPECTED_OPEN, VERSE, CHORUS, AURA_LEE_CHORDS } from './fixtures/auraLee';

const samplePath = (f: string) => join(__dirname, '..', 'public', 'samples', f);

function load(file: string) {
  const bytes = new Uint8Array(readFileSync(samplePath(file)));
  const at = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
  const harmony = parseMusicXmlHarmony(new TextDecoder().decode(bytes));
  const model = fromAlphaTab(at, { kind: 'musicxml', fileName: file }, harmony);
  return { at, model };
}

describe('Aura Lee sample', () => {
  const { at, model } = load('aura-lee.musicxml');
  const part = model.parts[0];

  it('imports written pitches, sections and repeats', () => {
    expect(model.title).toBe('Aura Lee');
    expect(model.measures).toHaveLength(12);
    const printed = [...VERSE, ...CHORUS].flat().map((n) => n.pitch);
    expect(part.notes.map((n) => spn(n.written, false))).toEqual(printed);
    expect(part.notes[0].writtenMidi - part.notes[0].soundingMidi).toBe(12);
    expect(part.octaveTransposed).toBe(true);
    expect(model.measures[0].section).toBe('Verse');
    expect(model.measures[4].section).toBe('Chorus');
    expect(model.measures[0].keyFifths).toBe(1);
    const order = playOrder(model.measures.map((m) => m.repeat));
    expect(order.map((i) => i + 1)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('reads chord symbols from <harmony>', () => {
    const byBar = model.measures.map((m) => part.chords.filter((c) => c.measure === m.index).map((c) => c.text));
    expect(byBar).toEqual(AURA_LEE_CHORDS);
    expect(part.chords.find((c) => c.text === 'E7')!.parsed!.quality).toBe('dominant7');
    const a7 = part.chords.find((c) => c.measure === 9 && c.text === 'A7')!;
    expect(a7.tick).toBe(1920);
  });

  it('arranges the expected open-position tab', () => {
    const arr = arrange(model, part, DEFAULT_TAB_SETTINGS);
    expect(arr.unplayable.size).toBe(0);
    for (const n of part.notes) {
      const p = arr.placements.get(n.id)!;
      expect(`${p.position.string}:${p.position.fret}`).toBe(EXPECTED_OPEN[spn(n.written, false)]);
      expect(arr.guitarMidi.get(n.id)).toBe(midiOf(parseSpn(spn(n.written, false))!) - 12);
    }
  });

  it('builds a render score with tab and accompaniment', () => {
    const settings = new alphaTab.Settings();
    const arr = arrange(model, part, { ...DEFAULT_TAB_SETTINGS, addBass: true });
    expect(arr.bass.length).toBeGreaterThan(0);
    const r = buildRenderScore(at, model, part, arr, { accompaniment: true, program: 24 }, settings);
    const staff = r.score.tracks[0].staves[0];
    expect(staff.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    const first = staff.bars[0].voices[0].beats[0].notes.find((n) => n.realValue === 50)!;
    expect(first.string).toBe(3); // alphaTab counts from the low string: D = 3
    expect(first.fret).toBe(0);
    expect(first.displayValue).toBe(62); // still written D4
    expect(r.accompanimentTrackIndex).toBe(1);
    const acc = r.score.tracks[1];
    expect(acc.staves[0].bars).toHaveLength(12);
    expect(acc.staves[0].bars[0].voices[0].beats[0].notes.length).toBeGreaterThan(2);
    // MIDI generation works on the result
    const midi = new alphaTab.midi.MidiFile();
    const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midi);
    const gen = new alphaTab.midi.MidiFileGenerator(r.score, settings, handler);
    gen.generate();
    expect(midi.events.length).toBeGreaterThan(100);
    // GP7 export works
    const gp = new alphaTab.exporter.Gp7Exporter().export(r.score, settings);
    expect(gp.length).toBeGreaterThan(1000);
  });

  it('writes a GP5 file that alphaTab reads back', () => {
    const arr = arrange(model, part, DEFAULT_TAB_SETTINGS);
    const bytes = exportGp5(model, part, arr);
    const header = new TextDecoder('latin1').decode(bytes.slice(1, 25));
    expect(header).toBe('FICHIER GUITAR PRO v5.00');
    const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
    expect(back.title.replace(/ /g, ' ')).toBe('Aura Lee');
    expect(back.masterBars).toHaveLength(12);
    expect(back.masterBars[0].isRepeatStart).toBe(true);
    expect(back.masterBars[3].repeatCount).toBe(2);
    expect(back.masterBars[4].section?.text.replace(/ /g, ' ')).toBe('Chorus');
    const staff = back.tracks[0].staves[0];
    expect(staff.bars[0].keySignature as number).toBe(1);
    const notes = staff.bars.flatMap((b) => b.voices[0].beats.flatMap((bt) => bt.notes));
    expect(notes.map((n) => n.realValue)).toEqual(part.notes.map((n) => n.writtenMidi - 12));
    expect(notes[0].string).toBe(3);
    expect(notes[0].fret).toBe(0);
    expect(staff.bars[1].voices[0].beats[2].duration as number).toBe(2);
    // chord symbols survive the round trip (stored as beat text)
    const again = fromAlphaTab(back, { kind: 'guitarpro', fileName: 'x.gp5' });
    expect(again.parts[0].chords.map((c) => c.text)).toEqual(AURA_LEE_CHORDS.flat());
    expect(again.parts[0].hasTab).toBe(true);
  });

  it('exports ASCII tab', () => {
    const arr = arrange(model, part, DEFAULT_TAB_SETTINGS);
    const txt = exportAscii(model, part, arr);
    expect(txt).toContain('Aura Lee');
    const firstSystem = txt.split('\n\n')[2].split('\n');
    expect(firstSystem[0]).toBe('1');
    expect(firstSystem[4]).toBe('D|-0-------4-------|-----2-----------|-----4---2---4---|---------|');
    const lens = firstSystem.slice(1).map((l) => l.length);
    expect(new Set(lens).size).toBe(1);
  });
});

describe('Chord study sample', () => {
  const { model } = load('chord-study.musicxml');
  const part = model.parts[0];
  it('has the chord sequence for chord-tone tests', () => {
    expect(part.chords.map((c) => c.text)).toEqual(['C', 'E7', 'Am', 'D7', 'G7', 'C', 'G7', 'C']);
    expect(spn(part.notes[4].written, false)).toBe('G#4');
  });
});
