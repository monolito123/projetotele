import { L, render } from './i18n.js';

/** Error whose message can be re-rendered in any language (msg may be an L() message). */
export class ResolveError extends Error {
  constructor(msg, extra = {}) {
    super(render(msg));
    this.name = 'ResolveError';
    this.l = msg;
    Object.assign(this, extra);
  }
}

/** Network failure: offline, DNS, or (most often) blocked by CORS. */
export class NetError extends ResolveError {
  constructor(url) {
    super(L('errNetwork', { host: hostOf(url) }), { net: true, url });
    this.name = 'NetError';
  }
}

/** Repair URLs as some APIs return them: "//host/x", "https:https://host/x", "http:/host". */
export function normUrl(u) {
  if (!u || typeof u !== 'string') return u;
  let s = u.trim();
  if (s.startsWith('//')) return `https:${s}`;
  s = s.replace(/^(?:https?:\/*)+(?=https?:\/\/)/i, ''); // duplicated scheme
  s = s.replace(/^(https?):\/?(?!\/)/i, '$1://'); // missing slash
  return s;
}

export const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u); } };
export const isUserAbort = (e) => e && e.name === 'AbortError';
export const errText = (e) => (e && e.l ? e.l : (e?.message || String(e)));

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
  if (child?.aborted) return new ResolveError(L('errTimeout', { host: hostOf(url) }), { timeout: true, url });
  if (e instanceof ResolveError) return e;
  return new NetError(url);
}

const httpError = (status, url) => new ResolveError(L('errHttp', { status, host: hostOf(url) }), { status, url });

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
  if (!r.ok) { const e = httpError(r.status, url); e.data = r.data; throw e; }
  if (r.data === undefined) throw new ResolveError(L('errBadJson', { host: hostOf(url) }));
  return r.data;
}

export async function fetchText(url, { signal, timeout = 20000, ...init } = {}) {
  const tm = withTimeout(signal, timeout);
  try {
    const res = await fetch(url, { referrerPolicy: 'no-referrer', ...init, signal: tm.signal });
    if (!res.ok) throw httpError(res.status, url);
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
    if (!res.ok) throw httpError(res.status, url);
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw mapFetchError(e, url, signal, tm.signal);
  } finally {
    tm.done();
  }
}

function readWithIdle(reader, ms, signal) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new ResolveError('stalled', { stalled: true })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Streamed download into a Blob, robust against flaky connections:
 * retries 5xx/network errors, resumes broken transfers with HTTP Range,
 * and aborts transfers that stall for `idleTimeout` ms.
 * onProgress({ loaded, total }).
 */
export async function fetchBlob(url, { signal, onProgress, connectTimeout = 30000, idleTimeout = 45000, retries = 4 } = {}) {
  const chunks = [];
  let loaded = 0, total = 0, type = '', disposition = '', attempt = 0;
  const backoff = () => sleep(Math.min(8000, 700 * 2 ** attempt));

  for (;;) {
    const tm = withTimeout(signal, connectTimeout);
    const headers = loaded > 0 ? { Range: `bytes=${loaded}-` } : undefined;
    let res;
    try {
      res = await fetch(url, { signal: tm.signal, headers, redirect: 'follow', referrerPolicy: 'no-referrer' });
    } catch (e) {
      tm.done();
      const err = mapFetchError(e, url, signal, tm.signal);
      // Resuming after a drop: a failed preflight/network blip deserves another try.
      if (!isUserAbort(err) && loaded > 0 && attempt < retries) { attempt++; await backoff(); continue; }
      throw err;
    }
    tm.done();

    if (loaded > 0) {
      if (res.status === 200) { chunks.length = 0; loaded = 0; } // server ignored Range: start over
      else if (res.status !== 206) {
        if (attempt < retries && res.status >= 500) { attempt++; await backoff(); continue; }
        throw httpError(res.status, url);
      }
    } else {
      if (!res.ok) {
        if (attempt < retries && (res.status >= 500 || res.status === 429)) { attempt++; await backoff(); continue; }
        throw httpError(res.status, url);
      }
      type = (res.headers.get('content-type') || '').split(';')[0].trim();
      total = Number(res.headers.get('content-length')) || 0;
      if (res.headers.get('content-encoding')) total = 0; // length is of the compressed body
      disposition = res.headers.get('content-disposition') || '';
    }

    if (!res.body) {
      const b = new Uint8Array(await res.arrayBuffer());
      chunks.push(b);
      loaded += b.byteLength;
      onProgress?.({ loaded, total });
      break;
    }
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await readWithIdle(reader, idleTimeout, signal);
        if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({ loaded, total });
      }
      if (total && loaded < total) throw new ResolveError('truncated');
      break;
    } catch (e) {
      reader.cancel().catch(() => {});
      if (signal?.aborted) throw signal.reason ?? e;
      if (attempt < retries) { attempt++; await backoff(); continue; } // resume with Range
      throw new NetError(url);
    }
  }
  return { blob: new Blob(chunks, { type: type || 'application/octet-stream' }), type, disposition };
}

/* ---------------- content sniffing ---------------- */

const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));

