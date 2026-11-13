// Writes the MusicXML source of the OMR test pages (tests/fixtures/omr/*.musicxml).
// The pages are rendered from these files in the app (staff view, light theme) and the PNGs are kept next to them;
// the MusicXML is the ground truth for the note-accuracy tests.
// Run: node tools/make-omr-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'omr');

// divisions = 4 (a sixteenth is 1)
const DUR = { w: [16, 'whole', false], dh: [12, 'half', true], h: [8, 'half', false], dq: [6, 'quarter', true], q: [4, 'quarter', false], de: [3, 'eighth', true], e: [2, 'eighth', false], s: [1, '16th', false] };
const KINDS = { '': ['major', ''], m: ['minor', 'm'], 7: ['dominant', '7'] };

function harmony(symbol) {
  const [, step, acc, suffix] = /^([A-G])([#b]?)(.*)$/.exec(symbol);
  const [kind, text] = KINDS[suffix];
  const alter = acc === '#' ? '<root-alter>1</root-alter>' : acc === 'b' ? '<root-alter>-1</root-alter>' : '';
  return `      <harmony><root><root-step>${step}</root-step>${alter}</root><kind text="${text}">${kind}</kind></harmony>\n`;
}

/** token: "F4:q", "C#5:e", "Bn4:q" (natural sign), "r:q" (rest), "r:w*" (whole-bar rest) */
function note(token) {
  const [p, d] = token.split(':');
  const bar = d.endsWith('*');
  const [div, type, dot] = DUR[d.replace('*', '')];
  const tail = `<duration>${div}</duration><voice>1</voice>${bar ? '' : `<type>${type}</type>`}${dot ? '<dot/>' : ''}`;
  if (p === 'r') return `      <note><rest${bar ? ' measure="yes"' : ''}/>${tail}</note>\n`;
  const [, step, acc, octave] = /^([A-G])(#|b|n)?(\d)$/.exec(p);
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  const accidental = acc === '#' ? 'sharp' : acc === 'b' ? 'flat' : acc === 'n' ? 'natural' : '';
  return `      <note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>${tail}${accidental ? `<accidental>${accidental}</accidental>` : ''}</note>\n`;
}

function score({ title, composer, fifths, tempo, bars }) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${title}</work-title></work>
  <identification><creator type="composer">${composer}</creator><rights>CC0</rights></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
`;
  bars.forEach(([chords, notes], i) => {
    xml += `    <measure number="${i + 1}">\n`;
    if (i === 0)
      xml += `      <attributes><divisions>4</divisions><key><fifths>${fifths}</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef><transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>\n`;
    notes.split(' ').forEach((tok, n) => {
      for (const [sym, at] of chords) if (at === n) xml += harmony(sym);
      xml += note(tok);
    });
    if (i === bars.length - 1) xml += `      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n`;
    xml += `    </measure>\n`;
  });
  return xml + `  </part>\n</score-partwise>\n`;
}

// An original exercise: beamed eighths and sixteenths, dotted rhythms, every rest length, accidentals.
const rhythmStudy = score({
  title: 'Rhythm Study',
  composer: 'StaffLens test page',
  fifths: -1,
  tempo: 96,
  bars: [
    [[['F', 0]], 'F4:q A4:e C5:e F5:h'],
    [[['C7', 0]], 'E5:e D5:e C5:e Bb4:e A4:q r:q'],
    [[['Bb', 0]], 'D5:dq C5:e Bb4:q A4:q'],
    [[['C', 0]], 'G4:s A4:s Bb4:s C5:s D5:e r:e C5:h'],
    [[], 'r:w*'],
    [[['F', 1]], 'r:h A4:q C5:q'],
    [[['Dm', 0]], 'F5:e E5:e D5:e C#5:e D5:h'],
    [[['C7', 0]], 'G4:q r:e Bn4:e C5:de Bb4:s A4:e G4:e'],
    [[['F', 0]], 'A4:e F4:e C5:e A4:e G4:q E4:q'],
    [[['F', 0]], 'F4:h r:h'],
  ],
});
writeFileSync(join(outDir, 'rhythm-study.musicxml'), rhythmStudy);
console.log('wrote rhythm-study.musicxml');

// Held-out page for the refinement layer: sharp key, ledger lines above and below, accidentals, rests.
const ledgerStudy = score({
  title: 'Ledger Study',
  composer: 'StaffLens test page',
  fifths: 2,
  tempo: 80,
  bars: [
    [[['D', 0]], 'D4:q F#4:e A4:e D5:h'],
    [[['A7', 0]], 'C#6:q B5:q A5:h'],
    [[['G', 0]], 'r:q B5:e G5:e D5:q r:q'],
    [[['D', 0]], 'A3:h r:h'],
    [[['Bm', 0]], 'B3:e C#4:e D4:e E4:e F#4:q r:e Fn4:e'],
    [[['Em', 0]], 'G4:dh r:q'],
    [[['A7', 0]], 'E5:q Bb4:q C#5:q A4:q'],
    [[['D', 0]], 'D5:w'],
    [[], 'r:w*'],
    [[['D', 0]], 'F#5:h D4:h'],
  ],
});
writeFileSync(join(outDir, 'ledger-study.musicxml'), ledgerStudy);
console.log('wrote ledger-study.musicxml');

