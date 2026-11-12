// Range checks and simple fingerstyle arranging (bass from chords).

import { isPlayable, positionsFor, type FretPosition } from './fretboard';
import { mod } from './pitch';

export interface RangeReport {
  playable: number;
  tooLow: number;
  tooHigh: number;
}

export function rangeReport(pitches: number[], tuning: number[], capo: number, maxFret: number): RangeReport {
  const lo = Math.min(...tuning) + capo;
  const hi = Math.max(...tuning) + maxFret;
  let playable = 0;
  let tooLow = 0;
  let tooHigh = 0;
  for (const p of pitches) {
    if (p < lo) tooLow++;
    else if (p > hi) tooHigh++;
    else if (isPlayable(p, tuning, capo, maxFret)) playable++;
  }
  return { playable, tooLow, tooHigh };
}

/** Octave shift (in octaves, -2..2) that makes the most notes playable; ties prefer no shift, then lower frets. */
export function suggestOctaveShift(pitches: number[], tuning: number[], capo: number, maxFret: number): number {
  if (pitches.length === 0) return 0;
  let best = 0;
  let bestScore = -Infinity;
  for (const shift of [0, -1, 1, -2, 2]) {
    const shifted = pitches.map((p) => p + 12 * shift);
    const r = rangeReport(shifted, tuning, capo, maxFret);
    const avgFret =
      shifted.reduce((s, p) => {
        const pos = positionsFor(p, tuning, capo, maxFret);
        return s + (pos.length ? pos[0].fret : maxFret);
      }, 0) / shifted.length;
    const score = r.playable * 100 - Math.abs(shift) * 10 - avgFret;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = shift;
    }
  }
  return best;
}

/**
 * Picks a bass note (chord root) on a low string for beat 1 of a bar.
 * The string must not be used by the melody at that moment and the bass must sound below the melody.
 */
export function bassPosition(
  rootPc: number,
  melody: { string: number; midi: number }[],
  tuning: number[],
  capo: number,
  handPosition: number,
): FretPosition | null {
  const used = new Set(melody.map((m) => m.string));
  const lowestMelody = melody.length ? Math.min(...melody.map((m) => m.midi)) : Infinity;
  const highestMelodyString = melody.length ? Math.max(...melody.map((m) => m.string)) : 0;
  let best: FretPosition | null = null;
  let bestCost = Infinity;
  for (let s = tuning.length; s >= Math.max(1, tuning.length - 2); s--) {
    if (used.has(s) || s <= highestMelodyString) continue;
    for (let fret = capo; fret <= capo + 12; fret++) {
      const midi = tuning[s - 1] + fret;
      if (mod(midi, 12) !== rootPc || midi >= lowestMelody) continue;
      const reach = fret === capo ? 0 : fret < handPosition ? handPosition - fret : Math.max(0, fret - (handPosition + 3));
      const cost = reach * 3 + (fret - capo) * 0.2 + (tuning.length - s) * 0.3;
      if (cost < bestCost) {
        bestCost = cost;
        best = { string: s, fret };
      }
    }
  }
  return bestCost <= 6 ? best : null;
}
