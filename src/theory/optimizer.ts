// Fingering optimizer: chooses a string/fret for every note so the whole passage is easy to play.
// Viterbi (dynamic programming) over note events. A state = (string/fret for each note of the event, hand position).

import { positionsFor, suggestFinger, type FretPosition } from './fretboard';

export type OptimizerMode = 'open' | 'position' | 'minimal';

export interface OptimizerWeights {
  /** Cost per fret the hand moves between events. */
  shift: number;
  /** Fixed cost for any hand movement. */
  shiftBase: number;
  /** Cost per fret a note lies outside the 4-fret span of the hand. */
  stretch: number;
  /** Cost per string skipped between consecutive melody notes. */
  stringSkip: number;
  /** Bonus (subtracted) per open string. */
  openBonus: number;
  /** Cost per fret above `highFretStart` (beginner mode). */
  highFret: number;
  highFretStart: number;
  /** Small cost per fret, breaks ties towards lower positions. */
  fretHeight: number;
  /** Cost per fret the hand is away from the target position (open: 1st position, position mode: N). */
  anchor: number;
}

export const MODE_WEIGHTS: Record<OptimizerMode, OptimizerWeights> = {
  open: { shift: 1, shiftBase: 0.5, stretch: 3, stringSkip: 0.3, openBonus: 1.5, highFret: 0.6, highFretStart: 4, fretHeight: 0.05, anchor: 0.4 },
  position: { shift: 1, shiftBase: 0.5, stretch: 3, stringSkip: 0.3, openBonus: 0.2, highFret: 0, highFretStart: 12, fretHeight: 0, anchor: 3 },
  minimal: { shift: 3, shiftBase: 2, stretch: 3, stringSkip: 0.3, openBonus: 0.2, highFret: 0, highFretStart: 12, fretHeight: 0.02, anchor: 0 },
};

/** Extra cost per fret above highFretStart applied in beginner mode on top of the mode weights. */
export const BEGINNER_HIGH_FRET = 0.8;

export interface OptimizerOptions {
  mode: OptimizerMode;
  /** Target hand position (fret under the index finger) for mode 'position'. */
  position?: number;
  /** Open-string pitches, string 1 (high) first. */
  tuning: number[];
  capo: number;
  maxFret: number;
  /** Adds a penalty for high frets. */
  beginner?: boolean;
  weights?: Partial<OptimizerWeights>;
}

export interface OptNote {
  id: string;
  /** Sounding guitar pitch (MIDI). */
  midi: number;
  /** User-locked position; the optimizer keeps it and plans around it. */
  locked?: FretPosition | null;
}

/** Notes attacked at the same time (a single note or a chord). */
export interface OptEvent {
  notes: OptNote[];
}

export interface OptPlacement {
  position: FretPosition;
  finger: number;
  handPosition: number;
}

export interface OptResult {
  placements: Map<string, OptPlacement>;
  /** Notes that cannot be played in the given tuning/capo/maxFret (or too many notes for the strings). */
  unplayable: string[];
  totalCost: number;
}

interface State {
  positions: FretPosition[]; // parallel to event.notes (playable ones)
  hand: number;
  local: number;
  melodyString: number;
}

const MAX_ASSIGNMENTS = 48;

