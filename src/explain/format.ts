// Localized formatting helpers for theory objects.

import { getLang, t, type StringKey } from '../i18n';
import { DURATION_KEYS, type DurationValue } from '../theory/duration';
import { ordinal, type Interval } from '../theory/interval';
import type { Key } from '../theory/key';
import { pitchClassName, type PitchClass } from '../theory/pitch';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function keyLabel(key: Key): string {
  return t(key.mode === 'major' ? 'key.major' : 'key.minor', { tonic: pitchClassName(key.tonic) });
}

export function pcLabel(p: PitchClass): string {
  return pitchClassName(p);
}

export function intervalLabel(iv: Interval): string {
  if (iv.number === 1 && iv.quality === 'P') return t('iv.unison');
  if (iv.number === 8 && iv.quality === 'P') return t('iv.octave');
  return t('iv.format', { quality: t(`iv.${iv.quality}` as StringKey), ord: ordinal(iv.number), n: iv.number });
}

export function durationLabel(value: number, dots: number, tuplet: { numerator: number; denominator: number } | null): string {
  const key = DURATION_KEYS[value as DurationValue];
  let name = key ? t(`dur.${key}` as StringKey) : `1/${value}`;
  if (dots === 1) name = t('dur.dotted', { name });
  else if (dots >= 2) name = t('dur.doubleDotted', { name });
  if (tuplet) {
    if (tuplet.numerator === 3 && tuplet.denominator === 2) name = t('dur.triplet', { name });
    else name = t('dur.tuplet', { name, n: tuplet.numerator, d: tuplet.denominator });
  }
  return name;
}

export function unitLabel(value: number): string {
  const key = DURATION_KEYS[value as DurationValue];
  return key ? t(`dur.${key}` as StringKey) : `1/${value}`;
}

export function numberLabel(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const fracs: [number, string][] = [
    [0.5, '½'],
    [0.25, '¼'],
    [0.75, '¾'],
    [1 / 3, '⅓'],
    [2 / 3, '⅔'],
    [0.125, '⅛'],
  ];
  const whole = Math.floor(n);
  const rest = n - whole;
  for (const [v, s] of fracs) if (Math.abs(rest - v) < 0.01) return whole > 0 ? `${whole}${s}` : s;
  return n.toFixed(2);
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (getLang() === 'th') return items.slice(0, -1).join(' ') + ' และ' + items[items.length - 1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
