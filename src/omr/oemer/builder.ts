// Port of oemer/build_system.py (oemer 0.1.8, MIT): voices, measures, time slots and the MusicXML writer.
// The output is byte-identical to oemer's MusicXML (minidom pretty print), so StaffLens can open it
// through its normal MusicXML import.

import type { BBox } from './cv';
import { pyRound } from './context';
import type { NoteGroup } from './noteGroup';
import { NoteType, type NoteHead } from './notehead';
import type { Staff } from './staffline';
import { ClefType, RestType, SfnType, type Barline, type Clef, type Rest, type Sfn } from './symbols';
import { getGlobalUnitSize } from './utils';

const DIV = 16;
const G_ORDER = ['D', 'E', 'F', 'G', 'A', 'B', 'C'];
const F_ORDER = ['F', 'G', 'A', 'B', 'C', 'D', 'E'];
const SHARP_KEY_ORDER = ['F', 'C', 'G', 'D', 'A', 'E'];
const FLAT_KEY_ORDER = ['B', 'E', 'A', 'D', 'G', 'C'];

const RHYTHM: Partial<Record<NoteType, { name: string; duration: number }>> = {
  [NoteType.WHOLE]: { name: 'whole', duration: DIV * 4 },
  [NoteType.HALF]: { name: 'half', duration: DIV * 2 },
  [NoteType.HALF_OR_WHOLE]: { name: 'half', duration: DIV * 2 },
  [NoteType.QUARTER]: { name: 'quarter', duration: DIV },
  [NoteType.EIGHTH]: { name: 'eighth', duration: DIV / 2 },
  [NoteType.SIXTEENTH]: { name: '16th', duration: DIV / 4 },
  [NoteType.THIRTY_SECOND]: { name: '32nd', duration: DIV / 8 },
  [NoteType.SIXTY_FOURTH]: { name: '64th', duration: DIV / 16 },
};
const REST_DURATION: Record<RestType, number> = {
  [RestType.QUARTER]: DIV,
  [RestType.EIGHTH]: DIV / 2,
  [RestType.SIXTEENTH]: DIV / 4,
  [RestType.THIRTY_SECOND]: DIV / 8,
  [RestType.SIXTY_FOURTH]: DIV / 16,
  [RestType.WHOLE_HALF]: DIV * 2,
  [RestType.WHOLE]: DIV * 4,
  [RestType.HALF]: DIV * 2,
};

const pyMod = (a: number, b: number) => a - b * Math.floor(a / b);
const xc = (b: BBox) => (b[0] + b[2]) / 2;

// ------------------------------------------------------------------ minimal ElementTree + minidom pretty print

