// Minimal Guitar Pro 5 (.gp5, v5.00) writer.
// TypeScript port of the TabLens writer (https://github.com/un4ckn0wl3z/TabLens, src/gp5writer.js),
// itself a port of the PyGuitarPro write path. Extended here with key signatures, volta endings
// and a second voice.

export interface Gp5Note {
  /** 1 = highest string */
  string: number;
  /** fret relative to the capo */
  fret: number;
  type?: 'normal' | 'tie' | 'dead';
}

export interface Gp5Beat {
  /** 1, 2, 4, 8, 16, 32, 64 */
  dur: number;
  dotted?: boolean;
  /** tuplet "enters", e.g. 3 for a triplet */
  tuplet?: number;
  rest?: boolean;
  text?: string;
  notes: Gp5Note[];
}

export interface Gp5Measure {
  num: number;
  den: number;
  repeatOpen?: boolean;
  /** Value stored in the file for a repeat end (alphaTab/GP: number of plays). 0 = none. */
  repeatClose?: number;
  /** bitmask of volta endings (bit 0 = 1st ending) */
  alternative?: number;
  marker?: string;
  /** key signature on the first bar / when it changes */
  keyFifths?: number;
  keyMinor?: boolean;
  beats: Gp5Beat[];
  beats2?: Gp5Beat[];
}

export interface Gp5Track {
  name: string;
  /** open-string MIDI, string 1 (highest) first */
  tuning: number[];
  capo?: number;
  fretCount?: number;
  /** GM program */
  instrument?: number;
  measures: Gp5Measure[];
}

export interface Gp5Song {
  title?: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  words?: string;
  music?: string;
  copyright?: string;
  tab?: string;
  instructions?: string;
  tempo?: number;
  tempoName?: string;
  tracks: Gp5Track[];
}

class W {
  buf = new Uint8Array(1 << 16);
  n = 0;
  ensure(k: number) {
    if (this.n + k > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
      b.set(this.buf);
      this.buf = b;
    }
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.n++] = v & 255;
  }
  i8(v: number) {
    this.u8(v < 0 ? 256 + v : v);
  }
  i16(v: number) {
    this.ensure(2);
    new DataView(this.buf.buffer).setInt16(this.n, v, true);
    this.n += 2;
  }
  i32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setInt32(this.n, v, true);
    this.n += 4;
  }
  pad(k: number) {
    for (let i = 0; i < k; i++) this.u8(0);
  }
  /** latin1-ish; non-latin characters become '?' (GP5 stores text in a Latin code page) */
  bytes(s: string): number[] {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      out.push(c < 256 ? c : 63);
    }
    return out;
  }
  byteSizeString(s: string, count: number) {
    const b = this.bytes(s).slice(0, count);
    this.u8(b.length);
    for (let i = 0; i < count; i++) this.u8(i < b.length ? b[i] : 0);
  }
  intSizeString(s: string) {
    const b = this.bytes(s);
    this.i32(b.length);
    b.forEach((x) => this.u8(x));
  }
  intByteSizeString(s: string) {
    const b = this.bytes(s).slice(0, 255);
    this.i32(b.length + 1);
    this.u8(b.length);
    b.forEach((x) => this.u8(x));
  }
  result() {
    return this.buf.slice(0, this.n);
  }
}

const DUR_CODE: Record<number, number> = { 1: -2, 2: -1, 4: 0, 8: 1, 16: 2, 32: 3, 64: 4, 128: 4 };
const NOTE_TYPE = { normal: 1, tie: 2, dead: 3 };

