// Turning a resolved Item into a finished file: download (with fallbacks, proxy, retries),
// then post-process with ffmpeg (merge audio+video, TS→MP4, audio extraction, mute).
import { L } from './i18n.js';
import {
  fetchBlob, pickVariant, variantFallbacks, sanitizeFilename, extFromMime, extFromUrl, DEFAULT_EXT,
  filenameFromDisposition, proxify, ResolveError, isUserAbort, sniff, VIDEO_EXT, AUDIO_EXT, normUrl,
} from './util.js';
import { downloadHls } from './m3u8.js';
import { resolve, canMerge } from './resolvers.js';
import { mergeAV, remuxToMp4, extractAudio, stripAudio } from './ffmpeg.js';

/** Every candidate was blocked by CORS: the user has to open the link themselves. */
export class ManualDownload extends ResolveError {
  constructor(url, filename, attachment, type) {
    super(L('statusManual'));
    this.name = 'ManualDownload';
    this.url = url;
    this.filename = filename;
    this.attachment = attachment;
    this.type = type;
  }
}

export function buildFilename(item, ext) {
  const e = ext || item.ext || DEFAULT_EXT[item.type] || 'mp4';
  if (item.filename) {
    const f = sanitizeFilename(item.filename);
    return /\.[a-z0-9]{2,5}$/i.test(f) ? f.replace(/\.[a-z0-9]{2,5}$/i, `.${e}`) : `${f}.${e}`;
  }
  return `${sanitizeFilename(item.name, item.type || 'video')}.${e}`;
}

export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 120000);
}

/**
 * Let the browser fetch the URL itself. `sameTab` is only safe for responses that
 * are sent as attachments (cobalt tunnels, Dropbox dl=1): the page stays put.
 */
export function openUrl(url, filename, sameTab = false) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener noreferrer';
  if (!sameTab) a.target = '_blank';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Resolve a lazy item (playlist entry, embedded player) into a concrete one. */
export async function concretize(item, { settings, signal }) {
  if (item.kind !== 'lazy') return item;
  const res = await resolve(item.sourceUrl, { settings, signal });
  const first = res.items.find((i) => i.kind !== 'lazy');
  if (!first) throw new ResolveError(L('errNoMedia'));
  return { ...first, name: first.name || item.name, thumb: first.thumb || item.thumb };
}

/** Try each candidate URL (directly, then through the CORS proxy). → { blob, ext, disposition } */
async function fetchCandidates(item, candidates, { settings, signal, onProgress }) {
  const seen = new Set();
  candidates = candidates
    .filter((c) => c && c.url)
    .map((c) => ({ ...c, url: normUrl(c.url) }))
    .filter((c) => !seen.has(c.url) && seen.add(c.url));
  const errors = [];
  let manual = null;
  for (const c of candidates) {
    for (const viaProxy of [false, true]) {
      if (viaProxy && !settings.corsProxy) break;
      const mapUrl = viaProxy ? (u) => proxify(u, settings.corsProxy) : (u) => u;
      try {
        const hls = () => downloadHls(c.url, {
          quality: settings.quality, signal, mapUrl, onProgress: (p) => onProgress?.({ ...p, segments: true }),
        }).then((r) => ({ blob: r.blob, ext: r.ext }));
        if (c.kind === 'hls') return await hls();
        const r = await fetchBlob(mapUrl(c.url), { signal, onProgress });
        if (!r.blob.size) throw new ResolveError(L('errEmptyFile')); // e.g. a cobalt tunnel whose source refused
        const sn = await sniff(r.blob);
        if (sn?.ext === 'm3u8') return await hls(); // playlist served without a .m3u8 name
        if (sn?.ext === 'html' || (!sn && /^text\/html/.test(r.type))) throw new ResolveError(L('errHtmlInsteadOfFile'));
        const ext = sn?.ext || extFromMime(r.type) || (c.ext !== 'm3u8' && c.ext) || item.ext || extFromUrl(c.url);
        const blob = sn && r.blob.type !== sn.mime ? new Blob([r.blob], { type: sn.mime }) : r.blob;
        return { blob, ext, disposition: r.disposition };
      } catch (e) {
        if (isUserAbort(e) || signal?.aborted) throw e;
        errors.push(e);
        if (c.kind !== 'hls' && !manual && (e.net || e.status === 403)) manual = c;
        if (!e.net) break; // HTTP errors won't be fixed by the proxy
      }
    }
  }
  if (manual) throw new ManualDownload(manual.url, buildFilename(item, manual.ext), !!item.attachment, item.type);
  throw errors.find((e) => !e.net) || errors[0] || new ResolveError(L('errNoMedia'));
}

const AUDIO_TARGET = { mp3: 'mp3', ogg: 'ogg', opus: 'opus', wav: 'wav' };
const isVideoExt = (ext) => VIDEO_EXT.includes(ext);
const hasSound = (ext) => isVideoExt(ext) || AUDIO_EXT.includes(ext);

