// Export: Guitar Pro 5, ASCII tab (pure, from the model + arrangement).
// GP7 (.gp), MIDI and print go through alphaTab in the UI layer.

import type { Arrangement } from '../model/arrangement';
import type { SLBeat, SLPart, SLScore } from '../model/score';
import { asciiTab, type AsciiBar } from '../theory/asciiTab';
import { keyName, majorKeyFor, minorKeyFor } from '../theory/key';
import { writeGp5, type Gp5Beat, type Gp5Measure, type Gp5Song } from './gp5writer';

function gp5Beats(part: SLPart, arr: Arrangement, measure: number, voice: number): Gp5Beat[] {
  const byId = new Map(part.notes.map((n) => [n.id, n]));
  const chordsAt = new Map(part.chords.filter((c) => c.measure === measure).map((c) => [c.tick, c.text]));
  const bassByBeat = new Map(arr.bass.filter((b) => b.measure === measure && b.voice === voice).map((b) => [b.beatIndex, b]));
  return part.beats
    .filter((b: SLBeat) => b.measure === measure && b.voice === voice && !b.isGrace)
    .map((b) => {
      const notes = b.noteIds
        .map((id) => {
          const p = arr.placements.get(id);
          const n = byId.get(id);
          if (!p || !n) return null;
          return { string: p.position.string, fret: p.position.fret - arr.capo, type: n.isTieDestination ? ('tie' as const) : ('normal' as const) };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const bass = bassByBeat.get(b.beatIndex);
      if (bass && !notes.some((x) => x.string === bass.position.string)) notes.push({ string: bass.position.string, fret: bass.position.fret - arr.capo, type: 'normal' });
      const beat: Gp5Beat = {
        dur: b.durationValue > 0 ? b.durationValue : 1,
        dotted: b.dots > 0,
        tuplet: b.tuplet ? b.tuplet.numerator : undefined,
        rest: notes.length === 0,
        notes,
      };
      const chord = voice === 0 ? chordsAt.get(b.tick) : undefined;
      if (chord) beat.text = chord;
      return beat;
    });
}

export function toGp5Song(score: SLScore, part: SLPart, arr: Arrangement, program = 24): Gp5Song {
  const measures: Gp5Measure[] = score.measures.map((m) => {
    let alternative = 0;
    for (const e of m.repeat.endings ?? []) alternative |= 1 << (e - 1);
    const beats2 = gp5Beats(part, arr, m.index, 1);
    return {
      num: m.timeSignature.numerator,
      den: m.timeSignature.denominator,
      repeatOpen: !!m.repeat.repeatStart,
      repeatClose: m.repeat.repeatEnd ?? 0,
      alternative,
      marker: m.section ?? undefined,
      keyFifths: m.keyFifths,
      keyMinor: m.keyMinor,
      beats: gp5Beats(part, arr, m.index, 0),
      beats2: beats2.length ? beats2 : undefined,
    };
  });
  return {
    title: score.title,
    subtitle: score.subtitle,
    music: score.composer,
    tab: 'StaffLens',
    tempo: score.tempo,
    tracks: [{ name: part.name || 'Guitar', tuning: arr.tuning, capo: arr.capo, instrument: program, fretCount: 24, measures }],
  };
}

export function exportGp5(score: SLScore, part: SLPart, arr: Arrangement, program = 24): Uint8Array {
  return writeGp5(toGp5Song(score, part, arr, program));
}

export function exportAscii(score: SLScore, part: SLPart, arr: Arrangement): string {
  const bars: AsciiBar[] = score.measures.map(() => ({ events: [] }));
  const byTick = new Map<string, AsciiBar['events'][number]>();
  for (const n of part.notes) {
    const p = arr.placements.get(n.id);
    const key = `${n.measure}:${n.tick}`;
    let ev = byTick.get(key);
    if (!ev) {
      ev = { tick: n.tick, duration: n.durationTicks, notes: [] };
      byTick.set(key, ev);
      bars[n.measure].events.push(ev);
    }
    ev.duration = Math.min(ev.duration, n.durationTicks);
    if (p && !ev.notes.some((x) => x.string === p.position.string)) {
      ev.notes.push({ string: p.position.string, fret: p.position.fret - arr.capo, tied: n.isTieDestination });
    }
  }
  for (const b of arr.bass) {
    const ev = bars[b.measure].events.find((e) => e.tick === 0);
    if (ev && !ev.notes.some((x) => x.string === b.position.string)) ev.notes.push({ string: b.position.string, fret: b.position.fret - arr.capo });
  }
  // rests keep their space
  for (const b of part.beats) {
    if (b.noteIds.length > 0 || b.voice !== 0) continue;
    const key = `${b.measure}:${b.tick}`;
    if (!byTick.has(key)) {
      const ev = { tick: b.tick, duration: b.durationTicks, notes: [] };
      byTick.set(key, ev);
      bars[b.measure].events.push(ev);
    }
  }
  const first = score.measures[0];
  const key = first ? (first.keyMinor ? minorKeyFor(first.keyFifths) : majorKeyFor(first.keyFifths)) : null;
  const header = [
    score.composer ? score.composer : '',
    `Tempo ${Math.round(score.tempo)}${first ? ` · ${first.timeSignature.numerator}/${first.timeSignature.denominator}` : ''}${key ? ` · ${keyName(key, false)}` : ''}`,
    `Tuning ${arr.tuning
      .slice()
      .reverse()
      .map((m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12])
      .join(' ')}`,
  ].filter(Boolean);
  return asciiTab(bars, { tuning: arr.tuning, title: score.title, capo: arr.capo, header });
}
