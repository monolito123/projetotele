import { t } from './i18n.js';

export class ResolveError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ResolveError';
    Object.assign(this, extra);
  }
}

/** Network failure: offline, DNS, or (most often) blocked by CORS. */
export class NetError extends ResolveError {
  constructor(url) {
    super(t('errNetwork', { host: hostOf(url) }), { net: true, url });
    this.name = 'NetError';
  }
}

export const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u); } };
export const isUserAbort = (e) => e && e.name === 'AbortError';

/** Child AbortSignal that also aborts after `ms`. */
export function withTimeout(parent, ms) {
  const ctrl = new AbortController();
  const timer = ms ? setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms) : null;
  const onAbort = () => ctrl.abort(parent.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); },
  };
}

export function mapFetchError(e, url, parent, child) {
  if (parent?.aborted) return parent.reason instanceof Error ? parent.reason : new DOMException('aborted', 'AbortError');
  if (child.aborted) return new ResolveError(t('errTimeout', { host: hostOf(url) }), { timeout: true, url });
  if (e instanceof ResolveError) return e;
  return new NetError(url);
}

/** fetch + JSON parse. Returns { status, ok, data }. Never throws on HTTP status. */
export async function fetchJsonRaw(url, { signal, timeout = 20000, ...init } = {}) {
  const tm = withTimeout(signal, timeout);
  try {
    const res = await fetch(url, { referrerPolicy: 'no-referrer', ...init, signal: tm.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { status: res.status, ok: res.ok, data, text, res };
  } catch (e) {
    throw mapFetchError(e, url, signal, tm.signal);
  } finally {
    tm.done();
  }
}

/** fetch JSON and throw on HTTP error / invalid JSON. */
export async function fetchJson(url, opts = {}) {
  const r = await fetchJsonRaw(url, opts);
  if (!r.ok) throw new ResolveError(t('errHttp', { status: r.status, host: hostOf(url) }), { status: r.status, data: r.data });
  if (r.data === undefined) throw new ResolveError(t('errBadJson', { host: hostOf(url) }));
  return r.data;
}

export async function fetchText(url, { signal, timeout = 20000, ...init } = {}) {
  const tm = withTimeout(signal, timeout);
  try {
    const res = await fetch(url, { referrerPolicy: 'no-referrer', ...init, signal: tm.signal });
    if (!res.ok) throw new ResolveError(t('errHttp', { status: res.status, host: hostOf(url) }), { status: res.status });
    return { text: await res.text(), type: res.headers.get('content-type') || '', url: res.url || url };
  } catch (e) {
    throw mapFetchError(e, url, signal, tm.signal);
  } finally {
    tm.done();
  }
}

/** Fetch binary with optional Range, returns Uint8Array. */
export async function fetchBytes(url, { signal, timeout = 60000, range } = {}) {
  const tm = withTimeout(signal, timeout);
  try {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
    const res = await fetch(url, { signal: tm.signal, headers, referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new ResolveError(t('errHttp', { status: res.status, host: hostOf(url) }), { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw mapFetchError(e, url, signal, tm.signal);
  } finally {
    tm.done();
  }
}

/** Streamed download into a Blob with progress callback ({loaded, total}). */
export async function fetchBlob(url, { signal, onProgress, connectTimeout = 30000 } = {}) {
  const tm = withTimeout(signal, connectTimeout);
  let res;
  try {
    res = await fetch(url, { signal: tm.signal, redirect: 'follow', referrerPolicy: 'no-referrer' });
  } catch (e) {
    tm.done();
    throw mapFetchError(e, url, signal, tm.signal);
  }
  tm.done();
  if (!res.ok) throw new ResolveError(t('errHttp', { status: res.status, host: hostOf(url) }), { status: res.status });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const total = Number(res.headers.get('content-length')) || 0;
  const disposition = res.headers.get('content-disposition') || '';
  if (!res.body || !onProgress) {
    const blob = await res.blob();
    return { blob, type, disposition };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    throw new NetError(url);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return { blob: new Blob(chunks, { type: type || 'application/octet-stream' }), type, disposition };
}

/* ---------------- URLs & names ---------------- */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_RE = /(?:^|\s)((?:www\.|m\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"'`]+)/gi;

function trimUrl(u) {
  let s = u.replace(/[),.;:!?'"\]»”]+$/u, '');
  // keep balanced parentheses (Wikipedia-style URLs)
  const open = (s.match(/\(/g) || []).length;
  const close = (s.match(/\)/g) || []).length;
  if (close < open && u.length > s.length && u[s.length] === ')') s += ')';
  return s;
}

/** Pull every URL out of arbitrary pasted text (share-sheet text, lists…). */
export function extractUrls(text) {
  if (!text) return [];
  const found = [];
  for (const m of text.matchAll(URL_RE)) found.push(trimUrl(m[0]));
  // Links pasted without a scheme ("youtu.be/xyz"), once full URLs are removed.
  const rest = text.replace(URL_RE, ' ');
  for (const m of rest.matchAll(BARE_RE)) found.push('https://' + trimUrl(m[1]));
  const seen = new Set();
  return found.filter((u) => {
    try { new URL(u); } catch { return false; }
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

export function sanitizeFilename(name, fallback = 'video') {
  const s = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#]+/g, ' ')
    .replace(/https?\s+\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return s || fallback;
}

export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'wmv', '3gp', 'ogv', 'ts', 'mpg', 'mpeg'];
export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic'];

export function extFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

export function typeFromExt(ext) {
  if (ext === 'gif') return 'gif';
  if (VIDEO_EXT.includes(ext) || ext === 'm3u8') return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'photo';
  return '';
}

export function isMediaUrl(u) {
  const ext = extFromUrl(u);
  return !!typeFromExt(ext);
}

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'video/mp2t': 'ts', 'video/x-flv': 'flv', 'video/3gpp': '3gp', 'video/ogg': 'ogv', 'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  'audio/webm': 'weba', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/heic': 'heic',
};
export const extFromMime = (m) => MIME_EXT[(m || '').split(';')[0].trim().toLowerCase()] || '';

export const DEFAULT_EXT = { video: 'mp4', gif: 'mp4', audio: 'mp3', photo: 'jpg' };

export function filenameFromDisposition(cd) {
  if (!cd) return '';
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { /* ignore */ } }
  m = cd.match(/filename\s*=\s*"([^"]+)"/) || cd.match(/filename\s*=\s*([^;]+)/);
  return m ? m[1].trim() : '';
}

/* ---------------- quality selection ---------------- */

/**
 * Variants may carry `p` (the short side of the frame, e.g. 1080).
 * Without any `p`, the list is assumed to be ordered best-first.
 */
export function pickVariant(variants, quality) {
  if (!variants || !variants.length) return null;
  const withP = variants.filter((v) => v.p > 0);
  if (!withP.length) return variants[0];
  withP.sort((a, b) => b.p - a.p || (b.bitrate || 0) - (a.bitrate || 0));
  if (quality === 'max') return withP[0];
  const target = parseInt(quality, 10) || 1080;
  return withP.find((v) => v.p <= target) || withP[withP.length - 1];
}

export const shortSide = (w, h) => (w && h ? Math.min(w, h) : (h || w || 0));

/* ---------------- formatting ---------------- */

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(s) {
  s = Math.round(Number(s) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apply the user's CORS proxy template to a URL (or return null if none). */
export function proxify(url, template) {
  const tpl = (template || '').trim();
  if (!tpl) return null;
  return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + url;
}

/** Resolve the first value from a list of promise factories, in parallel. */
export async function firstSuccess(factories) {
  if (!factories.length) throw new ResolveError('no candidates');
  return Promise.any(factories.map((f) => f())).catch((agg) => {
    const errs = agg.errors || [agg];
    const abort = errs.find(isUserAbort);
    throw abort || errs.find((e) => e && !e.net && !e.timeout) || errs[0];
  });
}
