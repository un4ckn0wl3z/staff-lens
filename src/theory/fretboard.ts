// Fretboard geometry. Strings are numbered like tab: string 1 = highest (thin E), string 6 = lowest.
// Frets are absolute (counted from the nut) unless stated otherwise.

import { mod } from './pitch';

export interface TuningPreset {
  id: 'standard' | 'dropD' | 'dadgad' | 'halfStepDown';
  /** Open-string MIDI pitches, string 1 (high) first. */
  strings: number[];
}

export const TUNINGS: Record<TuningPreset['id'], TuningPreset> = {
  standard: { id: 'standard', strings: [64, 59, 55, 50, 45, 40] },
  dropD: { id: 'dropD', strings: [64, 59, 55, 50, 45, 38] },
  dadgad: { id: 'dadgad', strings: [62, 57, 55, 50, 45, 38] },
  halfStepDown: { id: 'halfStepDown', strings: [63, 58, 54, 49, 44, 39] },
};

export const STANDARD = TUNINGS.standard.strings;

export interface FretPosition {
  /** 1 = highest string. */
  string: number;
  /** Absolute fret (0 = open string without capo). */
  fret: number;
}

export function pitchAt(pos: FretPosition, tuning: number[]): number {
  return tuning[pos.string - 1] + pos.fret;
}

/** Every (string, fret) producing `midi`, with frets in [capo, maxFret]. Sorted from low fret to high. */
export function positionsFor(midi: number, tuning: number[], capo = 0, maxFret = 15): FretPosition[] {
  const out: FretPosition[] = [];
  tuning.forEach((open, i) => {
    const fret = midi - open;
    if (fret >= capo && fret <= maxFret) out.push({ string: i + 1, fret });
  });
  return out.sort((a, b) => a.fret - b.fret || a.string - b.string);
}

export function isPlayable(midi: number, tuning: number[], capo = 0, maxFret = 15): boolean {
  return positionsFor(midi, tuning, capo, maxFret).length > 0;
}

export function lowestPitch(tuning: number[], capo = 0): number {
  return Math.min(...tuning) + capo;
}

export function highestPitch(tuning: number[], maxFret = 15): number {
  return Math.max(...tuning) + maxFret;
}

/**
 * Suggested fretting finger for a note given the hand position (fret under the index finger).
 * 0 = open string, 1 = index ... 4 = pinky.
 */
export function suggestFinger(pos: FretPosition, handPosition: number, capo = 0): number {
  if (pos.fret === capo) return 0;
  return Math.max(1, Math.min(4, pos.fret - handPosition + 1));
}

const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Tab string label for an open-string pitch, e.g. 64 -> "e" when first string, "E" otherwise. */
export function stringLabel(openMidi: number, isHighest: boolean): string {
  const n = NAMES_SHARP[mod(openMidi, 12)];
  return isHighest ? n.toLowerCase() : n;
}
