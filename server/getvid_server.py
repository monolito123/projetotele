#!/usr/bin/env python3
"""
getvid server — the "backend" that download sites have, built on yt-dlp.

It speaks the same small API as cobalt, so the getvid site uses it as-is:
paste its address in ⚙ Settings → cobalt servers.

  POST /            {"url": "...", "videoQuality": "1080", "downloadMode": "auto|audio|mute"}
                    → {"status": "tunnel" | "picker" | "local-processing" | "error", ...}
  GET  /tunnel?id=  → the media bytes (proxied, with CORS, Range and a download filename)
  GET  /            → server info

Media links from YouTube & co. only work from the IP that asked for them and
have no CORS, so the server streams the bytes through itself. When a site only
has separate video and audio tracks, the server hands both to the browser
("local-processing"), and the getvid page merges them with ffmpeg.wasm — so
ffmpeg is NOT required on the server.

Run:   pip install -U "yt-dlp[default]"   &&   python getvid_server.py --tunnel
       (--tunnel starts a free Cloudflare quick tunnel if `cloudflared` is installed and
        prints the https:// address to paste in the site)
Env:   PORT (9100) · HOST (0.0.0.0) · API_KEY (optional) · ALLOWED_ORIGINS (comma list, or *)
       TUNNEL=1 (same as --tunnel) · TRUST_PROXY=1 (behind Caddy/nginx) · RATE_LIMIT (30/300)
       MAX_STREAMS (6) · YTDLP_COOKIES (path to a cookies.txt, optional)
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    sys.exit('yt-dlp is not installed. Run:  pip install -U yt-dlp')

VERSION = '1.0'
PORT = int(os.environ.get('PORT', '9100'))
HOST = os.environ.get('HOST', '0.0.0.0')
API_KEY = os.environ.get('API_KEY', '').strip()
ALLOWED_ORIGINS = [o.strip().rstrip('/') for o in os.environ.get(
    'ALLOWED_ORIGINS',
    'https://monolito123.github.io,http://localhost:8000,http://127.0.0.1:8000,http://localhost:8765,http://127.0.0.1:8765',
).split(',') if o.strip()]
TRUST_PROXY = os.environ.get('TRUST_PROXY') == '1'  # behind Caddy/nginx: client IP from X-Forwarded-For
# Requests per IP: "20/300" = 20 link lookups every 300 s (downloads themselves aren't counted).
_rl = os.environ.get('RATE_LIMIT', '30/300').split('/')
RATE_MAX, RATE_WINDOW = int(_rl[0]), int(_rl[1] if len(_rl) > 1 else 300)
MAX_STREAMS = int(os.environ.get('MAX_STREAMS', '6'))  # simultaneous downloads (protects small VMs)
COOKIES = os.environ.get('YTDLP_COOKIES', '').strip()  # optional Netscape cookies file for sites that demand login
TUNNEL_TTL = 60 * 60  # seconds a download link stays valid
CHUNK = 10 * 1024 * 1024  # upstream range size (avoids per-connection throttling)
HAS_FFMPEG = shutil.which('ffmpeg') is not None

TUNNELS = {}
LOCK = threading.Lock()
HITS = {}
STREAMS = threading.BoundedSemaphore(MAX_STREAMS)


def rate_ok(ip):
    now = time.time()
    with LOCK:
        recent = [t for t in HITS.get(ip, []) if now - t < RATE_WINDOW]
        if len(recent) >= RATE_MAX:
            HITS[ip] = recent
            return False
        recent.append(now)
        HITS[ip] = recent
        return True


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ---------------------------------------------------------------- helpers

def safe_name(s, fallback='video'):
    s = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*#]+', ' ', str(s or ''))
    # Keep letters, digits, punctuation and spaces: browsers rename files with odd symbols to "download".
    s = ''.join(ch if (ch.isalnum() or ch in " .,;!'()[]{}&+-_=@%~^$") else ' ' for ch in s).strip()
    s = re.sub(r'\s+', ' ', s)[:120].rstrip('. ')
    return s or fallback


def short_side(f):
    w, h = f.get('width') or 0, f.get('height') or 0
    return min(w, h) if w and h else (h or w or 0)


def is_direct(f):
    return bool(f.get('url')) and (f.get('protocol') or 'https') in ('https', 'http')


def has_video(f):
    v = f.get('vcodec')
    if v == 'none':
        return False
    if v:
        return True
    # Unknown codecs (generic extractor, plain .mp4 links): video unless it clearly looks like audio.
    return bool(f.get('height')) or f.get('acodec') in (None, '')


def has_audio(f):
    return f.get('acodec') != 'none'


def add_tunnel(**data):
    tid = secrets.token_urlsafe(16)
    data['exp'] = time.time() + TUNNEL_TTL
    with LOCK:
        TUNNELS[tid] = data
    return tid


def cleanup_loop():
    while True:
        time.sleep(300)
        now = time.time()
        with LOCK:
            for k in [k for k, v in TUNNELS.items() if v['exp'] < now]:
                TUNNELS.pop(k, None)
            for ip in [ip for ip, ts in HITS.items() if not ts or now - ts[-1] > RATE_WINDOW]:
                HITS.pop(ip, None)


def ydl_opts(extra=None):
    o = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True, 'socket_timeout': 20}
    if COOKIES and os.path.isfile(COOKIES):
        o['cookiefile'] = COOKIES
    if extra:
        o.update(extra)
    return o


# ---------------------------------------------------------------- choosing formats

def pick(fmts, target, prefer_ext):
    """Best format whose short side ≤ target (or the smallest one if none fits)."""
    if not fmts:
        return None
    def key(f):
        return (short_side(f), f.get('ext') == prefer_ext, (f.get('vcodec') or '').startswith(('avc1', 'h264')), f.get('tbr') or 0)
    fits = [f for f in fmts if not target or short_side(f) <= target or not short_side(f)]
    pool = fits or sorted(fmts, key=short_side)[:1]
    return max(pool, key=key)


def best_audio(fmts, prefer_ext='m4a'):
    a = [f for f in fmts if not has_video(f) and has_audio(f)]
    return max(a, key=lambda f: (f.get('ext') == prefer_ext, f.get('abr') or f.get('tbr') or 0)) if a else None


def tunnel_for(base, info, f, name):
    tid = add_tunnel(kind='url', url=f['url'], headers=dict(f.get('http_headers') or info.get('http_headers') or {}),
                     filename=name, size=f.get('filesize') or f.get('filesize_approx'), ext=f.get('ext'))
    return f'{base}tunnel?id={tid}'


def stream_tunnel(base, link, fmt, name):
    tid = add_tunnel(kind='ytdlp', link=link, format=fmt, filename=name)
    return f'{base}tunnel?id={tid}'


def resolve(body, base):
    link = str(body.get('url') or '').strip()
    if not re.match(r'^https?://', link):
        return {'status': 'error', 'error': {'code': 'error.api.link.invalid'}}
    mode = body.get('downloadMode') or 'auto'
    q = str(body.get('videoQuality') or '1080')
    target = 0 if q == 'max' else int(q) if q.isdigit() else 1080

    with yt_dlp.YoutubeDL(ydl_opts({'noplaylist': False, 'extract_flat': 'in_playlist'})) as ydl:
        info = ydl.extract_info(link, download=False)

    # Playlists, carousels, multi-video posts → let the user choose.
    if info.get('_type') in ('playlist', 'multi_video') or (info.get('entries') and not info.get('formats')):
        audio_site = re.match(r'(Soundcloud|Bandcamp|Mixcloud|Audiomack|Audius|Podcast|Spreaker|Anchor)', info.get('extractor_key') or '', re.I)
        items = []
        for e in list(info.get('entries') or [])[:200]:
            if not e:
                continue
            src = e.get('webpage_url') or e.get('url')
            if not src:
                continue
            if not re.match(r'^https?://', src) and e.get('ie_key'):
                src = e.get('original_url') or src
            title = safe_name(e.get('title') or f"{info.get('title') or 'item'} {len(items) + 1}")
            fmt = 'ba/b' if mode == 'audio' else (f'b[height<={target}]/b' if target else 'b')
            thumbs = e.get('thumbnails') or []
            is_audio = mode == 'audio' or bool(audio_site)
            items.append({'type': 'audio' if is_audio else 'video',
                          'url': stream_tunnel(base, src, fmt, title),
                          'thumb': e.get('thumbnail') or (thumbs[-1]['url'] if thumbs else None),
                          'filename': f'{title}.m4a' if is_audio else title})
        if items:
            return {'status': 'picker', 'picker': items}
        return {'status': 'error', 'error': {'code': 'error.api.fetch.empty'}}

    title = safe_name(info.get('title') or info.get('id'))
    fmts = info.get('formats') or ([info] if info.get('url') else [])
    direct = [f for f in fmts if is_direct(f)]
    combined = [f for f in direct if has_video(f) and has_audio(f)]
    video_only = [f for f in direct if has_video(f) and not has_audio(f)]
    audio = best_audio(direct)

    if mode == 'audio':
        src = audio or pick(combined, 0, 'mp4')
        if src:
            return {'status': 'local-processing', 'type': 'audio', 'service': info.get('extractor_key', ''),
                    'tunnel': [tunnel_for(base, info, src, title)],
                    'output': {'type': 'audio/mpeg', 'filename': f'{title}.mp3'}}
        return {'status': 'tunnel', 'url': stream_tunnel(base, link, 'ba/b', title), 'filename': f'{title}.m4a'}

    if mode == 'mute':
        v = pick(video_only, target, 'mp4') or pick(combined, target, 'mp4')
        if v:
            res = f" ({short_side(v)}p)" if short_side(v) else ''
            if has_audio(v):
                return {'status': 'local-processing', 'type': 'mute', 'tunnel': [tunnel_for(base, info, v, title)],
                        'output': {'type': 'video/mp4', 'filename': f'{title}{res}.{v.get("ext") or "mp4"}'}}
            return {'status': 'tunnel', 'url': tunnel_for(base, info, v, title), 'filename': f'{title}{res}.{v.get("ext") or "mp4"}'}

    # Audio-only sites (SoundCloud, Bandcamp, podcasts…).
    if not combined and not video_only and audio:
        return {'status': 'tunnel', 'url': tunnel_for(base, info, audio, title), 'filename': f'{title}.{audio.get("ext") or "m4a"}'}

    c = pick(combined, target, 'mp4')
    v = pick(video_only, target, 'mp4')
    # Separate tracks give better quality (YouTube only muxes 360p): the browser merges them.
    if v and audio and (not c or short_side(v) > short_side(c)):
        a = audio
        if v.get('ext') == 'mp4':
            a = best_audio(direct, 'm4a') or audio
        elif v.get('ext') == 'webm':
            a = best_audio(direct, 'webm') or audio
        res = f" ({short_side(v)}p)" if short_side(v) else ''
        out_ext = 'webm' if v.get('ext') == 'webm' and a.get('ext') == 'webm' else 'mp4'
        return {'status': 'local-processing', 'type': 'merge', 'service': info.get('extractor_key', ''),
                'tunnel': [tunnel_for(base, info, v, title), tunnel_for(base, info, a, title)],
                'output': {'type': f'video/{out_ext}', 'filename': f'{title}{res}.{out_ext}'}}
    if c:
        res = f" ({short_side(c)}p)" if short_side(c) else ''
        return {'status': 'tunnel', 'url': tunnel_for(base, info, c, title), 'filename': f'{title}{res}.{c.get("ext") or "mp4"}'}

    # Only HLS/DASH or something exotic: let yt-dlp download it and pipe it through.
    # (Piping needs a single-file format; separate tracks were handled above.)
    fmt = f'b[height<={target}]/b' if target else 'b'
    audio_only = fmts and not any(has_video(f) for f in fmts)
    ext = 'm4a' if audio_only else 'mp4'
    return {'status': 'tunnel', 'url': stream_tunnel(base, link, fmt, title), 'filename': f'{title}.{ext}'}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = f'getvid-server/{VERSION}'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def client_ip(self):
        if TRUST_PROXY:
            fwd = (self.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
            if fwd:
                return fwd
        return self.client_address[0]

    def origin_ok(self):
        origin = (self.headers.get('Origin') or '').rstrip('/')
        if not origin:
            return '*'  # not a browser cross-site request (curl, same-origin)
        if '*' in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS:
            return origin
        return None

    def cors(self, origin):
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'content-type, accept, authorization, range')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Estimated-Content-Length')
            self.send_header('Access-Control-Allow-Private-Network', 'true')  # Chrome: public site → localhost/LAN

    def base_url(self):
        proto = self.headers.get('X-Forwarded-Proto') or ('https' if self.headers.get('CF-Visitor', '').find('https') >= 0 else 'http')
        host = self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or f'127.0.0.1:{PORT}'
        return f'{proto}://{host}/'

    def send_json(self, code, obj, origin):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors(origin)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.origin_ok()
        self.send_response(204 if origin else 403)
        self.cors(origin)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        origin = self.origin_ok()
        if origin is None:
            return self.send_json(403, {'status': 'error', 'error': {'code': 'error.api.origin'}}, None)
        u = urlparse(self.path)
        if u.path == '/':
            return self.send_json(200, {'cobalt': {'version': f'getvid-server {VERSION} / yt-dlp {yt_dlp.version.__version__}',
                                                   'url': self.base_url(), 'services': ['yt-dlp: 1000+ sites']},
                                        'ffmpeg': HAS_FFMPEG}, origin)
        if u.path == '/tunnel':
            tid = (parse_qs(u.query).get('id') or [''])[0]
            with LOCK:
                t = TUNNELS.get(tid)
            if not t or t['exp'] < time.time():
                return self.send_json(404, {'status': 'error', 'error': {'code': 'error.tunnel.expired'}}, origin)
            if not STREAMS.acquire(timeout=30):
                return self.send_json(503, {'status': 'error', 'error': {'code': 'error.api.busy'}}, origin)
            try:
                if t['kind'] == 'url':
                    return self.proxy(t, origin)
                return self.ytdlp_stream(t, origin)
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                STREAMS.release()
        self.send_json(404, {'status': 'error', 'error': {'code': 'error.api.not_found'}}, origin)

    def do_POST(self):
        # Always consume the body first: refusing early with unread bytes would corrupt the
        # next request on a kept-alive connection (e.g. behind Caddy).
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(min(length, 65536)) if length > 0 else b''
        if length > 65536:
            self.close_connection = True
        origin = self.origin_ok()
        if origin is None:
            return self.send_json(403, {'status': 'error', 'error': {'code': 'error.api.origin'}}, None)
        if API_KEY:
            auth = self.headers.get('Authorization') or ''
            if auth not in (f'Api-Key {API_KEY}', f'Bearer {API_KEY}'):
                return self.send_json(401, {'status': 'error', 'error': {'code': 'error.api.auth.key.invalid'}}, origin)
        if not rate_ok(self.client_ip()):
            return self.send_json(429, {'status': 'error', 'error': {'code': 'error.api.rate_exceeded'}}, origin)
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            return self.send_json(400, {'status': 'error', 'error': {'code': 'error.api.invalid_body'}}, origin)
        started = time.time()
        try:
            res = resolve(body, self.base_url())
        except yt_dlp.utils.DownloadError as e:
            msg = re.sub(r'\x1b\[[0-9;]*m', '', str(e)).replace('ERROR: ', '')[:300]
            code = 'error.api.content.video.unavailable'
            if 'Unsupported URL' in msg:
                code = 'error.api.link.unsupported'
            elif re.search(r'confirm you.re not a bot|Sign in', msg, re.I):
                code = 'error.api.youtube.login'
            res = {'status': 'error', 'error': {'code': code, 'context': {'message': msg}}}
        except Exception as e:  # noqa: BLE001 — report, never crash the server
            res = {'status': 'error', 'error': {'code': 'error.api.fetch.fail', 'context': {'message': str(e)[:300]}}}
        log('POST', body.get('url'), '→', res.get('status'), res.get('error', {}).get('code', ''), f'{time.time() - started:.1f}s')
        self.send_json(200 if res.get('status') != 'error' else 400, res, origin)

    # -- media

    def disposition(self, filename, ext=None):
        name = filename if not ext or filename.lower().endswith('.' + ext) else f'{filename}.{ext}'
        ascii_name = name.encode('ascii', 'replace').decode().replace('"', "'")
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"

    def proxy(self, t, origin):
        """Stream an upstream media URL (fetched in 10 MB ranges to avoid throttling)."""
        headers = {k: v for k, v in t['headers'].items() if k.lower() not in ('accept-encoding',)}
        client_range = self.headers.get('Range')
        size = t.get('size')
        if not size:  # learn the size so we can fetch in ranges
            try:
                req = urllib.request.Request(t['url'], headers={**headers, 'Range': 'bytes=0-0'})
                with urllib.request.urlopen(req, timeout=20) as r:
                    cr = r.headers.get('Content-Range') or ''
                    size = int(cr.split('/')[-1]) if '/' in cr and cr.split('/')[-1].isdigit() else None
            except Exception:  # noqa: BLE001
                size = None
        start, end = 0, (size - 1 if size else None)
        status = 200
        if client_range and size:
            m = re.match(r'bytes=(\d+)-(\d*)', client_range)
            if m:
                start = int(m.group(1))
                end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
                status = 206
        self.send_response(status)
        self.cors(origin)
        self.send_header('Content-Type', {'m4a': 'audio/mp4', 'webm': 'video/webm', 'mp3': 'audio/mpeg'}.get(t.get('ext'), 'video/mp4' if t.get('ext') in (None, 'mp4') else 'application/octet-stream'))
        self.send_header('Content-Disposition', self.disposition(t['filename'], t.get('ext')))
        self.send_header('Accept-Ranges', 'bytes')
        if size:
            self.send_header('Content-Length', str(end - start + 1))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.end_headers()
        pos = start
        while True:
            hdr = dict(headers)
            if size:
                if pos > end:
                    break
                hdr['Range'] = f'bytes={pos}-{min(pos + CHUNK - 1, end)}'
            req = urllib.request.Request(t['url'], headers=hdr)
            with urllib.request.urlopen(req, timeout=30) as r:
                while True:
                    buf = r.read(256 * 1024)
                    if not buf:
                        break
                    self.wfile.write(buf)
                    pos += len(buf)
            if not size:
                break

    def ytdlp_stream(self, t, origin):
        """Let yt-dlp download (HLS, DASH, merges…) and pipe the result to the browser."""
        self.send_response(200)
        self.cors(origin)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Disposition', self.disposition(t['filename'], 'mp4'))
        self.send_header('Connection', 'close')
        self.close_connection = True
        self.end_headers()
        cmd = [sys.executable, '-m', 'yt_dlp', '--quiet', '--no-warnings', '--no-playlist', '-f', t['format'],
               '-o', '-', '--no-part', t['link']]
        # yt-dlp keeps HLS/DASH fragments in its working directory: give each run its own temp dir.
        work = tempfile.mkdtemp(prefix='getvid-')
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=work)
        try:
            while True:
                buf = proc.stdout.read(256 * 1024)
                if not buf:
                    break
                self.wfile.write(buf)
        finally:
            proc.kill()
            proc.wait()
            shutil.rmtree(work, ignore_errors=True)


def banner(url):
    key = f' | {API_KEY}' if API_KEY else ''
    line = '=' * 64
    print(f'\n{line}\n  Cole no getvid → ⚙ Configurações → Servidores cobalt:\n\n      {url}{key}\n\n  Paste in getvid → ⚙ Settings → cobalt servers.\n{line}\n', flush=True)


def start_tunnel():
    """Free Cloudflare quick tunnel (no account): gives an https:// address reachable from anywhere."""
    exe = shutil.which('cloudflared')
    if not exe:
        print('cloudflared not found — install it to get an https:// address (see server/README.md).', flush=True)
        return
    proc = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', f'http://localhost:{PORT}'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    def watch():
        shown = False
        for row in proc.stderr:
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', row)
            if m and not shown:
                shown = True
                banner(m.group(0) + '/')
    threading.Thread(target=watch, daemon=True).start()


def main():
    threading.Thread(target=cleanup_loop, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'getvid server {VERSION} · yt-dlp {yt_dlp.version.__version__} · ffmpeg: {"yes" if HAS_FFMPEG else "no (not needed)"} · port {PORT}', flush=True)
    print('Keep yt-dlp current (sites change often):  pip install -U "yt-dlp[default]"', flush=True)
    if '--tunnel' in sys.argv or os.environ.get('TUNNEL') == '1':
        print('Starting the Cloudflare tunnel…', flush=True)
        start_tunnel()
    else:
        # A browser on THIS device may call localhost from the https site; other devices need --tunnel.
        banner(f'http://127.0.0.1:{PORT}/')
        print('  Using it from another device (phone ↔ PC)? Start with:  python getvid_server.py --tunnel\n', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
