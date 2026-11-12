// Score editing. Edits are applied to the imported alphaTab score (the source of truth for rendering
// and playback); the StaffLens model is rebuilt from it afterwards. Every edit is undoable.

import * as alphaTab from '@coderline/alphatab';
import { keySignatureAlter, midiOf, STEPS, stepIndex, type SpelledPitch } from '../theory/pitch';
import { cloneScore } from './toAlphaTab';
import { parseNoteId, type SLChord, type SLNote, type SLPart, type SLScore } from './score';

type AtScore = alphaTab.model.Score;
type AtBeat = alphaTab.model.Beat;
type AtNote = alphaTab.model.Note;

const { Beat, Note, Chord, JsonConverter } = alphaTab.model;

/** Position of a beat in the score (survives rebuilding the model). */
export interface BeatRef {
  track: number;
  staff: number;
  bar: number;
  voice: number;
  beat: number;
}

export const beatRefOf = (id: string): BeatRef => {
  const [track, staff, bar, voice, beat] = parseNoteId(id);
  return { track, staff, bar, voice, beat };
};

export const noteIdOf = (r: BeatRef, note: number) => `${r.track}:${r.staff}:${r.bar}:${r.voice}:${r.beat}:${note}`;

export function beatAt(score: AtScore, r: BeatRef): AtBeat | null {
  return score.tracks[r.track]?.staves[r.staff]?.bars[r.bar]?.voices[r.voice]?.beats[r.beat] ?? null;
}

export function noteAt(score: AtScore, id: string): AtNote | null {
  const [, , , , , n] = parseNoteId(id);
  return beatAt(score, beatRefOf(id))?.notes[n] ?? null;
}

/** NoteAccidentalMode for an alteration (as the MusicXML importer sets it). */
const MODE_FOR_ALTER: Record<number, number> = { 0: 2, 1: 3, 2: 4, [-1]: 5, [-2]: 6 };

/** Sets the written pitch of a note. `offset` = written − sounding (12 for guitar notation). */
function applyPitch(note: AtNote, written: SpelledPitch, offset: number): void {
  const staff = note.beat.voice.bar.staff;
  const sounding = midiOf(written) - offset;
  const v = sounding + staff.transpositionPitch;
  note.string = NaN; // becomes a pitched note; StaffLens re-fingers it for the tab
  note.fret = NaN;
  note.octave = Math.floor(v / 12);
  note.tone = v - note.octave * 12;
  note.accidentalMode = MODE_FOR_ALTER[written.alter] ?? 0;
  // a changed pitch can no longer be tied
  note.isTieDestination = false;
  if (note.tieDestination) note.tieDestination.isTieDestination = false;
}

/** One diatonic step up/down in the bar's key (like most notation editors). */
export function stepPitch(p: SpelledPitch, steps: number, keyFifths: number): SpelledPitch {
  const idx = stepIndex(p.step) + steps;
  const step = STEPS[((idx % 7) + 7) % 7];
  const octave = p.octave + Math.floor(idx / 7);
  return { step, octave, alter: keySignatureAlter(step, keyFifths) };
}

function reindex(beat: AtBeat): void {
  beat.notes.forEach((n, i) => (n.index = i));
}

function reindexVoice(voice: alphaTab.model.Voice): void {
  voice.beats.forEach((b, i) => {
    b.index = i;
    b.previousBeat = voice.beats[i - 1] ?? null;
    b.nextBeat = voice.beats[i + 1] ?? null;
  });
}

let chordCounter = 0;
function setBeatChord(beat: AtBeat, text: string | null): void {
  if (!text) {
    beat.chordId = null;
    return;
  }
  const chord = new Chord();
  chord.name = text;
  chord.showDiagram = false;
  const id = `sl-${Date.now().toString(36)}-${chordCounter++}`;
  beat.voice.bar.staff.addChord(id, chord);
  beat.chordId = id;
}

