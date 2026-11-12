// Rhythm helpers. Ticks use 960 per quarter note (same as alphaTab / MIDI convention).

export const TICKS_PER_QUARTER = 960;

/** 1 = whole, 2 = half, 4 = quarter, 8 = eighth, ... */
export type DurationValue = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;

export type DurationKey = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtySecond' | 'sixtyFourth' | 'hundredTwentyEighth';

export const DURATION_KEYS: Record<DurationValue, DurationKey> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: 'sixteenth',
  32: 'thirtySecond',
  64: 'sixtyFourth',
  128: 'hundredTwentyEighth',
};

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export function baseTicks(value: number): number {
  return (TICKS_PER_QUARTER * 4) / value;
}

/** Ticks of a duration with dots and an optional tuplet (e.g. 3:2 triplet). */
export function durationTicks(value: number, dots = 0, tuplet?: { numerator: number; denominator: number }): number {
  let t = baseTicks(value);
  let add = t;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    t += add;
  }
  if (tuplet && tuplet.numerator > 0) t = (t * tuplet.denominator) / tuplet.numerator;
  return t;
}

export function isCompound(ts: TimeSignature): boolean {
  return ts.denominator >= 8 && ts.numerator > 3 && ts.numerator % 3 === 0;
}

export interface BeatUnit {
  /** Ticks of one counted beat. */
  ticks: number;
  /** Note value of the beat (4 = quarter, 8 = eighth...). */
  value: number;
  dotted: boolean;
  beatsPerBar: number;
}

/** What one counted beat is. Compound meters (6/8, 9/8, 12/8) count dotted beats. */
export function beatUnit(ts: TimeSignature): BeatUnit {
  if (isCompound(ts)) {
    return { ticks: baseTicks(ts.denominator) * 3, value: ts.denominator / 2, dotted: true, beatsPerBar: ts.numerator / 3 };
  }
  return { ticks: baseTicks(ts.denominator), value: ts.denominator, dotted: false, beatsPerBar: ts.numerator };
}

/** Length of a note counted in denominator units (e.g. a half note in 4/4 = 2 beats, a quarter in 6/8 = 2 eighth beats). */
export function beatsIn(ticks: number, ts: TimeSignature): number {
  return round3(ticks / baseTicks(ts.denominator));
}

export interface BeatPosition {
  /** 1-based beat in the bar (counting denominator units in simple meter, dotted beats in compound). */
  beat: number;
  /** Fraction of the beat where the note starts (0, 0.5, 0.25, 0.333...). */
  offset: number;
  /** Count syllable: "" (on the beat), "&", "e", "a", "trip", "let". */
  syllable: '' | '&' | 'e' | 'a' | 'trip' | 'let' | 'other';
}

export function beatPosition(tickInBar: number, ts: TimeSignature): BeatPosition {
  const unit = beatUnit(ts);
  const beat = Math.floor(tickInBar / unit.ticks + 1e-6) + 1;
  const offset = round3((tickInBar - (beat - 1) * unit.ticks) / unit.ticks);
  let syllable: BeatPosition['syllable'] = 'other';
  if (offset === 0) syllable = '';
  else if (unit.dotted) {
    if (Math.abs(offset - 1 / 3) < 0.01) syllable = '&';
    else if (Math.abs(offset - 2 / 3) < 0.01) syllable = 'a';
  } else if (offset === 0.5) syllable = '&';
  else if (offset === 0.25) syllable = 'e';
  else if (offset === 0.75) syllable = 'a';
  else if (Math.abs(offset - 1 / 3) < 0.01) syllable = 'trip';
  else if (Math.abs(offset - 2 / 3) < 0.01) syllable = 'let';
  return { beat, offset, syllable };
}

export function barTicks(ts: TimeSignature): number {
  return baseTicks(ts.denominator) * ts.numerator;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
