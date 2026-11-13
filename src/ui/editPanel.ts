// Edit panel: fix recognised (or imported) notes.

import { durationLabel, esc } from '../explain/format';
import { t } from '../i18n';
import type { BarIssue, BeatRef } from '../model/edit';
import type { SLBeat, SLChord, SLNote } from '../model/score';
import { spn } from '../theory/pitch';

export interface EditPanelState {
  note: SLNote | null;
  rest: SLBeat | null;
  ref: BeatRef | null;
  chordAtBeat: SLChord | null;
  canUndo: boolean;
  canRedo: boolean;
  issues: BarIssue[];
  quarterTicks: number;
  /** Starting tempo of the score (♩ per minute). */
  tempo: number;
}

const DURS: [number, string][] = [
  [1, '𝅝'],
  [2, '𝅗𝅥'],
  [4, '♩'],
  [8, '♪'],
  [16, '𝅘𝅥𝅯'],
  [32, '𝅘𝅥𝅰'],
];

const btn = (action: string, label: string, title: string, extra = '', disabled = false) =>
  `<button class="btn small" data-action="${action}" ${extra} title="${esc(title)}" aria-label="${esc(title)}" ${disabled ? 'disabled' : ''}>${label}</button>`;

export function editPanelHtml(s: EditPanelState): string {
  const out: string[] = [`<h2>${esc(t('ed.heading'))}</h2>`];
  const sel = s.note ?? s.rest;
  const value = sel?.durationValue ?? 4;
  const dots = sel?.dots ?? 0;
  if (s.note) {
    out.push(`<p class="ed-sel"><strong>${esc(spn(s.note.written))}</strong> · ${esc(durationLabel(s.note.durationValue, s.note.dots, s.note.tuplet))} · ${esc(t('note.bar', { bar: s.note.measure + 1 }))}</p>`);
  } else if (s.rest) {
    out.push(`<p class="ed-sel"><strong>${esc(t('ed.rest'))}</strong> · ${esc(durationLabel(s.rest.durationValue, s.rest.dots, s.rest.tuplet))} · ${esc(t('note.bar', { bar: s.rest.measure + 1 }))}</p>`);
  } else out.push(`<p class="muted">${esc(t('ed.hint'))}</p>`);

  const none = !sel;
  const noNote = !s.note;
  out.push(`<section class="info-block"><h3>${esc(t('ed.pitch'))}</h3><div class="btn-row">
    ${btn('ed-step', '▲', t('ed.stepUp'), 'data-d="1"', noNote)}
    ${btn('ed-step', '▼', t('ed.stepDown'), 'data-d="-1"', noNote)}
    ${btn('ed-oct', '8va▲', t('ed.octUp'), 'data-d="1"', noNote)}
    ${btn('ed-oct', '8vb▼', t('ed.octDown'), 'data-d="-1"', noNote)}
    ${btn('ed-acc', '♭', t('ed.flat'), 'data-a="-1"', noNote)}
    ${btn('ed-acc', '♮', t('ed.natural'), 'data-a="0"', noNote)}
    ${btn('ed-acc', '♯', t('ed.sharp'), 'data-a="1"', noNote)}
  </div></section>`);

  out.push(`<section class="info-block"><h3>${esc(t('ed.length'))}</h3><div class="btn-row">
    ${DURS.map(([v, sym]) => btn('ed-dur', sym, durationLabel(v, 0, null), `data-v="${v}" aria-pressed="${sel && v === value ? 'true' : 'false'}"`, none)).join('')}
    ${btn('ed-dot', '•', t('ed.dot'), `aria-pressed="${dots ? 'true' : 'false'}"`, none)}
  </div></section>`);

  out.push(`<section class="info-block"><h3>${esc(t('ed.notes'))}</h3><div class="btn-row">
    ${btn('ed-insert', `＋ ${esc(t('ed.insert'))}`, t('ed.insert'), '', none)}
    ${btn('ed-chordnote', `＋ ${esc(t('ed.chordNote'))}`, t('ed.chordNote'), '', noNote)}
    ${s.note ? btn('ed-rest', esc(t('ed.toRest')), t('ed.toRest')) : btn('ed-note', esc(t('ed.toNote')), t('ed.toNote'), '', none)}
    ${btn('ed-del-note', `✕ ${esc(t('ed.delNote'))}`, t('ed.delNote'), '', noNote)}
    ${btn('ed-del-beat', `✕ ${esc(t('ed.delBeat'))}`, t('ed.delBeat'), '', none)}
  </div></section>`);

  out.push(`<section class="info-block"><h3>${esc(t('ed.chord'))}</h3><div class="btn-row">
    <input class="ed-chord" name="ed-chord" value="${esc(s.chordAtBeat?.text ?? '')}" placeholder="G7, Am, Cmaj7…" aria-label="${esc(t('ed.chord'))}" ${none ? 'disabled' : ''}>
    ${btn('ed-chord-set', esc(t('ed.chordSet')), t('ed.chordSet'), '', none)}
    ${btn('ed-chord-del', esc(t('ed.chordDel')), t('ed.chordDel'), '', none || !s.chordAtBeat)}
  </div></section>`);

  out.push(`<section class="info-block"><h3>${esc(t('ed.tempo'))}</h3><p class="muted small">${esc(t('ed.tempoHint'))}</p><div class="btn-row">
    <label class="inline-field">♩ = <input class="ed-tempo" name="ed-tempo" type="number" min="20" max="400" step="1" inputmode="numeric" value="${Math.round(s.tempo)}" aria-label="${esc(t('ed.tempo'))}"></label>
    ${btn('ed-tempo-set', esc(t('ed.tempoSet')), t('ed.tempoSet'))}
  </div></section>`);

  out.push(`<div class="btn-row">${btn('ed-undo', `↶ ${esc(t('ed.undo'))}`, `${t('ed.undo')} (Ctrl+Z)`, '', !s.canUndo)}${btn('ed-redo', `↷ ${esc(t('ed.redo'))}`, `${t('ed.redo')} (Ctrl+Y)`, '', !s.canRedo)}</div>`);

  const q = s.quarterTicks;
  const fmt = (ticks: number) => String(Math.round((ticks / q) * 100) / 100);
  out.push(
    `<section class="info-block"><h3>${esc(t('ed.barCheck'))}</h3>${
      s.issues.length
        ? `<p class="warn">${esc(t('ed.barIssues', { n: s.issues.length }))}</p><ul>${s.issues
            .map((i) => `<li><button class="link" data-action="goto-bar" data-bar="${i.measure}">${esc(t('ed.barIssue', { bar: i.measure + 1, actual: fmt(i.actual), expected: fmt(i.expected) }))}</button></li>`)
            .join('')}</ul>`
        : `<p class="ok">${esc(t('ed.barsOk'))}</p>`
    }</section>`,
  );
  out.push(`<p class="muted small">${esc(t('ed.keys'))}</p>`);
  return out.join('');
}
