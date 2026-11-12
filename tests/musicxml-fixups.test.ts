// @vitest-environment happy-dom
// MusicXML repairs applied before alphaTab import.
import * as alphaTab from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { fromAlphaTab } from '../src/model/fromAlphaTab';
import { addMissingStaffLines, fixMusicXml } from '../src/model/musicxmlFixups';

// Shape of a guitarnotation.com export: six <staff-tuning> lines, no <staff-lines>, sounding pitches + string/fret.
const tuning = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']
  .map((p, i) => `<staff-tuning line="${i + 1}"><tuning-step>${p[0]}</tuning-step><tuning-octave>${p[1]}</tuning-octave></staff-tuning>`)
  .join('');
const note = (step: string, octave: number, string: number, fret: number) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><technical><string>${string}</string><fret>${fret}</fret></technical></notations></note>`;
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><staff-details>${tuning}</staff-details></attributes>
${note('C', 4, 2, 1)}${note('G', 4, 1, 3)}${note('E', 4, 1, 0)}${note('D', 4, 2, 3)}</measure></part></score-partwise>`;

const load = (xml: string) => fromAlphaTab(alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml)), { kind: 'musicxml', fileName: 't.musicxml' });

describe('MusicXML fixups', () => {
  it('adds the line count of a tab staff that only lists its tunings', () => {
    expect(addMissingStaffLines(XML)).toContain('<staff-details><staff-lines>6</staff-lines><staff-tuning line="1">');
    const kept = '<staff-details><staff-lines>6</staff-lines><staff-tuning line="1"></staff-tuning></staff-details>';
    expect(addMissingStaffLines(kept)).toBe(kept);
    expect(addMissingStaffLines('<staff-details><staff-size>80</staff-size></staff-details>')).toBe('<staff-details><staff-size>80</staff-size></staff-details>');
  });

  it('keeps every note on its string and pitch', () => {
    const part = load(fixMusicXml(XML)).parts[0];
    expect(part.sourceTuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(part.notes.map((n) => [n.soundingMidi, n.sourceString, n.sourceFret])).toEqual([
      [60, 2, 1],
      [67, 1, 3],
      [64, 1, 0],
      [62, 2, 3],
    ]);
    // without the repair alphaTab reads 5 strings and moves the notes (the reported bug)
    expect(load(XML).parts[0].notes[0].soundingMidi).not.toBe(60);
  });
});
