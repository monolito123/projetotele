# getvid: paste a link, the video downloads itself

**Live site:** https://monolito123.github.io/projetotele/

A **frontend-only** video downloader: plain HTML/CSS/JS, no build step and no backend of its own.
Paste a link (or several). The page works out the platform and finds the media:

- **one video**: it downloads right away;
- **several videos/photos** (carousels, threads, galleries, playlists, pages with many players): a picker opens so you choose **one or more**, then download them one by one or **as a single ZIP**.

> 🇧🇷 *Cole o link e o vídeo baixa sozinho. Se o post tiver vários vídeos/fotos, você escolhe quais quer (um, vários ou todos, inclusive em ZIP). A interface está em 14 idiomas e troca na hora.*

## Languages

The interface is fully translated into **14 languages**, and switching is **instant**. No reload is needed, and cards already on screen re-render too:

English · Português · Español · Français · Deutsch · Italiano · Русский · Türkçe · العربية (right-to-left) · हिन्दी · Bahasa Indonesia · 日本語 · 한국어 · 中文

The browser language is detected automatically. Browsers with an **on-device translator** (Chrome's built-in Translator API) also get:

- **25 more interface languages** (Polski, Nederlands, Українська, Tiếng Việt, ไทย, فارسی, עברית, Svenska…). They are machine-translated on the device and cached; placeholders and brand names are protected.
- **Instant translation of post titles** into your language, with a 🌐 *Translate / Original* toggle on each card. Nothing is sent to any server.

Translations live in [`js/locales/`](js/locales/). To add a language, copy `en.js`, translate the values and add it to `LANGS` in [`js/i18n.js`](js/i18n.js).

## Download compatibility

| Problem | What getvid does |
|---|---|
| Audio and video stored separately (Reddit, high-quality YouTube, HLS with a separate audio track, cobalt "local processing") | Merges them **in the browser** with ffmpeg.wasm into one MP4/WebM |
| HLS streams in MPEG-TS | Remuxed to **MP4**, so they play on phones and in galleries |
| "Audio only" for a source with no separate audio (X, Bluesky, TikTok…) | Extracts the audio to **MP3** (or M4A/OGG/Opus/WAV) |
| "Muted" | Strips the audio track |
| Connection drops mid-download | **Resumes** with HTTP Range; stalled transfers time out and retry |
| Server says `application/octet-stream`, or the URL has no extension | Detects the real type from the file's bytes |
| Chosen quality fails | Tries the other qualities, then the item's fallbacks, then **another source** (e.g. vxTwitter after FxTwitter, or your cobalt server) |
| The site blocks pages from saving its files (CORS) | Built-in **player** to save it from (⋮ → Download), plus "open in new tab" |
| Phones | **Save to gallery / Share** button (Web Share API) after each download |
| CDNs that reject foreign `Referer`s (e.g. X/Twitter) | All requests are sent without a referrer |

The converter (≈31 MB, ffmpeg core from jsDelivr with unpkg as a fallback) only downloads the first time it's needed and is then cached. It can be turned off in ⚙ Settings, and then separate tracks are offered as two files.

## How each platform is handled

Each link goes through a chain of resolvers. The first one that works wins. If none works, the card lists every attempt and why it failed.

| Platform | How | Works with no setup? |
|---|---|---|
| **X / Twitter** | FxTwitter API → vxTwitter → cobalt | ✅ videos, GIFs, photos, multi-media posts |
| **TikTok** (incl. vm./vt. links) | TikWM API → cobalt | ✅ HD/SD/watermark, photo slideshows + audio |
| **Bluesky** | public AppView + author's PDS (original files) → cobalt | ✅ videos, image sets, quote posts |
| **Mastodon / Pixelfed**, **Misskey / Sharkey**, **Lemmy** (any instance) | instance APIs | ✅ |
| **PeerTube** (any instance) | instance API (videos and playlists) | ✅ |
| **Odysee** | LBRY API + Odysee CDN | ✅ |
| **Pinterest** | widget API → cobalt | ✅ images; videos where the CDN allows it |
| **Internet Archive** | metadata API (groups formats, picks MP4) | ✅ |
| **Giphy, Imgur, 9GAG, Dropbox, Google Drive** | URL rewriting to the real file | ✅ (some need the player) |
| **Streamable** | public API → cobalt | ✅ via player, or cobalt |
| **Reddit** | cobalt → public JSON + ffmpeg merge | ⚠️ the public JSON is blocked on some networks |
| **Direct files** (`.mp4 .webm .mov .mp3 .jpg…`) | fetched directly | ✅ |
| **HLS streams** (`.m3u8`) | built-in downloader: quality, AES-128, fMP4, separate audio | ✅ |
| **YouTube** (videos, Shorts, playlists) | cobalt (free public servers, or yours) → Piped → Invidious → loader.to button | ✅ automatic for most videos; the rest through the loader.to button (one tap, ads) |
| **Instagram** (Reels, videos, photos, carousels) | cobalt (free public servers, or yours) → Instagram player (eeinstagram/uuinstagram) | ✅ posts and carousels download directly; Reels the servers only return as a cover open in the built-in player to save |
| **Facebook, Vimeo, Dailymotion, Twitch clips, SoundCloud, Tumblr, Snapchat, Bilibili, Loom, Newgrounds, OK.ru, VK, Rutube, Medal, Xiaohongshu** | cobalt (free public servers, or yours) | ⚠️ best-effort on the public servers; reliable with your own |
| **Threads, Telegram, Kick, Rumble, LinkedIn, Kwai, Coub, any other site** | page scan (og:video, `<video>`, JSON-LD, raw media URLs, embedded players) | 🔧 usually needs the CORS proxy |
| Netflix, Prime Video, Disney+, Spotify… | refused (DRM) | ❌ |

### Free public servers (no setup)

Out of the box, platforms that need a server (YouTube, Instagram, Facebook…) go through a small pool of **free community-run cobalt servers** that accept requests from any website. They're listed in `PUBLIC_COBALT` in [`js/settings.js`](js/settings.js) and can be switched off in ⚙ Settings. If one server fails (busy, blocked, or sends an empty file), the next one is tried automatically. These servers are run by volunteers. They can be slow, change, or be blocked by a platform for a given video. Your own server (below) is the reliable option.

### When the free servers can't get a YouTube video: loader.to

For YouTube videos the free servers can't fetch (e.g. region-locked music videos), the result card shows the **official embeddable button of [loader.to](https://loader.to/api/)**, an ad-supported download service that offers this embed API to other websites. It's preset to the chosen quality or audio format. The user taps it, waits a few seconds, and taps "Download Now!". loader.to may open one ad tab. It can be turned off in ⚙ Settings. Nothing is sent to loader.to unless that card appears.

### Your own server: getvid-server (yt-dlp)

[`server/`](server/) contains the same kind of backend that download sites use: a single Python file built on **yt-dlp** (1000+ sites). It speaks the cobalt API, so the site uses it as-is, and it's tried before the public pool. Links the browser can't handle (Rumble, Kick, Twitch VODs, Bandcamp…) are sent to it too. Run it on a computer or Android phone at home (residential connections are rarely blocked by YouTube), then paste the address it prints into ⚙ Settings. `--tunnel` gives a free https:// address through Cloudflare. The step-by-step guide (in Portuguese) is in [`server/README.md`](server/README.md).

### Why some platforms need a server

A web page can only read another site if that site allows it (CORS). Instagram, YouTube, Facebook and others don't. That's why there are two optional, self-hosted helpers in [`self-host/`](self-host/):

1. **cobalt** ([imputnet/cobalt](https://github.com/imputnet/cobalt), open source). Run it with [`self-host/docker-compose.yml`](self-host/docker-compose.yml), then paste its URL (optionally `URL | API_KEY`) in **⚙ Settings → cobalt servers**. Your servers are always tried before the public pool. (Most public instances, including the official one, require their own captcha and can't be called from other sites. The pool only lists those that don't.)
2. **CORS proxy**: a ~40-line Cloudflare Worker, [`self-host/cors-proxy-worker.js`](self-host/cors-proxy-worker.js), restricted to your own site's origin. It's used for page scanning and for CDNs that block the browser.

## Publishing

The site is plain static files served by **GitHub Pages** from the `gh-pages` branch. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) copies the site files to `gh-pages` on every push to `main` (or the working branch), so the live site updates by itself about a minute after each push. It can also be re-run by hand from the *Actions* tab.

It also works on Netlify, Vercel or Cloudflare Pages (drag and drop the folder). To run it locally, ES modules need HTTP rather than `file://`:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Features

- Auto-start on paste (anywhere on the page), on Enter, on drag-and-drop of a link, or on the **Paste** button
- Several links at once (one per line, or any text containing links), processed 3 at a time
- Picker for multi-media posts and playlists: select all/none, thumbnails, durations, download selected, or **ZIP**
- Quality (best → 240p), mode (video / audio only / muted), audio format
- Per-item quality buttons and "audio only" extras on each result card
- Bookmarklet (footer) and mobile **share target** (`?url=` / `?text=`), so you can share from the TikTok/X app straight to the installed site
- 14 languages + on-device machine translation, light/dark theme, mobile layout, right-to-left support
- Settings are stored in `localStorage` only. No analytics, no accounts

## Files

```
index.html               page + dialogs (picker, player, settings)
css/style.css            styles (light/dark, RTL-aware)
js/app.js                UI: jobs, picker, player, settings, instant re-rendering on language change
js/i18n.js               languages, instant switching, on-device machine translation
js/locales/*.js          14 hand-written translations
js/resolvers.js          per-platform resolvers + resolution engine (fallback chain, retries)
js/platforms.js          platform catalogue / URL detection
js/download.js           fallbacks, proxy, alternate-source retry, ffmpeg post-processing
js/ffmpeg.js             on-demand ffmpeg.wasm: merge, remux, extract audio, mute
js/m3u8.js               HLS playlist parser + segment downloader (AES-128, fMP4)
js/util.js               resumable fetch, file sniffing, helpers
js/zip.js                store-only ZIP writer
vendor/ffmpeg/           @ffmpeg/ffmpeg 0.12.15 (MIT), unmodified
server/                  getvid-server: yt-dlp backend (Python, Docker, Cloudflare quick tunnel)
self-host/               cobalt docker-compose + CORS proxy worker
.github/workflows/       GitHub Pages publishing
```

## Limitations

- The free third-party APIs (FxTwitter, TikWM, Bluesky, Piped…) can change, rate-limit or go offline. Your own cobalt server is the most reliable option.
- Files are assembled in memory, and ffmpeg.wasm works on files up to roughly 1–2 GB. Very large videos may need to be downloaded without conversion (turn the converter off).
- DRM-protected services cannot be downloaded.
- Machine-translated languages and title translation need a browser that ships the on-device Translator API (desktop Chrome at the time of writing). Elsewhere, the 14 hand-written languages are offered.

Only download content you have the right to download, and respect each platform's terms of service.
