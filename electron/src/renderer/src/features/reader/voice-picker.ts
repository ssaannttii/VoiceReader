/** Voice picker helpers: language filter, search, and recently used voices. */
import type { ReaderVoice } from './reader-api';
import { searchKey } from './reader-chrome';

/** Show the search box only when the list is long enough to need it. */
export const VOICE_SEARCH_MIN = 7;
export const RECENT_VOICES_MAX = 5;
export const ALL_LANGUAGES = 'all';

// Codes a voice may name in English ("Spanish") instead of ISO 639-1 ("es").
const COMMON_CODES = [
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fr',
  'gl',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh',
];
let namesToCodes: Map<string, string> | null = null;

function codeForName(name: string): string | undefined {
  if (!namesToCodes) {
    namesToCodes = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'language' });
      for (const code of COMMON_CODES)
        namesToCodes.set(names.of(code)?.toLowerCase() ?? code, code);
    } catch {
      /* No Intl.DisplayNames: names stay as they are. */
    }
    namesToCodes.set('chinese', 'zh');
  }
  return namesToCodes.get(name);
}

/**
 * Comparable language key: "es-ES" → "es", "Spanish" → "es"; unknown names
 * stay as their lowercase selves so they still group together.
 */
export function languageKey(language: string | null | undefined): string {
  const value = language?.trim().toLowerCase() ?? '';
  if (!value) return '';
  if (/^[a-z]{2,3}(?:[-_].*)?$/.test(value)) return value.split(/[-_]/)[0];
  return codeForName(value) ?? value;
}

const base = languageKey;

/** Languages present in the list, most voices first. */
export function voiceLanguages(voices: readonly ReaderVoice[]): string[] {
  const counts = new Map<string, number>();
  for (const voice of voices) {
    const code = base(voice.language);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code);
}

/** The document's language when some voice speaks it, else every language. */
export function defaultVoiceLanguage(
  voices: readonly ReaderVoice[],
  docLanguage: string | null | undefined,
): string {
  const code = base(docLanguage);
  return code && voiceLanguages(voices).includes(code) ? code : ALL_LANGUAGES;
}

/**
 * Voices for a language chip and search text. Voices without a language
 * (multilingual presets) belong to every language.
 */
export function filterVoices(
  voices: readonly ReaderVoice[],
  language: string,
  query: string,
): ReaderVoice[] {
  const needle = searchKey(query.trim());
  return voices.filter((voice) => {
    if (language !== ALL_LANGUAGES && voice.language && base(voice.language) !== language)
      return false;
    if (!needle) return true;
    return searchKey(`${voice.name} ${voice.description ?? ''}`).includes(needle);
  });
}

/** Most recent first, no duplicates, at most `RECENT_VOICES_MAX`. */
export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((item) => item !== id)].slice(0, RECENT_VOICES_MAX);
}

export function parseRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string').slice(0, RECENT_VOICES_MAX);
}

const KEY = 'voicestudio.reader.recentVoices';

export function recentVoiceIds(): string[] {
  try {
    return parseRecent(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function rememberVoice(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pushRecent(recentVoiceIds(), id)));
  } catch {
    /* Recents are a convenience. */
  }
}

/**
 * Language key in the UI language ("es" → "Español"); unknown names capitalized. `inSentence`
 * keeps the locale's own casing for use mid-sentence ("documentos en español").
 */
export function languageName(code: string, locale: string, { inSentence = false } = {}): string {
  const capitalize = (value: string) =>
    inSentence ? value : value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
  if (code.length > 3) return capitalize(code);
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
    if (name && name !== code) return capitalize(name);
  } catch {
    /* Unknown code or no Intl.DisplayNames. */
  }
  return code.toUpperCase();
}