class El {
  children: El[] = [];
  text: string | null = null;
  constructor(
    public tag: string,
    public attrs: [string, string][] = [],
  ) {}
  sub(tag: string, text?: string | number, attrs: [string, string][] = []): El {
    const e = new El(tag, attrs);
    if (text !== undefined) e.text = String(text);
    this.children.push(e);
    return e;
  }
  append(e: El | null): void {
    if (e) this.children.push(e);
  }
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

function pretty(e: El, indent = '', out: string[] = []): string[] {
  const attrs = e.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (e.text !== null && e.children.length === 0) out.push(`${indent}<${e.tag}${attrs}>${escText(e.text)}</${e.tag}>\n`);
  else if (e.children.length === 0) out.push(`${indent}<${e.tag}${attrs}/>\n`);
  else {
    out.push(`${indent}<${e.tag}${attrs}>\n`);
    for (const c of e.children) pretty(c, indent + '  ', out);
    out.push(`${indent}</${e.tag}>\n`);
  }
  return out;
}

// ------------------------------------------------------------------ voices

export class Voice {
  id = 0;
  noteIds: number[] = [];
  stemUp: boolean | null = null;
  groupId = 0;
  xCenter = 0;
  label: NoteType = NoteType.QUARTER;
  hasDot = false;
  group: number | null = null;
  track = 0;
  duration = 0;
  rhythmName = '';
}

type Sym = { kind: 'voice'; v: Voice } | { kind: 'rest'; v: Rest & { insertedX?: number } } | { kind: 'clef'; v: Clef } | { kind: 'sfn'; v: Sfn } | { kind: 'barline'; v: Barline };

const symX = (s: Sym): number => {
  if (s.kind === 'voice') return s.v.xCenter;
  if (s.kind === 'rest' && s.v.insertedX !== undefined) return s.v.insertedX;
  return xc(s.v.bbox);
};
const symTrack = (s: Sym): number => (s.kind === 'barline' ? 0 : (s.v.track ?? 0));
const symGroup = (s: Sym): number => s.v.group ?? 0;

function restDuration(r: Rest): number {
  let d = REST_DURATION[r.label];
  if (r.hasDot) d = pyRound(d * 1.5);
  return d;
}
function duration(s: Sym): number {
  if (s.kind === 'voice') return s.v.duration;
  if (s.kind === 'rest') return restDuration(s.v);
  throw new Error('no duration');
}

function labelByDuration<T extends number>(d: number, mapping: [T, number][]): { label: T; hasDot: boolean } {
  let minDiff = 9999999;
  let label = mapping[0][0];
  for (const [l, dura] of mapping) {
    const diff = d - dura;
    if (diff >= 0 && diff < minDiff) {
      minDiff = diff;
      label = l;
    }
  }
  return { label, hasDot: minDiff > 0 };
}

const NOTE_DURATIONS: [NoteType, number][] = (Object.entries(RHYTHM) as [string, { duration: number }][]).map(([k, v]) => [Number(k) as NoteType, v.duration]);
const REST_DURATIONS: [RestType, number][] = (Object.entries(REST_DURATION) as [string, number][]).map(([k, v]) => [Number(k) as RestType, v]);

function getVoices(groups: NoteGroup[], notes: NoteHead[]): Voice[] {
  const voices: Voice[] = [];
  const add = (g: NoteGroup, nids: number[], stemUp: boolean | null) => {
    const ids = nids.filter((n) => !notes[n].invalid);
    if (ids.length === 0) return;
    const v = new Voice();
    v.group = g.group;
    v.groupId = g.id;
    v.track = g.track ?? 0;
    v.noteIds = ids;
    v.stemUp = stemUp;
    v.xCenter = g.xCenter;
    // most common label (oemer's tie order depends on Python's hash seed; we take the first seen)
    const counts = new Map<NoteType | null, number>();
    for (const n of ids) counts.set(notes[n].label, (counts.get(notes[n].label) ?? 0) + 1);
    const label = [...counts].sort((a, b) => b[1] - a[1])[0][0] ?? NoteType.QUARTER;
    v.label = label;
    const t = ids.filter((n) => notes[n].hasDot).length;
    v.hasDot = t > ids.length - t;
    for (const n of ids) {
      if (notes[n].label !== label) notes[n].forceSetLabel(label);
      notes[n].hasDot = v.hasDot;
    }
    const r = RHYTHM[label] ?? RHYTHM[NoteType.QUARTER]!;
    v.rhythmName = r.name;
    v.duration = v.hasDot ? pyRound(r.duration * 1.5) : r.duration;
    voices.push(v);
  };
  for (const g of groups) {
    if (g.stemUp === null && g.hasStem) {
      add(g, g.topNoteIds, true);
      add(g, g.bottomNoteIds, false);
    } else add(g, g.noteIds, g.stemUp);
  }
  voices.forEach((v, i) => (v.id = i));
  return voices;
}

// ------------------------------------------------------------------ measures

class Measure {
  symbols: Sym[] = [];
  doubleBarline = false;
  number = 0;
  atBeginning = false;
  group = 0;
  timeSlots: Sym[][] = [];
  slotDuras: number[][] = [];

  constructor(private trackNums: number) {}

