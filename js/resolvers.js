// URL → media resolvers. Each resolver gets a context and returns
// { title, author?, items: Item[], extras?: Item[], note? } or { redirect: url }.
//
// Item: { type: video|audio|photo|gif, kind: file|hls|lazy, url, name|filename, ext?, thumb?,
//         label?, duration?, variants?: [{url, kind, label, p?, ext?}], fallbacks?: [...],
//         audio?: { url, kind, ext, fallbacks? } separate audio track to merge in (ffmpeg),
//         attachment?: true when the server sends Content-Disposition: attachment,
//         final?: true when the file is already exactly what the user asked for (cobalt),
//         sourceUrl?: (lazy) page URL resolved again at download time }
import { L } from './i18n.js';
import {
  ResolveError, fetchJson, fetchJsonRaw, withTimeout, mapFetchError, hostOf, isUserAbort,
  extFromUrl, typeFromExt, isMediaUrl, shortSide, proxify, firstSuccess, extFromMime, sleep, normUrl,
} from './util.js';
import { inspectHls } from './m3u8.js';
import { detectPlatform, GENERIC } from './platforms.js';
import { cobaltInstances, ownCobaltInstances, pipedInstances, invidiousInstances } from './settings.js';
import { ffmpegSupported } from './ffmpeg.js';

export const LABELS = {
  direct: 'direct file', hls: 'HLS', fxtwitter: 'FxTwitter', vxtwitter: 'vxTwitter', tikwm: 'TikWM',
  bluesky: 'Bluesky API', streamable: 'Streamable API', reddit: 'Reddit API', vimeo: 'Vimeo player',
  mastodon: 'Mastodon API', peertube: 'PeerTube API', archive: 'Archive.org API', giphy: 'Giphy',
  imgur: 'Imgur', ninegag: '9GAG', dropbox: 'Dropbox', gdrive: 'Google Drive', telegram: 'Telegram',
  piped: 'Piped', invidious: 'Invidious', cobalt: 'cobalt', generic: 'page scan',
  odysee: 'Odysee API', pinterest: 'Pinterest API', misskey: 'Misskey API', lemmy: 'Lemmy API',
};

/** Whether separate audio/video can be merged in this browser with the user's settings. */
export const canMerge = (settings) => settings.useFfmpeg !== false && ffmpegSupported();

const bad = () => new ResolveError(L('errBadLink'));
const none = () => new ResolveError(L('errNoMedia'));
const nameFromPath = (u) => {
  try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '') || 'file'; } catch { return 'file'; }
};
const stripExt = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, '');

const R = {};

/* ------------------------------------------------------------------ */
/* Direct files & HLS                                                  */
/* ------------------------------------------------------------------ */

async function hlsItems(href, { name, thumb, signal, settings }) {
  let info;
  try {
    info = await inspectHls(href, { signal });
  } catch (e) {
    const px = proxify(href, settings.corsProxy);
    if (!e.net || !px) throw e;
    info = await inspectHls(href, { signal, mapUrl: (u) => proxify(u, settings.corsProxy) });
  }
  const item = { type: 'video', kind: 'hls', url: href, name, thumb, duration: info.duration || undefined };
  if (info.variants.length) item.variants = info.variants;
  if (info.audios.length) {
    // Separate audio rendition: merged with ffmpeg, or offered as its own file (see splitAudio).
    const a = info.audios.find((x) => x.isDefault) || info.audios[0];
    item.audio = { kind: 'hls', url: a.url, label: a.name || a.lang };
  }
  return [item];
}

R.direct = async ({ url, signal, settings }) => {
  const ext = extFromUrl(url.href);
  const file = nameFromPath(url.href);
  if (ext === 'm3u8') return R.hls({ url, signal, settings });
  const type = typeFromExt(ext) || 'video';
  return {
    title: file,
    items: [{ type, kind: 'file', url: url.href, name: stripExt(file), ext, thumb: type === 'photo' ? url.href : undefined }],
  };
};

R.hls = async ({ url, signal, settings }) => {
  const file = stripExt(nameFromPath(url.href));
  const name = file === 'playlist' || file === 'master' || file === 'index' ? `${hostOf(url.href)}_video` : file;
  return { title: name, items: await hlsItems(url.href, { name, signal, settings }) };
};

/* ------------------------------------------------------------------ */
/* X / Twitter                                                         */
/* ------------------------------------------------------------------ */

const tweetId = (url) => url.pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];

const twPhoto = (u) => (/[?&]name=/.test(u) ? u : u + (u.includes('?') ? '&' : '?') + 'name=orig');

