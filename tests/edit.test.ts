// @vitest-environment happy-dom
import * as alphaTab from '@coderline/alphatab';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, barLengthIssues, beatRefOf, EditHistory, finishScore, materializeChords, stepPitch, type EditOp } from '../src/model/edit';
import { fromAlphaTab } from '../src/model/fromAlphaTab';
import { parseMusicXmlHarmony } from '../src/model/musicxmlHarmony';
import { spn } from '../src/theory/pitch';

const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'public', 'samples', 'aura-lee.musicxml')));
const src = { kind: 'musicxml' as const, fileName: 'aura-lee.musicxml' };

function setup() {
  let score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
  const model = fromAlphaTab(score, src, parseMusicXmlHarmony(new TextDecoder().decode(bytes)));
  materializeChords(score, model.parts[0]);
  score = finishScore(score);
  return { score, model: fromAlphaTab(score, src) };
}

function edit(score: alphaTab.model.Score, op: EditOp) {
  const res = applyEdit(score, op);
  const next = finishScore(score);
  return { score: next, model: fromAlphaTab(next, src), res };
}

const names = (m: ReturnType<typeof fromAlphaTab>, bar: number) =>
  m.parts[0].notes.filter((n) => n.measure === bar).map((n) => `${spn(n.written, false)}:${n.durationValue}${n.dots ? '.' : ''}`);

describe('score editing', () => {
  it('keeps MusicXML chord symbols after materializing them onto beats', () => {
    const { model } = setup();
    expect(model.parts[0].chords.map((c) => c.text).slice(0, 4)).toEqual(['G', 'A7', 'D7', 'G']);
    expect(model.parts[0].chords.find((c) => c.measure === 9 && c.tick === 1920)?.text).toBe('A7');
  });

  it('steps pitches through the key', () => {
    expect(spn(stepPitch({ step: 'E', alter: 0, octave: 4 }, 1, 1), false)).toBe('F#4');
    expect(spn(stepPitch({ step: 'B', alter: 0, octave: 4 }, 1, 1), false)).toBe('C5');
    expect(spn(stepPitch({ step: 'C', alter: 0, octave: 5 }, -1, 0), false)).toBe('B4');
  });

  it('changes a pitch and keeps guitar notation (written vs sounding)', () => {
    const { score, model } = setup();
    const n = model.parts[0].notes[0]; // D4
    const r = edit(score, { kind: 'pitch', noteId: n.id, written: { step: 'E', alter: 0, octave: 4 }, offset: n.writtenMidi - n.soundingMidi });
    const e = r.model.parts[0].notes[0];
    expect(spn(e.written, false)).toBe('E4');
    expect(e.writtenMidi - e.soundingMidi).toBe(12);
    // F natural in G major
    const r2 = edit(r.score, { kind: 'pitch', noteId: e.id, written: { step: 'F', alter: 0, octave: 4 }, offset: 12 });
    expect(spn(r2.model.parts[0].notes[0].written, false)).toBe('F4');
  });

  it('changes durations and dots', () => {
    const { score, model } = setup();
    const ref = beatRefOf(model.parts[0].notes[0].id);
    const r = edit(score, { kind: 'duration', ref, value: 2, dots: 1 });
    expect(names(r.model, 0)[0]).toBe('D4:2.');
  });

  it('deletes notes, makes rests and inserts beats', () => {
    const { score, model } = setup();
    const first = model.parts[0].notes[0];
    let r = edit(score, { kind: 'makeRest', ref: beatRefOf(first.id) });
    expect(names(r.model, 0)).toEqual(['G4:4', 'F#4:4', 'G4:4']);
    expect(r.model.parts[0].beats.filter((b) => b.measure === 0)[0].noteIds).toEqual([]);
    r = edit(r.score, { kind: 'insertAfter', ref: beatRefOf(first.id), written: { step: 'A', alter: 0, octave: 4 }, offset: 12 });
    expect(names(r.model, 0)).toEqual(['A4:4', 'G4:4', 'F#4:4', 'G4:4']);
    r = edit(r.score, { kind: 'deleteBeat', ref: beatRefOf(first.id) });
    expect(names(r.model, 0)).toEqual(['A4:4', 'G4:4', 'F#4:4', 'G4:4']);
    expect(r.model.parts[0].beats.filter((b) => b.measure === 0)).toHaveLength(4);
  });

  it('adds chord notes and deletes single notes', () => {
    const { score, model } = setup();
    const ref = beatRefOf(model.parts[0].notes[0].id);
    let r = edit(score, { kind: 'addNote', ref, written: { step: 'B', alter: 0, octave: 4 }, offset: 12 });
    expect(names(r.model, 0).slice(0, 2).sort()).toEqual(['B4:4', 'D4:4']);
    r = edit(r.score, { kind: 'deleteNote', noteId: r.res.noteId! });
    expect(names(r.model, 0)[0]).toBe('D4:4');
    expect(names(r.model, 0)).toHaveLength(4);
  });

  it('sets and removes chord symbols', () => {
    const { score, model } = setup();
    const ref = beatRefOf(model.parts[0].notes[1].id); // bar 1, beat 2
    let r = edit(score, { kind: 'chord', ref, text: 'Em7' });
    expect(r.model.parts[0].chords.filter((c) => c.measure === 0).map((c) => c.text)).toEqual(['G', 'Em7']);
    r = edit(r.score, { kind: 'chord', ref, text: null });
    expect(r.model.parts[0].chords.filter((c) => c.measure === 0).map((c) => c.text)).toEqual(['G']);
  });

  it('undoes and redoes', () => {
    let { score, model } = setup();
    const h = new EditHistory();
    h.record(score);
    ({ score, model } = edit(score, { kind: 'makeRest', ref: beatRefOf(model.parts[0].notes[0].id) }));
    expect(names(model, 0)).toHaveLength(3);
    const back = h.undo(score)!;
    expect(names(fromAlphaTab(back, src), 0)).toHaveLength(4);
    const fwd = h.redo(back)!;
    expect(names(fromAlphaTab(fwd, src), 0)).toHaveLength(3);
    expect(h.canRedo).toBe(false);
  });

  it('finds bars whose length does not match the time signature', () => {
    const { score, model } = setup();
    expect(barLengthIssues(model, model.parts[0])).toEqual([]);
    const r = edit(score, { kind: 'deleteBeat', ref: beatRefOf(model.parts[0].notes[0].id) });
    expect(barLengthIssues(r.model, r.model.parts[0])).toEqual([{ measure: 0, actual: 2880, expected: 3840 }]);
  });
});
