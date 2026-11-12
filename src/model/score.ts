// StaffLens internal score model.
// File import (alphaTab) converts into this; Phase 2 OMR output will convert into it too.
// The theory/explanation code only reads this model, never alphaTab objects.

import type { ChordSymbol } from '../theory/chord';
import type { TimeSignature } from '../theory/duration';
import type { SpelledPitch } from '../theory/pitch';
import type { RepeatBar } from '../theory/repeats';

export type ClefKind = 'treble' | 'bass' | 'alto' | 'tenor' | 'neutral';

export interface SLScore {
  title: string;
  subtitle: string;
  composer: string;
  tempo: number;
  measures: SLMeasure[];
  parts: SLPart[];
  /** Where the score came from. */
  source: { kind: 'musicxml' | 'mxl' | 'guitarpro' | 'other'; fileName: string };
}

export interface SLMeasure {
  index: number;
  timeSignature: TimeSignature;
  keyFifths: number;
  keyMinor: boolean;
  /** Absolute start tick (display time, repeats not expanded). */
  startTick: number;
  ticks: number;
  repeat: RepeatBar;
  section: string | null;
  /** Tempo change at the start of this bar, if any. */
  tempo: number | null;
  isAnacrusis: boolean;
}

export interface SLPart {
  /** alphaTab track / staff this part comes from. */
  trackIndex: number;
  staffIndex: number;
  name: string;
  program: number;
  clef: ClefKind;
  /** Written pitch is an octave above sounding pitch (guitar notation). */
  octaveTransposed: boolean;
  /** The source already had tab (string/fret) information. */
  hasTab: boolean;
  sourceTuning: number[] | null;
  sourceCapo: number;
  notes: SLNote[];
  /** Every beat (including rests) per voice, in order; needed to keep rhythm when exporting. */
  beats: SLBeat[];
  chords: SLChord[];
}

export interface SLBeat {
  measure: number;
  voice: number;
  beatIndex: number;
  tick: number;
  durationTicks: number;
  durationValue: number;
  dots: number;
  tuplet: { numerator: number; denominator: number } | null;
  isGrace: boolean;
  noteIds: string[];
}

export interface SLNote {
  /** Stable path into the alphaTab model: track:staff:bar:voice:beat:note */
  id: string;
  measure: number;
  voice: number;
  beatIndex: number;
  noteIndex: number;
  /** Start tick within the bar. */
  tick: number;
  absTick: number;
  durationTicks: number;
  /** 1 = whole, 2 = half, 4 = quarter … */
  durationValue: number;
  dots: number;
  tuplet: { numerator: number; denominator: number } | null;
  /** Pitch as printed on the staff (MIDI). */
  writtenMidi: number;
  /** Pitch as it sounds on the source instrument (MIDI). */
  soundingMidi: number;
  written: SpelledPitch;
  isTieDestination: boolean;
  tieOriginId: string | null;
  isGrace: boolean;
  /** Original tab position from the file (string 1 = high), if any. */
  sourceString: number | null;
  sourceFret: number | null;
}

export interface SLChord {
  measure: number;
  tick: number;
  absTick: number;
  text: string;
  parsed: ChordSymbol | null;
}

export function noteId(track: number, staff: number, bar: number, voice: number, beat: number, note: number): string {
  return `${track}:${staff}:${bar}:${voice}:${beat}:${note}`;
}

export function parseNoteId(id: string): [number, number, number, number, number, number] {
  const p = id.split(':').map(Number);
  return [p[0], p[1], p[2], p[3], p[4], p[5]];
}

/** Chord symbol in force at an absolute tick (the last one at or before it). */
export function chordAt(part: SLPart, absTick: number): SLChord | null {
  let found: SLChord | null = null;
  for (const c of part.chords) {
    if (c.absTick <= absTick) found = c;
    else break;
  }
  return found;
}

/** Notes of the part ordered by time (then pitch, high first). */
export function notesInOrder(part: SLPart): SLNote[] {
  return [...part.notes].sort((a, b) => a.absTick - b.absTick || (a.isGrace === b.isGrace ? 0 : a.isGrace ? -1 : 1) || b.writtenMidi - a.writtenMidi);
}

/** The "melody" note sounding before `note`: previous onset's highest note. */
export function previousMelodyNote(part: SLPart, note: SLNote): SLNote | null {
  const ordered = notesInOrder(part).filter((n) => !n.isTieDestination);
  let prev: SLNote | null = null;
  for (const n of ordered) {
    if (n.absTick >= note.absTick) break;
    if (!prev || n.absTick !== prev.absTick) prev = n; // highest note of each onset comes first
  }
  return prev;
}