R.fxtwitter = async ({ url, signal }) => {
  const id = tweetId(url);
  if (!id) throw bad();
  const { data } = await fetchJsonRaw(`https://api.fxtwitter.com/status/${id}`, { signal });
  if (!data || data.code !== 200 || !data.tweet) throw new ResolveError(data?.code === 404 ? L('errNotFound') : `FxTwitter: ${data?.message || 'error'}`);
  const tw = data.tweet;
  let media = tw.media?.all || [];
  if (!media.length && tw.quote?.media?.all) media = tw.quote.media.all;
  const author = tw.author?.screen_name || 'x';
  const base = `${author}_${id}`;
  const items = media.map((m, i) => {
    const name = media.length > 1 ? `${base}_${i + 1}` : base;
    if (m.type === 'photo') return { type: 'photo', kind: 'file', url: twPhoto(m.url), thumb: m.url, name, ext: 'jpg' };
    const variants = (m.formats || m.variants || [])
      .filter((f) => f.container === 'mp4' || /mp4/.test(f.content_type || ''))
      .map((f) => {
        const r = f.url.match(/\/(\d+)x(\d+)\//);
        const p = r ? shortSide(+r[1], +r[2]) : 0;
        return { url: f.url, kind: 'file', ext: 'mp4', bitrate: f.bitrate || 0, p, label: p ? `${p}p` : `${Math.round((f.bitrate || 0) / 1000)} kbps` };
      });
    return {
      type: m.type === 'gif' ? 'gif' : 'video', kind: 'file', url: m.url, ext: 'mp4', thumb: m.thumbnail_url, name,
      duration: m.duration, variants: variants.length > 1 ? variants : undefined,
    };
  });
  return { title: (tw.text || base).slice(0, 120), author, items };
};

R.vxtwitter = async ({ url, signal }) => {
  const id = tweetId(url);
  if (!id) throw bad();
  const d = await fetchJson(`https://api.vxtwitter.com/Twitter/status/${id}`, { signal });
  let media = d.media_extended || [];
  if (!media.length && d.qrt?.media_extended) media = d.qrt.media_extended;
  const base = `${d.user_screen_name || 'x'}_${id}`;
  const items = media.map((m, i) => ({
    type: m.type === 'image' ? 'photo' : m.type === 'gif' ? 'gif' : 'video',
    kind: 'file', url: m.type === 'image' ? twPhoto(m.url) : m.url, thumb: m.thumbnail_url,
    name: media.length > 1 ? `${base}_${i + 1}` : base, ext: m.type === 'image' ? 'jpg' : 'mp4',
    duration: m.duration_millis ? m.duration_millis / 1000 : undefined,
  }));
  return { title: (d.text || base).slice(0, 120), author: d.user_screen_name, items };
};

/* ------------------------------------------------------------------ */
/* TikTok (TikWM public API)                                           */
/* ------------------------------------------------------------------ */

let tikwmLast = 0;
R.tikwm = async ({ url, signal, settings }) => {
  const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url.href)}&hd=1`;
  let d;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = tikwmLast + 1100 - Date.now(); // free tier: ~1 request/second
    if (wait > 0) await sleep(wait);
    tikwmLast = Date.now();
    d = await fetchJson(api, { signal });
    if (d.code === 0) break;
    if (!/limit|second/i.test(d.msg || '')) break;
  }
  if (d.code !== 0 || !d.data) throw new ResolveError(`TikWM: ${d.msg || 'error'}`);
  const v = d.data;
  const abs = (u) => (!u ? u : u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  const base = `${v.author?.unique_id || 'tiktok'}_${v.id}`;
  const title = v.title || base;
  const music = abs(v.music_info?.play || v.music);
  const audioItem = music ? { type: 'audio', kind: 'file', url: music, name: `${base}_audio`, ext: 'mp3', label: v.music_info?.title, thumb: abs(v.music_info?.cover) } : null;

  if (v.images?.length) {
    const items = v.images.map((img, i) => ({ type: 'photo', kind: 'file', url: abs(img), thumb: abs(img), name: `${base}_${i + 1}`, ext: 'jpg' }));
    if (audioItem) items.push(audioItem);
    return { title, author: v.author?.unique_id, items };
  }
  if (settings.mode === 'audio' && audioItem) return { title, items: [{ ...audioItem, name: base }] };
  const variants = [
    v.hdplay && { url: abs(v.hdplay), kind: 'file', ext: 'mp4', label: 'HD' },
    v.play && { url: abs(v.play), kind: 'file', ext: 'mp4', label: 'SD' },
    v.wmplay && { url: abs(v.wmplay), kind: 'file', ext: 'mp4', label: 'watermark' },
  ].filter(Boolean);
  if (!variants.length) throw none();
  return {
    title, author: v.author?.unique_id,
    items: [{ type: 'video', kind: 'file', url: variants[0].url, ext: 'mp4', name: base, thumb: abs(v.cover), duration: v.duration, variants, fallbacks: variants.slice(1) }],
    extras: audioItem ? [audioItem] : [],
  };
};

/* ------------------------------------------------------------------ */
/* Bluesky (AppView + the author's PDS for original files)            */
/* ------------------------------------------------------------------ */

const BSKY = 'https://public.api.bsky.app/xrpc';

async function pdsFor(did, signal) {
  const doc = did.startsWith('did:web:')
    ? await fetchJson(`https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`, { signal })
    : await fetchJson(`https://plc.directory/${did}`, { signal });
  const svc = (doc.service || []).find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds` || s.type === 'AtprotoPersonalDataServer');
  return svc?.serviceEndpoint?.replace(/\/+$/, '');
}

R.bluesky = async ({ url, signal }) => {
  const m = url.pathname.match(/^\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!m) throw bad();
  let did = decodeURIComponent(m[1]);
  if (!did.startsWith('did:')) did = (await fetchJson(`${BSKY}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`, { signal })).did;
  const uri = `at://${did}/app.bsky.feed.post/${m[2]}`;
  const { posts } = await fetchJson(`${BSKY}/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { signal });
  const post = posts?.[0];
  if (!post) throw new ResolveError(L('errNotFound'));

  const found = [];
  const collect = (e, owner) => {
    if (!e) return;
    const type = e.$type || '';
    if (type.startsWith('app.bsky.embed.video')) found.push({ kind: 'video', owner, e });
    else if (type.startsWith('app.bsky.embed.images')) (e.images || []).forEach((img) => found.push({ kind: 'image', owner, e: img }));
    else if (type.startsWith('app.bsky.embed.recordWithMedia')) {
      collect(e.media, owner);
      const rec = e.record?.record;
      (rec?.embeds || []).forEach((x) => collect(x, rec.author?.did || owner));
    } else if (type.startsWith('app.bsky.embed.record')) {
      const rec = e.record;
      (rec?.embeds || []).forEach((x) => collect(x, rec.author?.did || owner));
    } else if (type.startsWith('app.bsky.embed.external')) {
      const u = e.external?.uri;
      if (u && isMediaUrl(u)) found.push({ kind: 'external', owner, e: { url: u, thumb: e.external.thumb } });
    }
  };
  collect(post.embed, post.author?.did || did);
  if (!found.length) throw none();

  const handle = post.author?.handle || 'bsky';
  const base = `${handle}_${m[2]}`;
  // Original files live on the author's PDS, which (unlike the CDN) allows CORS.
  const pdsCache = new Map();
  const blobUrl = async (did, cid) => {
    if (!pdsCache.has(did)) pdsCache.set(did, pdsFor(did, signal).catch(() => null));
    const pds = await pdsCache.get(did);
    return pds ? `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}` : null;
  };
  const items = [];
  for (const [i, f] of found.entries()) {
    const name = found.length > 1 ? `${base}_${i + 1}` : base;
    if (f.kind === 'image') {
      const cdn = f.e.fullsize;
      const mm = cdn?.match(/\/plain\/(did:[^/]+)\/([^/@]+)/);
      const orig = mm ? await blobUrl(decodeURIComponent(mm[1]), mm[2]) : null;
      items.push({
        type: 'photo', kind: 'file', url: orig || cdn, thumb: f.e.thumb, name, ext: 'jpg', label: f.e.alt?.slice(0, 60),
        fallbacks: orig ? [{ kind: 'file', url: cdn, ext: 'jpg' }] : [],
      });
    } else if (f.kind === 'external') {
      items.push({ type: typeFromExt(extFromUrl(f.e.url)) || 'gif', kind: 'file', url: f.e.url, thumb: f.e.thumb, name });
    } else {
      const orig = await blobUrl(f.owner, f.e.cid);
      const hls = { kind: 'hls', url: f.e.playlist };
      items.push(orig
        ? { type: f.e.presentation === 'gif' ? 'gif' : 'video', kind: 'file', ext: 'mp4', name, thumb: f.e.thumbnail, url: orig, fallbacks: [hls] }
        : { type: 'video', kind: 'hls', url: f.e.playlist, name, thumb: f.e.thumbnail });
    }
  }
  return { title: (post.record?.text || base).slice(0, 120), author: handle, items };
};

/* ------------------------------------------------------------------ */
/* Streamable                                                          */
/* ------------------------------------------------------------------ */

R.streamable = async ({ url, signal }) => {
  const code = url.pathname.split('/').filter(Boolean).filter((s) => !['e', 'o', 's', 'm'].includes(s))[0];
  if (!code) throw bad();
  const d = await fetchJson(`https://api.streamable.com/videos/${code}`, { signal });
  if (d.status !== 2) throw new ResolveError(L('errProcessing'));
  const fix = normUrl;
  const variants = Object.entries(d.files || {})
    .filter(([, f]) => f?.url)
    .map(([k, f]) => ({ url: fix(f.url), kind: 'file', ext: 'mp4', p: shortSide(f.width, f.height), label: f.height ? `${shortSide(f.width, f.height)}p` : k }));
  if (!variants.length) throw none();
  return {
    title: d.title || code,
    items: [{ type: 'video', kind: 'file', url: variants[0].url, ext: 'mp4', name: d.title || `streamable_${code}`, thumb: fix(d.thumbnail_url), variants: variants.length > 1 ? variants : undefined }],
  };
};