  addSymbols(syms: Sym[]): void {
    this.symbols = [...this.symbols, ...syms].map((s, i) => ({ s, i })).sort((a, b) => symX(a.s) - symX(b.s) || a.i - b.i).map((e) => e.s);
  }
  get sfns(): Sfn[] {
    return this.symbols.filter((s): s is Extract<Sym, { kind: 'sfn' }> => s.kind === 'sfn').map((s) => s.v);
  }
  get clefs(): Clef[] {
    return this.symbols.filter((s): s is Extract<Sym, { kind: 'clef' }> => s.kind === 'clef').map((s) => s.v);
  }
  hasKey(): boolean {
    const start = this.atBeginning ? this.trackNums : 0;
    return this.symbols.slice(start, start + this.trackNums).every((s) => s.kind === 'sfn');
  }
  getKey(): number {
    if (this.sfns.length === 0) return 0;
    if (!this.hasKey()) return 0;
    const start = this.atBeginning ? this.trackNums : 0;
    const end = Math.min(this.trackNums * 7 + 4, this.symbols.length);
    const cands: Sfn[] = [];
    for (let i = start; i < end; i++) {
      const s = this.symbols[i];
      if (s.kind !== 'sfn') break;
      cands.push(s.v);
    }
    if (cands.length === 0) return 0;
    const counts = new Array<number>(this.trackNums).fill(0);
    for (const c of cands) counts[c.track ?? 0]++;
    let label = cands[0].label;
    if (!cands.every((c) => c.label === cands[0].label)) {
      let counter: [SfnType, number][] = [
        [SfnType.FLAT, 0],
        [SfnType.SHARP, 0],
        [SfnType.NATURAL, 0],
      ];
      for (const c of cands) counter.find((e) => e[0] === c.label)![1]++;
      counter = counter.map((e, i) => ({ e, i })).sort((a, b) => b.e[1] - a.e[1] || a.i - b.i).map((x) => x.e);
      if (counter[0][0] === SfnType.NATURAL) [counter[0], counter[1]] = [counter[1], counter[0]];
      if (counter[0][0] === SfnType.FLAT) label = SfnType.FLAT;
      else if (counter[0][0] === SfnType.SHARP) label = SfnType.SHARP;
    }
    let count = pyRound(counts.reduce((a, b) => a + b, 0) / this.trackNums);
    if (label === SfnType.FLAT) count = -count;
    for (const c of cands) c.isKey = true;
    return Math.max(-6, Math.min(6, count));
  }
  getTrackClef(): (Clef | null)[] {
    if (this.atBeginning || this.doubleBarline) {
      const out: Clef[] = [];
      for (let t = 0; t < this.trackNums; t++) {
        const c = this.clefs.filter((cl) => cl.track === t).sort((a, b) => xc(a.bbox) - xc(b.bbox))[0];
        out.push(c ?? { bbox: [0, 0, 0, 0], track: t, group: this.group, label: ((t % 2) + 1) as ClefType });
      }
      return out;
    }
    return new Array(this.trackNums).fill(null);
  }

