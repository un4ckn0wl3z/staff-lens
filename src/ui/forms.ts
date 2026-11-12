// Tab settings and Export panels (form controls).

import { esc } from '../explain/format';
import { t, type StringKey } from '../i18n';
import type { Arrangement, TabSettings } from '../model/arrangement';
import type { SLScore } from '../model/score';
import { TUNINGS } from '../theory/fretboard';

export interface TabPanelState {
  score: SLScore;
  partIndex: number;
  settings: TabSettings;
  arr: Arrangement | null;
  loop: { from: number; to: number; on: boolean };
  octaveScope: 'part' | 'selection';
}

const radio = (name: string, value: string, checked: boolean, label: string) =>
  `<label class="radio"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;

export function tabPanelHtml(s: TabPanelState): string {
  const { settings, arr, score } = s;
  const part = score.parts[s.partIndex];
  const total = part.notes.length;
  const unplayable = arr?.unplayable.size ?? 0;
  const out: string[] = [];

  if (score.parts.length > 1) {
    out.push(
      `<label class="field"><span>${esc(t('tab.part'))}</span><select name="part">${score.parts
        .map((p, i) => `<option value="${i}" ${i === s.partIndex ? 'selected' : ''}>${esc(p.name)}${p.staffIndex ? ` (${p.staffIndex + 1})` : ''}</option>`)
        .join('')}</select></label>`,
    );
  }
  if (part.hasTab) out.push(`<p class="muted">${esc(t('tab.fromFile'))}</p>`);

  out.push(
    `<fieldset><legend>${esc(t('tab.mode'))}</legend>${radio('mode', 'open', settings.mode === 'open', t('mode.open'))}${radio(
      'mode',
      'position',
      settings.mode === 'position',
      t('mode.position'),
    )}<label class="field inline ${settings.mode === 'position' ? '' : 'dim'}"><span>${esc(t('tab.position'))}</span><input type="number" name="position" min="1" max="12" value="${settings.position}"></label>${radio(
      'mode',
      'minimal',
      settings.mode === 'minimal',
      t('mode.minimal'),
    )}</fieldset>`,
  );

  out.push(
    `<div class="field-row"><label class="field"><span>${esc(t('tab.tuning'))}</span><select name="tuning">${Object.keys(TUNINGS)
      .map((id) => `<option value="${id}" ${id === settings.tuningId ? 'selected' : ''}>${esc(t(`tuning.${id}` as StringKey))}</option>`)
      .join('')}</select></label><label class="field"><span>${esc(t('tab.capo'))}</span><select name="capo">${Array.from({ length: 10 }, (_, i) => i)
      .map((i) => `<option value="${i}" ${i === settings.capo ? 'selected' : ''}>${i === 0 ? esc(t('tab.noCapo')) : i}</option>`)
      .join('')}</select></label></div>`,
  );

  out.push(`<label class="check"><input type="checkbox" name="beginner" ${settings.beginner ? 'checked' : ''}> ${esc(t('tab.beginner'))}</label>`);
  const hasChords = part.chords.some((c) => c.parsed);
  out.push(
    `<label class="check ${hasChords ? '' : 'dim'}"><input type="checkbox" name="addBass" ${settings.addBass ? 'checked' : ''} ${hasChords ? '' : 'disabled'}> ${esc(t('tab.addBass'))}</label>`,
  );

  // Range + octave
  const status = `<p class="${unplayable ? 'warn' : 'ok'}">${esc(t('tab.playable', { ok: total - unplayable, total }))}${unplayable ? ' — ' + esc(t('tab.outOfRange', { n: unplayable })) : ''}</p>`;
  let suggestion = '';
  const currentShift = settings.octaveShift[0] ?? 0;
  if (arr && unplayable > 0 && arr.suggestedShift !== currentShift) {
    suggestion = `<p>${esc(t('tab.suggest', { dir: t(arr.suggestedShift < currentShift ? 'dir.down' : 'dir.up') }))} <button class="btn small" data-action="apply-shift" data-shift="${arr.suggestedShift}">${esc(t('tab.apply'))}</button></p>`;
  }
  const selLabel = t('scope.selection', { from: s.loop.from, to: s.loop.to });
  out.push(
    `<fieldset><legend>${esc(t('tab.octave'))}</legend>${status}${suggestion}<div class="btn-row"><button class="btn" data-action="octave" data-delta="-1">${esc(
      t('tab.octaveDown'),
    )}</button><button class="btn" data-action="octave" data-delta="1">${esc(t('tab.octaveUp'))}</button><button class="btn ghost" data-action="octave-reset">${esc(
      t('tab.octaveReset'),
    )}</button></div><div class="radio-row"><span>${esc(t('tab.scope'))}:</span>${radio('octaveScope', 'part', s.octaveScope === 'part', t('scope.part'))}${radio(
      'octaveScope',
      'selection',
      s.octaveScope === 'selection',
      selLabel,
    )}</div></fieldset>`,
  );

  const locks = Object.keys(settings.locks).length;
  out.push(`<p class="muted">${esc(t('tab.lockHint'))}</p>`);
  if (locks) out.push(`<button class="btn ghost" data-action="clear-locks">${esc(t('tab.clearLocks', { n: locks }))}</button>`);
  return `<form class="tab-form" onsubmit="return false">${out.join('')}</form>`;
}

export function exportPanelHtml(ascii: string): string {
  return `<div class="export-grid">
    <button class="btn primary" data-action="export-gp5">${esc(t('export.gp5'))}</button>
    <button class="btn" data-action="export-gp7">${esc(t('export.gp7'))}</button>
    <button class="btn" data-action="export-midi">${esc(t('export.midi'))}</button>
    <button class="btn" data-action="export-ascii">${esc(t('export.ascii'))}</button>
    <button class="btn" data-action="copy-ascii">${esc(t('export.copyAscii'))}</button>
    <button class="btn" data-action="export-png">${esc(t('export.png'))}</button>
    <button class="btn" data-action="export-print">${esc(t('export.print'))}</button>
  </div>
  <p class="muted">${esc(t('export.gp5Note'))}</p>
  <h3>${esc(t('export.preview'))}</h3>
  <pre class="ascii" tabindex="0">${esc(ascii)}</pre>`;
}
