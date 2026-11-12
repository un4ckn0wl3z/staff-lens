// Builds the HTML of the explanation panels (overview, note, chord) from the score model.

import { t, type StringKey } from '../i18n';
import type { Arrangement, TabSettings } from '../model/arrangement';
import { chordAt, notesInOrder, previousMelodyNote, type SLChord, type SLNote, type SLPart, type SLScore } from '../model/score';
import { explainAccidentals } from '../theory/accidental';
import {
  chordDisplayName,
  chordFormula,
  chordFunction,
  chordNotes,
  chordToneRole,
  classifyNonChordTone,
  isMinorish,
} from '../theory/chord';
import { chordShapes } from '../theory/chordShapes';
import { beatPosition, beatsIn, beatUnit, isCompound } from '../theory/duration';
import { positionsFor } from '../theory/fretboard';
import { intervalBetween } from '../theory/interval';
import { detectKey, majorKeyFor, minorKeyFor, scaleDegree, type Key, type KeyDetection } from '../theory/key';
import { accidentalText, keySignatureSteps, mod, pcOf, pitchClassName, spellMidi, spn } from '../theory/pitch';
import { playOrder, type JumpMarker, type TargetMarker } from '../theory/repeats';
import { chordDiagramSvg, miniFretboardSvg } from '../ui/svg';
import { durationLabel, esc, intervalLabel, keyLabel, listJoin, numberLabel, unitLabel } from './format';

export interface Analysis {
  score: SLScore;
  part: SLPart;
  detection: KeyDetection;
  key: Key;
  ordered: SLNote[];
  order: number[];
}

export function analyze(score: SLScore, part: SLPart): Analysis {
  const first = score.measures[0];
  const fifths = first?.keyFifths ?? 0;
  const ordered = notesInOrder(part);
  const attacks = ordered.filter((n) => !n.isTieDestination && !n.isGrace);
  // melody line = highest note of each onset
  const melody: SLNote[] = [];
  for (const n of attacks) if (!melody.length || melody[melody.length - 1].absTick !== n.absTick) melody.push(n);
  const lastChord = [...part.chords].reverse().find((c) => c.parsed);
  const detection = detectKey({
    fifths,
    notes: melody.map((n) => ({ midi: n.writtenMidi, durationTicks: n.durationTicks })),
    finalChord: lastChord?.parsed ? { rootPc: pcOf(lastChord.parsed.root), minor: isMinorish(lastChord.parsed.quality) } : null,
  });
  // A file that explicitly says "minor" wins.
  const key = first?.keyMinor ? minorKeyFor(fifths) : detection.key;
  return { score, part, detection, key, ordered, order: playOrder(score.measures.map((m) => m.repeat)) };
}

function section(title: string, body: string): string {
  return `<section class="info-block"><h3>${esc(title)}</h3>${body}</section>`;
}

const p = (s: string) => `<p>${s}</p>`;

function tempoName(bpm: number): string {
  const k: StringKey = bpm < 50 ? 'tempo.veryslow' : bpm < 76 ? 'tempo.slow' : bpm < 108 ? 'tempo.walking' : bpm < 120 ? 'tempo.moderate' : bpm < 168 ? 'tempo.fast' : 'tempo.veryfast';
  return t(k);
}

// ---------------------------------------------------------------- overview

