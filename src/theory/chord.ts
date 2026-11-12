import { scaleDegree, type Key } from './key';
import {
  mod,
  parsePitchClass,
  pcOf,
  pitchClassName,
  transposePitchClass,
  type PitchClass,
} from './pitch';

export type ChordQuality =
  | 'major'
  | 'minor'
  | 'dominant7'
  | 'major7'
  | 'minor7'
  | 'minorMajor7'
  | 'diminished'
  | 'diminished7'
  | 'halfDiminished7'
  | 'augmented'
  | 'sus2'
  | 'sus4'
  | 'dominant7sus4'
  | 'add9'
  | 'minorAdd9'
  | 'major6'
  | 'minor6'
  | 'dominant9'
  | 'major9'
  | 'minor9'
  | 'power5';

/** A chord tone: degree label ("1", "3", "♭3", "♭7", "9") and its interval in semitones/letters. */
export interface ChordDegree {
  label: string;
  semitones: number;
  /** Letter steps above the root (0 = root, 2 = third, 4 = fifth, 6 = seventh, 1 = ninth/second, 3 = fourth, 5 = sixth). */
  steps: number;
  role: ChordToneRole;
}

export type ChordToneRole = 'root' | '3rd' | '5th' | '7th' | '9th' | '2nd' | '4th' | '6th';

const D = (label: string, semitones: number, steps: number, role: ChordToneRole): ChordDegree => ({ label, semitones, steps, role });
const R = D('1', 0, 0, 'root');
const M3 = D('3', 4, 2, '3rd');
const m3 = D('♭3', 3, 2, '3rd');
const P5 = D('5', 7, 4, '5th');
const d5 = D('♭5', 6, 4, '5th');
const A5 = D('♯5', 8, 4, '5th');
const m7 = D('♭7', 10, 6, '7th');
const M7 = D('7', 11, 6, '7th');
const d7 = D('𝄫7', 9, 6, '7th');
const M9 = D('9', 14, 1, '9th');
const M2 = D('2', 2, 1, '2nd');
const P4 = D('4', 5, 3, '4th');
const M6 = D('6', 9, 5, '6th');

const QUALITIES: Record<ChordQuality, ChordDegree[]> = {
  major: [R, M3, P5],
  minor: [R, m3, P5],
  dominant7: [R, M3, P5, m7],
  major7: [R, M3, P5, M7],
  minor7: [R, m3, P5, m7],
  minorMajor7: [R, m3, P5, M7],
  diminished: [R, m3, d5],
  diminished7: [R, m3, d5, d7],
  halfDiminished7: [R, m3, d5, m7],
  augmented: [R, M3, A5],
  sus2: [R, M2, P5],
  sus4: [R, P4, P5],
  dominant7sus4: [R, P4, P5, m7],
  add9: [R, M3, P5, M9],
  minorAdd9: [R, m3, P5, M9],
  major6: [R, M3, P5, M6],
  minor6: [R, m3, P5, M6],
  dominant9: [R, M3, P5, m7, M9],
  major9: [R, M3, P5, M7, M9],
  minor9: [R, m3, P5, m7, M9],
  power5: [R, P5],
};

