import { describe, expect, it } from 'vitest';
import { explainAccidentals } from '../src/theory/accidental';
import { bassPosition, rangeReport, suggestOctaveShift } from '../src/theory/arrange';
import { asciiTab } from '../src/theory/asciiTab';
import { chordFormula, chordFunction, chordNotes, chordToneRole, classifyNonChordTone, parseChordSymbol } from '../src/theory/chord';
import { chordShapes } from '../src/theory/chordShapes';
import { beatPosition, beatsIn, beatUnit, durationTicks } from '../src/theory/duration';
import { positionsFor, STANDARD, suggestFinger, TUNINGS } from '../src/theory/fretboard';
import { intervalBetween, intervalNameEn } from '../src/theory/interval';
import { detectKey, keyName, majorKeyFor, minorKeyFor, scaleDegree } from '../src/theory/key';
import { optimizeFingering, type OptEvent } from '../src/theory/optimizer';
import { midiOf, parseSpn, pitchClassName, spellMidi, spn } from '../src/theory/pitch';
import { formatPlayOrder, playOrder, type RepeatBar } from '../src/theory/repeats';
import { AURA_LEE_BARS, EXPECTED_OPEN } from './fixtures/auraLee';

const P = (s: string) => parseSpn(s)!;
const names = (pcs: { step: string; alter: number }[]) => pcs.map((p) => pitchClassName(p as never, false)).join(' ');

describe('pitch', () => {
  it('converts scientific pitch notation to MIDI', () => {
    expect(midiOf(P('C4'))).toBe(60);
    expect(midiOf(P('A4'))).toBe(69);
    expect(midiOf(P('E2'))).toBe(40);
    expect(midiOf(P('Cb4'))).toBe(59);
    expect(midiOf(P('B#3'))).toBe(60);
  });

  it('spells MIDI pitches in a key', () => {
    expect(spn(spellMidi(66, 1), false)).toBe('F#4'); // G major
    expect(spn(spellMidi(70, -1), false)).toBe('Bb4'); // F major
    expect(spn(spellMidi(61, 0), false)).toBe('C#4'); // chromatic in C -> sharp
    expect(spn(spellMidi(61, -2), false)).toBe('Db4'); // chromatic in Bb -> flat
    expect(spn(spellMidi(66, 0, -1), false)).toBe('Gb4'); // explicit alter wins
  });
});

describe('intervals', () => {
  it('names intervals with direction', () => {
    const iv = intervalBetween(P('D4'), P('G4'));
    expect(iv.direction).toBe('up');
    expect(intervalNameEn(iv)).toBe('perfect 4th');
    expect(intervalNameEn(intervalBetween(P('G4'), P('F#4')))).toBe('minor 2nd');
    expect(intervalBetween(P('G4'), P('F#4')).direction).toBe('down');
    expect(intervalNameEn(intervalBetween(P('F4'), P('B4')))).toBe('augmented 4th');
    expect(intervalNameEn(intervalBetween(P('B3'), P('F4')))).toBe('diminished 5th');
    expect(intervalNameEn(intervalBetween(P('C4'), P('C5')))).toBe('octave');
    expect(intervalNameEn(intervalBetween(P('C4'), P('E5')))).toBe('major 10th');
    expect(intervalBetween(P('A4'), P('A4')).direction).toBe('same');
  });
});

describe('keys', () => {
  it('maps key signatures to candidate keys', () => {
    expect(keyName(majorKeyFor(1), false)).toBe('G major');
    expect(keyName(minorKeyFor(1), false)).toBe('E minor');
    expect(keyName(majorKeyFor(-3), false)).toBe('Eb major');
    expect(keyName(minorKeyFor(4), false)).toBe('C# minor');
  });

  it('detects G major for Aura Lee', () => {
    const notes = AURA_LEE_BARS.flat().map((n) => ({ midi: midiOf(P(n.pitch)), durationTicks: 3840 / n.value }));
    const d = detectKey({ fifths: 1, notes });
    expect(keyName(d.key, false)).toBe('G major');
    expect(d.reasons).toContain('lastNote');
  });

  it('detects A minor from the raised 7th and last note', () => {
    const notes = ['A4', 'C5', 'B4', 'G#4', 'A4', 'E4', 'A4'].map((s) => ({ midi: midiOf(P(s)), durationTicks: 960 }));
    expect(keyName(detectKey({ fifths: 0, notes }).key, false)).toBe('A minor');
  });

  it('uses the final chord', () => {
    const notes = [{ midi: 64, durationTicks: 960 }];
    expect(detectKey({ fifths: 0, notes, finalChord: { rootPc: 9, minor: true } }).key.mode).toBe('minor');
  });

  it('gives scale degrees', () => {
    const g = majorKeyFor(1);
    expect(scaleDegree({ step: 'F', alter: 1 }, g).degree).toBe(7);
    expect(scaleDegree({ step: 'F', alter: 1 }, g).name).toBe('leading tone');
    expect(scaleDegree({ step: 'F', alter: 0 }, g).label).toBe('♭7');
    expect(scaleDegree({ step: 'D', alter: 0 }, g).name).toBe('dominant');
    const am = minorKeyFor(0);
    expect(scaleDegree({ step: 'G', alter: 1 }, am).minorRaised).toBe(true);
  });
});