  alignSymbols(unit: number, notes: NoteHead[]): void {
    const slots: Sym[][] = [];
    const corr: number[] = [];
    let lastX: number | null = null;
    this.symbols.forEach((s, idx) => {
      if (s.kind === 'clef' || s.kind === 'sfn') return;
      const x = symX(s);
      if (lastX === null) {
        lastX = x;
        slots.push([s]);
        corr.push(idx);
      } else if (Math.abs(x - lastX) < unit) slots[slots.length - 1].push(s);
      else {
        slots.push([s]);
        corr.push(idx);
        lastX = x;
      }
    });
    const T = this.trackNums;
    const duras = slots.map((slot) => {
      const per: number[][] = Array.from({ length: T }, () => []);
      for (const s of slot) per[symTrack(s)].push(duration(s));
      return per.map((d) => (d.length ? Math.min(...d) : 0) & 0xffff);
    });
    if (T === 1) {
      this.timeSlots = slots;
      this.slotDuras = duras;
      return;
    }
    if (T !== 2) throw new Error(`unsupported number of tracks: ${T}`);
    const next = duras.map((d) => [...d, 0, 0]);
    let diff = 0;
    let lead: number | null = null;
    let addIdx: number | null = null;
    let added = 0;
    let solved = true;
    const modify = (ai: number, df: number, ld: number, loopIdx: number) => {
      const pos = duras[ai][1 - ld];
      if (pos !== 0) {
        for (const s of slots[ai]) if (symTrack(s) === 1 - ld) extendSymbolLength(s, df + pos, notes);
        next[ai][1 - ld] = df + pos;
      } else {
        const lab = labelByDuration(df, REST_DURATIONS);
        const rest: Rest & { insertedX: number } = { bbox: [0, 0, 0, 0], label: lab.label, hasDot: lab.hasDot, track: 1 - ld, group: this.group, insertedX: symX(slots[ai][0]) };
        const sym: Sym = { kind: 'rest', v: rest };
        // oemer uses the loop variable `idx` here (late binding), not add_idx
        this.symbols.splice(corr[loopIdx] + added, 0, sym);
        slots[ai].unshift(sym);
        added++;
        next[ai][1 - ld] = df;
      }
    };
    let idx = 0;
    for (; idx < duras.length; idx++) {
      const [t1, t2] = duras[idx];
      if (t1 > 0 && t2 > 0) {
        if (diff > 0) modify(addIdx!, diff, lead!, idx);
        if (t1 > t2) {
          diff = t1 - t2;
          lead = 0;
        } else {
          diff = t2 - t1;
          lead = 1;
        }
        addIdx = idx;
        solved = true;
      } else if (t1 > 0) {
        if (lead === 0) diff += t1;
        else if (diff >= t1) diff -= t1;
        else {
          diff = diff > 0 && diff < t1 ? t1 - diff : t1;
          addIdx = idx;
          lead = 0;
        }
        solved = false;
      } else if (t2 > 0) {
        if (lead === 1) diff += t2;
        else if (diff >= t2) diff -= t2;
        else {
          diff = diff > 0 && diff < t2 ? t2 - diff : t2;
          addIdx = idx;
          lead = 1;
        }
        solved = false;
      }
      next[idx][2] = diff;
      next[idx][3] = lead ?? 0;
    }
    if (!solved && diff > 0) modify(addIdx!, diff, lead!, idx - 1);
    this.timeSlots = slots;
    this.slotDuras = next.map((r) => r.slice(0, 2));
  }

