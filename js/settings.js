// Persistent per-browser settings (localStorage, wrapped so private mode still works).
const KEY = 'getvid.settings.v1';

export const DEFAULTS = Object.freeze({
  lang: 'auto',
  mode: 'auto', // auto (video+audio) | audio | mute
  quality: '1080', // max | 2160 | 1440 | 1080 | 720 | 480 | 360 | 240
  audioFormat: 'mp3', // best | mp3 | ogg | wav | opus  (cobalt only)
  autoDownload: true,
  autoStart: true,
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

export function cobaltInstances(s = current) {
  return lines(s.cobalt).map((l) => {
    const [url, ...rest] = l.split('|');
    const key = rest.join('|').trim();
    return { url: normBase(url.trim()) + '/', key };
  }).filter((i) => /^https?:\/\//.test(i.url));
}

export const pipedInstances = (s = current) => lines(s.piped).map(normBase).filter((u) => /^https?:\/\//.test(u));
export const invidiousInstances = (s = current) => lines(s.invidious).map(normBase).filter((u) => /^https?:\/\//.test(u));