describe('accidentals', () => {
  it('explains where each alteration comes from', () => {
    const bar = [P('F#4'), P('F4'), P('F4'), P('G4'), P('F#5')].map((pitch) => ({ pitch }));
    const info = explainAccidentals(bar, 1);
    expect(info.map((i) => i.source)).toEqual(['keySignature', 'explicit', 'carried', 'none', 'keySignature']);
    expect(info[1].cancelsKey).toBe(true);
  });

  it('handles accidentals in C major', () => {
    const info = explainAccidentals([P('C#4'), P('C#4'), P('C4')].map((pitch) => ({ pitch })), 0);
    expect(info.map((i) => i.source)).toEqual(['explicit', 'carried', 'explicit']);
  });
});

describe('durations', () => {
  it('counts beats', () => {
    const ts = { numerator: 4, denominator: 4 };
    expect(beatsIn(durationTicks(2), ts)).toBe(2);
    expect(beatsIn(durationTicks(4, 1), ts)).toBe(1.5);
    expect(beatsIn(durationTicks(8, 0, { numerator: 3, denominator: 2 }), ts)).toBeCloseTo(0.333, 2);
    expect(beatPosition(960 * 2, ts)).toEqual({ beat: 3, offset: 0, syllable: '' });
    expect(beatPosition(960 + 480, ts).syllable).toBe('&');
  });

  it('knows compound meter beats', () => {
    const u = beatUnit({ numerator: 6, denominator: 8 });
    expect(u.dotted).toBe(true);
    expect(u.beatsPerBar).toBe(2);
    expect(beatPosition(480 * 3, { numerator: 6, denominator: 8 }).beat).toBe(2);
  });
});

describe('chords', () => {
  it('parses symbols and builds formulas', () => {
    const e7 = parseChordSymbol('E7')!;
    expect(chordFormula(e7)).toBe('1-3-5-♭7');
    expect(names(chordNotes(e7))).toBe('E G# B D');
    expect(names(chordNotes(parseChordSymbol('Cmaj7')!))).toBe('C E G B');
    expect(names(chordNotes(parseChordSymbol('Am')!))).toBe('A C E');
    expect(names(chordNotes(parseChordSymbol('Bbm7')!))).toBe('Bb Db F Ab');
    expect(names(chordNotes(parseChordSymbol('Bdim')!))).toBe('B D F');
    expect(names(chordNotes(parseChordSymbol('Dsus4')!))).toBe('D G A');
    expect(names(chordNotes(parseChordSymbol('Cadd9')!))).toBe('C E G D');
    expect(parseChordSymbol('G/B')!.bass).toEqual({ step: 'B', alter: 0 });
    expect(parseChordSymbol('C7M')!.quality).toBe('major7'); // alphaTab MusicXML naming
    expect(parseChordSymbol('B○')!.quality).toBe('diminished');
    expect(parseChordSymbol('Hello')).toBeNull();
  });

  it('labels chord tones', () => {
    const e7 = parseChordSymbol('E7')!;
    expect(chordToneRole(4, e7)).toBe('root');
    expect(chordToneRole(8, e7)).toBe('3rd');
    expect(chordToneRole(2, e7)).toBe('7th');
    expect(chordToneRole(9, e7)).toBeNull();
  });

  it('finds chord functions and secondary dominants', () => {
    const c = majorKeyFor(0);
    const f1 = chordFunction(parseChordSymbol('G7')!, c, parseChordSymbol('C'));
    expect(f1.roman).toBe('V7');
    expect(f1.resolvesTo).toBe('I');
    const f2 = chordFunction(parseChordSymbol('E7')!, c, parseChordSymbol('Am'));
    expect(f2.roman).toBe('V7/vi');
    expect(f2.resolvesTo).toBe('vi');
    expect(chordFunction(parseChordSymbol('D7')!, c, parseChordSymbol('G7')).roman).toBe('V7/V');
    expect(chordFunction(parseChordSymbol('Am')!, c).roman).toBe('vi');
    // In A minor, E7 is the regular dominant
    expect(chordFunction(parseChordSymbol('E7')!, minorKeyFor(0), parseChordSymbol('Am')).roman).toBe('V7');
  });

  it('classifies non-chord tones', () => {
    expect(classifyNonChordTone(67, 69, 71)).toBe('passing');
    expect(classifyNonChordTone(67, 69, 67)).toBe('neighbor');
    expect(classifyNonChordTone(60, 66, 64)).toBe('appoggiatura');
    expect(classifyNonChordTone(null, 66, 64)).toBe('other');
  });

  it('provides chord diagrams', () => {
    const c = chordShapes(parseChordSymbol('C')!);
    expect(c[0].kind).toBe('open');
    expect(c[0].frets).toEqual([-1, 3, 2, 0, 1, 0]);
    const fsm = chordShapes(parseChordSymbol('F#m')!);
    expect(fsm[0].kind).toBe('barre');
    expect(fsm[0].frets).toEqual([2, 4, 4, 2, 2, 2]);
    expect(chordShapes(parseChordSymbol('Bbmaj7')!)[0].barre).toBe(1);
  });
});