/** The edit operations. Each returns the note id (or beat) to select afterwards. */
export type EditOp =
  | { kind: 'pitch'; noteId: string; written: SpelledPitch; offset: number }
  | { kind: 'duration'; ref: BeatRef; value: number; dots: number }
  | { kind: 'deleteNote'; noteId: string }
  | { kind: 'deleteBeat'; ref: BeatRef }
  | { kind: 'makeRest'; ref: BeatRef }
  | { kind: 'addNote'; ref: BeatRef; written: SpelledPitch; offset: number }
  | { kind: 'insertAfter'; ref: BeatRef; written: SpelledPitch | null; offset: number }
  | { kind: 'chord'; ref: BeatRef; text: string | null };

export interface EditResult {
  /** Note to select after the edit, if any. */
  noteId: string | null;
  /** Beat to select (for rests). */
  ref: BeatRef | null;
}

/** Applies an edit in place; call finishScore() afterwards. */
export function applyEdit(score: AtScore, op: EditOp): EditResult {
  switch (op.kind) {
    case 'pitch': {
      const note = noteAt(score, op.noteId);
      if (!note) throw new Error('note not found');
      applyPitch(note, op.written, op.offset);
      return { noteId: op.noteId, ref: null };
    }
    case 'duration': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      beat.duration = op.value as alphaTab.model.Duration;
      beat.dots = op.dots;
      return { noteId: beat.notes.length ? noteIdOf(op.ref, 0) : null, ref: op.ref };
    }
    case 'deleteNote': {
      const note = noteAt(score, op.noteId);
      if (!note) throw new Error('note not found');
      const beat = note.beat;
      if (note.tieDestination) note.tieDestination.isTieDestination = false;
      beat.removeNote(note);
      reindex(beat);
      const ref = beatRefOf(op.noteId);
      return { noteId: beat.notes.length ? noteIdOf(ref, Math.min(note.index, beat.notes.length - 1)) : null, ref };
    }
    case 'makeRest': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      for (const n of [...beat.notes]) {
        if (n.tieDestination) n.tieDestination.isTieDestination = false;
        beat.removeNote(n);
      }
      return { noteId: null, ref: op.ref };
    }
    case 'addNote': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      const note = new Note();
      beat.addNote(note);
      note.beat = beat;
      applyPitch(note, op.written, op.offset);
      return { noteId: noteIdOf(op.ref, note.index), ref: op.ref };
    }
    case 'insertAfter': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      const voice = beat.voice;
      const nb = new Beat();
      nb.duration = beat.duration;
      nb.dots = beat.dots;
      nb.isEmpty = false;
      voice.beats.splice(beat.index + 1, 0, nb);
      nb.voice = voice;
      reindexVoice(voice);
      const ref = { ...op.ref, beat: op.ref.beat + 1 };
      if (op.written) {
        const note = new Note();
        nb.addNote(note);
        applyPitch(note, op.written, op.offset);
        return { noteId: noteIdOf(ref, 0), ref };
      }
      return { noteId: null, ref };
    }
    case 'deleteBeat': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      const voice = beat.voice;
      for (const n of beat.notes) if (n.tieDestination) n.tieDestination.isTieDestination = false;
      if (voice.beats.length === 1) {
        // keep the bar valid: an empty bar holds a single rest
        for (const n of [...beat.notes]) beat.removeNote(n);
        return { noteId: null, ref: op.ref };
      }
      voice.beats.splice(beat.index, 1);
      reindexVoice(voice);
      const ref = { ...op.ref, beat: Math.min(op.ref.beat, voice.beats.length - 1) };
      const sel = voice.beats[ref.beat];
      return { noteId: sel.notes.length ? noteIdOf(ref, 0) : null, ref };
    }
    case 'chord': {
      const beat = beatAt(score, op.ref);
      if (!beat) throw new Error('beat not found');
      setBeatChord(beat, op.text?.trim() || null);
      return { noteId: beat.notes.length ? noteIdOf(op.ref, 0) : null, ref: op.ref };
    }
  }
}