/** ffmpeg post-processing. Never loses the download: on failure the original is kept. */
async function postProcess(item, got, { settings, signal, onProgress }) {
  let { blob, ext } = got;
  const extras = [];
  let warning = null;
  let type = item.type;
  const conv = (stage, fmt) => ({
    signal,
    onLoad: (p) => onProgress?.({ stage: 'load', ...p }),
    onProgress: (frac) => onProgress?.({ stage, frac, fmt }),
  });
  const useFf = canMerge(settings);
  try {
    // 1. Separate audio track → merge it in.
    if (item.audio && useFf) {
      let audio = null;
      try {
        audio = await fetchCandidates({ ...item, type: 'audio', ext: item.audio.ext || 'm4a', attachment: false },
          [item.audio, ...(item.audio.fallbacks || [])], { settings, signal, onProgress: (p) => onProgress?.({ ...p, part: 'audio' }) });
      } catch (e) {
        if (isUserAbort(e) || signal?.aborted) throw e;
        if (!item.audio.optional) warning = L('noAudio');
      }
      if (audio) {
        try {
          const r = await mergeAV({ blob, ext }, { blob: audio.blob, ext: audio.ext }, conv('merge'));
          blob = r.blob; ext = r.ext;
        } catch (e) {
          if (isUserAbort(e) || signal?.aborted) throw e;
          extras.push({ blob: audio.blob, filename: buildFilename({ ...item, filename: null, name: `${item.name || 'media'}_audio` }, audio.ext) });
          warning = L('errConvert');
        }
      }
    }

    // 2. Mode-driven conversions (cobalt results are already final).
    const target = AUDIO_TARGET[settings.audioFormat];
    const wantAudio = item.transform === 'audio'
      || (!item.final && settings.mode === 'audio' && type !== 'photo' && type !== 'gif' && (isVideoExt(ext) || (target && ext !== target && hasSound(ext))));
    const wantMute = item.transform === 'mute' || (!item.final && settings.mode === 'mute' && type === 'video' && isVideoExt(ext));
    if (useFf && wantAudio && hasSound(ext)) {
      const r = await extractAudio({ blob, ext }, settings.audioFormat, conv('convert', (target || 'audio').toUpperCase()));
      blob = r.blob; ext = r.ext; type = 'audio';
    } else if (useFf && wantMute) {
      const r = await stripAudio({ blob, ext }, conv('convert', ext.toUpperCase()));
      blob = r.blob; ext = r.ext;
    } else if (useFf && ext === 'ts') {
      const r = await remuxToMp4({ blob, ext }, conv('convert', 'MP4'));
      blob = r.blob; ext = r.ext;
    }
  } catch (e) {
    if (isUserAbort(e) || signal?.aborted) throw e;
    warning = L('errConvert');
  }
  const named = { ...item, type };
  if (ext === 'mp4' && (type === 'audio' || item.type === 'audio') && !item.audio) ext = 'm4a'; // audio-only MP4
  const disp = filenameFromDisposition(got.disposition);
  const filename = !item.name && !item.filename && disp ? sanitizeFilename(disp) : buildFilename(named, ext);
  return { blob, filename, warning, extras };
}

/**
 * Download one item into memory → { blob, filename, warning?, extras? }.
 * Order: chosen variant → item fallbacks → other variants, each direct then via proxy;
 * then the rest of the resolver chain (another API, or cobalt) if everything failed.
 * onProgress receives { loaded, total } | { segments, done, total, loaded } |
 * { stage: 'load'|'merge'|'convert'|'retry', ... } | { part: 'audio', ... }.
 */
export async function fetchItem(item, { settings, signal, onProgress, variant } = {}) {
  item = await concretize(item, { settings, signal });
  // Audio-only and the source has a separate audio track: skip the video entirely.
  if (settings.mode === 'audio' && item.audio && !item.final && canMerge(settings)) {
    item = { ...item, ...item.audio, type: 'audio', variants: undefined, audio: undefined, ext: item.audio.ext || 'm4a' };
  }
  const chosen = variant || pickVariant(item.variants, settings.quality);
  const primary = chosen ? { ...chosen } : { url: item.url, kind: item.kind, ext: item.ext };
  const candidates = [primary, ...(item.fallbacks || []), ...variantFallbacks(item.variants, chosen)];
  let got;
  try {
    got = await fetchCandidates(item, candidates, { settings, signal, onProgress });
  } catch (e) {
    if (isUserAbort(e) || signal?.aborted) throw e;
    if (item.retry) {
      onProgress?.({ stage: 'retry' });
      try {
        const res = await resolve(item.retry.url, {
          settings, signal, skip: item.retry.skip, cobaltExclude: item.retry.cobaltExclude || [], noGeneric: true,
        });
        if (res.items.length === 1) return await fetchItem(res.items[0], { settings, signal, onProgress });
      } catch (e2) {
        if (isUserAbort(e2) || signal?.aborted) throw e2;
        if (e2 instanceof ManualDownload) throw e2;
      }
    }
    // Free community servers can be busy or blocked for a given video: say so plainly.
    if (item.cobaltPublic && !(e instanceof ManualDownload)) throw new ResolveError(L('errPublicFailed'), { needsCobalt: true });
    throw e;
  }
  return postProcess(item, got, { settings, signal, onProgress });
}
