// One-shot previews (single pitches, strums, arpeggios) through alphaTab's synthesizer and SoundFont.

import * as alphaTab from '@coderline/alphatab';

const { MidiFile, NoteOnEvent, NoteOffEvent, ProgramChangeEvent, TempoChangeEvent } = alphaTab.midi;

const TICKS_PER_MS = 960 / 500; // tempo 120: one quarter (960 ticks) = 500 ms
const PREVIEW_CHANNEL = 15;

export interface PreviewNote {
  midi: number;
  startMs: number;
  durationMs: number;
  velocity?: number;
}

export function playPreview(api: alphaTab.AlphaTabApi | null, notes: PreviewNote[], program: number): boolean {
  const player = api?.player;
  if (!api || !player || !api.isReadyForPlayback || notes.length === 0) return false;
  const midi = new MidiFile();
  midi.addEvent(new TempoChangeEvent(0, 500000));
  midi.addEvent(new ProgramChangeEvent(0, 0, PREVIEW_CHANNEL, program));
  const events: { tick: number; on: boolean; n: PreviewNote }[] = [];
  for (const n of notes) {
    events.push({ tick: Math.round(n.startMs * TICKS_PER_MS) + 1, on: true, n });
    events.push({ tick: Math.round((n.startMs + n.durationMs) * TICKS_PER_MS) + 1, on: false, n });
  }
  events.sort((a, b) => a.tick - b.tick || (a.on ? 1 : -1));
  for (const e of events) {
    const key = Math.max(0, Math.min(127, e.n.midi));
    midi.addEvent(e.on ? new NoteOnEvent(0, e.tick, PREVIEW_CHANNEL, key, e.n.velocity ?? 100) : new NoteOffEvent(0, e.tick, PREVIEW_CHANNEL, key, 0));
  }
  player.playOneTimeMidiFile(midi);
  return true;
}

export function strum(pitches: number[], strumMs = 35, durationMs = 1800): PreviewNote[] {
  return [...pitches].sort((a, b) => a - b).map((midi, i) => ({ midi, startMs: i * strumMs, durationMs: durationMs - i * strumMs }));
}

export function arpeggio(pitches: number[], stepMs = 260): PreviewNote[] {
  const up = [...pitches].sort((a, b) => a - b);
  return up.map((midi, i) => ({ midi, startMs: i * stepMs, durationMs: (up.length - i) * stepMs + 600 }));
}

export function single(midi: number, durationMs = 1200): PreviewNote[] {
  return [{ midi, startMs: 0, durationMs }];
}
