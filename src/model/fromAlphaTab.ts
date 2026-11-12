// Converts an alphaTab Score into the StaffLens score model.

import type * as alphaTab from '@coderline/alphatab';
import { parseChordSymbol } from '../theory/chord';
import { spellMidi, spellWithAlter } from '../theory/pitch';
import type { JumpMarker, RepeatBar, TargetMarker } from '../theory/repeats';
import type { ParsedHarmony } from './musicxmlHarmony';
import { noteId, type ClefKind, type SLBeat, type SLChord, type SLMeasure, type SLNote, type SLPart, type SLScore } from './score';

type AtScore = alphaTab.model.Score;
type AtStaff = alphaTab.model.Staff;

// alphaTab enum values (kept numeric so this module does not need the runtime import)
const DIRECTION_TARGET: Record<number, TargetMarker> = { 0: 'fine', 1: 'segno', 3: 'coda' };
const DIRECTION_JUMP: Record<number, JumpMarker> = {
  5: 'daCapo',
  6: 'daCapoAlCoda',
  8: 'daCapoAlFine',
  9: 'dalSegno',
  10: 'dalSegnoAlCoda',
  12: 'dalSegnoAlFine',
  17: 'toCoda',
};
const CLEF: Record<number, ClefKind> = { 0: 'neutral', 1: 'alto', 2: 'tenor', 3: 'bass', 4: 'treble' };
/** NoteAccidentalMode -> alter */
const ACCIDENTAL_ALTER: Record<number, number> = { 2: 0, 3: 1, 4: 2, 5: -1, 6: -2 };

/** alphaTab stores spaces in texts as non-breaking spaces. */
const clean = (s: string | null | undefined): string => (s ?? '').replace(/ /g, ' ').trim();

export function fromAlphaTab(
  score: AtScore,
  source: SLScore['source'],
  harmony?: ParsedHarmony[][] | null,
): SLScore {
  const firstStaff = score.tracks[0]?.staves[0];
  const measures: SLMeasure[] = score.masterBars.map((mb) => {
    const bar = firstStaff?.bars[mb.index];
    const repeat: RepeatBar = {};
    if (mb.isRepeatStart) repeat.repeatStart = true;
    if (mb.repeatCount > 0) repeat.repeatEnd = mb.repeatCount;
    if (mb.alternateEndings) {
      const endings: number[] = [];
      for (let k = 0; k < 8; k++) if (mb.alternateEndings & (1 << k)) endings.push(k + 1);
      repeat.endings = endings;
    }
    if (mb.directions) {
      for (const d of mb.directions) {
        if (DIRECTION_TARGET[d]) (repeat.targets ??= []).push(DIRECTION_TARGET[d]);
        if (DIRECTION_JUMP[d]) (repeat.jumps ??= []).push(DIRECTION_JUMP[d]);
      }
    }
    const tempoAuto = mb.tempoAutomations?.[0];
    return {
      index: mb.index,
      timeSignature: { numerator: mb.timeSignatureNumerator, denominator: mb.timeSignatureDenominator },
      keyFifths: bar ? Number(bar.keySignature) : 0,
      keyMinor: bar ? Number(bar.keySignatureType) === 1 : false,
      startTick: mb.start,
      ticks: mb.calculateDuration(),
      repeat,
      section: mb.section ? clean(mb.section.marker) || clean(mb.section.text) || null : null,
      tempo: tempoAuto ? tempoAuto.value : null,
      isAnacrusis: mb.isAnacrusis,
    };
  });

  const parts: SLPart[] = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      const part = convertStaff(staff, measures, harmony?.[track.index] ?? null);
      if (part.notes.length > 0) parts.push(part);
    }
  }

  return {
    title: clean(score.title) || source.fileName.replace(/\.[^.]+$/, ''),
    subtitle: clean(score.subTitle),
    composer: clean(score.music) || clean(score.artist) || clean(score.words),
    tempo: score.tempo,
    measures,
    parts,
    source,
  };
}

