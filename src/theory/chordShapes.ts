// Common open chord shapes and movable barre shapes (standard tuning).
// Frets are listed low E (string 6) -> high E (string 1); -1 = muted.

import { chordNotes, type ChordQuality, type ChordSymbol } from './chord';
import { mod, pcOf, pitchClassName } from './pitch';

export interface ChordShape {
  /** low E -> high E, -1 = muted, absolute frets */
  frets: number[];
  /** finger per string, 0 = open/muted */
  fingers: number[];
  /** fret of a barre, if any */
  barre?: number;
  kind: 'open' | 'barre';
  /** name of the movable shape ("E shape", "A shape") for barre chords */
  shapeName?: string;
}

const OPEN: Record<string, [string, string]> = {
  // name: [frets low->high, fingers]
  C: ['x32010', '032010'],
  A: ['x02220', '001230'],
  G: ['320003', '210003'],
  E: ['022100', '023100'],
  D: ['xx0232', '000132'],
  F: ['xx3211', '003211'],
  Am: ['x02210', '002310'],
  Em: ['022000', '023000'],
  Dm: ['xx0231', '000231'],
  C7: ['x32310', '032410'],
  A7: ['x02020', '002030'],
  G7: ['320001', '320001'],
  E7: ['020100', '020100'],
  D7: ['xx0212', '000213'],
  B7: ['x21202', '021304'],
  Cmaj7: ['x32000', '032000'],
  Amaj7: ['x02120', '002130'],
  Dmaj7: ['xx0222', '000111'],
  Fmaj7: ['xx3210', '003210'],
  Gmaj7: ['320002', '210003'],
  Emaj7: ['021100', '031200'],
  Am7: ['x02010', '002010'],
  Em7: ['022030', '012040'],
  Dm7: ['xx0211', '000211'],
  Bm7: ['x20202', '010203'],
  Asus2: ['x02200', '001200'],
  Asus4: ['x02230', '001230'],
  Dsus2: ['xx0230', '000130'],
  Dsus4: ['xx0233', '000134'],
  Esus4: ['022200', '023400'],
  Cadd9: ['x32030', '021030'],
  Gadd9: ['320203', '210304'],
  A6: ['x02222', '001111'],
  C6: ['x32210', '042310'],
  D6: ['xx0202', '000102'],
  E5: ['022xxx', '011000'],
  A5: ['x022xx', '001100'],
  Bdim: ['x2343x', '012430'],
  Ddim: ['xx0131', '000132'],
  Caug: ['x32110', '043120'],
  Bm7b5: ['x2323x', '013240'],
};

// Movable barre templates relative to the barre fret (0 = barre), on the 6th string (E shape) or 5th string (A shape).
const E_SHAPES: Partial<Record<ChordQuality, [number[], number[]]>> = {
  major: [[0, 2, 2, 1, 0, 0], [1, 3, 4, 2, 1, 1]],
  minor: [[0, 2, 2, 0, 0, 0], [1, 3, 4, 1, 1, 1]],
  dominant7: [[0, 2, 0, 1, 0, 0], [1, 3, 1, 2, 1, 1]],
  minor7: [[0, 2, 0, 0, 0, 0], [1, 3, 1, 1, 1, 1]],
  major7: [[0, -1, 1, 1, 0, -1], [1, 0, 3, 4, 2, 0]],
  sus4: [[0, 2, 2, 2, 0, 0], [1, 2, 3, 4, 1, 1]],
  power5: [[0, 2, 2, -1, -1, -1], [1, 3, 4, 0, 0, 0]],
};
const A_SHAPES: Partial<Record<ChordQuality, [number[], number[]]>> = {
  major: [[-1, 0, 2, 2, 2, 0], [0, 1, 2, 3, 4, 1]],
  minor: [[-1, 0, 2, 2, 1, 0], [0, 1, 3, 4, 2, 1]],
  dominant7: [[-1, 0, 2, 0, 2, 0], [0, 1, 3, 1, 4, 1]],
  minor7: [[-1, 0, 2, 0, 1, 0], [0, 1, 3, 1, 2, 1]],
  major7: [[-1, 0, 2, 1, 2, 0], [0, 1, 3, 2, 4, 1]],
  sus4: [[-1, 0, 2, 2, 3, 0], [0, 1, 2, 3, 4, 1]],
  sus2: [[-1, 0, 2, 2, 0, 0], [0, 1, 3, 4, 1, 1]],
  halfDiminished7: [[-1, 0, 1, 0, 1, -1], [0, 1, 2, 1, 3, 0]],
  power5: [[-1, 0, 2, 2, -1, -1], [0, 1, 3, 4, 0, 0]],
};

