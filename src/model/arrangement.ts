// Staff -> tab: builds the guitar arrangement of one part from the score model and the user's settings.

import { bassPosition, rangeReport, suggestOctaveShift, type RangeReport } from '../theory/arrange';
import { chordRootPc } from '../theory/chord';
import { TUNINGS, type FretPosition, type TuningPreset } from '../theory/fretboard';
import { optimizeFingering, type OptEvent, type OptimizerMode, type OptPlacement } from '../theory/optimizer';
import { chordAt, type SLNote, type SLPart, type SLScore } from './score';

export interface TabSettings {
  tuningId: TuningPreset['id'];
  capo: number;
  mode: OptimizerMode;
  /** Hand position for mode 'position'. */
  position: number;
  beginner: boolean;
  maxFret: number;
  addBass: boolean;
  /** Octave shift per measure index (missing = 0). */
  octaveShift: Record<number, number>;
  /** Locked positions per note id. */
  locks: Record<string, FretPosition>;
}

export const DEFAULT_TAB_SETTINGS: TabSettings = {
  tuningId: 'standard',
  capo: 0,
  mode: 'open',
  position: 5,
  beginner: true,
  maxFret: 15,
  addBass: false,
  octaveShift: {},
  locks: {},
};

export interface BassNote {
  measure: number;
  voice: number;
  beatIndex: number;
  midi: number;
  position: FretPosition;
  chord: string;
}

export interface Arrangement {
  tuning: number[];
  capo: number;
  placements: Map<string, OptPlacement>;
  /** Sounding guitar pitch for every note of the part. */
  guitarMidi: Map<string, number>;
  unplayable: Set<string>;
  bass: BassNote[];
  range: RangeReport;
  /** Octave shift (whole part) that would make the most notes playable. */
  suggestedShift: number;
}

/** Guitar convention: play what is written, it sounds an octave lower. */
export function guitarPitchOf(note: SLNote, settings: TabSettings): number {
  return note.writtenMidi - 12 + 12 * (settings.octaveShift[note.measure] ?? 0);
}

export function arrange(score: SLScore, part: SLPart, settings: TabSettings): Arrangement {
  const tuning = TUNINGS[settings.tuningId].strings;
  const { capo, maxFret } = settings;
  const guitarMidi = new Map<string, number>();
  for (const n of part.notes) guitarMidi.set(n.id, guitarPitchOf(n, settings));

  // Group attacks into events. Tie destinations are not re-attacked: they copy their origin.
  const groups = new Map<string, SLNote[]>();
  for (const n of part.notes) {
    if (n.isTieDestination && n.tieOriginId) continue;
    const key = n.isGrace ? `${n.absTick}-g${n.measure}:${n.voice}:${n.beatIndex}` : `${n.absTick}`;
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].absTick - b[0].absTick || (a[0].isGrace ? -1 : 0) - (b[0].isGrace ? -1 : 0));
  const events: OptEvent[] = ordered.map((notes) => ({
    notes: notes.map((n) => {
      const lock = settings.locks[n.id];
      const midi = guitarMidi.get(n.id)!;
      // A lock only applies while it still produces this pitch (settings like capo/tuning may have changed).
      const valid = lock && tuning[lock.string - 1] + lock.fret === midi && lock.fret >= capo && lock.fret <= maxFret;
      return { id: n.id, midi, locked: valid ? lock : null };
    }),
  }));

  const result = optimizeFingering(events, {
    mode: settings.mode,
    position: settings.position,
    tuning,
    capo,
    maxFret,
    beginner: settings.beginner,
  });
  const placements = result.placements;
  const unplayable = new Set(result.unplayable);

  // Resolve ties (origins come first in time, but chains may be long: iterate until stable)
  const byId = new Map(part.notes.map((n) => [n.id, n]));
  const resolveTie = (n: SLNote, depth = 0): OptPlacement | null => {
    if (!n.isTieDestination || !n.tieOriginId || depth > 64) return placements.get(n.id) ?? null;
    const origin = byId.get(n.tieOriginId);
    return origin ? resolveTie(origin, depth + 1) : null;
  };
  for (const n of part.notes) {
    if (!n.isTieDestination || !n.tieOriginId) continue;
    const p = resolveTie(n);
    if (p) placements.set(n.id, p);
    else unplayable.add(n.id);
  }

  const bass: BassNote[] = settings.addBass ? addBass(score, part, tuning, capo, placements, guitarMidi) : [];

  const pitches = part.notes.map((n) => guitarMidi.get(n.id)!);
  return {
    tuning,
    capo,
    placements,
    guitarMidi,
    unplayable,
    bass,
    range: rangeReport(pitches, tuning, capo, maxFret),
    suggestedShift: suggestOctaveShift(
      part.notes.map((n) => n.writtenMidi - 12),
      tuning,
      capo,
      maxFret,
    ),
  };
}

function addBass(
  score: SLScore,
  part: SLPart,
  tuning: number[],
  capo: number,
  placements: Map<string, OptPlacement>,
  guitarMidi: Map<string, number>,
): BassNote[] {
  const out: BassNote[] = [];
  for (const m of score.measures) {
    const chord = chordAt(part, m.startTick);
    if (!chord?.parsed) continue;
    const atStart = part.notes.filter((n) => n.measure === m.index && n.tick === 0 && n.voice === 0 && !n.isGrace);
    if (atStart.length === 0) continue; // a rest or no beat on 1 in voice 1
    const beatIndex = atStart[0].beatIndex;
    const dur = atStart[0].durationTicks;
    // Melody notes that sound while the bass rings: everything attacked in [start, start + dur), plus ties into it.
    const ringing = part.notes.filter((n) => n.absTick >= m.startTick && n.absTick < m.startTick + dur);
    const melody = ringing
      .map((n) => ({ p: placements.get(n.id), midi: guitarMidi.get(n.id)! }))
      .filter((x): x is { p: OptPlacement; midi: number } => !!x.p)
      .map((x) => ({ string: x.p.position.string, midi: x.midi }));
    if (melody.length === 0) continue;
    const hand = placements.get(atStart[0].id)?.handPosition ?? capo + 1;
    const pos = bassPosition(chordRootPc(chord.parsed), melody, tuning, capo, hand);
    if (!pos) continue;
    out.push({ measure: m.index, voice: 0, beatIndex, midi: tuning[pos.string - 1] + pos.fret, position: pos, chord: chord.text });
  }
  return out;
}
