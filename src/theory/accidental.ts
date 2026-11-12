import { keySignatureAlter, type SpelledPitch } from './pitch';

export type AccidentalSource =
  /** No accidental at all: natural note, key signature does not touch it. */
  | 'none'
  /** Altered by the key signature (e.g. F played as F# in G major). */
  | 'keySignature'
  /** An accidental is printed on this note. */
  | 'explicit'
  /** An accidental printed earlier in the same bar still applies. */
  | 'carried'
  /** Tied over from the previous note, which already had the accidental. */
  | 'tied';

export interface AccidentalInfo {
  source: AccidentalSource;
  /** Alteration the key signature would apply to this step. */
  keyAlter: number;
  /** Actual alteration of the note. */
  alter: number;
  /** For 'explicit': whether the printed sign cancels the key signature (natural sign). */
  cancelsKey: boolean;
}

export interface BarNoteForAccidentals {
  pitch: SpelledPitch;
  isTieDestination?: boolean;
}

/**
 * Works out, for each note in one bar (in time order, single staff), why it has its alteration:
 * key signature, a printed accidental, or an accidental carried from earlier in the bar.
 * Follows the standard rule: an accidental lasts until the end of the bar for the same staff position (step + octave).
 */
export function explainAccidentals(notes: BarNoteForAccidentals[], keyFifths: number): AccidentalInfo[] {
  const active = new Map<string, number>(); // "F4" -> alter currently in force in this bar
  return notes.map((n) => {
    const { step, octave, alter } = n.pitch;
    const posKey = `${step}${octave}`;
    const keyAlter = keySignatureAlter(step, keyFifths);
    const inForce = active.has(posKey) ? active.get(posKey)! : keyAlter;
    let source: AccidentalSource;
    if (n.isTieDestination) {
      source = alter !== 0 || keyAlter !== 0 ? 'tied' : 'none';
      // a tie carries the pitch; it does not set a new accidental for later notes unless it differs
      if (alter !== inForce) active.set(posKey, alter);
    } else if (alter === inForce) {
      if (active.has(posKey) && active.get(posKey) !== keyAlter) source = 'carried';
      else source = alter === 0 ? 'none' : 'keySignature';
    } else {
      source = 'explicit';
      active.set(posKey, alter);
    }
    return { source, keyAlter, alter, cancelsKey: source === 'explicit' && alter === 0 && keyAlter !== 0 };
  });
}