/* ------------------------------------------------------------------ */
/* Reddit (public JSON)                                                */
/* ------------------------------------------------------------------ */

R.reddit = async ({ url, signal, settings }) => {
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'v.redd.it') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (!id) throw bad();
    return { title: `reddit_${id}`, items: await hlsItems(`https://v.redd.it/${id}/HLSPlaylist.m3u8`, { name: `reddit_${id}`, signal, settings }) };
  }
  const id = url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] || (host === 'redd.it' ? url.pathname.split('/').filter(Boolean)[0] : null);
  if (!id) throw bad();
  const json = await fetchJson(`https://www.reddit.com/comments/${id}.json?raw_json=1`, { signal });
  let post = json?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new ResolveError(L('errNotFound'));
  if (post.crosspost_parent_list?.length) post = post.crosspost_parent_list[0];
  const base = `reddit_${post.id}`;
  const thumb = post.preview?.images?.[0]?.source?.url || (/^https?:/.test(post.thumbnail || '') ? post.thumbnail : undefined);
  const title = post.title || base;

  const rv = post.secure_media?.reddit_video || post.media?.reddit_video || post.preview?.reddit_video_preview;
  if (rv?.fallback_url) {
    const video = rv.fallback_url.split('?')[0];
    const dir = video.slice(0, video.lastIndexOf('/'));
    const item = {
      type: rv.is_gif ? 'gif' : 'video', kind: 'file', url: video, ext: 'mp4', name: base, thumb, duration: rv.duration,
      fallbacks: rv.hls_url ? [{ kind: 'hls', url: rv.hls_url }] : [],
    };
    if (rv.has_audio !== false && !rv.is_gif) {
      // Reddit keeps the soundtrack in a separate file; it is merged in with ffmpeg.
      item.audio = {
        kind: 'file', url: `${dir}/DASH_AUDIO_128.mp4`, ext: 'm4a', optional: true,
        fallbacks: [`${dir}/DASH_AUDIO_64.mp4`, `${dir}/DASH_audio.mp4`, `${dir}/audio`].map((u) => ({ kind: 'file', url: u, ext: 'm4a' })),
      };
    }
    return { title, items: [item] };
  }
  if (post.is_gallery && post.gallery_data?.items) {
    const items = post.gallery_data.items.map((g, i) => {
      const md = post.media_metadata?.[g.media_id];
      const s = md?.s || {};
      const u = s.mp4 || s.gif || s.u;
      if (!u) return null;
      return { type: s.mp4 ? 'gif' : 'photo', kind: 'file', url: u, thumb: md.p?.[md.p.length - 1]?.u || u, name: `${base}_${i + 1}`, label: g.caption };
    }).filter(Boolean);
    if (items.length) return { title, items };
  }
  const dest = post.url_overridden_by_dest || post.url;
  if (dest && isMediaUrl(dest)) {
    const type = typeFromExt(extFromUrl(dest));
    return { title, items: [{ type, kind: 'file', url: dest, name: base, thumb: type === 'photo' ? dest : thumb }] };
  }
  if (dest && !/reddit\.com|redd\.it/.test(hostOf(dest))) return { redirect: dest };
  throw none();
};

/* ------------------------------------------------------------------ */
/* Vimeo (player config — works only when Vimeo allows it)            */
/* ------------------------------------------------------------------ */

R.vimeo = async ({ url, signal, settings }) => {
  const m = url.pathname.match(/(?:\/video)?\/(\d{5,})(?:\/([0-9a-f]{6,}))?/);
  if (!m) throw bad();
  const h = m[2] || url.searchParams.get('h');
  const cfg = await fetchJson(`https://player.vimeo.com/video/${m[1]}/config${h ? `?h=${h}` : ''}`, { signal });
  const title = cfg.video?.title || `vimeo_${m[1]}`;
  const thumb = cfg.video?.thumbs?.base || cfg.video?.thumbs?.['640'];
  const files = cfg.request?.files || {};
  const prog = (files.progressive || []).map((f) => ({ url: f.url, kind: 'file', ext: 'mp4', p: shortSide(f.width, f.height), label: f.quality }));
  if (prog.length) return { title, items: [{ type: 'video', kind: 'file', url: prog[0].url, ext: 'mp4', name: title, thumb, variants: prog, duration: cfg.video?.duration }] };
  const cdn = files.hls?.cdns?.[files.hls.default_cdn] || Object.values(files.hls?.cdns || {})[0];
  if (cdn?.url) return { title, items: await hlsItems(cdn.url, { name: title, thumb, signal, settings }) };
  throw none();
};

/* ------------------------------------------------------------------ */
/* Fediverse: Mastodon / Pixelfed / PeerTube                           */
/* ------------------------------------------------------------------ */

R.mastodon = async ({ url, signal }) => {
  const id = url.pathname.match(/\/(\d{5,})\/?$/)?.[1];
  if (!id) throw bad();
  const st = await fetchJson(`${url.origin}/api/v1/statuses/${id}`, { signal });
  const s = st.reblog || st;
  const acct = (s.account?.acct || 'post').replace(/@.*/, '');
  const list = s.media_attachments || [];
  const items = list.map((a, i) => ({
    type: a.type === 'image' ? 'photo' : a.type === 'gifv' ? 'gif' : a.type === 'audio' ? 'audio' : 'video',
    kind: 'file', url: a.url || a.remote_url, thumb: a.preview_url, label: a.description?.slice(0, 60),
    name: list.length > 1 ? `${acct}_${s.id}_${i + 1}` : `${acct}_${s.id}`,
    fallbacks: a.remote_url && a.remote_url !== a.url ? [{ kind: 'file', url: a.remote_url }] : [],
  })).filter((x) => x.url);
  const text = (s.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: text.slice(0, 120) || `${acct}_${s.id}`, author: acct, items };
};