export function writeGp5(song: Gp5Song): Uint8Array {
  const w = new W();
  w.byteSizeString('FICHIER GUITAR PRO v5.00', 30);
  [song.title, song.subtitle, song.artist, song.album, song.words, song.music, song.copyright, song.tab, song.instructions].forEach((s) =>
    w.intByteSizeString(s ?? ''),
  );
  w.i32(0); // notice lines
  // lyrics
  w.i32(0);
  for (let i = 0; i < 5; i++) {
    w.i32(1);
    w.intSizeString('');
  }
  // page setup
  [210, 297, 10, 10, 15, 10, 100].forEach((v) => w.i32(v));
  w.u8(0xff);
  w.u8(0x01);
  [
    '%title%',
    '%subtitle%',
    '%artist%',
    '%album%',
    'Words by %words%',
    'Music by %music%',
    'Words & Music by %WORDSMUSIC%',
    'Copyright %copyright%',
    'All Rights Reserved - International Copyright Secured',
    'Page %N%/%P%',
  ].forEach((s) => w.intByteSizeString(s));
  w.intByteSizeString(song.tempoName || 'Moderate');
  w.i32(Math.round(song.tempo || 120));
  w.i8(0);
  w.i32(0); // key, octave
  // midi channels
  const tracks = song.tracks;
  const fromShort = (d: number) => Math.min(Math.max((d >> 3) - 1, -128), 127) + 1;
  for (let ch = 0; ch < 64; ch++) {
    const t = tracks.findIndex((_tr, i) => ch === 2 * i || ch === 2 * i + 1);
    const perc = ch % 16 === 9;
    const instr = t >= 0 ? (tracks[t].instrument ?? 25) : perc ? 0 : 25;
    if (perc && instr === 0) w.i32(-1);
    else w.i32(instr);
    [104, 64, 0, 0, 0, 0].forEach((v) => w.i8(fromShort(v)));
    w.pad(2);
  }
  for (let i = 0; i < 19; i++) w.i16(-1); // directions
  w.i32(0); // master reverb
  const measures = tracks[0].measures;
  w.i32(measures.length);
  w.i32(tracks.length);
  // measure headers
  let prev: Gp5Measure | null = null;
  measures.forEach((m) => {
    let flags = 0;
    if (!prev) flags |= 0x03;
    else {
      if (m.num !== prev.num) flags |= 0x01;
      if (m.den !== prev.den) flags |= 0x02;
    }
    if (m.repeatOpen) flags |= 0x04;
    if (m.repeatClose && m.repeatClose > 0) flags |= 0x08;
    if (m.alternative) flags |= 0x10;
    if (m.marker) flags |= 0x20;
    const key = m.keyFifths ?? 0;
    if (!prev || key !== (prev.keyFifths ?? 0) || !!m.keyMinor !== !!prev.keyMinor) flags |= 0x40;
    if (prev) w.pad(1);
    w.u8(flags);
    if (flags & 0x01) w.i8(m.num);
    if (flags & 0x02) w.i8(m.den);
    if (flags & 0x08) w.i8(m.repeatClose!);
    if (flags & 0x20) {
      w.intByteSizeString(m.marker!);
      w.u8(255);
      w.u8(0);
      w.u8(0);
      w.pad(1);
    }
    if (flags & 0x40) {
      w.i8(key);
      w.i8(m.keyMinor ? 1 : 0);
    }
    if (flags & 0x03) [2, 2, 2, 2].forEach((b) => w.u8(b));
    w.u8(flags & 0x10 ? m.alternative! : 0); // GP5 always stores the volta byte here

    w.u8(0); // triplet feel
    prev = m;
  });
  // tracks
  tracks.forEach((tr, i) => {
    w.pad(1);
    w.u8(0x08); // visible
    w.byteSizeString(tr.name || 'Guitar', 40);
    const strings = tr.tuning;
    w.i32(strings.length);
    for (let s = 0; s < 7; s++) w.i32(s < strings.length ? strings[s] : 0);
    w.i32(1);
    w.i32(2 * i + 1);
    w.i32(2 * i + 2); // port, channel+1, effect channel+1
    w.i32(tr.fretCount || 24);
    w.i32(tr.capo || 0);
    w.u8(255);
    w.u8(0);
    w.u8(0);
    w.pad(1); // color
    w.i16(0x0043); // tablature + notation + diagram list
    w.u8(0);
    w.u8(0);
    w.u8(0); // auto accentuation, bank, humanize
    const ct = strings[strings.length - 1] < 35 ? 12 : 0;
    w.i32(ct);
    w.i32(ct);
    w.i32(100);
    w.pad(12);
    w.i32(-1);
    w.i32(-1);
    w.i32(-1);
    w.i16(-1);
    w.pad(1); // RSE instrument (5.00)
  });
  w.pad(2);
  // measures (timewise)
  for (let mi = 0; mi < measures.length; mi++) {
    tracks.forEach((tr) => {
      const m = tr.measures[mi];
      const beats = m.beats && m.beats.length ? m.beats : [{ dur: 1, rest: true, notes: [] }];
      w.i32(beats.length);
      beats.forEach((b) => writeBeat(w, b));
      const beats2 = m.beats2 ?? [];
      w.i32(beats2.length);
      beats2.forEach((b) => writeBeat(w, b));
      w.u8(0); // line break
    });
  }
  return w.result();
}

function writeBeat(w: W, b: Gp5Beat) {
  const notes = b.rest ? [] : b.notes;
  let flags = 0;
  if (b.dotted) flags |= 0x01;
  if (b.text) flags |= 0x04;
  if (b.tuplet && b.tuplet > 1) flags |= 0x20;
  const isRest = b.rest || notes.length === 0;
  if (isRest) flags |= 0x40;
  w.i8(flags);
  if (flags & 0x40) w.u8(2); // rest
  w.i8(DUR_CODE[b.dur] ?? 0);
  if (flags & 0x20) w.i32(b.tuplet!);
  if (flags & 0x04) w.intByteSizeString(b.text!);
  let sf = 0;
  notes.forEach((n) => (sf |= 1 << (7 - n.string)));
  w.u8(sf);
  [...notes]
    .sort((a, c) => a.string - c.string)
    .forEach((n) => {
      w.u8(0x20); // note type present
      w.u8(NOTE_TYPE[n.type ?? 'normal']);
      w.i8(n.type === 'tie' ? 0 : n.fret);
      w.u8(0); // flags2
    });
  w.i16(0); // beat flags2
}