export function optimizeFingering(events: OptEvent[], opts: OptimizerOptions): OptResult {
  const w: OptimizerWeights = { ...MODE_WEIGHTS[opts.mode], ...opts.weights };
  if (opts.beginner) w.highFret += BEGINNER_HIGH_FRET;
  const { tuning, capo, maxFret } = opts;
  const minHand = capo + 1;
  const maxHand = Math.max(minHand, maxFret - 3);
  const target = opts.mode === 'position' ? Math.max(minHand, Math.min(maxHand, opts.position ?? minHand)) : minHand;

  const unplayable: string[] = [];
  const layers: { notes: OptNote[]; states: State[] }[] = [];

  for (const ev of events) {
    const cands: { note: OptNote; positions: FretPosition[] }[] = [];
    for (const note of ev.notes) {
      let positions: FretPosition[];
      if (note.locked) positions = [note.locked];
      else positions = positionsFor(note.midi, tuning, capo, maxFret);
      if (positions.length === 0) unplayable.push(note.id);
      else cands.push({ note, positions });
    }
    // Too many notes for the strings: keep the highest and lowest, drop inner notes.
    cands.sort((a, b) => b.note.midi - a.note.midi);
    while (cands.length > tuning.length) {
      const removed = cands.splice(Math.floor(cands.length / 2), 1)[0];
      unplayable.push(removed.note.id);
    }
    if (cands.length === 0) continue;
    const assignments = assign(cands.map((c) => c.positions), capo).slice(0, MAX_ASSIGNMENTS);
    const states: State[] = [];
    for (const positions of assignments) {
      for (const hand of handOptions(positions, capo, minHand, maxHand)) {
        states.push({
          positions,
          hand,
          local: localCost(positions, hand, w, opts.mode, target, capo),
          melodyString: positions[0].string, // cands sorted high -> low, so [0] is the top (melody) note
        });
      }
    }
    if (states.length === 0) {
      cands.forEach((c) => unplayable.push(c.note.id));
      continue;
    }
    layers.push({ notes: cands.map((c) => c.note), states });
  }

  // Viterbi
  const placements = new Map<string, OptPlacement>();
  if (layers.length === 0) return { placements, unplayable, totalCost: 0 };
  let prevCost = layers[0].states.map((s) => s.local);
  const back: Int32Array[] = [new Int32Array(layers[0].states.length).fill(-1)];
  for (let i = 1; i < layers.length; i++) {
    const prev = layers[i - 1].states;
    const cur = layers[i].states;
    const cost = new Array<number>(cur.length);
    const bp = new Int32Array(cur.length);
    for (let j = 0; j < cur.length; j++) {
      let best = Infinity;
      let arg = 0;
      for (let k = 0; k < prev.length; k++) {
        const c = prevCost[k] + transitionCost(prev[k], cur[j], w);
        if (c < best) {
          best = c;
          arg = k;
        }
      }
      cost[j] = best + cur[j].local;
      bp[j] = arg;
    }
    prevCost = cost;
    back.push(bp);
  }
  let idx = 0;
  for (let j = 1; j < prevCost.length; j++) if (prevCost[j] < prevCost[idx]) idx = j;
  const totalCost = prevCost[idx];
  for (let i = layers.length - 1; i >= 0; i--) {
    const s = layers[i].states[idx];
    layers[i].notes.forEach((n, k) => {
      const position = s.positions[k];
      placements.set(n.id, { position, handPosition: s.hand, finger: suggestFinger(position, s.hand, capo) });
    });
    idx = back[i][idx];
  }
  return { placements, unplayable, totalCost };
}

/** All ways to put the notes on distinct strings, cheapest (smallest span) first. */
function assign(cands: FretPosition[][], capo: number, strictOrder = true): FretPosition[][] {
  const out: FretPosition[][] = [];
  const cur: FretPosition[] = [];
  const used = new Set<number>();
  const limit = 2000;
  const rec = (i: number): void => {
    if (out.length >= limit) return;
    if (i === cands.length) {
      out.push([...cur]);
      return;
    }
    for (const p of cands[i]) {
      if (used.has(p.string)) continue;
      // pitch order must match string order (higher note on a higher string = lower string number)
      if (strictOrder && i > 0 && p.string <= cur[i - 1].string) continue;
      used.add(p.string);
      cur.push(p);
      rec(i + 1);
      cur.pop();
      used.delete(p.string);
    }
  };
  rec(0);
  // A locked note can force an unusual voicing; then allow crossed strings.
  if (out.length === 0 && strictOrder) return assign(cands, capo, false);
  const span =(ps: FretPosition[]) => {
    const f = ps.filter((p) => p.fret > capo).map((p) => p.fret);
    return f.length ? Math.max(...f) - Math.min(...f) : 0;
  };
  return out.sort((a, b) => span(a) - span(b));
}

function handOptions(positions: FretPosition[], capo: number, minHand: number, maxHand: number): number[] {
  const fretted = positions.filter((p) => p.fret > capo).map((p) => p.fret);
  const out: number[] = [];
  if (fretted.length === 0) {
    for (let h = minHand; h <= maxHand; h++) out.push(h);
    return out;
  }
  const lo = Math.min(...fretted);
  const hi = Math.max(...fretted);
  const from = Math.max(minHand, hi - 3);
  const to = Math.min(maxHand, lo);
  for (let h = from; h <= to; h++) out.push(h);
  if (out.length === 0) out.push(Math.max(minHand, Math.min(maxHand, lo)));
  return out;
}

function localCost(positions: FretPosition[], hand: number, w: OptimizerWeights, mode: OptimizerMode, target: number, capo: number): number {
  let c = 0;
  for (const p of positions) {
    const rel = p.fret - capo;
    if (p.fret === capo) {
      c -= w.openBonus;
      continue;
    }
    if (p.fret < hand) c += w.stretch * (hand - p.fret);
    if (p.fret > hand + 3) c += w.stretch * (p.fret - hand - 3);
    c += w.fretHeight * rel;
    if (rel > w.highFretStart) c += w.highFret * (rel - w.highFretStart);
  }
  if (mode === 'position') c += w.anchor * Math.abs(hand - target);
  else c += w.anchor * (hand - target);
  return c;
}

function transitionCost(a: State, b: State, w: OptimizerWeights): number {
  let c = 0;
  const d = Math.abs(a.hand - b.hand);
  if (d > 0) c += w.shiftBase + w.shift * d;
  const gap = Math.abs(a.melodyString - b.melodyString);
  if (gap > 1) c += w.stringSkip * (gap - 1);
  return c;
}
