# getvid — paste a link, the video downloads itself

A **frontend-only** video downloader (plain HTML/CSS/JS, no build step, no backend of its own).
Paste a link (or several) and the page works out the platform and finds the media:

- **one video** → it downloads right away;
- **several videos/photos** (carousels, threads, galleries, playlists, pages with many players) → a picker opens so you choose **one or more**, then download them one by one or **as a single ZIP**.

> 🇧🇷 *Cole o link e o vídeo baixa sozinho. Se o post tiver vários vídeos/fotos, você escolhe quais quer (um, vários ou todos, inclusive em ZIP). A interface fica em português ou inglês automaticamente.*

## Run it

ES modules need to be served over HTTP (not `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Deploy anywhere static: **GitHub Pages** (Settings → Pages → deploy from branch, root folder), Netlify, Vercel, or Cloudflare Pages. A `.nojekyll` file is included.

## How each platform is handled

Each link goes through a chain of resolvers. The first one that works wins. If none works, the card lists every attempt and why it failed.

| Platform | How | Works with no setup? |
|---|---|---|
| **X / Twitter** (x.com, twitter.com, fxtwitter…) | FxTwitter API → vxTwitter → cobalt | ✅ videos, GIFs, photos, multi-media posts |
| **TikTok** (incl. vm./vt. short links) | TikWM API → cobalt | ✅ HD/SD/watermark, photo slideshows + audio |
| **Bluesky** | public AppView + author's PDS (original files) → cobalt | ✅ videos, image sets, quote posts |
| **Mastodon / Pixelfed** (any instance) | instance API | ✅ |
| **PeerTube** (any instance) | instance API (videos and playlists) | ✅ |
| **Internet Archive** | metadata API (groups formats, picks MP4) | ✅ |
| **Giphy, Imgur, 9GAG, Dropbox, Google Drive** | URL rewriting to the real file | ✅ (some CDNs need "Open file") |
| **Streamable** | public API → cobalt | ✅ when CORS allows it, else "Open file" or cobalt |
| **Reddit** | cobalt → public JSON (video + audio as separate files) | ⚠️ partial |
| **Direct files** (`.mp4 .webm .mov .mp3 .jpg…`) | fetched directly | ✅ |
| **HLS streams** (`.m3u8`) | built-in downloader: picks quality, AES-128, fMP4 | ✅ |
| **YouTube** (videos, Shorts, playlists) | cobalt → Piped → Invidious | 🔧 needs cobalt (public Piped/Invidious are mostly blocked by YouTube) |
| **Instagram, Facebook, Vimeo, Dailymotion, Twitch clips, SoundCloud, Pinterest, Tumblr, Snapchat, Bilibili, Loom, Newgrounds, OK.ru, VK, Rutube, Medal, Xiaohongshu** | cobalt | 🔧 needs cobalt |
| **Threads, Telegram, Kick, Rumble, LinkedIn, Odysee, Kwai, Coub, any other site** | page scan (og:video, `<video>`, JSON-LD, raw `.mp4/.m3u8` URLs, embedded YouTube/Vimeo… players) | 🔧 usually needs the CORS proxy |
| Netflix, Prime Video, Disney+, Spotify… | refused (DRM) | ❌ |

### Why some platforms need a server

A web page can only read another site if that site allows it (CORS). Instagram, YouTube, Facebook and others don't, and their media is often split into separate audio and video tracks. A page alone can't get past that. That's why there are two optional, self-hosted helpers in [`self-host/`](self-host/):

1. **cobalt** ([imputnet/cobalt](https://github.com/imputnet/cobalt), open source). Run it with [`self-host/docker-compose.yml`](self-host/docker-compose.yml), then paste its URL (optionally `URL | API_KEY`) in **⚙ Settings → cobalt servers**. This unlocks every 🔧 platform above and returns finished, merged files. Public cobalt instances require their own Turnstile captcha, so they can't be called from other sites.
2. **CORS proxy**: a ~40-line Cloudflare Worker, [`self-host/cors-proxy-worker.js`](self-host/cors-proxy-worker.js), restricted to your own site's origin. Set it as `https://<worker>.workers.dev/?url={url}` in settings. It's used for page scanning and for CDNs that block the browser.

When a single file was found natively but its CDN blocks the browser (e.g. Streamable), getvid automatically retries through cobalt if you configured one. Without cobalt, it shows an **Open file** button so you can save it from the new tab.

## Features

- Auto-start on paste (anywhere on the page), on Enter, on drag-and-drop of a link, or on the **Paste** button
- Several links at once (one per line, or any text containing links). They are processed 3 at a time
- Picker for multi-media posts and playlists: select all/none, thumbnails, durations, download selected, or **ZIP**
- Quality (best → 240p), mode (video / audio only / muted), audio format for cobalt
- Per-item quality buttons and "audio only" extras on each result card
- Bookmarklet (footer) and mobile **share target** (`?url=` / `?text=`), so you can share from the TikTok/X app straight to the installed site
- Portuguese/English UI, light/dark theme, mobile layout
- Settings are stored in `localStorage` only. No analytics, no accounts

## Files

```
index.html            page + dialogs
css/style.css         styles (light/dark)
js/app.js             UI: jobs, picker, settings, paste/drop handling
js/resolvers.js       per-platform resolvers + resolution engine
js/platforms.js       platform catalogue / URL detection
js/download.js        fetch with progress, fallbacks, CORS proxy, cobalt retry
js/m3u8.js            HLS playlist parser + segment downloader (AES-128, fMP4)
js/zip.js             store-only ZIP writer
js/util.js, i18n.js, settings.js
self-host/            cobalt docker-compose + CORS proxy worker
```

## Limitations

- The free third-party APIs (FxTwitter, TikWM, Bluesky, Piped…) can change, rate-limit or go offline. Your own cobalt server is the most reliable option.
- Files are assembled in memory before saving, so very large videos (several GB) can hit browser memory limits.
- MPEG-TS HLS streams are saved as `.ts`; VLC/most players open them, or remux with `ffmpeg -i in.ts -c copy out.mp4`.
- DRM-protected services cannot be downloaded.

Only download content you have the right to download, and respect each platform's terms of service.