function convertStaff(staff: AtStaff, measures: SLMeasure[], harmony: ParsedHarmony[] | null): SLPart {
  const track = staff.track;
  const notes: SLNote[] = [];
  const beats: SLBeat[] = [];
  const chords: SLChord[] = [];
  const tuningLen = staff.tuning.length;
  for (const bar of staff.bars) {
    const m = measures[bar.index];
    const fifths = m?.keyFifths ?? 0;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        // Chord symbols: alphaTab chords, or beat text that reads as a chord (how StaffLens/TabLens GP5 files store them).
        const beatText = clean(beat.text);
        const chordName = beat.chord ? clean(beat.chord.name) : beatText && parseChordSymbol(beatText) ? beatText : '';
        if (chordName && !harmony) {
          chords.push({
            measure: bar.index,
            tick: beat.displayStart,
            absTick: (m?.startTick ?? 0) + beat.displayStart,
            text: chordName,
            parsed: parseChordSymbol(chordName),
          });
        }
        if (beat.isEmpty) continue;
        const slBeat: SLBeat = {
          measure: bar.index,
          voice: voice.index,
          beatIndex: beat.index,
          tick: beat.displayStart,
          durationTicks: beat.displayDuration,
          durationValue: Number(beat.duration),
          dots: beat.dots,
          tuplet: beat.hasTuplet ? { numerator: beat.tupletNumerator, denominator: beat.tupletDenominator } : null,
          isGrace: Number(beat.graceType) !== 0,
          noteIds: [],
        };
        beats.push(slBeat);
        if (beat.isRest) continue;
        for (const note of beat.notes) {
          if (note.isPercussion) continue;
          const writtenMidi = note.displayValueWithoutBend;
          const alter = ACCIDENTAL_ALTER[note.accidentalMode as number];
          const written = (alter !== undefined ? spellWithAlter(writtenMidi, alter) : null) ?? spellMidi(writtenMidi, fifths);
          const origin = note.isTieDestination ? note.tieOrigin : null;
          const id = noteId(track.index, staff.index, bar.index, voice.index, beat.index, note.index);
          slBeat.noteIds.push(id);
          notes.push({
            id,
            measure: bar.index,
            voice: voice.index,
            beatIndex: beat.index,
            noteIndex: note.index,
            tick: beat.displayStart,
            absTick: (m?.startTick ?? 0) + beat.displayStart,
            durationTicks: beat.displayDuration,
            durationValue: Number(beat.duration),
            dots: beat.dots,
            tuplet: beat.hasTuplet ? { numerator: beat.tupletNumerator, denominator: beat.tupletDenominator } : null,
            writtenMidi,
            soundingMidi: note.realValueWithoutHarmonic,
            written,
            isTieDestination: note.isTieDestination,
            tieOriginId: origin
              ? noteId(track.index, staff.index, origin.beat.voice.bar.index, origin.beat.voice.index, origin.beat.index, origin.index)
              : null,
            isGrace: Number(beat.graceType) !== 0,
            sourceString: note.isStringed && tuningLen > 0 ? tuningLen - note.string + 1 : null,
            sourceFret: note.isStringed ? note.fret + staff.capo : null,
          });
        }
      }
    }
  }
  if (harmony) {
    for (const h of harmony) {
      const m = measures[h.measure];
      if (!m) continue;
      chords.push({ measure: h.measure, tick: h.tick, absTick: m.startTick + h.tick, text: h.text, parsed: parseChordSymbol(h.text) });
    }
  }
  chords.sort((a, b) => a.absTick - b.absTick);
  const firstBar = staff.bars[0];
  const firstNote = notes[0];
  return {
    trackIndex: track.index,
    staffIndex: staff.index,
    name: clean(track.name) || `Track ${track.index + 1}`,
    program: track.playbackInfo.program,
    clef: firstBar ? (CLEF[Number(firstBar.clef)] ?? 'treble') : 'treble',
    octaveTransposed: staff.displayTranspositionPitch === -12 || (firstNote ? firstNote.writtenMidi - firstNote.soundingMidi === 12 : false),
    hasTab: tuningLen > 0 && notes.some((n) => n.sourceString !== null),
    sourceTuning: tuningLen > 0 ? [...staff.tuning] : null,
    sourceCapo: staff.capo,
    notes,
    beats,
    chords,
  };
}
