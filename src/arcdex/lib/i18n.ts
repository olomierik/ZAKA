// Languages (fomo parity: Settings → Languages).
//
//   t('Buy {symbol}', { symbol })  →  "Acheter PEPE"
//
// Keys are the English text itself, so any string without a translation
// simply shows in English. Dictionaries load on demand (one small chunk per
// language); the choice is remembered in this browser.

import { useSyncExternalStore } from 'react'

export type Lang = 'en' | 'fr' | 'es' | 'pt' | 'sw' | 'de' | 'zh'
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'sw', name: 'Kiswahili' },
  { code: 'de', name: 'Deutsch' },
  { code: 'zh', name: '中文' },
]

const KEY = 'arcdex:lang'
const loaders: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  fr: () => import('./i18n/fr'),
  es: () => import('./i18n/es'),
  pt: () => import('./i18n/pt'),
  sw: () => import('./i18n/sw'),
  de: () => import('./i18n/de'),
  zh: () => import('./i18n/zh'),
}

let lang: Lang = 'en'
let dict: Record<string, string> = {}
const listeners = new Set<() => void>()

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY) as Lang | null
    if (saved && LANGS.some(l => l.code === saved)) return saved
  } catch { /* storage blocked */ }
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || 'en').slice(0, 2).toLowerCase()
  return (LANGS.some(l => l.code === nav) ? nav : 'en') as Lang
}

export function t(s: string, vars?: Record<string, string | number>): string {
  const out = dict[s] ?? s
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out
}

export function getLang(): Lang { return lang }

export async function setLang(next: Lang): Promise<void> {
  const d = next === 'en' ? {} : (await loaders[next]()).default
  lang = next
  dict = d
  try { localStorage.setItem(KEY, next) } catch { /* storage blocked */ }
  try { document.documentElement.lang = next } catch { /* SSR */ }
  listeners.forEach(l => l())
}

/** Re-renders the caller when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => lang, () => lang)
}

// Pick up the saved (or browser) language on load.
const initial = detect()
if (initial !== 'en') void setLang(initial).catch(() => {})

/** Marks a string for translation where it's defined (e.g. a module-level
 * table); translate it with t() where it's shown. */
export const N_ = <S extends string>(s: S): S => s
