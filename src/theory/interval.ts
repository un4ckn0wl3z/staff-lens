import { diatonicIndex, midiOf, type SpelledPitch } from './pitch';

export type IntervalQuality = 'P' | 'M' | 'm' | 'A' | 'd' | 'AA' | 'dd';

export interface Interval {
  direction: 'up' | 'down' | 'same';
  /** Diatonic number: 1 = unison, 8 = octave, 10 = tenth… */
  number: number;
  /** Number reduced to 1..7 (octave = 8 stays 8 when number is exactly 8). */
  simpleNumber: number;
  quality: IntervalQuality;
  semitones: number;
  octaves: number;
}

const MAJOR_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const PERFECT = new Set([1, 4, 5]);

/** Interval from `a` to `b` using spelling (so F→B is an augmented 4th, F→C♭ a diminished 5th). */
export function intervalBetween(a: SpelledPitch, b: SpelledPitch): Interval {
  const da = diatonicIndex(a);
  const db = diatonicIndex(b);
  const ma = midiOf(a);
  const mb = midiOf(b);
  let direction: Interval['direction'];
  if (db > da || (db === da && mb > ma)) direction = 'up';
  else if (db < da || mb < ma) direction = 'down';
  else direction = 'same';
  const [lo, hi] = direction === 'down' ? [b, a] : [a, b];
  const steps = diatonicIndex(hi) - diatonicIndex(lo);
  const semis = midiOf(hi) - midiOf(lo);
  const number = steps + 1;
  const octaves = Math.floor(steps / 7);
  const simple = (steps % 7) + 1;
  const expected = MAJOR_SEMIS[simple - 1] + 12 * octaves;
  const diff = semis - expected;
  let quality: IntervalQuality;
  if (PERFECT.has(simple)) {
    quality = diff === 0 ? 'P' : diff === 1 ? 'A' : diff === -1 ? 'd' : diff > 1 ? 'AA' : 'dd';
  } else {
    quality = diff === 0 ? 'M' : diff === -1 ? 'm' : diff === 1 ? 'A' : diff === -2 ? 'd' : diff > 1 ? 'AA' : 'dd';
  }
  // Unison with zero semitones has no direction.
  if (steps === 0 && semis === 0) direction = 'same';
  return {
    direction,
    number,
    simpleNumber: number === 8 ? 8 : simple,
    quality,
    semitones: Math.abs(semis),
    octaves,
  };
}

/** Inversion of a simple interval (P4 ↔ P5, M3 ↔ m6, A4 ↔ d5). Compound intervals are reduced first. */
export function invertInterval(iv: Interval): { number: number; quality: IntervalQuality } {
  const simple = ((iv.number - 1) % 7) + 1;
  const number = simple === 1 ? 8 : 9 - simple;
  const swap: Record<IntervalQuality, IntervalQuality> = { P: 'P', M: 'm', m: 'M', A: 'd', d: 'A', AA: 'dd', dd: 'AA' };
  return { number, quality: swap[iv.quality] };
}

export function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
}

const QUALITY_EN: Record<IntervalQuality, string> = {
  P: 'perfect',
  M: 'major',
  m: 'minor',
  A: 'augmented',
  d: 'diminished',
  AA: 'doubly augmented',
  dd: 'doubly diminished',
};

/** English name, e.g. "perfect 4th", "major 3rd", "octave", "unison". */
export function intervalNameEn(iv: Interval): string {
  if (iv.number === 1 && iv.quality === 'P') return 'unison';
  if (iv.number === 8 && iv.quality === 'P') return 'octave';
  return `${QUALITY_EN[iv.quality]} ${ordinal(iv.number)}`;
}

/** Short symbol, e.g. "P4", "m3", "M9". */
export function intervalShort(iv: Interval): string {
  return `${iv.quality}${iv.number}`;
}
