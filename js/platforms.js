// Platform catalogue. `resolvers` is the ordered chain tried for that platform;
// "cobalt" is skipped automatically when no cobalt server is configured, and
// the generic page scanner is always the last resort (except for DRM services).
import { isMediaUrl, extFromUrl } from './util.js';

const P = (id, name, color, hosts, resolvers, extra = {}) => ({ id, name, color, hosts, resolvers, ...extra });

export const PLATFORMS = [
  P('youtube', 'YouTube', '#ff0033', ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], ['cobalt', 'piped', 'invidious']),
  P('tiktok', 'TikTok', '#25f4ee', ['tiktok.com'], ['tikwm', 'cobalt']),
  P('instagram', 'Instagram', '#e1306c', ['instagram.com', 'instagr.am', 'ddinstagram.com'], ['cobalt']),
  P('facebook', 'Facebook', '#1877f2', ['facebook.com', 'fb.watch', 'fb.com'], ['cobalt']),
  P('twitter', 'X / Twitter', '#a3a3a3', ['x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com', 'twittpr.com', 'nitter.net', 'xcancel.com'], ['fxtwitter', 'vxtwitter', 'cobalt']),
  P('reddit', 'Reddit', '#ff4500', ['reddit.com', 'redd.it', 'redditmedia.com'], ['cobalt', 'reddit']),
  P('bluesky', 'Bluesky', '#1185fe', ['bsky.app', 'bskx.app', 'fxbsky.app', 'vxbsky.app'], ['bluesky', 'cobalt']),
  P('threads', 'Threads', '#a3a3a3', ['threads.net', 'threads.com'], ['generic']),
  P('vimeo', 'Vimeo', '#1ab7ea', ['vimeo.com'], ['cobalt', 'vimeo']),
  P('dailymotion', 'Dailymotion', '#0a6cff', ['dailymotion.com', 'dai.ly'], ['cobalt']),
  P('twitch', 'Twitch', '#9146ff', ['twitch.tv'], ['cobalt']),
  P('streamable', 'Streamable', '#0f90fa', ['streamable.com'], ['streamable', 'cobalt']),
  P('soundcloud', 'SoundCloud', '#ff5500', ['soundcloud.com', 'snd.sc'], ['cobalt']),
  P('pinterest', 'Pinterest', '#e60023', ['pin.it'], ['cobalt'], { hostRe: /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/i }),
  P('tumblr', 'Tumblr', '#5a6f8f', ['tumblr.com'], ['cobalt']),
  P('snapchat', 'Snapchat', '#f7e600', ['snapchat.com'], ['cobalt']),
  P('bilibili', 'Bilibili', '#00a1d6', ['bilibili.com', 'bilibili.tv', 'b23.tv'], ['cobalt']),
  P('loom', 'Loom', '#625df5', ['loom.com'], ['cobalt']),
  P('newgrounds', 'Newgrounds', '#fda238', ['newgrounds.com'], ['cobalt']),
  P('ok', 'OK.ru', '#ee8208', ['ok.ru'], ['cobalt']),
  P('vk', 'VK Video', '#0077ff', ['vk.com', 'vk.ru', 'vkvideo.ru'], ['cobalt']),
  P('rutube', 'Rutube', '#00a3ff', ['rutube.ru'], ['cobalt']),
  P('medal', 'Medal', '#f5c518', ['medal.tv'], ['cobalt']),
  P('xiaohongshu', 'Xiaohongshu', '#ff2442', ['xiaohongshu.com', 'xhslink.com'], ['cobalt']),
  P('mastodon', 'Mastodon / Fediverse', '#6364ff', ['mastodon.social', 'mastodon.online', 'mstdn.social', 'mas.to', 'fosstodon.org', 'pixelfed.social', 'infosec.exchange', 'hachyderm.io'], ['mastodon'], {
    pathRe: /^\/(?:@[^/]+\/\d{5,}|users\/[^/]+\/statuses\/\d{5,}|p\/[^/]+\/\d{5,})\/?$/,
  }),
  P('peertube', 'PeerTube', '#f1680d', ['framatube.org', 'tilvids.com', 'peertube.tv'], ['peertube'], {
    pathRe: /^\/(?:w\/(?:p\/)?[A-Za-z0-9]{20,24}|videos\/(?:watch|embed)\/(?:playlist\/)?[0-9a-f-]{36})\/?$/,
  }),
  P('archive', 'Internet Archive', '#9aa0a6', ['archive.org'], ['archive']),
  P('giphy', 'Giphy', '#00e68a', ['giphy.com'], ['giphy']),
  P('imgur', 'Imgur', '#1bb76e', ['imgur.com'], ['imgur']),
  P('ninegag', '9GAG', '#a3a3a3', ['9gag.com'], ['ninegag']),
  P('dropbox', 'Dropbox', '#0061ff', ['dropbox.com'], ['dropbox']),
  P('gdrive', 'Google Drive', '#1fa463', ['drive.google.com', 'drive.usercontent.google.com'], ['gdrive']),
  P('telegram', 'Telegram', '#26a5e4', ['t.me', 'telegram.me'], ['telegram']),
  P('kick', 'Kick', '#53fc18', ['kick.com'], ['generic']),
  P('rumble', 'Rumble', '#85c742', ['rumble.com'], ['generic']),
  P('linkedin', 'LinkedIn', '#0a66c2', ['linkedin.com'], ['generic']),
  P('odysee', 'Odysee', '#ef1970', ['odysee.com'], ['generic']),
  P('kwai', 'Kwai', '#ff7b00', ['kwai.com', 'kw.ai'], ['generic']),
  P('coub', 'Coub', '#0332ff', ['coub.com'], ['generic']),
];

