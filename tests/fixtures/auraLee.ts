// Aura Lee (W. W. Fosdick / G. R. Poulton, 1861 — public domain). Key G, 4/4.
// Written pitches for guitar (guitar sounds one octave lower than written).

export interface FixtureNote {
  pitch: string;
  /** 4 = quarter, 2 = half, 1 = whole */
  value: 1 | 2 | 4;
}

const q = (pitch: string): FixtureNote => ({ pitch, value: 4 });
const h = (pitch: string): FixtureNote => ({ pitch, value: 2 });
const w = (pitch: string): FixtureNote => ({ pitch, value: 1 });

export const VERSE: FixtureNote[][] = [
  [q('D4'), q('G4'), q('F#4'), q('G4')],
  [q('A4'), q('E4'), h('A4')],
  [q('G4'), q('F#4'), q('E4'), q('F#4')],
  [w('G4')],
];

export const CHORUS: FixtureNote[][] = [
  [q('B4'), q('B4'), h('B4')],
  [q('B4'), q('B4'), h('B4')],
  [q('B4'), q('A4'), q('G4'), q('A4')],
  [w('B4')],
  [q('B4'), q('B4'), q('C5'), q('B4')],
  [q('A4'), q('E4'), q('A4'), q('G4')],
  [q('G4'), q('F#4'), q('B4'), q('A4')],
  [w('G4')],
];

/** All 16 bars as played (bars 5–8 repeat 1–4). */
export const AURA_LEE_BARS: FixtureNote[][] = [...VERSE, ...VERSE, ...CHORUS];

/** Expected open-position tab, string:fret with string 1 = high E (from the spec). */
export const EXPECTED_OPEN: Record<string, string> = {
  D4: '4:0',
  E4: '4:2',
  'F#4': '4:4',
  G4: '3:0',
  A4: '3:2',
  B4: '2:0',
  C5: '2:1',
};

/** Chord symbols of the bundled sample, per printed bar (12 printed bars, verse has a repeat sign). */
export const AURA_LEE_CHORDS: string[][] = [
  ['G'],
  ['A7'],
  ['D7'],
  ['G'],
  ['G'],
  ['B7'],
  ['Em'],
  ['G7'],
  ['Cmaj7'],
  ['E7', 'A7'],
  ['D7'],
  ['G'],
];