export function overviewHtml(an: Analysis, arr: Arrangement | null, settings: TabSettings): string {
  const { score, part } = an;
  const out: string[] = [];
  const first = score.measures[0];

  // Clef
  let clef = p(esc(t(`clef.${part.clef}` as StringKey)));
  if (part.clef === 'treble') clef += p(esc(t('clef.guitar')));
  out.push(section(t('ov.clef'), clef));

  // Key
  const fifths = first?.keyFifths ?? 0;
  const steps = keySignatureSteps(fifths).map((s) => pitchClassName(s));
  let keyHtml =
    fifths === 0
      ? esc(t('key.none'))
      : esc(t(fifths > 0 ? 'key.sharps' : 'key.flats', { n: Math.abs(fifths), list: steps.join(' ') }));
  keyHtml += ' ' + esc(t('key.candidates', { major: keyLabel(majorKeyFor(fifths)), minor: keyLabel(minorKeyFor(fifths)) }));
  const tonic = pitchClassName(an.key.tonic);
  const lt = pitchClassName(spellMidi(pcOf(an.key.tonic) + 11, fifths, undefined));
  const reasons = an.detection.reasons.map((r) => t(`key.reason.${r}` as StringKey, { tonic, lt }));
  let keyBody = p(keyHtml) + p(`<strong>${esc(t('key.likely', { key: keyLabel(an.key), reasons: listJoin(reasons) }))}</strong>`);
  if (fifths !== 0) keyBody += p(esc(t('key.applies')));
  out.push(section(t('ov.key'), keyBody));

  // Time
  if (first) {
    const ts = first.timeSignature;
    const u = beatUnit(ts);
    const text = isCompound(ts)
      ? t('time.compound', { num: ts.numerator, den: ts.denominator, beats: u.beatsPerBar, unit: unitLabel(u.value), small: unitLabel(ts.denominator) })
      : t('time.simple', { num: ts.numerator, den: ts.denominator, unit: unitLabel(ts.denominator) });
    const changes = score.measures.filter((m, i) => i > 0 && (m.timeSignature.numerator !== score.measures[i - 1].timeSignature.numerator || m.timeSignature.denominator !== score.measures[i - 1].timeSignature.denominator));
    let body = p(esc(text));
    if (changes.length) body += p(changes.map((m) => `${esc(t('note.bar', { bar: m.index + 1 }))}: ${m.timeSignature.numerator}/${m.timeSignature.denominator}`).join(' · '));
    out.push(section(t('ov.time'), body));
  }

  // Tempo
  const bpm = Math.round(score.tempo);
  let tempoBody = p(esc(t('tempo.text', { bpm, name: tempoName(bpm) })));
  const tempoChanges = score.measures.filter((m) => m.index > 0 && m.tempo !== null);
  if (tempoChanges.length) tempoBody += p(tempoChanges.map((m) => `${esc(t('note.bar', { bar: m.index + 1 }))}: ♩ = ${Math.round(m.tempo!)}`).join(' · '));
  out.push(section(t('ov.tempo'), tempoBody));

  // Sections
  const sections = score.measures.filter((m) => m.section);
  out.push(
    section(
      t('ov.sections'),
      sections.length
        ? `<ul>${sections.map((m) => `<li><button class="link" data-action="goto-bar" data-bar="${m.index}">${esc(t('section.item', { name: m.section!, bar: m.index + 1 }))}</button></li>`).join('')}</ul>`
        : p(esc(t('sections.none'))),
    ),
  );

  // Repeats
  const items: string[] = [];
  for (const m of score.measures) {
    const bar = m.index + 1;
    const r = m.repeat;
    if (r.repeatStart) items.push(t('repeat.start', { bar }));
    for (const e of r.endings ?? []) items.push(t('repeat.ending', { bar, n: e }));
    for (const tg of r.targets ?? []) items.push(t(`target.${tg as TargetMarker}` as StringKey, { bar }));
    if (r.repeatEnd) items.push(t('repeat.end', { bar, times: r.repeatEnd }));
    for (const j of r.jumps ?? []) items.push(t(`jump.${j as JumpMarker}` as StringKey, { bar }));
  }
  out.push(section(t('ov.repeats'), items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : p(esc(t('repeats.none')))));

  // Play order
  const chips = an.order
    .map((i, k) => {
      const jump = k > 0 && an.order[k - 1] + 1 !== i;
      return `${jump ? '<span class="order-jump" aria-hidden="true">↩</span>' : ''}<button class="chip" data-action="goto-bar" data-bar="${i}">${i + 1}</button>`;
    })
    .join('');
  out.push(
    section(
      t('ov.order'),
      p(esc(t('order.hint'))) + `<div class="order-map">${chips}</div>` + p(`<small>${esc(t('order.total', { n: an.order.length, printed: score.measures.length }))}</small>`),
    ),
  );

  // Chords
  const seen = new Map<string, { chord: SLChord; index: number; bars: number[] }>();
  part.chords.forEach((c, index) => {
    const e = seen.get(c.text);
    if (e) e.bars.push(c.measure + 1);
    else seen.set(c.text, { chord: c, index, bars: [c.measure + 1] });
  });
  const chordChips = [...seen.values()]
    .map(({ chord, index }) => {
      const next = part.chords[index + 1]?.parsed ?? null;
      const fn = chord.parsed ? chordFunction(chord.parsed, an.key, next).roman : '?';
      return `<button class="chip chord-chip" data-action="show-chord" data-chord="${index}"><strong>${esc(chord.text)}</strong><small>${esc(fn)}</small></button>`;
    })
    .join('');
  out.push(section(t('ov.chords'), seen.size ? `<div class="chip-row">${chordChips}</div>` : p(esc(t('chords.none')))));

  // Range
  if (part.notes.length) {
    const sorted = [...part.notes].sort((a, b) => a.writtenMidi - b.writtenMidi);
    let body = p(esc(t('range.text', { lo: spn(sorted[0].written), hi: spn(sorted[sorted.length - 1].written) })));
    if (arr) {
      body += p(esc(t('range.guitar', { ok: part.notes.length - arr.unplayable.size, total: part.notes.length, capo: settings.capo, max: settings.maxFret })));
    }
    out.push(section(t('ov.range'), body));
  }
  return out.join('');
}