// Services with DRM — we refuse up front instead of failing slowly.
const DRM = [
  ['Netflix', 'netflix.com'], ['Prime Video', 'primevideo.com'], ['Disney+', 'disneyplus.com'],
  ['Max', 'max.com'], ['HBO Max', 'hbomax.com'], ['Hulu', 'hulu.com'], ['Spotify', 'spotify.com'],
  ['Apple TV+', 'tv.apple.com'], ['Apple Music', 'music.apple.com'], ['Paramount+', 'paramountplus.com'],
  ['Globoplay', 'globoplay.globo.com'], ['Crunchyroll', 'crunchyroll.com'], ['Deezer', 'deezer.com'],
  ['Tidal', 'tidal.com'], ['Star+', 'starplus.com'],
].map(([name, host]) => P('drm', name, '#888', [host], [], { drm: true }));

export const DIRECT = P('direct', 'Direct file', '#22c55e', [], ['direct']);
export const HLS = P('hls', 'HLS stream (.m3u8)', '#22c55e', [], ['hls']);
export const GENERIC = P('generic', 'Website', '#94a3b8', [], ['generic']);

const hostMatches = (host, h) => host === h || host.endsWith('.' + h);

export function detectPlatform(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const d of DRM) if (d.hosts.some((h) => hostMatches(host, h))) return d;
  for (const p of PLATFORMS) {
    if (p.hosts.some((h) => hostMatches(host, h)) || (p.hostRe && p.hostRe.test(host))) return p;
  }
  // Federated software lives on any domain: recognise it by URL shape.
  for (const p of PLATFORMS) if (p.pathRe && p.pathRe.test(url.pathname)) return p;
  if (extFromUrl(url.href) === 'm3u8') return HLS;
  if (isMediaUrl(url.href)) return DIRECT;
  return GENERIC;
}

/** How a platform is served — used for the legend on the platform chips. */
export function platformKind(p) {
  // Piped/Invidious/Vimeo depend on flaky public services, so they don't count as "native".
  const weak = new Set(['cobalt', 'generic', 'telegram', 'piped', 'invidious', 'vimeo']);
  const native = p.resolvers.filter((r) => !weak.has(r));
  if (native.length) return 'native';
  if (p.resolvers.includes('cobalt')) return 'cobalt';
  return 'scan';
}
