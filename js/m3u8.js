// Minimal in-browser HLS downloader: master/media playlists, byte ranges,
// fMP4 init segments (EXT-X-MAP) and AES-128 decryption via WebCrypto.
import { t } from './i18n.js';
import { fetchText, fetchBytes, pickVariant, shortSide, ResolveError, isUserAbort, sleep } from './util.js';

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(ATTR_RE)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new ResolveError(t('errHlsInvalid'));
  const out = { isMaster: false, variants: [], media: [], segments: [], ended: false, duration: 0 };
  let pendingVariant = null, key = null, map = null, seq = 0, segIndex = 0, nextRange = null, extinf = 0;
  const rangeEnd = new Map();
  const abs = (u) => new URL(u, baseUrl).href;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) { out.isMaster = true; pendingVariant = attrs(line.slice(18)); continue; }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13));
      out.media.push({ type: a.TYPE, group: a['GROUP-ID'], name: a.NAME, lang: a.LANGUAGE, isDefault: a.DEFAULT === 'YES', url: a.URI ? abs(a.URI) : null });
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = parseInt(line.slice(22), 10) || 0; continue; }
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, url: a.URI ? abs(a.URI) : null, iv: a.IV || null };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11));
      let range = null;
      if (a.BYTERANGE) { const [len, off] = a.BYTERANGE.split('@').map(Number); range = { start: off || 0, end: (off || 0) + len - 1 }; }
      map = { url: abs(a.URI), range };
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { nextRange = line.slice(17); continue; }
    if (line.startsWith('#EXTINF:')) { extinf = parseFloat(line.slice(8)) || 0; continue; }
    if (line === '#EXT-X-ENDLIST') { out.ended = true; continue; }
    if (line.startsWith('#')) continue;

    const url = abs(line);
    if (pendingVariant) {
      const [w, h] = (pendingVariant.RESOLUTION || '').split('x').map(Number);
      out.variants.push({
        url, bandwidth: Number(pendingVariant.BANDWIDTH) || 0, width: w || 0, height: h || 0,
        codecs: pendingVariant.CODECS || '', audio: pendingVariant.AUDIO || null,
      });
      pendingVariant = null;
      continue;
    }
    let range = null;
    if (nextRange) {
      const [len, off] = nextRange.split('@');
      const start = off !== undefined ? Number(off) : (rangeEnd.get(url) ?? 0);
      range = { start, end: start + Number(len) - 1 };
      rangeEnd.set(url, range.end + 1);
      nextRange = null;
    }
    out.segments.push({ url, seq: seq + segIndex, key, map, range, duration: extinf });
    out.duration += extinf;
    segIndex++;
  }
  return out;
}

export async function loadPlaylist(url, { signal, mapUrl = (u) => u } = {}) {
  const { text, url: finalUrl } = await fetchText(mapUrl(url), { signal });
  // Relative URIs resolve against the real playlist URL, not the proxy URL.
  return parsePlaylist(text, mapUrl(url) === url ? finalUrl : url);
}

/** Describe a playlist: variants (for quality choice) and separate audio renditions. */
export async function inspectHls(url, opts = {}) {
  const pl = await loadPlaylist(url, opts);
  const variants = pl.variants.map((v) => ({
    url: v.url, kind: 'hls', bitrate: v.bandwidth, p: shortSide(v.width, v.height),
    label: v.height ? `${shortSide(v.width, v.height)}p` : `${Math.round(v.bandwidth / 1000)} kbps`,
    audioGroup: v.audio,
  }));
  const audios = pl.media.filter((m) => m.type === 'AUDIO' && m.url);
  return { isMaster: pl.isMaster, variants, audios, duration: pl.duration, ended: pl.ended };
}

function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    let n = seg.seq;
    for (let i = 15; i >= 12 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
  }
  return iv;
}

async function withRetry(fn, signal, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      if (isUserAbort(e) || signal?.aborted) throw e;
      last = e;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

/**
 * Download a whole HLS stream into one Blob.
 * Returns { blob, ext, mime }. fMP4 streams become .mp4, MPEG-TS streams .ts.
 */
export async function downloadHls(url, { quality = '1080', signal, onProgress, mapUrl = (u) => u } = {}) {
  let pl = await loadPlaylist(url, { signal, mapUrl });
  let codecs = '';
  if (pl.isMaster) {
    const opts = pl.variants.map((v) => ({ ...v, p: shortSide(v.width, v.height), bitrate: v.bandwidth }));
    // Without resolution info, prefer the highest bandwidth.
    if (!opts.some((o) => o.p)) opts.sort((a, b) => b.bitrate - a.bitrate);
    const chosen = pickVariant(opts, quality);
    if (!chosen) throw new ResolveError(t('errHlsInvalid'));
    codecs = chosen.codecs || '';
    pl = await loadPlaylist(chosen.url, { signal, mapUrl });
  }
  const segs = pl.segments;
  if (!segs.length) throw new ResolveError(t('errHlsInvalid'));
  if (segs.some((s) => s.key && s.key.method !== 'AES-128')) throw new ResolveError(t('errHlsDrm'));

  const keys = new Map();
  const getKey = (k) => {
    if (!keys.has(k.url)) {
      keys.set(k.url, withRetry(() => fetchBytes(mapUrl(k.url), { signal }), signal)
        .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    return keys.get(k.url);
  };

  const results = new Array(segs.length);
  let next = 0, done = 0, bytes = 0;
  const worker = async () => {
    while (next < segs.length) {
      const i = next++;
      const s = segs[i];
      let data = await withRetry(() => fetchBytes(mapUrl(s.url), { signal, range: s.range }), signal);
      if (s.key) {
        const k = await getKey(s.key);
        data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(s) }, k, data));
      }
      results[i] = data;
      done++;
      bytes += data.byteLength;
      onProgress?.({ done, total: segs.length, loaded: bytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, segs.length) }, worker));

  const parts = [];
  let lastMap = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.map && s.map !== lastMap) {
      parts.push(await withRetry(() => fetchBytes(mapUrl(s.map.url), { signal, range: s.map.range }), signal));
      lastMap = s.map;
    }
    parts.push(results[i]);
  }

  const fmp4 = segs.some((s) => s.map);
  const segExt = (segs[0].url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const audioOnly = /mp4a|ac-3|ec-3|opus/.test(codecs) && !/avc|hvc|hev|vp0|vp9|av01/.test(codecs);
  let ext = fmp4 ? (audioOnly ? 'm4a' : 'mp4') : 'ts';
  let mime = fmp4 ? (audioOnly ? 'audio/mp4' : 'video/mp4') : 'video/mp2t';
  if (!fmp4 && (segExt === 'aac' || segExt === 'mp3')) { ext = segExt; mime = segExt === 'aac' ? 'audio/aac' : 'audio/mpeg'; }
  if (fmp4 && segExt === 'm4a') { ext = 'm4a'; mime = 'audio/mp4'; }
  return { blob: new Blob(parts, { type: mime }), ext, mime, live: !pl.ended };
}