/** Re-finishes the score after edits (recomputes durations, ties, indexes). */
export function finishScore(score: AtScore, settings?: alphaTab.Settings): AtScore {
  return cloneScore(score, settings ?? new alphaTab.Settings());
}

/**
 * Chord symbols read straight from MusicXML live in the model, not in the alphaTab score.
 * Before the first edit they are written onto the beats, so edits keep them.
 */
export function materializeChords(score: AtScore, part: SLPart): void {
  const staff = score.tracks[part.trackIndex]?.staves[part.staffIndex];
  if (!staff) return;
  for (const bar of staff.bars) for (const v of bar.voices) for (const b of v.beats) b.chordId = null;
  for (const c of part.chords) placeChord(staff, c);
}

/** Adds chord symbols (e.g. from OCR) at bar/tick positions of the part. */
export function addChordsToScore(score: AtScore, part: SLPart, chords: { measure: number; tick: number; text: string }[]): void {
  const staff = score.tracks[part.trackIndex]?.staves[part.staffIndex];
  if (!staff) return;
  for (const c of chords) placeChord(staff, { measure: c.measure, tick: c.tick, absTick: 0, text: c.text, parsed: null });
}

function placeChord(staff: alphaTab.model.Staff, c: SLChord): void {
  const bar = staff.bars[c.measure];
  const voice = bar?.voices[0];
  if (!voice || voice.beats.length === 0) return;
  let target = voice.beats[0];
  for (const b of voice.beats) if (b.displayStart <= c.tick) target = b;
  setBeatChord(target, c.text);
}

// ------------------------------------------------------------------ history

/** Undo/redo stack of score snapshots (alphaTab JSON). */
export class EditHistory {
  private undoStack: unknown[] = [];
  private redoStack: unknown[] = [];
  constructor(private limit = 50) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
  /** Call before changing `score`. */
  record(score: AtScore): void {
    this.undoStack.push(JsonConverter.scoreToJsObject(score));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current: AtScore, settings?: alphaTab.Settings): AtScore | null {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push(JsonConverter.scoreToJsObject(current));
    return JsonConverter.jsObjectToScore(snap, settings);
  }
  redo(current: AtScore, settings?: alphaTab.Settings): AtScore | null {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push(JsonConverter.scoreToJsObject(current));
    return JsonConverter.jsObjectToScore(snap, settings);
  }
}

// ------------------------------------------------------------------ bar check

export interface BarIssue {
  measure: number;
  /** Ticks found in voice 1. */
  actual: number;
  expected: number;
}

/** Bars whose first voice is longer or shorter than the time signature (often an OMR mistake). */
export function barLengthIssues(model: SLScore, part: SLPart): BarIssue[] {
  const out: BarIssue[] = [];
  for (const m of model.measures) {
    const beats = part.beats.filter((b) => b.measure === m.index && b.voice === 0 && !b.isGrace);
    if (beats.length === 0) continue;
    const actual = beats.reduce((s, b) => s + b.durationTicks, 0);
    const expected = (3840 / m.timeSignature.denominator) * m.timeSignature.numerator;
    if (Math.abs(actual - expected) > 1) out.push({ measure: m.index, actual, expected });
  }
  return out;
}

/** A sensible pitch for a new note next to `ref`: the nearest note before it, or the middle line. */
export function defaultWrittenPitch(part: SLPart, ref: BeatRef, keyFifths: number): SpelledPitch {
  const before = part.notes
    .filter((n: SLNote) => n.measure < ref.bar || (n.measure === ref.bar && n.beatIndex <= ref.beat))
    .sort((a, b) => b.absTick - a.absTick)[0];
  if (before) return before.written;
  return { step: 'B', octave: 4, alter: keySignatureAlter('B', keyFifths) };
}
