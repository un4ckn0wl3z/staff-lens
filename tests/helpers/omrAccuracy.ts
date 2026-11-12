// Note accuracy of an OMR result against the score the page was rendered from.
import * as alphaTab from '@coderline/alphatab';
import { fromAlphaTab } from '../../src/model/fromAlphaTab';
import type { SLScore } from '../../src/model/score';

export function scoreFromMusicXml(xml: string, fileName = 'page.musicxml'): SLScore {
  const at = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml));
  return fromAlphaTab(at, { kind: 'musicxml', fileName });
}

/** Voice-1 events in order: "64+67:960" (written MIDI pitches : length in ticks) or "r:1920". */
export function events(score: SLScore): { bar: number; token: string; pitch: string }[] {
  const part = score.parts[0];
  const byId = new Map(part.notes.map((n) => [n.id, n]));
  return part.beats
    .filter((b) => b.voice === 0 && !b.isGrace)
    .sort((a, b) => a.measure - b.measure || a.tick - b.tick)
    .map((b) => {
      const pitches = b.noteIds.map((id) => byId.get(id)!.writtenMidi).sort((x, y) => x - y);
      const pitch = pitches.length ? pitches.join('+') : 'r';
      return { bar: b.measure, token: `${pitch}:${b.durationTicks}`, pitch };
    });
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const score01 = (truth: string[], got: string[]) => Math.max(0, 1 - editDistance(truth, got) / Math.max(1, truth.length));

export interface Accuracy {
  /** pitch and length of every note and rest */
  events: number;
  /** pitches only (notes in order, rests and lengths ignored) */
  pitches: number;
  /** printed bars recognised */
  bars: [found: number, expected: number];
  truthNotes: number;
  foundNotes: number;
}

export function accuracy(truth: SLScore, got: SLScore): Accuracy {
  const t = events(truth);
  const g = events(got);
  const notes = (e: typeof t) => e.filter((x) => x.pitch !== 'r').map((x) => x.pitch);
  return {
    events: score01(t.map((e) => e.token), g.map((e) => e.token)),
    pitches: score01(notes(t), notes(g)),
    bars: [got.measures.length, truth.measures.length],
    truthNotes: notes(t).length,
    foundNotes: notes(g).length,
  };
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const label = (e: { token: string }) => {
  const [p, d] = e.token.split(':');
  const name = p === 'r' ? 'r' : p.split('+').map((m) => NAMES[+m % 12] + (Math.floor(+m / 12) - 1)).join('+');
  return `${name}/${+(3840 / +d).toFixed(1)}`; // "/4" quarter, "/2.7" dotted quarter, "/5.3" dotted eighth
};

/** Side-by-side listing per printed bar (for reading what the recogniser got wrong). */
export function barDiff(truth: SLScore, got: SLScore): string {
  const t = events(truth);
  const g = events(got);
  const bars = Math.max(truth.measures.length, got.measures.length);
  const lines: string[] = [];
  for (let b = 0; b < bars; b++) {
    const a = t.filter((e) => e.bar === b).map(label).join(' ');
    const o = g.filter((e) => e.bar === b).map(label).join(' ');
    lines.push(`${a === o ? ' ' : '≠'} bar ${b + 1}: ${a || '—'}  |  ${o || '—'}`);
  }
  return lines.join('\n');
}
