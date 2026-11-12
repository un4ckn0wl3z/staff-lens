// Tiny i18n: Thai and English. Keys are shared; `{name}` placeholders are replaced from vars.

import { en } from './en';
import { th } from './th';

export type Lang = 'en' | 'th';
export type StringKey = keyof typeof en;

const dicts: Record<Lang, Record<StringKey, string>> = { en, th };

let current: Lang = 'en';
const listeners = new Set<() => void>();

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem('stafflens.lang', lang);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function getLang(): Lang {
  return current;
}

export function initialLang(): Lang {
  try {
    const s = localStorage.getItem('stafflens.lang');
    if (s === 'en' || s === 'th') return s;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('th') ? 'th' : 'en';
}

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s = dicts[current][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Applies translations to elements with data-i18n / data-i18n-title / data-i18n-aria attributes. */
export function translateDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as StringKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as StringKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as StringKey));
  });
}
