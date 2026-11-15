// Turning a resolved Item into a file on disk.
import { t } from './i18n.js';
import {
  fetchBlob, pickVariant, sanitizeFilename, extFromMime, extFromUrl, DEFAULT_EXT,
  filenameFromDisposition, proxify, ResolveError, isUserAbort,
} from './util.js';
import { downloadHls } from './m3u8.js';
import { resolve } from './resolvers.js';
import { cobaltInstances } from './settings.js';

/** Every candidate was blocked by CORS: the user has to open the link themselves. */
export class ManualDownload extends Error {
  constructor(url, filename, attachment) {
    super(t('statusManual'));
    this.name = 'ManualDownload';
    this.url = url;
    this.filename = filename;
    this.attachment = attachment;
  }
}

export function buildFilename(item, ext) {
  const e = ext || item.ext || DEFAULT_EXT[item.type] || 'mp4';
  if (item.filename) {
    const f = sanitizeFilename(item.filename);
    return /\.[a-z0-9]{2,5}$/i.test(f) ? f : `${f}.${e}`;
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
  if (!first) throw new ResolveError(t('errNoMedia'));
  return { ...first, name: first.name || item.name, thumb: first.thumb || item.thumb };
}

/**
 * Download one item into memory → { blob, filename }.
 * Tries the chosen variant, then fallbacks, each directly and then via the CORS proxy.
 * onProgress({ loaded, total }) or ({ done, total, loaded, segments: true }) for HLS.
 */
export async function fetchItem(item, { settings, signal, onProgress, variant } = {}) {
  item = await concretize(item, { settings, signal });
  const chosen = variant || pickVariant(item.variants, settings.quality);
  const primary = chosen ? { ...chosen } : { url: item.url, kind: item.kind, ext: item.ext };
  const seen = new Set();
  const candidates = [primary, ...(item.fallbacks || [])].filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));

  const errors = [];
  let manual = null;
  for (const c of candidates) {
    for (const viaProxy of [false, true]) {
      if (viaProxy && !settings.corsProxy) break;
      const mapUrl = viaProxy ? (u) => proxify(u, settings.corsProxy) : (u) => u;
      try {
        if (c.kind === 'hls') {
          const r = await downloadHls(c.url, {
            quality: settings.quality, signal, mapUrl,
            onProgress: (p) => onProgress?.({ ...p, segments: true }),
          });
          return { blob: r.blob, filename: buildFilename(item, r.ext) };
        }
        const r = await fetchBlob(mapUrl(c.url), { signal, onProgress });
        if (/^text\/html/.test(r.type)) throw new ResolveError(t('errHtmlInsteadOfFile'));
        if (item.filename) return { blob: r.blob, filename: buildFilename(item) };
        const ext = extFromMime(r.type) || (c.ext !== 'm3u8' && c.ext) || item.ext || extFromUrl(c.url);
        const disp = filenameFromDisposition(r.disposition);
        return { blob: r.blob, filename: !item.name && disp ? sanitizeFilename(disp) : buildFilename(item, ext) };
      } catch (e) {
        if (isUserAbort(e) || signal?.aborted) throw e;
        errors.push(e);
        if (c.kind !== 'hls' && !manual && (e.net || e.status === 403)) manual = c;
        if (!e.net) break; // HTTP errors won't be fixed by the proxy
      }
    }
  }
  if (manual && item.cobaltRetry && cobaltInstances(settings).length) {
    try {
      const res = await resolve(item.cobaltRetry, { settings, signal, only: 'cobalt' });
      if (res.items.length === 1) return await fetchItem(res.items[0], { settings, signal, onProgress });
    } catch (e) {
      if (e instanceof ManualDownload) throw e;
      if (isUserAbort(e) || signal?.aborted) throw e;
    }
  }
  if (manual) throw new ManualDownload(manual.url, buildFilename(item, manual.ext), !!item.attachment);
  throw errors.find((e) => !e.net) || errors[0] || new ResolveError(t('errNoMedia'));
}