  timeSlotDura(x: number): [number, number[]] {
    for (let i = 0; i < this.timeSlots.length - 1; i++) {
      if (symX(this.timeSlots[i][0]) <= x && x < symX(this.timeSlots[i + 1][0])) return [i, this.slotDuras[i]];
    }
    return [this.timeSlots.length - 1, this.slotDuras[this.slotDuras.length - 1]];
  }
}

function extendSymbolLength(s: Sym, d: number, notes: NoteHead[]): void {
  if (s.kind === 'voice') {
    const { label, hasDot } = labelByDuration(d, NOTE_DURATIONS);
    s.v.label = label;
    s.v.hasDot = hasDot;
    s.v.duration = d;
    s.v.rhythmName = RHYTHM[label]!.name;
    for (const n of s.v.noteIds) {
      notes[n].forceSetLabel(label);
      notes[n].hasDot = hasDot;
    }
  } else if (s.kind === 'rest') {
    const { label, hasDot } = labelByDuration(d, REST_DURATIONS);
    s.v.label = label;
    s.v.hasDot = hasDot;
  }
}

// ------------------------------------------------------------------ decoding to MusicXML elements

function chroma(pos: number, clef: ClefType): string {
  const order = clef === ClefType.G_CLEF ? G_ORDER : F_ORDER;
  return pos >= 0 ? order[pos % 7] : order[order.length + pyMod(pos, -7)] ?? order[0];
}

export interface DecodedNote {
  step: string;
  alter: number;
  octave: number;
}

/** Pitch of a note from its staff position and clef, as oemer computes it. */
export function decodePitch(pos: number, clef: ClefType, sfn: SfnType | null): DecodedNote | null {
  const order = clef === ClefType.G_CLEF ? G_ORDER : F_ORDER;
  const octOffset = clef === ClefType.G_CLEF ? 4 : 2;
  const pitchOffset = clef === ClefType.G_CLEF ? 1 : 3;
  const m = pyMod(pos, -7);
  const step = pos >= 0 ? order[pos % 7] : order[(order.length + m) % order.length];
  const octave = pos - pitchOffset >= 0 ? Math.floor((pos + pitchOffset) / 7) + octOffset : -Math.ceil((pos + pitchOffset) / -7) + octOffset;
  const alter = sfn === SfnType.SHARP ? 1 : sfn === SfnType.FLAT ? -1 : 0;
  if (octave < 0 || octave > 8 || (octave === 0 && step !== 'A') || (octave === 8 && step !== 'C')) return null;
  return { step, alter, octave: octave + 0 };
}

function decodeNote(note: NoteHead, clef: ClefType, chord: boolean, voice: number): El | null {
  if (note.invalid) return null;
  const p = decodePitch(note.staffLinePos, clef, note.sfn as SfnType | null);
  if (!p) return null;
  const e = new El('note');
  if (chord) e.sub('chord');
  const pitch = e.sub('pitch');
  pitch.sub('step', p.step);
  pitch.sub('alter', p.alter);
  pitch.sub('octave', p.octave);
  const r = RHYTHM[note.label ?? NoteType.QUARTER] ?? RHYTHM[NoteType.QUARTER]!;
  const dura = e.sub('duration', r.duration);
  e.sub('type', r.name);
  if (note.hasDot) {
    dura.text = String(pyRound(r.duration * 1.5));
    e.sub('dot');
  }
  e.sub('stem', note.stemUp ? 'up' : 'down');
  e.sub('staff', (note.track ?? 0) + 1);
  e.sub('voice', voice);
  return e;
}

function decodeRest(r: Rest): El {
  const e = new El('note');
  e.sub('rest', undefined, [['measure', 'yes']]);
  const d = e.sub('duration', REST_DURATION[r.label]);
  if (r.hasDot) {
    d.text = String(pyRound(REST_DURATION[r.label] * 1.5));
    e.sub('dot');
  }
  e.sub('staff', (r.track ?? 0) + 1);
  return e;
}

function clefEl(c: Clef): El {
  const cc = new El('clef', [['number', String((c.track ?? 0) + 1)]]);
  const sign = c.label === ClefType.G_CLEF ? 'G' : 'F';
  cc.sub('sign', sign);
  cc.sub('line', sign === 'G' ? '2' : '4');
  return cc;
}

function keyEl(fifths: number): El {
  const k = new El('key');
  k.sub('fifths', fifths);
  return k;
}

// ------------------------------------------------------------------ builder

export interface BuildInput {
  staffs: Staff[][];
  notes: NoteHead[];
  groups: NoteGroup[];
  barlines: Barline[];
  clefs: Clef[];
  sfns: Sfn[];
  rests: Rest[];
}

/** Where each first-voice beat of track 1 sits on the page: lets chord names found by OCR snap to beats. */
export interface TimelineEntry {
  /** System (oemer "group"). */
  group: number;
  /** 0-based measure index in the written MusicXML (= alphaTab bar index). */
  measure: number;
  /** Horizontal centre on the processed page image. */
  x: number;
  /** Start of the beat in the measure, 960 ticks per quarter. */
  tick: number;
}

export function buildMusicXml(input: BuildInput, title = 'Aura Lee', tempo = 90, timeline?: TimelineEntry[]): string {
  const { notes } = input;
  const flat = input.staffs.flat();
  const trackNums = new Set(flat.map((s) => s.track)).size;
  const unit = getGlobalUnitSize(flat);
  const voices = getVoices(input.groups, notes);

  // sort_symbols
  const container = new Map<number, Sym[]>();
  const put = (s: Sym) => {
    const g = symGroup(s);
    if (!container.has(g)) container.set(g, []);
    container.get(g)!.push(s);
  };
  voices.forEach((v) => put({ kind: 'voice', v }));
  input.barlines.forEach((v) => put({ kind: 'barline', v }));
  input.rests.forEach((v) => put({ kind: 'rest', v }));
  input.clefs.forEach((v) => put({ kind: 'clef', v }));
  input.sfns.filter((s) => s.noteId === null).forEach((v) => put({ kind: 'sfn', v }));
  const groupKeys = [...container.keys()].sort((a, b) => a - b);
  for (const k of groupKeys) {
    container.set(
      k,
      container
        .get(k)!
        .map((s, i) => ({ s, i }))
        .sort((a, b) => symX(a.s) - symX(b.s) || a.i - b.i)
        .map((e) => e.s),
    );
  }

  // gen_measures
  const measures = new Map<number, Measure[]>();
  let num = 1;
  const gen = (buffer: Sym[], grp: number, n: number, atBeginning: boolean, dbl: boolean) => {
    const m = new Measure(trackNums);
    m.addSymbols(buffer);
    m.doubleBarline = dbl;
    m.number = n;
    m.atBeginning = atBeginning;
    m.group = grp;
    m.getKey();
    m.alignSymbols(unit, notes);
    return m;
  };
  for (const grp of groupKeys) {
    measures.set(grp, []);
    let buffer: Sym[] = [];
    let atBeginning = true;
    let dbl = false;
    for (const inst of container.get(grp)!) {
      if (inst.kind === 'barline') {
        if (buffer.length === 0) dbl = true;
        else {
          measures.get(grp)!.push(gen(buffer, grp, num, atBeginning, dbl));
          num++;
          buffer = [];
          atBeginning = false;
          dbl = false;
        }
        continue;
      }
      buffer.push(inst);
    }
    if (buffer.length) measures.get(grp)!.push(gen(buffer, grp, num, atBeginning, dbl));
  }

  // actions, performed directly while writing
  const score = new El('score-partwise', [['version', '4.0']]);
  score.sub('work').sub('work-title', title);
  score.sub('identification').sub('creator', 'Transcribed by Oemer', [['type', 'composer']]);
  const pl = score.sub('part-list').sub('score-part', undefined, [['id', 'P1']]);
  pl.sub('part-name', 'Piano');
  const si = pl.sub('score-instrument', undefined, [['id', 'P1-I1']]);
  si.sub('instrument-name', 'Piano');
  si.sub('instrument-sound', 'keyboard.piano');
  const mi = pl.sub('midi-instrument', undefined, [['id', 'P1-I1']]);
  mi.sub('midi-channel', '1');
  mi.sub('midi-program', '1');
  mi.sub('volume', '80');
  mi.sub('pan', '0');
  const part = score.sub('part', undefined, [['id', 'P1']]);
  part.sub('sound', undefined, [['tempo', String(tempo)]]);

  const first = measures.get(groupKeys[0])?.[0];
  if (!first) return '';
  let ctxKey = 0;
  let ctxClefs: (Clef | null)[] = [];
  let sfnState: Record<string, SfnType | null> = {};
  const initSfn = () => {
    sfnState = Object.fromEntries('ABCDEFG'.split('').map((c) => [c, null]));
    if (ctxKey > 0) for (const s of SHARP_KEY_ORDER.slice(0, ctxKey)) sfnState[s] = SfnType.SHARP;
    else if (ctxKey < 0) for (const s of FLAT_KEY_ORDER.slice(0, -ctxKey)) sfnState[s] = SfnType.FLAT;
  };
  // AddInit
  ctxKey = first.getKey();
  ctxClefs = first.getTrackClef();
  initSfn();
  let measureEl = part.sub('measure', undefined, [['number', String(first.number)]]);
  const attr = measureEl.sub('attributes');
  attr.sub('divisions', DIV);
  attr.append(keyEl(first.getKey()));
  attr.sub('staves', trackNums);
  for (const c of first.getTrackClef()) attr.append(clefEl(c!));
  let curKey = first.getKey();
  const curClefs = first.getTrackClef();

  const addNote = (note: NoteHead, chord: boolean, voice: number) => {
    const clef = ctxClefs[note.track ?? 0]?.label ?? ClefType.G_CLEF;
    const ch = chroma(note.staffLinePos, clef);
    const cur = sfnState[ch] ?? null;
    if (note.sfn !== null && note.sfn !== undefined && cur !== note.sfn) sfnState[ch] = note.sfn as SfnType;
    else note.sfn = cur;
    measureEl.append(decodeNote(note, clef, chord, voice));
  };
  const backup = (d: number) => {
    if (d) measureEl.sub('backup').sub('duration', d);
  };
  const forward = (d: number) => {
    if (d) measureEl.sub('forward').sub('duration', d);
  };

  let firstMeasure = true;
  let measureOrdinal = -1;
  for (const grp of groupKeys) {
    let breakSystem = true;
    for (const m of measures.get(grp)!) {
      // AddMeasure (oemer's regex merges the first one into the AddInit measure)
      initSfn();
      if (!firstMeasure) {
        measureEl = part.sub('measure', undefined, [['number', String(m.number)]]);
        if (breakSystem) measureEl.sub('print', undefined, [['new-system', 'yes']]);
      }
      firstMeasure = false;
      breakSystem = false;
      measureOrdinal++;
      let lastTidx = 0;
      let lastDura = 0;
      let lastPos = 0;
      const total = new Array<number>(trackNums).fill(0);
      let minAdded = new Array<boolean>(trackNums).fill(false);
      for (const s of m.symbols) {
        const track = symTrack(s);
        if (s.kind === 'clef') {
          if (curClefs[track]?.label !== s.v.label) {
            ctxClefs[s.v.track ?? 0] = s.v;
            const a = measureEl.sub('attributes');
            a.append(clefEl(s.v));
            curClefs[track] = s.v;
          }
          continue;
        }
        if (s.kind === 'sfn') {
          if (m.hasKey()) {
            const key = m.getKey();
            if (key !== curKey) {
              ctxKey = key;
              initSfn();
              measureEl.sub('attributes').append(keyEl(key));
              curKey = key;
            }
          }
          continue;
        }
        if (s.kind === 'barline') continue;
        const [tidx, minDuras] = m.timeSlotDura(symX(s));
        const minDura = minDuras[track];
        const dura = duration(s);
        if (tidx === lastTidx && lastDura > 0) backup(Math.trunc(lastDura));
        else {
          minAdded = new Array<boolean>(trackNums).fill(false);
          const diff = lastPos - total[track];
          if (diff > 0 && diff !== lastDura) backup(Math.trunc(diff));
        }
        let voiceOne: boolean;
        if (dura === minDura && !minAdded[track] && track === 0) timeline?.push({ group: grp, measure: measureOrdinal, x: symX(s), tick: total[track] * (960 / DIV) });
        if (dura === minDura && !minAdded[track]) {
          total[track] += minDura;
          minAdded[track] = true;
          voiceOne = true;
        } else voiceOne = false;
        if (s.kind === 'rest') {
          measureEl.append(decodeRest(s.v));
          lastPos = total[track];
          lastDura = dura;
          lastTidx = tidx;
        } else {
          const v = s.v;
          if (v.duration === minDura && voiceOne) {
            addNote(notes[v.noteIds[0]], false, 1);
            for (const nid of v.noteIds.slice(1)) addNote(notes[nid], true, 1);
            lastPos = total[track];
            lastDura = dura;
            lastTidx = tidx;
          } else {
            addNote(notes[v.noteIds[0]], false, 2);
            for (const nid of v.noteIds.slice(1)) addNote(notes[nid], true, 2);
            let curPos = total[track] + v.duration;
            if (minAdded[track]) curPos -= minDura;
            const diff = lastPos - curPos;
            if (diff > 0) forward(Math.trunc(diff));
            else if (diff < 0) backup(Math.trunc(-diff));
          }
        }
      }
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
    pretty(score).join('')
  );
}