// ---------------------------------------------------------------- note

function signName(alter: number): string {
  const k: StringKey = alter === 1 ? 'sign.sharp' : alter === -1 ? 'sign.flat' : alter === 2 ? 'sign.doubleSharp' : alter === -2 ? 'sign.doubleFlat' : 'sign.natural';
  return t(k);
}

export function noteHtml(an: Analysis, note: SLNote, arr: Arrangement | null, settings: TabSettings, detailed: boolean): string {
  const { score, part } = an;
  const out: string[] = [];
  const m = score.measures[note.measure];
  const guitarMidi = arr?.guitarMidi.get(note.id) ?? note.writtenMidi - 12;
  const sounding = spellMidi(guitarMidi, m.keyFifths, note.written.alter);
  const shift = settings.octaveShift[note.measure] ?? 0;

  // Name
  let name = `<div class="note-name"><span class="big">${esc(spn(note.written))}</span>`;
  name += `<span class="sub">${esc(t('note.written'))}</span>`;
  name += `<span class="arrow">→</span><span class="big">${esc(spn(sounding))}</span><span class="sub">${esc(t('note.sounds'))}</span>`;
  name += `<button class="icon-btn" data-action="play-note" title="${esc(t('note.play'))}" aria-label="${esc(t('note.play'))}">▶</button></div>`;
  name += `<p class="muted">${esc(t('note.bar', { bar: note.measure + 1 }))}</p>`;
  name += p(esc(part.octaveTransposed || part.clef === 'treble' ? t('note.guitarOctave', { written: spn(note.written), sounding: spn(sounding) }) : t('note.nonGuitar', { sounding: spn(sounding) })));
  if (shift) name += p(esc(t('note.shifted', { shift: (shift > 0 ? '+' : '') + shift })));
  out.push(`<section class="info-block">${name}</section>`);

  // Duration and beat
  const ts = m.timeSignature;
  const dName = durationLabel(note.durationValue, note.dots, note.tuplet);
  const beats = beatsIn(note.durationTicks, ts);
  let dur = esc(ts.denominator === 4 ? t('note.durationBeats', { name: dName, beats: numberLabel(beats), beatWord: t(beats === 1 ? 'unit.beat' : 'unit.beats') }) : t('note.durationBeatsUnit', { name: dName, beats: numberLabel(beats), unit: unitLabel(ts.denominator) }));
  const pos = beatPosition(note.tick, ts);
  const posKey: Record<string, StringKey> = { '': 'note.beat', '&': 'note.beatAnd', e: 'note.beatE', a: 'note.beatA', trip: 'note.beatTrip', let: 'note.beatLet', other: 'note.beatOther' };
  dur += '<br>' + esc(t(posKey[pos.syllable], { beat: pos.beat, frac: numberLabel(pos.offset) }));
  if (note.isTieDestination) dur += '<br>' + esc(t('note.tied'));
  out.push(section(t('note.length'), p(dur)));

  // Accidental source
  const barNotes = notesInOrder(part).filter((n) => n.measure === note.measure);
  const infos = explainAccidentals(
    barNotes.map((n) => ({ pitch: n.written, isTieDestination: n.isTieDestination })),
    m.keyFifths,
  );
  const info = infos[barNotes.findIndex((n) => n.id === note.id)];
  if (info) {
    const nm = pitchClassName(note.written);
    let text = '';
    switch (info.source) {
      case 'none':
        text = t('acc.none');
        break;
      case 'keySignature':
        text = t('acc.keySignature', { step: note.written.step, name: nm });
        break;
      case 'explicit':
        text = t('acc.explicit', { sign: signName(info.alter), name: nm });
        if (info.cancelsKey) text += ' ' + t('acc.cancels', { keyName: note.written.step + accidentalText(info.keyAlter) });
        break;
      case 'carried':
        text = t('acc.carried', { name: nm });
        break;
      case 'tied':
        text = t('acc.tied', { name: nm });
        break;
    }
    out.push(section(t('note.accidental'), p(esc(text))));
  }

  // Interval from previous melody note
  const prev = previousMelodyNote(part, note);
  let ivText: string;
  if (!prev) ivText = t('interval.first');
  else {
    const iv = intervalBetween(prev.written, note.written);
    if (iv.direction === 'same') ivText = t('interval.same', { prev: spn(prev.written) });
    else ivText = t(iv.direction === 'up' ? 'interval.up' : 'interval.down', { name: intervalLabel(iv), prev: spn(prev.written), semis: iv.semitones, semiWord: t(iv.semitones === 1 ? 'unit.semitone' : 'unit.semitones') });
  }
  out.push(section(t('note.interval'), p(esc(ivText))));

  // Scale degree
  const deg = scaleDegree(note.written, an.key);
  let degText: string;
  if (deg.alter === 0 || deg.minorRaised) {
    degText = esc(t('degree.text', { label: deg.label, key: keyLabel(an.key), name: t(`deg.${deg.name}` as StringKey) }));
    if (deg.minorRaised) degText += '<br>' + esc(t('degree.minorRaised'));
  } else {
    degText = esc(t('degree.chromaticText', { label: deg.label, key: keyLabel(an.key) })) + '<br>' + esc(t('degree.chromatic', { key: keyLabel(an.key) }));
  }
  out.push(section(t('note.degree'), p(degText)));

  // Chord context
  const chord = chordAt(part, note.absTick);
  let chordText: string;
  if (!chord || !chord.parsed) chordText = esc(t('nochord.text'));
  else {
    const role = chordToneRole(mod(note.writtenMidi, 12), chord.parsed);
    const link = `<button class="link" data-action="show-chord" data-chord="${part.chords.indexOf(chord)}">${esc(chord.text)}</button>`;
    if (role) chordText = t('chordtone.text', { chord: '\u0000', role: t(`role.${role}` as StringKey) });
    else {
      const ordered = an.ordered.filter((n) => !n.isTieDestination);
      const idx = ordered.findIndex((n) => n.id === note.id);
      const next = ordered.slice(idx + 1).find((n) => n.absTick > note.absTick);
      const type = classifyNonChordTone(prev?.writtenMidi ?? null, note.writtenMidi, next?.writtenMidi ?? null);
      chordText = t('nonchord.text', { chord: '\u0000', name: pitchClassName(note.written), type: t(`nonchord.${type}` as StringKey) });
    }
    chordText = esc(chordText).replace('\u0000', link);
  }
  out.push(section(t('note.chord'), p(chordText)));

  // Fretboard positions
  out.push(positionsHtml(note, guitarMidi, arr, settings, detailed));
  return out.join('');
}

