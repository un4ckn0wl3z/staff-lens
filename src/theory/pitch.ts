// Pitch spelling and scientific pitch notation. Pure functions, no alphaTab.
// MIDI 60 = C4 (scientific pitch notation).

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const STEP_PC: Readonly<Record<Step, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A spelled pitch class, e.g. F# = { step: 'F', alter: 1 }. */
export interface PitchClass {
  step: Step;
  alter: number;
}

/** A spelled pitch with scientific octave, e.g. F#4. */
export interface SpelledPitch extends PitchClass {
  octave: number;
}

export const mod = (n: number, m: number): number => ((n % m) + m) % m;

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

export function pcOf(p: PitchClass): number {
  return mod(STEP_PC[p.step] + p.alter, 12);
}

export function midiOf(p: SpelledPitch): number {
  return (p.octave + 1) * 12 + STEP_PC[p.step] + p.alter;
}

/** Diatonic index (letter position counting octaves), C4 = 28. */
export function diatonicIndex(p: SpelledPitch): number {
  return p.octave * 7 + stepIndex(p.step);
}

export function accidentalText(alter: number, unicode = true): string {
  if (alter === 0) return '';
  if (unicode) {
    if (alter === 1) return '♯';
    if (alter === 2) return '𝄪';
    if (alter === -1) return '♭';
    if (alter === -2) return '𝄫';
  }
  return alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter);
}

export function pitchClassName(p: PitchClass, unicode = true): string {
  return p.step + accidentalText(p.alter, unicode);
}

/** Scientific pitch notation, e.g. "F♯4". */
export function spn(p: SpelledPitch, unicode = true): string {
  return pitchClassName(p, unicode) + p.octave;
}

/** Builds a spelled pitch from a MIDI number and a known alteration (e.g. from MusicXML <alter>). */
export function spellWithAlter(midi: number, alter: number): SpelledPitch | null {
  const natural = midi - alter;
  const pc = mod(natural, 12);
  const step = STEPS.find((s) => STEP_PC[s] === pc);
  if (!step) return null;
  return { step, alter, octave: Math.floor(natural / 12) - 1 };
}

/** Alteration the key signature applies to a step. fifths > 0 = sharps, < 0 = flats. */
export function keySignatureAlter(step: Step, fifths: number): number {
  const sharpOrder: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return sharpOrder.indexOf(step) < Math.min(fifths, 7) ? 1 : 0;
  if (fifths < 0) return flatOrder.indexOf(step) < Math.min(-fifths, 7) ? -1 : 0;
  return 0;
}

export function keySignatureSteps(fifths: number): PitchClass[] {
  const sharpOrder: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return sharpOrder.slice(0, fifths).map((step) => ({ step, alter: 1 }));
  if (fifths < 0) return flatOrder.slice(0, -fifths).map((step) => ({ step, alter: -1 }));
  return [];
}

/**
 * Spells a MIDI pitch. If `alter` is known it is used; otherwise the note is spelled
 * diatonically in the key signature, and chromatic notes use sharps in sharp keys and flats in flat keys.
 */
export function spellMidi(midi: number, keyFifths = 0, alter?: number): SpelledPitch {
  if (alter !== undefined) {
    const s = spellWithAlter(midi, alter);
    if (s) return s;
  }
  const pc = mod(midi, 12);
  // Diatonic in key?
  for (const step of STEPS) {
    const a = keySignatureAlter(step, keyFifths);
    if (mod(STEP_PC[step] + a, 12) === pc) return spellWithAlter(midi, a)!;
  }
  // Chromatic: try natural, then sharp/flat according to key direction.
  const natural = spellWithAlter(midi, 0);
  if (natural) return natural;
  return spellWithAlter(midi, keyFifths < 0 ? -1 : 1)!;
}

export function transposePitchClass(p: PitchClass, semitones: number, steps: number): PitchClass {
  const step = STEPS[mod(stepIndex(p.step) + steps, 7)];
  const target = mod(pcOf(p) + semitones, 12);
  let alter = mod(target - STEP_PC[step], 12);
  if (alter > 6) alter -= 12;
  return { step, alter };
}

export function parsePitchClass(text: string): PitchClass | null {
  const m = /^([A-Ga-g])(##|bb|#|b|♯|♭|𝄪|𝄫|x)?/.exec(text.trim());
  if (!m) return null;
  const step = m[1].toUpperCase() as Step;
  const acc = m[2] ?? '';
  const alter = { '': 0, '#': 1, '♯': 1, b: -1, '♭': -1, '##': 2, x: 2, '𝄪': 2, bb: -2, '𝄫': -2 }[acc] ?? 0;
  return { step, alter };
}

/** Parses "F#4" style scientific pitch notation. */
export function parseSpn(text: string): SpelledPitch | null {
  const m = /^([A-Ga-g](?:##|bb|#|b|♯|♭)?)(-?\d+)$/.exec(text.trim());
  if (!m) return null;
  const pc = parsePitchClass(m[1]);
  if (!pc) return null;
  return { ...pc, octave: Number(m[2]) };
}
