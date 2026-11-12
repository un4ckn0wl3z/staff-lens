// SVG drawings: fretboards and chord diagrams. Colors come from CSS variables (see style.css).

import type { ChordShape } from '../theory/chordShapes';
import type { FretPosition } from '../theory/fretboard';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const MARKERS = [3, 5, 7, 9, 12, 15, 17, 19, 21];

export function noteNameOf(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export interface FretboardGeometry {
  frets: number;
  strings: number;
  left: number;
  top: number;
  fretW: number;
  stringGap: number;
  width: number;
  height: number;
}

export function geometry(frets: number, strings: number, fretW = 48, stringGap = 15): FretboardGeometry {
  const left = 34;
  const top = 14;
  return { frets, strings, left, top, fretW, stringGap, width: left + fretW * frets + 12, height: top + stringGap * (strings - 1) + 26 };
}

/** x of the centre of a fret cell (fret 0 is drawn left of the nut). */
export function fretX(g: FretboardGeometry, fret: number): number {
  return fret === 0 ? g.left - 16 : g.left + (fret - 0.5) * g.fretW;
}

export function stringY(g: FretboardGeometry, string: number): number {
  return g.top + (string - 1) * g.stringGap;
}

/** Static board: strings, frets, nut, inlays, fret numbers. */
export function boardSvg(g: FretboardGeometry, tuning: number[], capo: number): string {
  const parts: string[] = [];
  for (const m of MARKERS) {
    if (m > g.frets) continue;
    const x = g.left + (m - 0.5) * g.fretW;
    const midY = g.top + ((g.strings - 1) * g.stringGap) / 2;
    if (m % 12 === 0) {
      parts.push(`<circle class="fb-inlay" cx="${x}" cy="${midY - g.stringGap}" r="4"/><circle class="fb-inlay" cx="${x}" cy="${midY + g.stringGap}" r="4"/>`);
    } else parts.push(`<circle class="fb-inlay" cx="${x}" cy="${midY}" r="4"/>`);
  }
  for (let f = 0; f <= g.frets; f++) {
    const x = g.left + f * g.fretW;
    parts.push(`<line class="${f === 0 ? 'fb-nut' : 'fb-fret'}" x1="${x}" y1="${g.top - 4}" x2="${x}" y2="${stringY(g, g.strings) + 4}"/>`);
    if (f > 0 && (MARKERS.includes(f) || f === 1)) parts.push(`<text class="fb-num" x="${g.left + (f - 0.5) * g.fretW}" y="${stringY(g, g.strings) + 20}">${f}</text>`);
  }
  for (let s = 1; s <= g.strings; s++) {
    const y = stringY(g, s);
    parts.push(`<line class="fb-string" x1="${g.left}" y1="${y}" x2="${g.left + g.frets * g.fretW}" y2="${y}" style="stroke-width:${0.8 + (s - 1) * 0.35}"/>`);
    parts.push(`<text class="fb-label" x="6" y="${y + 4}">${NAMES[tuning[s - 1] % 12].replace('♯', '#')}</text>`);
  }
  if (capo > 0 && capo <= g.frets) {
    const x = g.left + (capo - 0.5) * g.fretW;
    parts.push(`<rect class="fb-capo" x="${x - 5}" y="${g.top - 7}" width="10" height="${(g.strings - 1) * g.stringGap + 14}" rx="4"/>`);
  }
  return parts.join('');
}

export function miniFretboardSvg(positions: FretPosition[], current: FretPosition | null, tuning: number[], capo: number, frets: number): string {
  const g = geometry(frets, tuning.length, 26, 14);
  const dots = positions
    .map((p) => {
      const isCur = current && current.string === p.string && current.fret === p.fret;
      const x = fretX(g, p.fret);
      const y = stringY(g, p.string);
      return `<circle class="fb-dot ${isCur ? 'current' : 'option'}" cx="${x}" cy="${y}" r="${isCur ? 7 : 6}"/>${isCur ? `<text class="fb-dot-text" x="${x}" y="${y + 3.5}">${p.fret - capo}</text>` : ''}`;
    })
    .join('');
  return `<svg class="mini-fretboard" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-hidden="true">${boardSvg(g, tuning, capo)}${dots}</svg>`;
}

/** Vertical chord box: strings low E (left) -> high E (right). */
export function chordDiagramSvg(shape: ChordShape, title: string): string {
  const fretted = shape.frets.filter((f) => f > 0);
  const minF = fretted.length ? Math.min(...fretted) : 1;
  const maxF = fretted.length ? Math.max(...fretted) : 1;
  const start = maxF <= 4 ? 1 : minF;
  const rows = Math.max(4, maxF - start + 1);
  const gap = 16;
  const left = 22;
  const top = 26;
  const w = left + gap * 5 + 22;
  const h = top + gap * rows + 12;
  const parts: string[] = [];
  for (let s = 0; s < 6; s++) parts.push(`<line class="cd-line" x1="${left + s * gap}" y1="${top}" x2="${left + s * gap}" y2="${top + rows * gap}"/>`);
  for (let r = 0; r <= rows; r++) {
    const cls = r === 0 && start === 1 ? 'cd-nut' : 'cd-line';
    parts.push(`<line class="${cls}" x1="${left}" y1="${top + r * gap}" x2="${left + 5 * gap}" y2="${top + r * gap}"/>`);
  }
  if (start > 1) parts.push(`<text class="cd-fretno" x="${left - 6}" y="${top + gap * 0.7}">${start}</text>`);
  if (shape.barre) {
    const strings = shape.frets.map((f, i) => (f === shape.barre && shape.fingers[i] === 1 ? i : -1)).filter((i) => i >= 0);
    if (strings.length >= 2) {
      const y = top + (shape.barre - start + 0.5) * gap;
      parts.push(`<rect class="cd-barre" x="${left + strings[0] * gap - 6}" y="${y - 6}" width="${(strings[strings.length - 1] - strings[0]) * gap + 12}" height="12" rx="6"/>`);
    }
  }
  shape.frets.forEach((f, i) => {
    const x = left + i * gap;
    if (f < 0) parts.push(`<text class="cd-mark" x="${x}" y="${top - 8}">×</text>`);
    else if (f === 0) parts.push(`<circle class="cd-open" cx="${x}" cy="${top - 11}" r="4"/>`);
    else {
      const y = top + (f - start + 0.5) * gap;
      parts.push(`<circle class="cd-dot" cx="${x}" cy="${y}" r="6"/>`);
      if (shape.fingers[i]) parts.push(`<text class="cd-finger" x="${x}" y="${y + 3.5}">${shape.fingers[i]}</text>`);
    }
  });
  return `<svg class="chord-diagram" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">${parts.join('')}</svg>`;
}
