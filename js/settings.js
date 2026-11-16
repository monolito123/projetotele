import { PROJECT_SERVERS } from './config.js';

// Persistent per-browser settings (localStorage, wrapped so private mode still works).
const KEY = 'getvid.settings.v1';

export const DEFAULTS = Object.freeze({
  lang: 'auto',
  mode: 'auto', // auto (video+audio) | audio | mute
  quality: '1080', // max | 2160 | 1440 | 1080 | 720 | 480 | 360 | 240
  audioFormat: 'mp3', // best | mp3 | ogg | wav | opus  (cobalt only)
  autoDownload: true,
  autoStart: true,
  useFfmpeg: true, // merge audio+video / remux / extract audio in the browser (ffmpeg.wasm)
  translateTitles: true, // on-device translation of post titles (Chrome Translator API)
  publicCobalt: true, // fall back to the free community cobalt servers below
  loaderTo: true, // offer loader.to's official embed (external, with ads) when YouTube fails
  // "https://your-cobalt.example.com/" or "https://your-cobalt.example.com/ | API_KEY"
  cobalt: '',
  piped: [
    'https://api.piped.private.coffee',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.r4fo.com',
  ].join('\n'),
  invidious: [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.privacyredirect.com',
  ].join('\n'),
  corsProxy: '',
});

let current = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS };
}

export const getSettings = () => current;

export function saveSettings(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
  return current;
}

export function resetSettings() {
  current = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return current;
}

const lines = (s) => String(s || '').split(/\n+/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const normBase = (u) => u.replace(/\/+$/, '');

/**
 * Free community cobalt servers that answer without a captcha/JWT and allow
 * browser (CORS) requests. Checked 2026-11: YouTube + TikTok work on the first
 * two; cobaltapi.cjs.nz is the one reported working for Facebook.
 */
export const PUBLIC_COBALT = [
  { url: 'https://rue-cobalt.xenon.zone/', key: '', public: true },
  { url: 'https://co.otomir23.me/', key: '', public: true },
  { url: 'https://cobaltapi.cjs.nz/', key: '', public: true, prefer: ['facebook'] },
];

const parseServer = (l) => {
  const [url, ...rest] = String(l).split('|');
  return { url: normBase(url.trim()) + '/', key: rest.join('|').trim() };
};

/** The visitor's own servers, then the servers this site runs (js/config.js). */
export function ownCobaltInstances(s = current) {
  const own = lines(s.cobalt).map(parseServer);
  const project = PROJECT_SERVERS.map(parseServer).map((i) => ({ ...i, project: true }))
    .filter((p) => !own.some((o) => o.url === p.url));
  return [...own, ...project].filter((i) => /^https?:\/\//.test(i.url));
}

/** Own servers first, then (unless disabled) the public pool, ordered for the platform. */
export function cobaltInstances(s = current, platformId = '') {
  const own = ownCobaltInstances(s);
  if (s.publicCobalt === false) return own;
  const pool = [...PUBLIC_COBALT].sort((a, b) => (b.prefer?.includes(platformId) ? 1 : 0) - (a.prefer?.includes(platformId) ? 1 : 0));
  return [...own, ...pool.filter((p) => !own.some((o) => o.url === p.url))];
}

export const pipedInstances = (s = current) => lines(s.piped).map(normBase).filter((u) => /^https?:\/\//.test(u));
export const invidiousInstances = (s = current) => lines(s.invidious).map(normBase).filter((u) => /^https?:\/\//.test(u));