R.peertube = async ({ url, signal }) => {
  const p = url.pathname;
  const pl = p.match(/^\/(?:w\/p|videos\/watch\/playlist)\/([^/?#]+)/);
  if (pl) {
    const d = await fetchJson(`${url.origin}/api/v1/video-playlists/${pl[1]}/videos?count=100`, { signal });
    const items = (d.data || []).filter((e) => e.video).map((e) => ({
      type: 'video', kind: 'lazy', sourceUrl: `${url.origin}/w/${e.video.shortUUID || e.video.uuid}`,
      name: e.video.name, thumb: e.video.thumbnailPath ? url.origin + e.video.thumbnailPath : undefined, duration: e.video.duration,
    }));
    return { title: `PeerTube playlist ${pl[1]}`, items };
  }
  const id = p.match(/^\/(?:w|videos\/(?:watch|embed))\/([^/?#]+)/)?.[1];
  if (!id) throw bad();
  const v = await fetchJson(`${url.origin}/api/v1/videos/${id}`, { signal });
  const files = [...(v.files || []), ...(v.streamingPlaylists || []).flatMap((s) => s.files || [])];
  const seen = new Set();
  const variants = files
    .filter((f) => f.fileUrl && f.resolution?.id > 0)
    .sort((a, b) => b.resolution.id - a.resolution.id)
    .filter((f) => !seen.has(f.resolution.id) && seen.add(f.resolution.id))
    .map((f) => ({ url: f.fileUrl, kind: 'file', ext: extFromUrl(f.fileUrl) || 'mp4', p: f.resolution.id, label: f.resolution.label, size: f.size }));
  const thumb = v.previewPath ? (v.previewPath.startsWith('http') ? v.previewPath : url.origin + v.previewPath) : undefined;
  if (variants.length) return { title: v.name, items: [{ type: 'video', kind: 'file', url: variants[0].url, name: v.name, thumb, duration: v.duration, variants }] };
  const hls = v.streamingPlaylists?.[0]?.playlistUrl;
  if (hls) return { title: v.name, items: [{ type: 'video', kind: 'hls', url: hls, name: v.name, thumb }] };
  throw none();
};

/* ------------------------------------------------------------------ */
/* Internet Archive                                                     */
/* ------------------------------------------------------------------ */

const IA_VIDEO = { mp4: 6, m4v: 5, webm: 5, mkv: 4, mov: 4, ogv: 3, avi: 3, mpeg: 2, mpg: 2, flv: 1 };
const IA_AUDIO = { mp3: 6, m4a: 5, ogg: 4, opus: 4, flac: 3, wav: 2 };

R.archive = async ({ url, signal, settings }) => {
  const parts = url.pathname.split('/').filter(Boolean);
  if (!['details', 'download', 'embed'].includes(parts[0]) || !parts[1]) throw bad();
  const id = parts[1];
  if (parts[0] === 'download' && parts.length > 2 && isMediaUrl(url.href)) return R.direct({ url, signal, settings });
  const md = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, { signal });
  if (!md.files) throw new ResolveError(L('errNotFound'));
  const wantAudio = settings.mode === 'audio';
  const groups = new Map();
  for (const f of md.files) {
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const score = (wantAudio ? IA_AUDIO : IA_VIDEO)[ext];
    if (!score || /thumb/i.test(f.format || '')) continue;
    const key = f.name.replace(/\.[^.]+$/, '').replace(/(\.ia|_512kb|_edit)$/i, '').toLowerCase();
    const entry = {
      url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      kind: 'file', ext, size: Number(f.size) || 0, label: `${ext.toUpperCase()}${f.size ? ' · ' + Math.round(f.size / 1048576) + ' MB' : ''}`,
      score: score * 1e12 + (Number(f.size) || 0), title: f.title || f.name.replace(/\.[^.]+$/, ''), length: Number(f.length) || undefined,
    };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  if (!groups.size && !wantAudio) throw none();
  if (!groups.size) return R.archive({ url, signal, settings: { ...settings, mode: 'auto' } });
  const thumb = `https://archive.org/services/img/${encodeURIComponent(id)}`;
  const items = [...groups.values()].map((vars) => {
    vars.sort((a, b) => b.score - a.score);
    return {
      type: wantAudio ? 'audio' : 'video', kind: 'file', url: vars[0].url, ext: vars[0].ext, name: vars[0].title, thumb,
      duration: vars[0].length, variants: vars.length > 1 ? vars : undefined,
    };
  });
  return { title: md.metadata?.title || id, items };
};

/* ------------------------------------------------------------------ */
/* Small URL rewrites: Giphy, Imgur, 9GAG, Dropbox, Google Drive       */
/* ------------------------------------------------------------------ */

R.giphy = async ({ url }) => {
  const p = url.pathname.split('/').filter(Boolean);
  let id;
  if (/^(media\d*|i)\.giphy\.com$/.test(url.hostname)) id = /^giphy/.test(p[p.length - 1] || '') ? p[p.length - 2] : p[p.length - 1];
  else if (p[0] === 'embed') id = p[1];
  else if (['gifs', 'clips', 'stickers'].includes(p[0]) && p[1]) id = p[1].split('-').pop();
  if (!id) throw bad();
  id = id.replace(/\.(gif|mp4|webp)$/, '');
  const mp4 = `https://i.giphy.com/media/${id}/giphy.mp4`;
  return {
    title: `giphy_${id}`,
    items: [{
      type: 'gif', kind: 'file', url: mp4, ext: 'mp4', name: `giphy_${id}`, thumb: `https://i.giphy.com/media/${id}/200w.gif`,
      variants: [{ url: mp4, kind: 'file', ext: 'mp4', label: 'MP4' }, { url: `https://i.giphy.com/media/${id}/giphy.gif`, kind: 'file', ext: 'gif', label: 'GIF' }],
    }],
  };
};

R.imgur = async ({ url }) => {
  const p = url.pathname.split('/').filter(Boolean);
  if (url.hostname.startsWith('i.')) {
    const m = p[0]?.match(/^(\w+)\.(gifv|mp4|webm)$/);
    if (!m) throw bad();
    return { title: m[1], items: [{ type: 'video', kind: 'file', url: `https://i.imgur.com/${m[1]}.mp4`, ext: 'mp4', name: `imgur_${m[1]}` }] };
  }
  if (p.length === 1 && /^\w{5,8}$/.test(p[0])) {
    const id = p[0];
    return {
      title: id,
      items: [{ type: 'video', kind: 'file', url: `https://i.imgur.com/${id}.mp4`, ext: 'mp4', name: `imgur_${id}`, thumb: `https://i.imgur.com/${id}m.jpeg`,
        fallbacks: [{ kind: 'file', url: `https://i.imgur.com/${id}.jpeg`, ext: 'jpg' }] }],
    };
  }
  throw bad(); // albums/galleries → page scan
};

R.ninegag = async ({ url }) => {
  const id = url.pathname.match(/\/gag\/(\w+)/)?.[1];
  if (!id) throw bad();
  const b = `https://img-9gag-fun.9cache.com/photo/${id}`;
  return {
    title: `9gag_${id}`,
    items: [{ type: 'video', kind: 'file', url: `${b}_460sv.mp4`, ext: 'mp4', name: `9gag_${id}`, thumb: `${b}_460s.jpg`,
      fallbacks: [{ kind: 'file', url: `${b}_460svvp9.webm`, ext: 'webm' }, { kind: 'file', url: `${b}_700b.jpg`, ext: 'jpg' }] }],
  };
};

R.dropbox = async ({ url }) => {
  const u = new URL(url.href);
  u.searchParams.delete('raw');
  u.searchParams.set('dl', '1');
  const file = nameFromPath(u.href);
  const ext = extFromUrl(u.href);
  return { title: file, items: [{ type: typeFromExt(ext) || 'video', kind: 'file', url: u.href, name: stripExt(file), ext, attachment: true }] };
};

R.gdrive = async ({ url }) => {
  const id = url.pathname.match(/\/d\/([\w-]{20,})/)?.[1] || url.searchParams.get('id');
  if (!id) throw bad();
  return {
    title: `drive_${id}`,
    items: [{ type: 'video', kind: 'file', url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, name: `drive_${id}`,
      thumb: `https://drive.google.com/thumbnail?id=${id}` }],
  };
};

/* ------------------------------------------------------------------ */
/* YouTube via Piped / Invidious (public instances, often rate-limited) */
/* ------------------------------------------------------------------ */

function ytIds(url) {
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let v = url.searchParams.get('v');
  if (host === 'youtu.be') v = url.pathname.split('/')[1];
  const m = url.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([\w-]{11})/);
  if (m) v = m[1];
  if (v && !/^[\w-]{11}$/.test(v)) v = null;
  const list = url.searchParams.get('list');
  return { v, list: list && (!v || url.pathname === '/playlist') ? list : null };
}

const ytAudioExt = (mime) => (/webm/i.test(mime || '') ? 'weba' : 'm4a');

function ytItems({ title, thumb, duration, muxed, videoOnly, audio, hls }, settings) {
  const bestAudio = [...audio].sort((a, b) => (/mp4/.test(b.mime) - /mp4/.test(a.mime)) || b.bitrate - a.bitrate)[0];
  const audioItem = bestAudio && { type: 'audio', kind: 'file', url: bestAudio.url, ext: ytAudioExt(bestAudio.mime), name: title, thumb, label: L('audioExtra') };
  if (settings.mode === 'audio' && audioItem) return { items: [audioItem] };
  const toVariants = (arr) => arr
    .map((s) => ({ url: s.url, kind: 'file', ext: /webm/i.test(s.mime) ? 'webm' : 'mp4', p: s.p, bitrate: s.bitrate, label: `${s.p || '?'}p${/webm/i.test(s.mime) ? ' webm' : ''}` }))
    .sort((a, b) => (b.ext === 'mp4') - (a.ext === 'mp4'));
  if (settings.mode === 'mute' && videoOnly.length) {
    const vs = toVariants(videoOnly);
    return { items: [{ type: 'video', kind: 'file', url: vs[0].url, name: title, thumb, duration, variants: vs, final: true }] };
  }
  const extras = audioItem ? [audioItem] : [];
  const bestMuxed = Math.max(0, ...muxed.map((s) => s.p || 0));
  const bestAdaptive = Math.max(0, ...videoOnly.map((s) => s.p || 0));
  // With ffmpeg, high-quality adaptive video + audio beats the 360p/720p muxed streams.
  if (videoOnly.length && bestAudio && canMerge(settings) && bestAdaptive > bestMuxed) {
    const vs = toVariants(videoOnly.filter((s) => !/av01/i.test(s.mime || '')));
    if (vs.length) {
      return {
        items: [{ type: 'video', kind: 'file', url: vs[0].url, ext: vs[0].ext, name: title, thumb, duration, variants: vs,
          audio: { kind: 'file', url: bestAudio.url, ext: ytAudioExt(bestAudio.mime) } }],
        extras,
      };
    }
  }
  if (muxed.length) {
    const vs = toVariants(muxed);
    return { items: [{ type: 'video', kind: 'file', url: vs[0].url, ext: vs[0].ext, name: title, thumb, duration, variants: vs }], extras };
  }
  if (hls) return { items: [{ type: 'video', kind: 'hls', url: hls, name: title, thumb, duration }], extras };
  if (videoOnly.length) {
    const vs = toVariants(videoOnly);
    const item = { type: 'video', kind: 'file', url: vs[0].url, name: title, thumb, duration, variants: vs };
    if (bestAudio) item.audio = { kind: 'file', url: bestAudio.url, ext: ytAudioExt(bestAudio.mime) };
    return { items: [item], extras };
  }
  throw none();
}

async function pipedGet(base, path, signal) {
  const r = await fetchJsonRaw(`${base}${path}`, { signal, timeout: 12000 });
  if (!r.ok || !r.data || r.data.error) throw new ResolveError(`Piped ${hostOf(base)}: ${r.data?.message?.split('\n')[0]?.slice(0, 120) || r.data?.error || r.status}`);
  return r.data;
}

R.piped = async ({ url, settings, signal }) => {
  const { v, list } = ytIds(url);
  const insts = pipedInstances(settings);
  if (!insts.length || (!v && !list)) throw bad();
  if (list) {
    const d = await firstSuccess(insts.map((b) => () => pipedGet(b, `/playlists/${list}`, signal)));
    return {
      title: d.name,
      items: (d.relatedStreams || []).map((s) => ({ type: 'video', kind: 'lazy', sourceUrl: `https://www.youtube.com${s.url}`, name: s.title, thumb: s.thumbnail, duration: s.duration, label: s.uploaderName })),
    };
  }
  const d = await firstSuccess(insts.map((b) => () => pipedGet(b, `/streams/${v}`, signal)));
  const vs = d.videoStreams || [];
  const map = (s) => ({ url: s.url, mime: s.mimeType || s.format, p: shortSide(s.width, s.height) || parseInt(s.quality, 10) || 0, bitrate: s.bitrate || 0 });
  const res = ytItems({
    title: d.title, thumb: d.thumbnailUrl, duration: d.duration, hls: d.hls,
    muxed: vs.filter((s) => !s.videoOnly).map(map), videoOnly: vs.filter((s) => s.videoOnly).map(map),
    audio: (d.audioStreams || []).map((s) => ({ url: s.url, mime: s.mimeType || s.format, bitrate: s.bitrate || 0 })),
  }, settings);
  return { title: d.title, author: d.uploader, ...res };
};

R.invidious = async ({ url, settings, signal }) => {
  const { v, list } = ytIds(url);
  const insts = invidiousInstances(settings);
  if (!insts.length || (!v && !list)) throw bad();
  const get = (b, path) => fetchJsonRaw(`${b}${path}`, { signal, timeout: 12000 }).then((r) => {
    if (!r.ok || !r.data || r.data.error) throw new ResolveError(`Invidious ${hostOf(b)}: ${r.data?.error || r.status}`);
    return { base: b, d: r.data };
  });
  if (list) {
    const { d } = await firstSuccess(insts.map((b) => () => get(b, `/api/v1/playlists/${list}`)));
    return {
      title: d.title,
      items: (d.videos || []).map((x) => ({ type: 'video', kind: 'lazy', sourceUrl: `https://www.youtube.com/watch?v=${x.videoId}`, name: x.title, thumb: x.videoThumbnails?.[0]?.url, duration: x.lengthSeconds, label: x.author })),
    };
  }
  const { base, d } = await firstSuccess(insts.map((b) => () => get(b, `/api/v1/videos/${v}?local=true`)));
  const abs = (u) => new URL(u, base).href;
  const res = (s) => parseInt(s.resolution || s.qualityLabel || '', 10) || 0;
  const adaptive = d.adaptiveFormats || [];
  const out = ytItems({
    title: d.title, thumb: d.videoThumbnails?.find((x) => x.quality === 'high')?.url || d.videoThumbnails?.[0]?.url, duration: d.lengthSeconds,
    hls: d.hlsUrl,
    muxed: (d.formatStreams || []).map((s) => ({ url: abs(s.url), mime: s.type, p: res(s), bitrate: Number(s.bitrate) || 0 })),
    videoOnly: adaptive.filter((s) => /^video/.test(s.type)).map((s) => ({ url: abs(s.url), mime: s.type, p: res(s), bitrate: Number(s.bitrate) || 0 })),
    audio: adaptive.filter((s) => /^audio/.test(s.type)).map((s) => ({ url: abs(s.url), mime: s.type, bitrate: Number(s.bitrate) || 0 })),
  }, settings);
  return { title: d.title, author: d.author, ...out };
};

/* ------------------------------------------------------------------ */
/* cobalt (self-hosted or any instance without captcha)                */
/* ------------------------------------------------------------------ */

function cobaltError(code = '') {
  if (/auth\.jwt|turnstile/.test(code)) return L('errCobaltJwt');
  if (/auth\.(key|not_authenticated|missing)|api_key/.test(code)) return L('errCobaltAuth');
  if (/rate_exceeded/.test(code)) return L('errCobaltRate');
  if (/link\.(unsupported|invalid)|service\.(unsupported|disabled)/.test(code)) return L('errCobaltUnsupported');
  if (/content\.|fetch\.empty|fetch\.fail/.test(code)) return L('errNotFoundCode', { code });
  return L('errCobaltGeneric', { code });
}

async function cobaltRequest(inst, link, s, signal) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (inst.key) headers.Authorization = /^(api-key|bearer)\s/i.test(inst.key) ? inst.key : `Api-Key ${inst.key}`;
  const body = {
    url: link, videoQuality: s.quality === 'max' ? 'max' : String(s.quality), downloadMode: s.mode,
    audioFormat: s.audioFormat, filenameStyle: 'pretty', youtubeVideoCodec: 'h264', alwaysProxy: true,
  };
  const post = (b) => fetchJsonRaw(inst.url, { method: 'POST', headers, body: JSON.stringify(b), signal, timeout: 60000 });
  let r = await post(body);
  if (r.data?.status === 'error' && /invalid_body/.test(r.data.error?.code || '')) r = await post({ url: link });
  const d = r.data;
  if (!d) throw new ResolveError(L('errHttp', { status: r.status, host: hostOf(inst.url) }));

  const base = stripExt(nameFromPath(link)) || 'media';
  switch (d.status) {
    case 'tunnel': case 'stream': case 'redirect': {
      const fn = d.filename || '';
      const ext = (fn.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
      const type = typeFromExt(ext) || (s.mode === 'audio' ? 'audio' : 'video');
      return { title: stripExt(fn) || link, items: [{ type, kind: 'file', url: d.url, filename: fn || undefined, name: base, ext, attachment: d.status !== 'redirect', final: true }] };
    }
    case 'picker': {
      const items = (d.picker || []).map((p, i) => ({
        type: p.type === 'photo' ? 'photo' : p.type === 'gif' ? 'gif' : p.type === 'audio' ? 'audio' : 'video',
        kind: 'file', url: p.url, thumb: p.thumb, final: true,
        name: p.filename ? stripExt(String(p.filename)) : `${base}_${i + 1}`, // getvid-server sends titles
      }));
      if (d.audio) items.push({ type: 'audio', kind: 'file', url: d.audio, filename: d.audioFilename, name: `${base}_audio`, attachment: true });
      return { title: base, items };
    }
    case 'local-processing': {
      // cobalt 11 hands the final processing step (merge/convert) to the client: we do it with ffmpeg.
      const tunnels = d.tunnel || [];
      const fn = d.output?.filename || base;
      const outExt = (fn.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
      if (!tunnels.length) throw new ResolveError(L('errCobaltGeneric', { code: 'local-processing' }));
      const item = { type: d.type === 'audio' ? 'audio' : 'video', kind: 'file', url: tunnels[0], name: stripExt(fn), ext: outExt, final: true };
      if (d.type === 'merge' && tunnels[1]) item.audio = { kind: 'file', url: tunnels[1] };
      else if (d.type === 'audio') item.transform = 'audio';
      else if (d.type === 'mute') item.transform = 'mute';
      return { title: stripExt(fn), items: [item] };
    }
    case 'error': {
      const code = d.error?.code || 'error';
      throw new ResolveError(cobaltError(code), { unsupported: /unsupported/.test(code), code });
    }
    default:
      throw new ResolveError(L('errCobaltGeneric', { code: d.status || r.status }));
  }
}

R.cobalt = async ({ url, settings, signal, platform, cobaltExclude = [] }) => {
  let last;
  // Sites cobalt doesn't list go only to the user's own servers (e.g. a yt-dlp based getvid-server).
  const pool = platform && !platform.resolvers.includes('cobalt') ? ownCobaltInstances(settings) : cobaltInstances(settings, platform?.id);
  for (const inst of pool.filter((i) => !cobaltExclude.includes(i.url))) {
    try {
      const res = await cobaltRequest(inst, url.href, settings, signal);
      // Remember which server produced the files, so a failed download can move on to the next one.
      res.items.forEach((it) => { it.cobaltInst = inst.url; it.cobaltPublic = !!inst.public; });
      return res;
    } catch (e) {
      if (isUserAbort(e)) throw e;
      last = e;
      // A user's own server saying "unsupported" is final; public servers differ, so keep trying.
      if (e.unsupported && !inst.public) break;
    }
  }
  throw last || new ResolveError(L('errNoCobalt'));
};

/* ------------------------------------------------------------------ */
/* Generic page scanner (og:video, <video>, JSON-LD, raw URLs, embeds) */
/* ------------------------------------------------------------------ */

async function fetchPage(u, signal) {
  const tm = withTimeout(signal, 20000);
  try {
    const res = await fetch(u, { signal: tm.signal, referrerPolicy: 'no-referrer' });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (/^(video|audio|image)\//.test(type) || /mpegurl|octet-stream|binary/.test(type)) {
      res.body?.cancel().catch(() => {});
      return { media: type };
    }
    if (!res.ok) throw new ResolveError(L('errHttp', { status: res.status, host: hostOf(u) }));
    return { html: await res.text() };
  } catch (e) {
    throw mapFetchError(e, u, signal, tm.signal);
  } finally {
    tm.done();
  }
}

function walkLd(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walkLd(n, cb)); return; }
  cb(node);
  Object.values(node).forEach((v) => { if (v && typeof v === 'object') walkLd(v, cb); });
}

R.generic = async ({ url, settings, signal }) => {
  const tries = [url.href];
  const px = proxify(url.href, settings.corsProxy);
  if (px) tries.push(px);
  let page, lastErr;
  for (const u of tries) {
    try { page = await fetchPage(u, signal); break; } catch (e) { if (isUserAbort(e)) throw e; lastErr = e; }
  }
  if (!page) throw lastErr?.net && !px ? new ResolveError(L('errNoProxy')) : lastErr;

  if (page.media) {
    if (/mpegurl/.test(page.media)) return R.hls({ url, signal, settings });
    const ext = extFromMime(page.media); // octet-stream: the real type is sniffed after download
    const type = page.media.startsWith('image/') ? (ext === 'gif' ? 'gif' : 'photo') : page.media.startsWith('audio/') ? 'audio' : 'video';
    return { title: nameFromPath(url.href), items: [{ type, kind: 'file', url: url.href, ext, name: stripExt(nameFromPath(url.href)) }] };
  }

  const html = page.html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (sel) => [...doc.querySelectorAll(sel)].map((m) => m.getAttribute('content')).filter(Boolean);
  const title = (meta('meta[property="og:title"],meta[name="twitter:title"]')[0] || doc.title || hostOf(url.href)).trim();
  const ogImage = meta('meta[property="og:image"],meta[name="twitter:image"]')[0];

  const media = new Map(); // url → { type, thumb, label }
  const embeds = new Set();
  const add = (raw, type, thumb, label, embedOnly = false) => {
    if (!raw) return;
    let parsed;
    try { parsed = new URL(raw.replace(/&amp;/g, '&').trim(), url.href); } catch { return; }
    const u = parsed.href;
    if (!/^https?:/.test(u)) return;
    const p = detectPlatform(parsed);
    const known = !isMediaUrl(u) && p !== GENERIC && p.id !== 'direct' && p.id !== 'hls' && !p.drm;
    if (known) { if (u !== url.href) embeds.add(u); return; }
    if (embedOnly) return; // unknown iframes are ads/widgets, not media
    if (!media.has(u)) media.set(u, { type: extFromUrl(u) === 'm3u8' ? 'video' : (typeFromExt(extFromUrl(u)) || type), thumb, label });
  };

  meta('meta[property="og:video:secure_url"],meta[property="og:video:url"],meta[property="og:video"],meta[name="twitter:player:stream"],meta[property="twitter:player:stream"]').forEach((u) => add(u, 'video', ogImage));
  meta('meta[property="og:audio:secure_url"],meta[property="og:audio"]').forEach((u) => add(u, 'audio', ogImage));
  doc.querySelectorAll('video[src],video source[src],audio[src],audio source[src]').forEach((el) => {
    const v = el.closest('video');
    add(el.getAttribute('src'), v ? 'video' : 'audio', v?.getAttribute('poster') || ogImage, el.getAttribute('label') || el.getAttribute('title'));
  });
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      walkLd(JSON.parse(s.textContent), (n) => {
        const ty = [].concat(n['@type'] || []);
        if (ty.includes('VideoObject') || ty.includes('AudioObject')) {
          const thumb = [].concat(n.thumbnailUrl || [])[0];
          add(n.contentUrl, ty.includes('AudioObject') ? 'audio' : 'video', typeof thumb === 'string' ? thumb : thumb?.url, n.name);
          if (n.embedUrl) add(n.embedUrl, 'video', thumb, n.name, true);
        }
      });
    } catch { /* bad JSON-LD */ }
  });
  // Raw media URLs inside scripts / JSON blobs.
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  for (const m of unescaped.matchAll(/https?:\/\/[^"'\s<>\\()]+?\.(?:mp4|m3u8|webm|mov|m4v)(?:\?[^"'\s<>\\()]*)?(?=["'\s<>\\()]|$)/gi)) add(m[0], 'video', ogImage);
  if (/^(t\.me|telegram\.me)$/.test(url.hostname)) {
    for (const m of html.matchAll(/background-image:url\('([^']+)'\)/g)) if (/telesco\.pe|cdn\d*\.telegram/.test(m[1])) add(m[1], 'photo', m[1]);
  }
  doc.querySelectorAll('iframe[src]').forEach((f) => add(f.getAttribute('src'), 'video', undefined, undefined, true));

  const items = [...media.entries()].map(([u, info], i) => {
    const name = media.size > 1 ? `${title}_${i + 1}` : title;
    if (extFromUrl(u) === 'm3u8') return { type: 'video', kind: 'hls', url: u, name, thumb: info.thumb, label: info.label };
    return { type: info.type, kind: 'file', url: u, name, thumb: info.thumb || (info.type === 'photo' ? u : undefined), label: info.label };
  });
  for (const e of embeds) {
    const p = detectPlatform(new URL(e));
    items.push({ type: 'video', kind: 'lazy', sourceUrl: e, name: `${title} (${p.name})`, label: p.name, thumb: ogImage });
  }
  if (!items.length) throw none();
  return { title, items };
};

R.telegram = async (ctx) => {
  const p = ctx.url.pathname.split('/').filter(Boolean);
  const parts = p[0] === 's' ? p.slice(1) : p;
  if (parts.length < 2 || !/^\d+$/.test(parts[1])) throw bad();
  const embed = new URL(`https://t.me/${parts[0]}/${parts[1]}?embed=1&mode=tme`);
  const res = await R.generic({ ...ctx, url: embed });
  res.items = res.items.filter((i) => i.kind !== 'lazy');
  if (!res.items.length) throw none();
  return res;
};

/* ------------------------------------------------------------------ */
/* Odysee, Pinterest, Misskey-family, Lemmy                            */
/* ------------------------------------------------------------------ */

R.odysee = async ({ url, signal }) => {
  const segs = url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
  let lbry;
  if (segs[0] === '$' && segs[1] === 'embed' && segs[2]) lbry = `lbry://${segs[2]}${segs[3] ? `#${segs[3]}` : ''}`;
  else if (segs.length && segs[0] !== '$') lbry = `lbry://${segs.slice(0, 2).map((x) => x.replace(':', '#')).join('/')}`;
  else throw bad();
  const { data } = await fetchJsonRaw('https://api.na-backend.odysee.com/api/v1/proxy?m=resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'resolve', params: { urls: [lbry] } }),
  });
  let c = data?.result?.[lbry];
  if (!c || c.error) throw new ResolveError(L('errNotFound'));
  if (c.value_type === 'repost' && c.reposted_claim) c = c.reposted_claim;
  const v = c.value || {};
  const sd = v.source?.sd_hash;
  if (!sd) throw none();
  const mime = v.source?.media_type || 'video/mp4';
  const type = mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'photo' : 'video';
  const ext = type === 'video' ? 'mp4' : (extFromMime(mime) || 'bin');
  const title = v.title || c.name;
  return {
    title,
    items: [{ type, kind: 'file', url: `https://player.odycdn.com/v6/streams/${c.claim_id}/${sd.slice(0, 6)}.${ext}`, ext, name: title,
      thumb: v.thumbnail?.url, duration: v.video?.duration || v.audio?.duration }],
  };
};

