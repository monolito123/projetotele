// On-demand ffmpeg.wasm (single-threaded core, so no special server headers are needed).
// Merges separate audio/video, remuxes MPEG-TS → MP4, extracts audio, strips audio.
import { fetchBlob } from './util.js';

const CORE_VERSION = '0.12.10';
const CDNS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/`,
];

let loading = null;
let instance = null;

export const ffmpegSupported = () => typeof WebAssembly === 'object' && typeof Worker === 'function';

/** Load (once) and return the FFmpeg instance. onLoad({ loaded, total }) reports the wasm download. */
async function getFFmpeg(onLoad) {
  if (!loading) {
    loading = (async () => {
      const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
      let last;
      for (const base of CDNS) {
        const ff = new FFmpeg();
        try {
          // Fetch the 31 MB wasm ourselves to show progress; the browser HTTP cache keeps it afterwards.
          const { blob } = await fetchBlob(`${base}ffmpeg-core.wasm`, { onProgress: onLoad, connectTimeout: 30000, idleTimeout: 60000 });
          const wasmURL = URL.createObjectURL(new Blob([blob], { type: 'application/wasm' }));
          await ff.load({ coreURL: `${base}ffmpeg-core.js`, wasmURL });
          instance = ff;
          return ff;
        } catch (e) {
          last = e;
          try { ff.terminate(); } catch { /* ignore */ }
        }
      }
      throw last || new Error('ffmpeg load failed');
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// ffmpeg.wasm runs one command at a time.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Run ffmpeg with several argument sets (first that succeeds wins).
 * inputs: [{ blob, ext }]; variants: [{ args: (names) => [...], out: 'mp4', mime }]
 */
function run(inputs, variants, { signal, onLoad, onProgress } = {}) {
  return exclusive(async () => {
    if (signal?.aborted) throw signal.reason;
    const ff = await getFFmpeg(onLoad);
    const names = inputs.map((f, i) => `in${i}.${f.ext || 'bin'}`);
    const onAbort = () => { try { ff.terminate(); } catch { /* ignore */ } loading = null; instance = null; };
    signal?.addEventListener('abort', onAbort, { once: true });
    const prog = ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress || 0)));
    ff.on('progress', prog);
    const written = [];
    try {
      for (let i = 0; i < inputs.length; i++) {
        await ff.writeFile(names[i], new Uint8Array(await inputs[i].blob.arrayBuffer()));
        written.push(names[i]);
      }
      let lastErr;
      for (const v of variants) {
        const out = `out.${v.out}`;
        try {
          const code = await ff.exec([...v.args(names), '-y', out]);
          if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
          const data = await ff.readFile(out);
          await ff.deleteFile(out).catch(() => {});
          if (!data || !data.length) throw new Error('empty output');
          return { blob: new Blob([data], { type: v.mime }), ext: v.out, mime: v.mime };
        } catch (e) {
          if (signal?.aborted) throw signal.reason;
          lastErr = e;
          await ff.deleteFile(out).catch(() => {});
        }
      }
      throw lastErr;
    } finally {
      ff.off('progress', prog);
      signal?.removeEventListener('abort', onAbort);
      if (instance === ff) for (const n of written) await ff.deleteFile(n).catch(() => {});
    }
  });
}

const WEBM_AUDIO = new Set(['webm', 'weba', 'opus', 'ogg']);

/** video {blob, ext} + audio {blob, ext} → one file. */
export function mergeAV(video, audio, opts) {
  const webm = video.ext === 'webm' && WEBM_AUDIO.has(audio.ext);
  const map = (n) => ['-i', n[0], '-i', n[1], '-map', '0:v:0', '-map', '1:a:0'];
  return run([video, audio], [
    webm
      ? { args: (n) => [...map(n), '-c', 'copy'], out: 'webm', mime: 'video/webm' }
      : { args: (n) => [...map(n), '-c', 'copy', '-movflags', '+faststart'], out: 'mp4', mime: 'video/mp4' },
    { args: (n) => [...map(n), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'], out: 'mp4', mime: 'video/mp4' },
    { args: (n) => [...map(n), '-c', 'copy'], out: 'mkv', mime: 'video/x-matroska' },
  ], opts);
}

/** MPEG-TS (or any container) → MP4 without re-encoding. */
export function remuxToMp4(input, opts) {
  return run([input], [
    { args: (n) => ['-i', n[0], '-map', '0', '-c', 'copy', '-movflags', '+faststart'], out: 'mp4', mime: 'video/mp4' },
    { args: (n) => ['-i', n[0], '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'], out: 'mp4', mime: 'video/mp4' },
    { args: (n) => ['-i', n[0], '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart'], out: 'mp4', mime: 'video/mp4' },
  ], opts);
}

const MP3 = { args: (n) => ['-i', n[0], '-vn', '-c:a', 'libmp3lame', '-q:a', '2'], out: 'mp3', mime: 'audio/mpeg' };
const AUDIO_PLANS = {
  mp3: [MP3],
  best: [{ args: (n) => ['-i', n[0], '-vn', '-c:a', 'copy'], out: 'm4a', mime: 'audio/mp4' }, { args: (n) => ['-i', n[0], '-vn', '-c:a', 'copy'], out: 'mka', mime: 'audio/x-matroska' }, MP3],
  ogg: [{ args: (n) => ['-i', n[0], '-vn', '-c:a', 'libvorbis', '-q:a', '5'], out: 'ogg', mime: 'audio/ogg' }, MP3],
  opus: [{ args: (n) => ['-i', n[0], '-vn', '-c:a', 'libopus', '-b:a', '128k'], out: 'opus', mime: 'audio/ogg' }, MP3],
  wav: [{ args: (n) => ['-i', n[0], '-vn', '-c:a', 'pcm_s16le'], out: 'wav', mime: 'audio/wav' }, MP3],
};

/** Video/audio file → audio file in the requested format (mp3 | best | ogg | opus | wav). */
export function extractAudio(input, format, opts) {
  return run([input], AUDIO_PLANS[format] || AUDIO_PLANS.mp3, opts);
}

/** Drop the audio track. */
export function stripAudio(input, opts) {
  const ext = ['mp4', 'webm', 'mkv', 'mov'].includes(input.ext) ? input.ext : 'mp4';
  const mime = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' }[ext];
  return run([input], [{ args: (n) => ['-i', n[0], '-an', '-c:v', 'copy'], out: ext, mime }], opts);
}