function positionsHtml(note: SLNote, guitarMidi: number, arr: Arrangement | null, settings: TabSettings, detailed: boolean): string {
  const tuning = arr?.tuning ?? [64, 59, 55, 50, 45, 40];
  const capo = settings.capo;
  const all = positionsFor(guitarMidi, tuning, capo, settings.maxFret);
  const current = arr?.placements.get(note.id) ?? null;
  const locked = settings.locks[note.id];
  if (all.length === 0) return section(t('note.positions'), p(`<span class="warn">${esc(t('note.unplayable', { capo, max: settings.maxFret }))}</span>`));
  const rows = all
    .map((pos) => {
      const isCur = current && current.position.string === pos.string && current.position.fret === pos.fret;
      const isLocked = locked && locked.string === pos.string && locked.fret === pos.fret;
      // Tab numbers are relative to the capo.
      const label = t('note.stringFret', { s: pos.string, f: pos.fret - capo }) + (capo ? ` (${t('tab.capo')} ${capo})` : '');
      let extra = '';
      if (isCur) {
        const finger = current!.finger;
        extra = `<span class="badge">${esc(t('note.inTab'))}</span> <span class="muted">${esc(finger === 0 ? t('note.open') : detailed ? t(`finger.${finger}` as StringKey) : t('note.finger', { n: finger }))}</span>`;
      }
      const btn = isLocked
        ? `<button class="btn small" data-action="unlock">${esc(t('note.unlock'))}</button>`
        : isCur
          ? ''
          : `<button class="btn small" data-action="lock" data-string="${pos.string}" data-fret="${pos.fret}">${esc(t('note.use'))}</button>`;
      return `<li class="${isCur ? 'current' : ''}">${esc(label)} ${isLocked ? `<span class="badge lock">🔒 ${esc(t('note.locked'))}</span>` : ''} ${extra} ${btn}</li>`;
    })
    .join('');
  const svg = miniFretboardSvg(all, current?.position ?? null, tuning, capo, Math.max(12, settings.maxFret));
  return section(t('note.positions'), `<ul class="positions">${rows}</ul>${svg}`);
}