// Root on the 4th (D) string.
const D_SHAPES: Partial<Record<ChordQuality, [number[], number[]]>> = {
  diminished7: [[-1, -1, 0, 1, 0, 1], [0, 0, 1, 3, 2, 4]],
  diminished: [[-1, -1, 0, 1, 3, 1], [0, 0, 1, 2, 4, 3]],
};

const QUALITY_KEY: Partial<Record<ChordQuality, string>> = {
  major: '',
  minor: 'm',
  dominant7: '7',
  major7: 'maj7',
  minor7: 'm7',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  major6: '6',
  power5: '5',
  diminished: 'dim',
  augmented: 'aug',
  halfDiminished7: 'm7b5',
};

function parseFrets(s: string): number[] {
  return [...s].map((c) => (c === 'x' ? -1 : Number(c)));
}

/** Up to `limit` shapes: the open shape if one exists, then E-shape / A-shape barre chords. */
export function chordShapes(chord: ChordSymbol, limit = 2): ChordShape[] {
  const out: ChordShape[] = [];
  const q = QUALITY_KEY[chord.quality];
  if (q !== undefined) {
    // Try enharmonic root names too (A# vs Bb don't have open shapes anyway).
    const name = pitchClassName(chord.root, false) + q;
    const open = OPEN[name];
    if (open) out.push({ frets: parseFrets(open[0]), fingers: parseFrets(open[1]).map((f) => Math.max(0, f)), kind: 'open' });
  }
  const rootPc = pcOf(chord.root);
  const candidates: ChordShape[] = [];
  const e = E_SHAPES[chord.quality];
  if (e) {
    const fret = mod(rootPc - 4, 12) || 12; // E string open = E (pc 4)
    candidates.push(barreFrom(e, fret, 'E shape'));
  }
  const a = A_SHAPES[chord.quality];
  if (a) {
    const fret = mod(rootPc - 9, 12) || 12; // A string open = A (pc 9)
    candidates.push(barreFrom(a, fret, 'A shape'));
  }
  const d = D_SHAPES[chord.quality];
  if (d) {
    const fret = mod(rootPc - 2, 12) || 12; // D string open = D (pc 2)
    candidates.push(barreFrom(d, fret, 'D shape'));
  }
  candidates.sort((x, y) => (x.barre ?? 0) - (y.barre ?? 0));
  for (const c of candidates) if (out.length < limit) out.push(c);
  return out.slice(0, limit);
}

function barreFrom([rel, fingers]: [number[], number[]], fret: number, shapeName: string): ChordShape {
  return {
    frets: rel.map((r) => (r < 0 ? -1 : r + fret)),
    fingers: rel.map((r, i) => (r < 0 ? 0 : fingers[i])),
    barre: fret,
    kind: 'barre',
    shapeName,
  };
}

/** MIDI pitches of a shape (low to high), standard tuning. */
export function shapePitches(shape: ChordShape, tuningLowToHigh = [40, 45, 50, 55, 59, 64]): number[] {
  return shape.frets.map((f, i) => (f < 0 ? -1 : tuningLowToHigh[i] + f)).filter((m) => m >= 0);
}

/** Simple voicing for any chord (root in the bass around E2–E3, tones above), used when no shape exists. */
export function simpleVoicing(chord: ChordSymbol): number[] {
  const rootPc = pcOf(chord.root);
  const bass = 40 + mod(rootPc - 4, 12);
  const tones = chordNotes(chord).map((p) => pcOf(p));
  const out = [bass];
  let cur = bass + 7;
  for (const pc of [...tones.slice(1), tones[0]]) {
    let m = cur - mod(cur - pc, 12) + 12;
    while (m <= out[out.length - 1]) m += 12;
    out.push(m);
    cur = m;
  }
  return out;
}
