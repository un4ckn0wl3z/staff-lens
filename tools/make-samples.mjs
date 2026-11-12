// Generates the bundled MusicXML demo files in public/samples/.
// Run: node tools/make-samples.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'samples');
mkdirSync(outDir, { recursive: true });

const TYPES = { 1: ['whole', 4], 2: ['half', 2], 4: ['quarter', 1] };
const KINDS = {
  '': ['major', ''],
  m: ['minor', 'm'],
  7: ['dominant', '7'],
  maj7: ['major-seventh', 'maj7'],
  m7: ['minor-seventh', 'm7'],
};

function harmonyXml(symbol) {
  const m = /^([A-G])([#b]?)(.*)$/.exec(symbol);
  const [, step, acc, suffix] = m;
  const [kind, text] = KINDS[suffix];
  const alter = acc === '#' ? '<root-alter>1</root-alter>' : acc === 'b' ? '<root-alter>-1</root-alter>' : '';
  return `      <harmony><root><root-step>${step}</root-step>${alter}</root><kind text="${text}">${kind}</kind></harmony>\n`;
}

function noteXml(pitch, value) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(pitch);
  const [, step, acc, octave] = m;
  const alter = acc === '#' ? '<alter>1</alter>' : acc === 'b' ? '<alter>-1</alter>' : '';
  const [type, dur] = TYPES[value];
  return `      <note><pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>\n`;
}

/**
 * bars: [{ notes: [[pitch, value]...], chords: [[symbol, noteIndex]...], rehearsal?, repeatStart?, repeatEnd?, final? }]
 */
function score({ title, composer, lyricist, fifths, tempo, bars, program = 25 }) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${title}</work-title></work>
  <identification>
    <creator type="composer">${composer}</creator>
${lyricist ? `    <creator type="lyricist">${lyricist}</creator>\n` : ''}    <rights>Public domain</rights>
    <encoding><software>StaffLens sample generator</software></encoding>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Guitar</part-name>
      <score-instrument id="P1-I1"><instrument-name>Acoustic Guitar (nylon)</instrument-name></score-instrument>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>${program}</midi-program></midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
`;
  bars.forEach((bar, i) => {
    xml += `    <measure number="${i + 1}">\n`;
    if (bar.repeatStart) xml += `      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>\n`;
    if (i === 0) {
      xml += `      <attributes>
        <divisions>1</divisions>
        <key><fifths>${fifths}</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>\n`;
    }
    if (bar.rehearsal) xml += `      <direction placement="above"><direction-type><rehearsal>${bar.rehearsal}</rehearsal></direction-type></direction>\n`;
    bar.notes.forEach(([pitch, value], n) => {
      for (const [sym, at] of bar.chords) if (at === n) xml += harmonyXml(sym);
      xml += noteXml(pitch, value);
    });
    if (bar.repeatEnd) xml += `      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward" times="${bar.repeatEnd}"/></barline>\n`;
    else if (bar.final) xml += `      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n`;
    xml += `    </measure>\n`;
  });
  xml += `  </part>\n</score-partwise>\n`;
  return xml;
}

const q = (p) => [p, 4];
const h = (p) => [p, 2];
const w = (p) => [p, 1];

// Aura Lee — public domain (1861). Bars 5–8 of the tune repeat bars 1–4, written here with repeat signs.
const auraLee = score({
  title: 'Aura Lee',
  composer: 'George R. Poulton (1861)',
  lyricist: 'W. W. Fosdick',
  fifths: 1,
  tempo: 92,
  bars: [
    { rehearsal: 'Verse', repeatStart: true, notes: [q('D4'), q('G4'), q('F#4'), q('G4')], chords: [['G', 0]] },
    { notes: [q('A4'), q('E4'), h('A4')], chords: [['A7', 0]] },
    { notes: [q('G4'), q('F#4'), q('E4'), q('F#4')], chords: [['D7', 0]] },
    { repeatEnd: 2, notes: [w('G4')], chords: [['G', 0]] },
    { rehearsal: 'Chorus', notes: [q('B4'), q('B4'), h('B4')], chords: [['G', 0]] },
    { notes: [q('B4'), q('B4'), h('B4')], chords: [['B7', 0]] },
    { notes: [q('B4'), q('A4'), q('G4'), q('A4')], chords: [['Em', 0]] },
    { notes: [w('B4')], chords: [['G7', 0]] },
    { notes: [q('B4'), q('B4'), q('C5'), q('B4')], chords: [['Cmaj7', 0]] },
    { notes: [q('A4'), q('E4'), q('A4'), q('G4')], chords: [['E7', 0], ['A7', 2]] },
    { notes: [q('G4'), q('F#4'), q('B4'), q('A4')], chords: [['D7', 0]] },
    { final: true, notes: [w('G4')], chords: [['G', 0]] },
  ],
});
writeFileSync(join(outDir, 'aura-lee.musicxml'), auraLee);

// Chord study — a short original exercise for chord-tone labelling (E7 → Am, D7 → G7 → C).
const chordStudy = score({
  title: 'Chord Study in C',
  composer: 'StaffLens',
  fifths: 0,
  tempo: 80,
  bars: [
    { notes: [q('E4'), q('F4'), q('G4'), q('C5')], chords: [['C', 0]] },
    { notes: [q('G#4'), q('B4'), q('D5'), q('B4')], chords: [['E7', 0]] },
    { notes: [q('A4'), q('C5'), q('E5'), q('C5')], chords: [['Am', 0]] },
    { notes: [q('F#4'), q('A4'), q('C5'), q('A4')], chords: [['D7', 0]] },
    { notes: [q('G4'), q('B4'), q('D5'), q('F5')], chords: [['G7', 0]] },
    { notes: [h('E5'), h('C5')], chords: [['C', 0]] },
    { notes: [q('D5'), q('B4'), q('G4'), q('F4')], chords: [['G7', 0]] },
    { final: true, notes: [w('E4')], chords: [['C', 0]] },
  ],
});
writeFileSync(join(outDir, 'chord-study.musicxml'), chordStudy);
console.log('samples written to', outDir);