describe('fretboard', () => {
  it('lists every position for a pitch', () => {
    expect(positionsFor(55, STANDARD)).toEqual([
      { string: 3, fret: 0 },
      { string: 4, fret: 5 },
      { string: 5, fret: 10 },
      { string: 6, fret: 15 },
    ]);
    expect(positionsFor(55, STANDARD, 2)).toHaveLength(3);
    expect(positionsFor(38, TUNINGS.dropD.strings)).toEqual([{ string: 6, fret: 0 }]);
  });

  it('suggests fingers', () => {
    expect(suggestFinger({ string: 4, fret: 4 }, 1)).toBe(4);
    expect(suggestFinger({ string: 3, fret: 0 }, 1)).toBe(0);
    expect(suggestFinger({ string: 2, fret: 7 }, 5)).toBe(3);
  });
});

function auraEvents(): { events: OptEvent[]; pitches: string[] } {
  const pitches = AURA_LEE_BARS.flat().map((n) => n.pitch);
  // Guitar sounds an octave below written pitch.
  const events = pitches.map((p, i) => ({ notes: [{ id: `n${i}`, midi: midiOf(P(p)) - 12 }] }));
  return { events, pitches };
}

describe('fingering optimizer', () => {
  it('produces the expected open-position tab for Aura Lee', () => {
    const { events, pitches } = auraEvents();
    const res = optimizeFingering(events, { mode: 'open', tuning: STANDARD, capo: 0, maxFret: 15 });
    expect(res.unplayable).toEqual([]);
    pitches.forEach((p, i) => {
      const pl = res.placements.get(`n${i}`)!;
      expect(`${pl.position.string}:${pl.position.fret}`, `${p} (note ${i})`).toBe(EXPECTED_OPEN[p]);
    });
  });

  it('respects locked notes and re-plans around them', () => {
    const { events } = auraEvents();
    // Lock the first chorus B4 (index 24) to 3:4
    events[24].notes[0].locked = { string: 3, fret: 4 };
    const res = optimizeFingering(events, { mode: 'open', tuning: STANDARD, capo: 0, maxFret: 15 });
    expect(res.placements.get('n24')!.position).toEqual({ string: 3, fret: 4 });
  });

  it('stays in a requested position', () => {
    const { events } = auraEvents();
    const res = optimizeFingering(events, { mode: 'position', position: 5, tuning: STANDARD, capo: 0, maxFret: 15 });
    for (const pl of res.placements.values()) {
      if (pl.position.fret > 0) {
        expect(pl.position.fret).toBeGreaterThanOrEqual(4);
        expect(pl.position.fret).toBeLessThanOrEqual(9);
      }
    }
  });

  it('minimize-movement mode keeps the hand still', () => {
    const { events } = auraEvents();
    const res = optimizeFingering(events, { mode: 'minimal', tuning: STANDARD, capo: 0, maxFret: 15 });
    const hands = new Set([...res.placements.values()].map((p) => p.handPosition));
    expect(hands.size).toBeLessThanOrEqual(2);
  });

  it('places chords on distinct strings and flags unplayable notes', () => {
    const res = optimizeFingering(
      [
        { notes: [{ id: 'a', midi: 48 }, { id: 'b', midi: 52 }, { id: 'c', midi: 55 }, { id: 'd', midi: 60 }, { id: 'e', midi: 64 }] },
        { notes: [{ id: 'low', midi: 30 }] },
      ],
      { mode: 'open', tuning: STANDARD, capo: 0, maxFret: 15 },
    );
    const strings = ['a', 'b', 'c', 'd', 'e'].map((id) => res.placements.get(id)!.position.string);
    expect(new Set(strings).size).toBe(5);
    // Open C chord
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => res.placements.get(id)!.position.fret)).toEqual([3, 2, 0, 1, 0]);
    expect(res.unplayable).toEqual(['low']);
  });

  it('works with a capo', () => {
    const res = optimizeFingering([{ notes: [{ id: 'x', midi: 57 }] }], { mode: 'open', tuning: STANDARD, capo: 2, maxFret: 15 });
    expect(res.placements.get('x')!.position).toEqual({ string: 3, fret: 2 }); // open (capo) G string -> A
  });
});