// ---------------------------------------------------------------- chord

export function chordHtml(an: Analysis, index: number): string {
  const c = an.part.chords[index];
  if (!c) return p(esc(t('chord.selectHint')));
  if (!c.parsed) return p(esc(t('chord.unknown', { text: c.text })));
  const chord = c.parsed;
  const next = an.part.chords.slice(index + 1).find((x) => x.text !== c.text)?.parsed ?? null;
  const out: string[] = [];
  const notes = chordNotes(chord).map((n) => pitchClassName(n));
  out.push(
    `<section class="info-block"><div class="note-name"><span class="big">${esc(chordDisplayName(chord))}</span>` +
      `<button class="btn" data-action="strum">${esc(t('chord.strum'))}</button>` +
      `<button class="btn" data-action="arpeggio">${esc(t('chord.arpeggio'))}</button></div>` +
      p(`<strong>${esc(chordDisplayName(chord))} = ${esc(chordFormula(chord))} = ${esc(notes.join(' '))}</strong>`) +
      `</section>`,
  );
  let sym = p(esc(t(`suffix.${chord.quality}` as StringKey)));
  if (chord.bass) sym += p(esc(t('chord.slash', { bass: pitchClassName(chord.bass) })));
  out.push(section(t('chord.symbol'), sym));

  const fn = chordFunction(chord, an.key, next);
  let fnBody = p(`<span class="roman">${esc(fn.roman)}</span> ${esc(fn.diatonic ? t('chord.diatonic') : t('chord.nonDiatonic'))}`);
  if (fn.secondaryOf) fnBody += p(esc(t('chord.secondary', { target: fn.secondaryOf })));
  if (fn.resolvesTo && next) fnBody += p(esc(t('chord.resolves', { roman: fn.roman, next: fn.resolvesTo, nextName: chordDisplayName(next) })));
  out.push(section(t('chord.function', { key: keyLabel(an.key) }), fnBody));

  const shapes = chordShapes(chord, 2);
  if (shapes.length) {
    const diagrams = shapes
      .map((s) => {
        const caption = s.kind === 'open' ? t('chord.openShape') : t('chord.barre', { shape: s.shapeName ?? '', fret: s.barre ?? 0 });
        return `<figure class="diagram">${chordDiagramSvg(s, chordDisplayName(chord))}<figcaption>${esc(caption)}</figcaption></figure>`;
      })
      .join('');
    out.push(section(t('chord.shapes'), `<div class="diagram-row">${diagrams}</div>`));
  }
  const bars = [...new Set(an.part.chords.filter((x) => x.text === c.text).map((x) => x.measure + 1))];
  out.push(p(`<small>${esc(t('chord.inBars', { bars: bars.join(', ') }))}</small>`));
  return out.join('');
}
