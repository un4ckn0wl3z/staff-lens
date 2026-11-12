// Applies a tab arrangement to a copy of the imported alphaTab score so alphaTab can render staff + tab and play it.

import * as alphaTab from '@coderline/alphatab';
import { chordShapes, shapePitches, simpleVoicing } from '../theory/chordShapes';
import { beatUnit } from '../theory/duration';
import type { Arrangement } from './arrangement';
import { chordAt, parseNoteId, type SLPart, type SLScore } from './score';

type AtScore = alphaTab.model.Score;

const { JsonConverter, Tuning, Track, Bar, Voice, Beat, Note } = alphaTab.model;

export interface RenderOptions {
  /** Add a strummed chord track generated from chord symbols. */
  accompaniment: boolean;
  /** GM program for the guitar (24 nylon, 25 steel). */
  program: number;
}

export interface RenderScore {
  score: AtScore;
  melodyTrackIndex: number;
  accompanimentTrackIndex: number | null;
}

export function cloneScore(score: AtScore, settings: alphaTab.Settings): AtScore {
  return JsonConverter.jsObjectToScore(JsonConverter.scoreToJsObject(score), settings);
}

export function buildRenderScore(
  base: AtScore,
  model: SLScore,
  part: SLPart,
  arr: Arrangement,
  opts: RenderOptions,
  settings: alphaTab.Settings,
): RenderScore {
  const score = cloneScore(base, settings);
  const track = score.tracks[part.trackIndex];
  const staff = track.staves[part.staffIndex];
  // Show only the converted staff of this track (e.g. the treble staff of a piano part).
  if (track.staves.length > 1) {
    track.staves = [staff];
    staff.index = 0;
  }
  const n = arr.tuning.length;
  staff.stringTuning = new Tuning('', [...arr.tuning], false);
  staff.capo = arr.capo;
  staff.showTablature = true;
  staff.showStandardNotation = true;
  staff.transpositionPitch = 0;
  // guitar is written an octave above sounding: either the clef says so (treble 8vb, as in many guitar files) or the
  // staff is shifted for display; never both, or the notes are drawn two octaves up
  const clef8vb = staff.bars.some((b) => b.clefOttava === alphaTab.model.Ottavia._8vb);
  staff.displayTranspositionPitch = clef8vb ? 0 : -12;
  track.playbackInfo.program = opts.program;

  for (const sl of part.notes) {
    const [, , barIdx, voiceIdx, beatIdx, noteIdx] = parseNoteId(sl.id);
    const note = staff.bars[barIdx]?.voices[voiceIdx]?.beats[beatIdx]?.notes[noteIdx];
    if (!note) continue;
    const midi = arr.guitarMidi.get(sl.id)!;
    const p = arr.placements.get(sl.id);
    if (p) {
      note.string = n - p.position.string + 1;
      note.fret = p.position.fret - arr.capo;
    } else {
      // Unplayable on guitar: keep it as a pitched note so it still shows in the staff.
      note.string = NaN;
      note.fret = NaN;
    }
    note.octave = Math.floor(midi / 12);
    note.tone = midi % 12;
  }

  for (const b of arr.bass) {
    const beat = staff.bars[b.measure]?.voices[b.voice]?.beats[b.beatIndex];
    if (!beat) continue;
    const note = new Note();
    note.string = n - b.position.string + 1;
    note.fret = b.position.fret - arr.capo;
    beat.addNote(note);
  }

  let accompanimentTrackIndex: number | null = null;
  if (opts.accompaniment && part.chords.length > 0) {
    accompanimentTrackIndex = addAccompaniment(score, model, part, opts.program);
  }

  const finished = cloneScore(score, settings);
  return { score: finished, melodyTrackIndex: part.trackIndex, accompanimentTrackIndex };
}

function freeChannels(score: AtScore): [number, number] {
  const used = new Set<number>();
  for (const t of score.tracks) {
    used.add(t.playbackInfo.primaryChannel);
    used.add(t.playbackInfo.secondaryChannel);
  }
  const free: number[] = [];
  for (let c = 0; c < 16 && free.length < 2; c++) if (c !== 9 && !used.has(c)) free.push(c);
  return [free[0] ?? 14, free[1] ?? 15];
}

function addAccompaniment(score: AtScore, model: SLScore, part: SLPart, program: number): number {
  const track = new Track();
  track.name = 'Chords';
  track.shortName = 'Ch';
  track.ensureStaveCount(1);
  const [primary, secondary] = freeChannels(score);
  track.playbackInfo.program = program;
  track.playbackInfo.primaryChannel = primary;
  track.playbackInfo.secondaryChannel = secondary;
  track.playbackInfo.volume = 9;
  const staff = track.staves[0];
  staff.showTablature = false;
  score.addTrack(track);
  const melodyStaff = score.tracks[part.trackIndex].staves[0];

  for (const m of model.measures) {
    const bar = new Bar();
    const mBar = melodyStaff.bars[m.index];
    if (mBar) {
      bar.clef = mBar.clef;
      bar.keySignature = mBar.keySignature;
      bar.keySignatureType = mBar.keySignatureType;
    }
    staff.addBar(bar);
    const voice = new Voice();
    bar.addVoice(voice);
    const unit = beatUnit(m.timeSignature);
    let t = 0;
    while (t + unit.ticks <= m.ticks + 1e-6) {
      const beat = new Beat();
      beat.duration = unit.value as alphaTab.model.Duration;
      beat.dots = unit.dotted ? 1 : 0;
      const chord = chordAt(part, m.startTick + t);
      if (chord?.parsed) {
        const shape = chordShapes(chord.parsed, 1)[0];
        const pitches = shape ? shapePitches(shape) : simpleVoicing(chord.parsed);
        for (const midi of pitches) {
          const note = new Note();
          note.octave = Math.floor(midi / 12);
          note.tone = midi % 12;
          beat.addNote(note);
        }
        beat.brushType = alphaTab.model.BrushType.BrushDown;
      } else {
        beat.isEmpty = false; // rest
      }
      voice.addBeat(beat);
      t += unit.ticks;
    }
    if (voice.beats.length === 0) {
      const rest = new Beat();
      rest.duration = alphaTab.model.Duration.Whole;
      voice.addBeat(rest);
    }
  }
  return track.index;
}

/** Maps a clicked alphaTab note in the rendered score back to the StaffLens note id. */
export function idForRenderedNote(note: alphaTab.model.Note, part: SLPart): string | null {
  const beat = note.beat;
  const bar = beat.voice.bar;
  if (bar.staff.track.index !== part.trackIndex) return null;
  return `${part.trackIndex}:${part.staffIndex}:${bar.index}:${beat.voice.index}:${beat.index}:${note.index}`;
}