describe('play order', () => {
  it('expands simple repeats', () => {
    const bars = [{ repeatStart: true }, {}, {}, { repeatEnd: 2 }, {}, {}];
    expect(playOrder(bars)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 4, 5]);
    expect(formatPlayOrder(playOrder(bars))).toBe('1–4, 1–6');
  });

  it('handles 1st and 2nd endings', () => {
    const bars = [{ repeatStart: true }, {}, { endings: [1], repeatEnd: 2 }, { endings: [2] }, {}];
    expect(playOrder(bars)).toEqual([0, 1, 2, 0, 1, 3, 4]);
  });

  it('handles D.C. al Fine and D.S. al Coda', () => {
    expect(playOrder([{}, { targets: ['fine'] }, {}, { jumps: ['daCapoAlFine'] }] as RepeatBar[])).toEqual([0, 1, 2, 3, 0, 1]);
    const ds: RepeatBar[] = [{}, { targets: ['segno'] }, { jumps: ['toCoda'] }, { jumps: ['dalSegnoAlCoda'] }, { targets: ['coda'] }];
    expect(playOrder(ds)).toEqual([0, 1, 2, 3, 1, 2, 4]);
  });

  it('implicit repeat start at the beginning', () => {
    expect(playOrder([{}, { repeatEnd: 2 }, {}])).toEqual([0, 1, 0, 1, 2]);
  });
});

describe('range and arranging', () => {
  it('reports and fixes range', () => {
    const violin = [79, 81, 83, 88, 91]; // G5..G6 — above fret 15 except G5
    expect(rangeReport(violin, STANDARD, 0, 15).tooHigh).toBe(4);
    expect(suggestOctaveShift(violin, STANDARD, 0, 15)).toBe(-1);
    expect(suggestOctaveShift([28, 30, 33], STANDARD, 0, 15)).toBe(1);
  });

  it('puts a bass root on a free low string', () => {
    // melody G3 on string 3 open; chord G -> bass G2 on string 6 fret 3
    expect(bassPosition(7, [{ string: 3, midi: 55 }], STANDARD, 0, 1)).toEqual({ string: 6, fret: 3 });
    // chord D -> open D string (4) if free
    expect(bassPosition(2, [{ string: 2, midi: 59 }], STANDARD, 0, 1)).toEqual({ string: 4, fret: 0 });
    // A chord with the melody on string 5: only string 6 is below it -> A2 at fret 5
    expect(bassPosition(9, [{ string: 5, midi: 47 }], STANDARD, 0, 1)).toEqual({ string: 6, fret: 5 });
    // nothing free below the melody
    expect(bassPosition(9, [{ string: 6, midi: 41 }], STANDARD, 0, 1)).toBeNull();
  });
});

describe('ascii tab', () => {
  it('aligns columns', () => {
    const txt = asciiTab(
      [
        {
          events: [
            { tick: 0, duration: 960, notes: [{ string: 4, fret: 0 }] },
            { tick: 960, duration: 960, notes: [{ string: 3, fret: 0 }] },
            { tick: 1920, duration: 960, notes: [{ string: 4, fret: 4 }] },
            { tick: 2880, duration: 960, notes: [{ string: 3, fret: 10 }] },
          ],
        },
      ],
      { tuning: STANDARD },
    );
    const lines = txt.trim().split('\n');
    expect(lines[0]).toBe('1');
    expect(lines.slice(1).map((l) => l.length).every((n) => n === lines[1].length)).toBe(true);
    expect(lines[3]).toBe('G|-----0-------10--|');
    expect(lines[4]).toBe('D|-0-------4-------|');
    expect(lines[1].startsWith('e|')).toBe(true);
  });
});
