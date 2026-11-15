// i18n: 14 hand-translated languages loaded on demand, instant switching, and
// optional on-device machine translation (Chrome's built-in Translator API) for
// extra UI languages and for post titles.
import EN from './locales/en.js';

export const LANGS = [
  ['en', 'English'], ['pt', 'Português'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['ru', 'Русский'], ['tr', 'Türkçe'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
  ['id', 'Bahasa Indonesia'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文（简体）'],
];

// Offered only when the browser ships an on-device translator.
export const MT_LANGS = [
  ['pl', 'Polski'], ['nl', 'Nederlands'], ['uk', 'Українська'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'],
  ['fa', 'فارسی'], ['he', 'עברית'], ['sv', 'Svenska'], ['el', 'Ελληνικά'], ['ro', 'Română'],
  ['cs', 'Čeština'], ['hu', 'Magyar'], ['bn', 'বাংলা'], ['da', 'Dansk'], ['fi', 'Suomi'],
  ['no', 'Norsk'], ['bg', 'Български'], ['hr', 'Hrvatski'], ['sk', 'Slovenčina'], ['lt', 'Lietuvių'],
  ['sl', 'Slovenščina'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'], ['mr', 'मराठी'], ['kn', 'ಕನ್ನಡ'],
];

const RTL = new Set(['ar', 'fa', 'he', 'ur']);
const HAND = new Set(LANGS.map(([c]) => c));
const DICT_VERSION = 3;

let lang = 'en';
let dict = EN;
const cache = new Map([['en', EN]]);

export const hasTranslator = () => typeof self !== 'undefined' && 'Translator' in self;
export const getLang = () => lang;
export const isHandmade = (code) => HAND.has(code);

/** Pick the best language for this browser (or the saved preference). */
export function detectLang(pref) {
  if (pref && pref !== 'auto') return pref;
  const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
  for (const p of prefs) {
    const base = String(p).toLowerCase().split('-')[0];
    if (HAND.has(base)) return base;
    if (hasTranslator() && MT_LANGS.some(([c]) => c === base) && readMtCache(base)) return base;
  }
  return 'en';
}

export function t(key, vars) {
  let s = dict[key] ?? EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

/** A translatable message: rendered with the language current at render time. */
export function L(key, vars) {
  return { i18n: true, key, vars, toString() { return t(key, vars); } };
}

/** Render a string, an L() message, or an array of both. */
export function render(x) {
  if (x == null) return '';
  if (Array.isArray(x)) return x.map(render).join('');
  if (typeof x === 'object' && x.i18n) return t(x.key, x.vars && Object.fromEntries(Object.entries(x.vars).map(([k, v]) => [k, render(v)])));
  return String(x);
}

async function loadHandmade(code) {
  if (!cache.has(code)) cache.set(code, (await import(`./locales/${code}.js`)).default);
  return cache.get(code);
}

/* ---------------- on-device machine translation ---------------- */

const mtKey = (code) => `getvid.mt.${code}.v${DICT_VERSION}`;
function readMtCache(code) {
  try { return JSON.parse(localStorage.getItem(mtKey(code)) || 'null'); } catch { return null; }
}

// Words that must survive machine translation untouched.
const KEEP = ['getvid', 'cobalt', 'Piped', 'Invidious', 'ffmpeg.wasm', 'ffmpeg', 'YouTube', 'TikTok', 'Instagram', 'Reddit',
  'Bluesky', 'Facebook', 'Docker', 'README', 'CORS', 'ZIP', 'MP4', 'MP3', 'HLS', 'GIF', 'Chrome', 'Edge', 'Firefox', 'iPhone', 'Android',
  'Ctrl+S', 'Ctrl+V', 'API', 'X', '.mp4', '.m3u8', 'MB', 'GB', '{url}'];

function mask(text) {
  const keep = [];
  let s = text.replace(/\{(\w+)\}/g, (m) => { keep.push(m); return `[${keep.length}]`; });
  for (const w of KEEP) {
    if (w.startsWith('{')) continue;
    const re = new RegExp(`(^|[^\\w.])(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w])`, 'g');
    s = s.replace(re, (m, pre, word) => { keep.push(word); return `${pre}[${keep.length}]`; });
  }
  return { s, keep };
}

function unmask(s, keep) {
  for (let i = keep.length; i >= 1; i--) {
    const tok = `[${i}]`;
    if (!s.includes(tok)) return null; // a placeholder was lost — reject this string
    s = s.split(tok).join(keep[i - 1]);
  }
  return s;
}

/** Some builds expose the API but never answer: never wait forever. */
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function machineDict(code, onProgress) {
  const cached = readMtCache(code);
  if (cached) return cached;
  if (!hasTranslator()) throw new Error('no translator');
  const avail = await within(self.Translator.availability({ sourceLanguage: 'en', targetLanguage: code }), 8000);
  if (avail === 'unavailable') throw new Error('unavailable');
  const tr = await within(self.Translator.create({
    sourceLanguage: 'en', targetLanguage: code,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)); },
  }), avail === 'available' ? 15000 : 180000);
  const out = {};
  const entries = Object.entries(EN);
  let done = 0;
  await Promise.all(entries.map(async ([k, v]) => {
    const { s, keep } = mask(v);
    try { out[k] = unmask(await within(tr.translate(s), 10000), keep) ?? v; } catch { out[k] = v; }
    onProgress?.(++done / entries.length);
  }));
  try { localStorage.setItem(mtKey(code), JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}

/** Switch language. Resolves once the dictionary is ready; falls back to English. */
export async function setLang(code, { onProgress } = {}) {
  let next = EN, ok = true;
  try {
    if (code === 'en') next = EN;
    else if (HAND.has(code)) next = await loadHandmade(code);
    else next = await machineDict(code, onProgress);
  } catch {
    next = EN;
    ok = false;
    code = 'en';
  }
  lang = code;
  dict = next;
  document.documentElement.lang = code === 'pt' ? 'pt-BR' : code === 'zh' ? 'zh-CN' : code;
  document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
  return ok;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', t(el.dataset.i18nTitle));
  });
}

/* ---------------- instant translation of post titles ---------------- */

let detectorP = null;
const translators = new Map();

/**
 * Translate free text into the UI language with the browser's on-device models.
 * Without `allowDownload`, only uses models that are already installed (no user gesture needed).
 * Returns { text, from } or null when not possible / not needed.
 */
export async function translateText(text, { allowDownload = false } = {}) {
  if (!text || !hasTranslator() || !('LanguageDetector' in self)) return null;
  const target = lang;
  try {
    if (!detectorP) {
      const a = await within(self.LanguageDetector.availability(), 5000);
      if (a === 'unavailable' || (a !== 'available' && !allowDownload)) return null;
      detectorP = within(self.LanguageDetector.create(), allowDownload ? 120000 : 10000).catch((e) => { detectorP = null; throw e; });
    }
    const [top] = await within((await detectorP).detect(text), 5000);
    const from = top?.detectedLanguage;
    if (!from || from === 'und' || top.confidence < 0.4 || from.split('-')[0] === target) return null;
    const key = `${from}>${target}`;
    if (!translators.has(key)) {
      const a = await within(self.Translator.availability({ sourceLanguage: from, targetLanguage: target }), 5000);
      if (a === 'unavailable' || (a !== 'available' && !allowDownload)) return null;
      translators.set(key, within(self.Translator.create({ sourceLanguage: from, targetLanguage: target }), allowDownload ? 120000 : 10000)
        .catch((e) => { translators.delete(key); throw e; }));
    }
    const out = await within((await translators.get(key)).translate(text), 15000);
    return out && out !== text ? { text: out, from } : null;
  } catch {
    return null;
  }
}