// Suffix spellings, longest first. Includes alphaTab's MusicXML kind names (7M, ○, ⍉, mMaj).
const SUFFIXES: [RegExp, ChordQuality][] = [
  [/^(m7b5|m7♭5|ø7?|⍉7?|min7b5|-7b5)$/, 'halfDiminished7'],
  [/^(dim7|°7|o7|○7)$/, 'diminished7'],
  [/^(dim|°|o|○)$/, 'diminished'],
  [/^(mmaj7|mMaj7?|m\(maj7\)|minmaj7|-maj7|m7M)$/, 'minorMajor7'],
  [/^(maj9|M9|Δ9)$/, 'major9'],
  [/^(m9|min9|-9)$/, 'minor9'],
  [/^(9)$/, 'dominant9'],
  [/^(maj7|M7|Δ7?|7M|ma7)$/, 'major7'],
  [/^(m7|min7|-7|mi7)$/, 'minor7'],
  [/^(7sus4|7sus)$/, 'dominant7sus4'],
  [/^(7)$/, 'dominant7'],
  [/^(madd9|m\(add9\)|minadd9)$/, 'minorAdd9'],
  [/^(add9|\(add9\)|add2)$/, 'add9'],
  [/^(m6|min6|-6)$/, 'minor6'],
  [/^(6|maj6|M6)$/, 'major6'],
  [/^(sus2)$/, 'sus2'],
  [/^(sus4|sus)$/, 'sus4'],
  [/^(aug|\+|\+5|#5)$/, 'augmented'],
  [/^(m|min|mi|-)$/, 'minor'],
  [/^(5)$/, 'power5'],
  [/^(|maj|M|major)$/, 'major'],
];

export interface ChordSymbol {
  /** Text as written, e.g. "E7", "G/B". */
  text: string;
  root: PitchClass;
  quality: ChordQuality;
  /** Suffix as written after the root, e.g. "7", "maj7", "m". */
  suffix: string;
  bass: PitchClass | null;
  degrees: ChordDegree[];
}

export function parseChordSymbol(input: string): ChordSymbol | null {
  const text = input.trim();
  const root = parsePitchClass(text);
  if (!root) return null;
  const rootLen = /^[A-Ga-g](##|bb|#|b|♯|♭)?/.exec(text)![0].length;
  let rest = text.slice(rootLen);
  let bass: PitchClass | null = null;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const b = parsePitchClass(rest.slice(slash + 1));
    if (b) {
      bass = b;
      rest = rest.slice(0, slash);
    }
  }
  const suffix = rest.trim();
  const norm = suffix.replace(/\s+/g, '');
  for (const [re, quality] of SUFFIXES) {
    if (re.test(norm)) return { text, root, quality, suffix, bass, degrees: QUALITIES[quality] };
  }
  return null;
}

export function chordNotes(chord: ChordSymbol): PitchClass[] {
  return chord.degrees.map((d) => transposePitchClass(chord.root, d.semitones, d.steps));
}

/** e.g. "1-3-5-♭7" */
export function chordFormula(chord: ChordSymbol): string {
  return chord.degrees.map((d) => d.label).join('-');
}

export function chordDisplayName(chord: ChordSymbol, unicode = true): string {
  const suffix: Record<ChordQuality, string> = {
    major: '',
    minor: 'm',
    dominant7: '7',
    major7: 'maj7',
    minor7: 'm7',
    minorMajor7: 'm(maj7)',
    diminished: 'dim',
    diminished7: 'dim7',
    halfDiminished7: 'm7♭5',
    augmented: 'aug',
    sus2: 'sus2',
    sus4: 'sus4',
    dominant7sus4: '7sus4',
    add9: 'add9',
    minorAdd9: 'm(add9)',
    major6: '6',
    minor6: 'm6',
    dominant9: '9',
    major9: 'maj9',
    minor9: 'm9',
    power5: '5',
  };
  const bass = chord.bass ? '/' + pitchClassName(chord.bass, unicode) : '';
  return pitchClassName(chord.root, unicode) + suffix[chord.quality] + bass;
}

export function isMinorish(q: ChordQuality): boolean {
  return ['minor', 'minor7', 'minorMajor7', 'minor6', 'minor9', 'minorAdd9', 'diminished', 'diminished7', 'halfDiminished7'].includes(q);
}

/** Role of a pitch class in a chord, or null if it is a non-chord tone. Bass of a slash chord counts as 'root' only if it is the root. */
export function chordToneRole(pc: number, chord: ChordSymbol): ChordToneRole | null {
  const rel = mod(pc - pcOf(chord.root), 12);
  const d = chord.degrees.find((x) => mod(x.semitones, 12) === rel);
  return d ? d.role : null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export interface ChordFunction {
  /** Roman numeral in the key, e.g. "V7", "vi", "♭VII". */
  roman: string;
  /** True if all chord tones belong to the key (natural minor + raised 7th allowed in minor). */
  diatonic: boolean;
  /** For secondary dominants: the roman numeral of the target, e.g. "vi" for V7/vi. */
  secondaryOf: string | null;
  /** Roman numeral of the next chord, if this chord resolves to it by a falling fifth. */
  resolvesTo: string | null;
}

function romanFor(chord: ChordSymbol, key: Key): string {
  const deg = scaleDegree(chord.root, key);
  const minorish = isMinorish(chord.quality);
  let r = ROMAN[deg.degree - 1];
  if (minorish) r = r.toLowerCase();
  const prefix = deg.alter < 0 ? '♭' : deg.alter > 0 ? '♯' : '';
  const suffix: Partial<Record<ChordQuality, string>> = {
    dominant7: '7',
    major7: 'maj7',
    minor7: '7',
    diminished: '°',
    diminished7: '°7',
    halfDiminished7: 'ø7',
    augmented: '+',
    dominant9: '9',
    major9: 'maj9',
    minor9: '9',
    major6: '6',
    minor6: '6',
    sus4: 'sus4',
    sus2: 'sus2',
    dominant7sus4: '7sus4',
  };
  return prefix + r + (suffix[chord.quality] ?? '');
}

function isDiatonic(chord: ChordSymbol, key: Key): boolean {
  return chordNotes(chord).every((n) => {
    const d = scaleDegree(n, key);
    return d.alter === 0 || d.minorRaised;
  });
}

const isDominantQuality = (q: ChordQuality) => q === 'dominant7' || q === 'dominant9' || q === 'major' || q === 'dominant7sus4';

/**
 * Function of a chord in a key. Recognises secondary dominants when the chord is a
 * non-diatonic dominant whose root is a fifth above a diatonic chord (and, if given, the next chord is that chord).
 */
export function chordFunction(chord: ChordSymbol, key: Key, next?: ChordSymbol | null): ChordFunction {
  const roman = romanFor(chord, key);
  const diatonic = isDiatonic(chord, key);
  const nextRoman = next ? romanFor(next, key) : null;
  const fallsFifth = next ? mod(pcOf(chord.root) - pcOf(next.root), 12) === 7 : false;
  let secondaryOf: string | null = null;
  if (!diatonic && isDominantQuality(chord.quality)) {
    // Target = a fifth below the root.
    const target = transposePitchClass(chord.root, -7, -4);
    const tDeg = scaleDegree(target, key);
    if (tDeg.alter === 0 && tDeg.degree !== 1 && (!next || fallsFifth)) {
      // Case follows the diatonic triad on that degree (ii, iii, vi in major), as in "V7/vi".
      const targetIsMinor = key.mode === 'major' ? [2, 3, 6].includes(tDeg.degree) : [1, 4, 5].includes(tDeg.degree);
      let t = ROMAN[tDeg.degree - 1];
      if (targetIsMinor) t = t.toLowerCase();
      secondaryOf = t;
    }
  }
  return {
    roman: secondaryOf ? `V${chord.quality === 'major' ? '' : '7'}/${secondaryOf}` : roman,
    diatonic,
    secondaryOf,
    resolvesTo: fallsFifth ? nextRoman : null,
  };
}

export type NonChordToneType = 'passing' | 'neighbor' | 'appoggiatura' | 'escape' | 'other';

/** Classifies a non-chord tone by how it is approached and left (semitone steps of 1–2 count as steps). */
export function classifyNonChordTone(prev: number | null, cur: number, next: number | null): NonChordToneType {
  if (prev === null || next === null) return 'other';
  const a = cur - prev;
  const b = next - cur;
  const isStep = (d: number) => Math.abs(d) >= 1 && Math.abs(d) <= 2;
  if (isStep(a) && isStep(b) && Math.sign(a) === Math.sign(b)) return 'passing';
  if (isStep(a) && isStep(b) && next === prev) return 'neighbor';
  if (Math.abs(a) > 2 && isStep(b) && Math.sign(a) !== Math.sign(b)) return 'appoggiatura';
  if (isStep(a) && Math.abs(b) > 2 && Math.sign(a) !== Math.sign(b)) return 'escape';
  return 'other';
}

/** Pitch class of the root as 0..11. */
export function chordRootPc(chord: ChordSymbol): number {
  return pcOf(chord.root);
}

export { pitchClassName };