/** Identify a file from its first bytes. Returns { ext, mime } or null. */
export async function sniff(blob) {
  const b = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  if (b.length < 4) return null;
  const head = ascii(b, 0, Math.min(b.length, 64));
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (/^M4A|^M4B|^dash/.test(brand) && !/avc|vide/.test(ascii(b, 0, 512))) return { ext: 'm4a', mime: 'audio/mp4' };
    if (brand === 'qt  ') return { ext: 'mov', mime: 'video/quicktime' };
    return { ext: 'mp4', mime: 'video/mp4' };
  }
  if (/^(moof|styp|sidx)/.test(ascii(b, 4, 8))) return { ext: 'mp4', mime: 'video/mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return /webm/.test(ascii(b, 0, 64)) ? { ext: 'webm', mime: 'video/webm' } : { ext: 'mkv', mime: 'video/x-matroska' };
  }
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return { ext: 'ts', mime: 'video/mp2t' };
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { ext: 'aac', mime: 'audio/aac' };
  if (head.startsWith('OggS')) return /OpusHead/.test(ascii(b, 0, 64)) ? { ext: 'opus', mime: 'audio/ogg' } : { ext: 'ogg', mime: 'audio/ogg' };
  if (head.startsWith('fLaC')) return { ext: 'flac', mime: 'audio/flac' };
  if (head.startsWith('RIFF')) {
    const k = ascii(b, 8, 12);
    if (k === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
    if (k === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (k === 'AVI ') return { ext: 'avi', mime: 'video/x-msvideo' };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x89 && head.slice(1, 4) === 'PNG') return { ext: 'png', mime: 'image/png' };
  if (head.startsWith('GIF8')) return { ext: 'gif', mime: 'image/gif' };
  if (head.startsWith('FLV')) return { ext: 'flv', mime: 'video/x-flv' };
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(head)) return { ext: 'html', mime: 'text/html' };
  if (/^\s*#EXTM3U/.test(head)) return { ext: 'm3u8', mime: 'application/vnd.apple.mpegurl' };
  return null;
}

/* ---------------- URLs & names ---------------- */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_RE = /(?:^|\s)((?:www\.|m\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"'`]+)/gi;

function trimUrl(u) {
  let s = u.replace(/[),.;:!?'"\]»”]+$/u, '');
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

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

export function sanitizeFilename(name, fallback = 'video') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#]+/g, ' ')
    .replace(/https?\s+\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  if (WIN_RESERVED.test(s)) s = `_${s}`;
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

export const isMediaUrl = (u) => !!typeFromExt(extFromUrl(u));

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

/** Other variants ordered by closeness to the chosen one (used as fallbacks). */
export function variantFallbacks(variants, chosen) {
  if (!variants || variants.length < 2 || !chosen) return [];
  const rest = variants.filter((v) => v !== chosen && v.url !== chosen.url);
  if (!chosen.p) return rest;
  return rest.sort((a, b) => Math.abs((a.p || 0) - chosen.p) - Math.abs((b.p || 0) - chosen.p));
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
