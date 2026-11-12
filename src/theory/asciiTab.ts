// Plain-text tab: aligned columns, N bars per line.

import { stringLabel } from './fretboard';

export interface AsciiNote {
  /** 1 = highest string */
  string: number;
  /** fret as written in the tab (relative to capo) */
  fret: number;
  tied?: boolean;
}

export interface AsciiEvent {
  tick: number;
  duration: number;
  notes: AsciiNote[];
}

export interface AsciiBar {
  events: AsciiEvent[];
}

export interface AsciiOptions {
  tuning: number[];
  barsPerLine?: number;
  title?: string;
  capo?: number;
  /** extra header lines (tempo, key …) */
  header?: string[];
}

const SIXTEENTH = 240;

function renderBar(bar: AsciiBar, strings: number): string[] {
  const lines = Array.from({ length: strings }, () => '-');
  const events = [...bar.events].sort((a, b) => a.tick - b.tick);
  if (events.length === 0) return lines.map((l) => l + '-'.repeat(8));
  for (const ev of events) {
    const texts = new Map<number, string>();
    for (const n of ev.notes) texts.set(n.string, n.tied ? `(${n.fret})` : String(n.fret));
    const maxLen = Math.max(1, ...[...texts.values()].map((t) => t.length));
    const width = Math.max(maxLen + 1, Math.min(8, Math.max(2, Math.round(ev.duration / SIXTEENTH))));
    for (let s = 1; s <= strings; s++) {
      const t = texts.get(s) ?? '';
      lines[s - 1] += t + '-'.repeat(width - t.length);
    }
  }
  return lines;
}

export function asciiTab(bars: AsciiBar[], opts: AsciiOptions): string {
  const perLine = opts.barsPerLine ?? 4;
  const strings = opts.tuning.length;
  const labels = opts.tuning.map((m, i) => stringLabel(m, i === 0));
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const out: string[] = [];
  if (opts.title) out.push(opts.title, '');
  if (opts.header) out.push(...opts.header);
  if (opts.capo) out.push(`Capo ${opts.capo}`);
  if (opts.title || opts.header?.length || opts.capo) out.push('');
  for (let b = 0; b < bars.length; b += perLine) {
    const chunk = bars.slice(b, b + perLine).map((bar) => renderBar(bar, strings));
    out.push(`${b + 1}`);
    for (let s = 0; s < strings; s++) {
      out.push(labels[s].padEnd(labelWidth) + '|' + chunk.map((c) => c[s] + '|').join(''));
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}