R.pinterest = async ({ url, signal }) => {
  const id = url.pathname.match(/\/pin\/(?:[\w-]*--)?(\d{6,})/)?.[1];
  if (!id) throw bad();
  const d = await fetchJson(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${id}`, { signal });
  const pin = d?.data?.[0];
  if (!pin) throw new ResolveError(L('errNotFound'));
  const base = `pinterest_${id}`;
  const largest = (images) => Object.values(images || {}).filter((x) => x?.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
  const photo = (images, name) => {
    const big = largest(images);
    if (!big) return null;
    const orig = big.replace(/\/\d+x(\d+)?\//, '/originals/');
    return { type: 'photo', kind: 'file', url: orig, thumb: big, name, fallbacks: orig !== big ? [{ kind: 'file', url: big }] : [] };
  };
  const video = (list, name, thumb) => {
    const all = Object.values(list || {}).filter((x) => x?.url);
    const mp4 = all.filter((x) => /\.mp4(\?|$)/.test(x.url)).sort((a, b) => (b.width || 0) - (a.width || 0));
    const hls = all.find((x) => /\.m3u8(\?|$)/.test(x.url));
    if (mp4.length) {
      const variants = mp4.map((x) => ({ url: x.url, kind: 'file', ext: 'mp4', p: shortSide(x.width, x.height), label: `${shortSide(x.width, x.height)}p` }));
      return { type: 'video', kind: 'file', url: mp4[0].url, ext: 'mp4', name, thumb, variants: variants.length > 1 ? variants : undefined, fallbacks: hls ? [{ kind: 'hls', url: hls.url }] : [] };
    }
    return hls ? { type: 'video', kind: 'hls', url: hls.url, name, thumb } : null;
  };
  const thumb = largest(pin.images);
  const items = [];
  const main = video(pin.videos?.video_list, base, thumb);
  if (main) items.push(main);
  for (const page of pin.story_pin_data?.pages || []) {
    for (const b of page.blocks || []) {
      const name = `${base}_${items.length + 1}`;
      const it = (b.video && video(b.video.video_list, name, thumb)) || (b.image && photo(b.image.images, name));
      if (it) items.push(it);
    }
  }
  if (!items.length) { const p = photo(pin.images, base); if (p) items.push(p); }
  if (!items.length) throw none();
  return { title: (pin.title || pin.grid_title || pin.description || base).trim().slice(0, 120), items };
};

R.misskey = async ({ url, signal }) => {
  const id = url.pathname.match(/^\/notes\/([a-z0-9]+)/i)?.[1];
  if (!id) throw bad();
  const n = await fetchJson(`${url.origin}/api/notes/show`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId: id }), signal,
  });
  const note = n.files?.length ? n : (n.renote || n);
  const files = note.files || [];
  const user = note.user?.username || 'note';
  const items = files.map((f, i) => ({
    type: /^image\/gif/.test(f.type) ? 'gif' : /^image\//.test(f.type) ? 'photo' : /^audio\//.test(f.type) ? 'audio' : 'video',
    kind: 'file', url: f.url, thumb: f.thumbnailUrl, ext: extFromMime(f.type), label: f.comment?.slice(0, 60),
    name: files.length > 1 ? `${user}_${id}_${i + 1}` : `${user}_${id}`,
  })).filter((x) => x.url);
  return { title: (note.text || `${user}_${id}`).slice(0, 120), author: user, items };
};

R.lemmy = async ({ url, signal }) => {
  const id = url.pathname.match(/^\/post\/(\d+)/)?.[1];
  if (!id) throw bad();
  const d = await fetchJson(`${url.origin}/api/v3/post?id=${id}`, { signal });
  const p = d.post_view?.post;
  if (!p) throw new ResolveError(L('errNotFound'));
  const title = p.name || `lemmy_${id}`;
  const media = p.embed_video_url || (p.url && isMediaUrl(p.url) ? p.url : null);
  if (media) {
    const ext = extFromUrl(media);
    return { title, items: [{ type: ext === 'm3u8' ? 'video' : (typeFromExt(ext) || 'video'), kind: ext === 'm3u8' ? 'hls' : 'file', url: media, name: title, thumb: p.thumbnail_url }] };
  }
  if (p.url && /\/pictrs\//.test(p.url)) return { title, items: [{ type: 'photo', kind: 'file', url: p.url, thumb: p.thumbnail_url, name: title }] };
  if (p.url) return { redirect: p.url };
  throw none();
};

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const NO_DIRECT_SHORTCUT = new Set(['dropbox', 'gdrive', 'archive', 'imgur']);

/** Without ffmpeg, a separate audio track becomes its own downloadable item. */
function splitAudio(res, settings) {
  if (canMerge(settings) || !res.items.some((i) => i.audio)) return res;
  const items = [];
  for (const it of res.items) {
    if (!it.audio) { items.push(it); continue; }
    const { audio, ...video } = it;
    items.push({ ...video, label: L('noAudio') });
    items.push({ type: 'audio', kind: audio.kind, url: audio.url, ext: audio.ext || 'm4a', fallbacks: audio.fallbacks, name: `${it.name || 'media'}_audio`, thumb: it.thumb });
  }
  return { ...res, items, note: res.note || L('redditSplit') };
}

/**
 * Resolve a URL into media items.
 * options.only: run just this resolver; options.skip: resolvers to leave out (used for retries).
 */
export async function resolve(raw, { settings, signal, onStatus, depth = 0, only = null, skip = [], noGeneric = false, cobaltExclude = [] }) {
  let url;
  try {
    url = new URL(String(raw).trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new ResolveError(L('errNoUrl'), { fatal: true });
  }
  const platform = detectPlatform(url);
  if (platform.drm) throw new ResolveError(L('errDrm', { name: platform.name }), { fatal: true, platform });

  let chain = [...platform.resolvers];
  if (isMediaUrl(url.href) && !NO_DIRECT_SHORTCUT.has(platform.id)) chain.unshift('direct');
  // Your own server (getvid-server / cobalt) also gets every link the browser can't handle itself.
  if (!chain.includes('cobalt') && ownCobaltInstances(settings).length) chain.push('cobalt');
  if (!noGeneric) chain.push('generic');
  chain = only ? [only] : [...new Set(chain)].filter((n) => !skip.includes(n));

  const cobaltLeft = () => cobaltInstances(settings, platform.id).filter((i) => !cobaltExclude.includes(i.url)).length;
  const hasCobalt = cobaltLeft() > 0;
  const attempts = [];
  for (const name of chain) {
    if (name === 'cobalt' && !hasCobalt) { attempts.push({ via: LABELS.cobalt, error: L('errNoCobalt'), skipped: true }); continue; }
    onStatus?.(L('statusTrying', { via: LABELS[name] }), { platform });
    try {
      let res = await R[name]({ url, raw, settings, signal, platform, cobaltExclude });
      if (res.redirect && depth < 3 && res.redirect !== url.href) return await resolve(res.redirect, { settings, signal, onStatus, depth: depth + 1 });
      if (res.items?.length) {
        res = splitAudio(res, settings);
        // If this single file later fails to download, the rest of the chain gets a turn.
        const at = chain.indexOf(name);
        const rest = chain.slice(at + 1).filter((n) => n !== 'generic' && (n !== 'cobalt' || hasCobalt));
        if (res.items.length === 1) {
          const it = res.items[0];
          if (name === 'cobalt') {
            // Next try: the other cobalt servers, then whatever followed cobalt in the chain.
            const excl = [...cobaltExclude, it.cobaltInst];
            const more = cobaltInstances(settings, platform.id).some((i) => !excl.includes(i.url));
            if (more || rest.length) it.retry = { url: url.href, skip: [...skip, ...chain.slice(0, at)], cobaltExclude: excl };
          } else if (rest.length) {
            it.retry = { url: url.href, skip: [...skip, ...chain.slice(0, at + 1)], cobaltExclude };
          }
        }
        return { ...res, platform, via: LABELS[name], sourceUrl: url.href };
      }
      attempts.push({ via: LABELS[name], error: L('errNoMedia') });
    } catch (e) {
      if (isUserAbort(e)) throw e;
      attempts.push({ via: LABELS[name], error: e?.l || e?.message || String(e) });
      if (e?.fatal) break;
    }
  }
  // Platforms that only cobalt can handle: point to the settings (own server / public pool).
  const cobaltPlatform = platform.resolvers.includes('cobalt') && !ownCobaltInstances(settings).length;
  const usedPublic = cobaltPlatform && settings.publicCobalt !== false;
  const msg = !cobaltPlatform ? L('errAllFailed') : usedPublic ? L('errPublicFailed') : L('errNeedCobalt', { name: platform.name });
  throw new ResolveError(msg, { attempts, needsCobalt: cobaltPlatform, platform });
}
