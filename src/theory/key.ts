import { keySignatureAlter, mod, pcOf, pitchClassName, stepIndex, STEPS, type PitchClass } from './pitch';

export type Mode = 'major' | 'minor';

export interface Key {
  tonic: PitchClass;
  mode: Mode;
  /** Key signature: number of sharps (> 0) or flats (< 0). */
  fifths: number;
}

const MAJOR_TONICS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_TONICS = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

function parseTonic(t: string): PitchClass {
  return { step: t[0] as PitchClass['step'], alter: t.length > 1 ? (t[1] === '#' ? 1 : -1) : 0 };
}

export function majorKeyFor(fifths: number): Key {
  const f = Math.max(-7, Math.min(7, fifths));
  return { tonic: parseTonic(MAJOR_TONICS[f + 7]), mode: 'major', fifths: f };
}

export function minorKeyFor(fifths: number): Key {
  const f = Math.max(-7, Math.min(7, fifths));
  return { tonic: parseTonic(MINOR_TONICS[f + 7]), mode: 'minor', fifths: f };
}

export function keyName(key: Key, unicode = true): string {
  return `${pitchClassName(key.tonic, unicode)} ${key.mode}`;
}

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** The 7 spelled scale tones of the key (natural minor for minor keys). */
export function scaleOf(key: Key): PitchClass[] {
  const start = stepIndex(key.tonic.step);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const step = STEPS[(start + i) % 7];
    return { step, alter: keySignatureAlter(step, key.fifths) };
  });
}

export const DEGREE_NAMES = ['tonic', 'supertonic', 'mediant', 'subdominant', 'dominant', 'submediant', 'leading tone'] as const;
export type DegreeName = (typeof DEGREE_NAMES)[number] | 'subtonic';

export interface ScaleDegree {
  /** 1..7 */
  degree: number;
  /** Chromatic alteration relative to the key's scale: -1 = lowered, +1 = raised. */
  alter: number;
  name: DegreeName;
  /** Label like "5", "♭7", "♯4". */
  label: string;
  /** True for the raised 6th/7th in minor (melodic/harmonic minor). */
  minorRaised: boolean;
}

export function scaleDegree(p: PitchClass, key: Key): ScaleDegree {
  const degree = mod(stepIndex(p.step) - stepIndex(key.tonic.step), 7) + 1;
  const scale = key.mode === 'major' ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const actual = mod(pcOf(p) - pcOf(key.tonic), 12);
  let alter = actual - scale[degree - 1];
  if (alter > 6) alter -= 12;
  if (alter < -6) alter += 12;
  let name: DegreeName = DEGREE_NAMES[degree - 1];
  if (degree === 7 && key.mode === 'minor' && alter === 0) name = 'subtonic';
  const minorRaised = key.mode === 'minor' && (degree === 6 || degree === 7) && alter === 1;
  const label = (alter > 0 ? '♯'.repeat(alter) : '♭'.repeat(-alter)) + degree;
  return { degree, alter, name, label, minorRaised };
}

export interface KeyEvidenceNote {
  midi: number;
  durationTicks: number;
}

export interface KeyDetectionInput {
  fifths: number;
  notes: KeyEvidenceNote[];
  /** Root pitch class (0..11) and whether minor, of the last chord symbol if any. */
  finalChord?: { rootPc: number; minor: boolean } | null;
}

export type KeyReason = 'lastNote' | 'firstNote' | 'finalChord' | 'tonicWeight' | 'leadingTone' | 'default';

export interface KeyDetection {
  key: Key;
  candidates: [Key, Key];
  scores: [number, number];
  /** Reasons that favoured the chosen key. */
  reasons: KeyReason[];
}

/**
 * Picks major or relative minor for a key signature using simple, explainable evidence:
 * last note, first note, final chord, how often each tonic sounds, and the minor-key leading tone.
 */
export function detectKey(input: KeyDetectionInput): KeyDetection {
  const major = majorKeyFor(input.fifths);
  const minor = minorKeyFor(input.fifths);
  const majPc = pcOf(major.tonic);
  const minPc = pcOf(minor.tonic);
  const reasons: [KeyReason[], KeyReason[]] = [[], []];
  const score: [number, number] = [0.5, 0]; // tiny bias to major when there is no evidence
  const notes = input.notes;
  if (notes.length > 0) {
    const last = mod(notes[notes.length - 1].midi, 12);
    const first = mod(notes[0].midi, 12);
    if (last === majPc) (score[0] += 3, reasons[0].push('lastNote'));
    if (last === minPc) (score[1] += 3, reasons[1].push('lastNote'));
    if (first === majPc) (score[0] += 1, reasons[0].push('firstNote'));
    if (first === minPc) (score[1] += 1, reasons[1].push('firstNote'));
    const weight = new Array(12).fill(0);
    let total = 0;
    for (const n of notes) {
      weight[mod(n.midi, 12)] += n.durationTicks;
      total += n.durationTicks;
    }
    if (total > 0) {
      const wMaj = (weight[majPc] + 0.5 * weight[mod(majPc + 7, 12)]) / total;
      const wMin = (weight[minPc] + 0.5 * weight[mod(minPc + 7, 12)]) / total;
      if (wMaj > wMin + 0.02) (score[0] += 2, reasons[0].push('tonicWeight'));
      else if (wMin > wMaj + 0.02) (score[1] += 2, reasons[1].push('tonicWeight'));
      // Raised 7th of the minor key (e.g. G# in A minor) is strong minor evidence.
      const leading = mod(minPc + 11, 12);
      if (weight[leading] / total > 0.01) (score[1] += 2, reasons[1].push('leadingTone'));
    }
  }
  const fc = input.finalChord;
  if (fc) {
    if (fc.rootPc === majPc && !fc.minor) (score[0] += 4, reasons[0].push('finalChord'));
    if (fc.rootPc === minPc && fc.minor) (score[1] += 4, reasons[1].push('finalChord'));
  }
  const pickMinor = score[1] > score[0];
  const chosenReasons = pickMinor ? reasons[1] : reasons[0];
  return {
    key: pickMinor ? minor : major,
    candidates: [major, minor],
    scores: score,
    reasons: chosenReasons.length ? chosenReasons : ['default'],
  };
}

/** Tonic pitch class of the key as a number 0..11. */
export function tonicPc(key: Key): number {
  return pcOf(key.tonic);
}
