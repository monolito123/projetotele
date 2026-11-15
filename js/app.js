import {
  t, L, render, setLang, detectLang, applyI18n, getLang, LANGS, MT_LANGS, hasTranslator, isHandmade, translateText,
} from './i18n.js';
import { getSettings, saveSettings, resetSettings, cobaltInstances } from './settings.js';
import { PLATFORMS, DIRECT, HLS, platformKind } from './platforms.js';
import { resolve } from './resolvers.js';
import { fetchItem, saveBlob, openUrl, ManualDownload } from './download.js';
import { makeZip } from './zip.js';
import { extractUrls, formatBytes, formatDuration, isUserAbort, sanitizeFilename, sleep, errText } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const safeHttp = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/** Tiny DOM builder. Text children are always inserted as text (never HTML). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : render(kid));
  return el;
}

const ICONS = {
  video: '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="3" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m17 10 4-2.5v9L17 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  photo: '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = ICONS[name] || ICONS.video; // static markup only
  return s;
}
const iconFor = (type) => icon(type === 'photo' ? 'photo' : type === 'audio' ? 'audio' : 'video');
const typeLabel = (type) => ({ video: t('typeVideo'), audio: t('typeAudio'), photo: t('typePhoto'), gif: t('typeGif') }[type] || t('typeLink'));

/* ------------------------------------------------------------------ */
/* toast / theme                                                       */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = render(msg);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const THEME_KEY = 'getvid.theme';
function applyTheme(v) {
  if (v === 'dark' || v === 'light') document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* jobs — every visible string is stored as parts and re-rendered      */
/* on language change, so switching language is instant everywhere.    */
/* ------------------------------------------------------------------ */

const jobs = new Map();
let jobSeq = 0;

const MAX_PARALLEL = 3;
let running = 0;
const waiting = [];
function schedule(fn) { waiting.push(fn); pump(); }
function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const fn = waiting.shift();
    running++;
    Promise.resolve().then(fn).catch(() => {}).finally(() => { running--; pump(); });
  }
}

function createJob(url) {
  const id = ++jobSeq;
  const ui = {
    thumb: h('div', { class: 'thumb' }, icon('video')),
    badge: h('span', { class: 'badge' }, '…'),
    via: h('span', { class: 'via' }),
    tr: h('button', { class: 'linkish', type: 'button', hidden: true }),
    title: h('h3', { class: 'title' }, url),
    src: h('div', { class: 'src' }, url),
    status: h('p', { class: 'status' }),
    bar: h('div', { class: 'bar indet' }, h('i')),
    sub: h('ul', { class: 'sublist', hidden: true }),
    details: h('details', { hidden: true }, h('summary'), h('ul')),
    actions: h('div', { class: 'actions' }),
    close: h('button', { class: 'close', type: 'button' }, '×'),
  };
  const job = { id, url, ui, ctrl: null, result: null, manual: null, done: false, status: { parts: '', cls: '' }, actionsFn: () => [], rows: [], attempts: [] };
  ui.close.addEventListener('click', () => removeJob(job));
  ui.tr.addEventListener('click', () => toggleTitleTranslation(job));
  job.el = h('article', { class: 'job' },
    ui.thumb,
    h('div', { class: 'body' }, h('div', { class: 'meta' }, ui.badge, ui.via, ui.tr), ui.title, ui.src, ui.status, ui.bar, ui.sub, ui.details, ui.actions),
    ui.close);
  $('#jobs').prepend(job.el);
  jobs.set(id, job);
  rerenderJob(job);
  return job;
}

function removeJob(job) {
  job.ctrl?.abort();
  job.el.remove();
  jobs.delete(job.id);
  const qi = pickerQueue.indexOf(job);
  if (qi >= 0) pickerQueue.splice(qi, 1);
}

function paintStatus(job) {
  job.ui.status.textContent = render(job.status.parts);
  job.el.classList.remove('ok', 'err', 'warn');
  if (job.status.cls) job.el.classList.add(job.status.cls);
}
function setStatus(job, parts, cls = '') { job.status = { parts, cls }; paintStatus(job); }

function setBar(job, v) {
  const b = job.ui.bar;
  if (v === 'hide') { b.hidden = true; return; }
  b.hidden = false;
  b.classList.toggle('indet', v === 'indet');
  b.firstChild.style.width = typeof v === 'number' ? `${Math.max(2, Math.round(v * 100))}%` : '';
}

function setActions(job, fn) { job.actionsFn = fn; job.ui.actions.replaceChildren(...fn().filter(Boolean)); }

function paintRows(job) {
  job.rows.forEach((r) => {
    if (r.link) return;
    r.s.textContent = render(r.parts);
    r.s.className = `s${r.cls ? ` ${r.cls}` : ''}`;
  });
}

function paintDetails(job) {
  const d = job.ui.details;
  d.querySelector('summary').textContent = t('details');
  d.querySelector('ul').replaceChildren(...job.attempts.map((a) => h('li', {}, h('b', {}, a.via), ': ', render(a.error))));
  d.hidden = !job.attempts.length;
}

function paintTitle(job) {
  const r = job.result;
  const tr = job.translated;
  const showTr = tr && !job.showOriginal;
  job.ui.title.textContent = showTr ? tr.text : (r?.title || job.url);
  job.ui.title.title = showTr ? (r?.title || '') : '';
  job.ui.tr.hidden = !job.canTranslate;
  job.ui.tr.textContent = `🌐 ${tr && !job.showOriginal ? t('original') : t('translate')}`;
}

/** Re-render every string of a job in the current language. */
function rerenderJob(job) {
  paintStatus(job);
  job.ui.actions.replaceChildren(...job.actionsFn().filter(Boolean));
  paintRows(job);
  paintDetails(job);
  if (job.result) job.ui.via.textContent = t('via', { via: job.result.via });
  job.ui.close.title = t('remove');
  job.ui.close.setAttribute('aria-label', t('remove'));
  paintTitle(job);
}

const btn = (label, onclick, kind = 'ghost') => h('button', { type: 'button', class: `btn ${kind}`, onclick }, label);
const linkBtn = (label, href, filename, kind = 'primary') => h('a', { class: `btn ${kind}`, href, target: '_blank', rel: 'noopener noreferrer', download: filename || true }, label);
const cancelBtn = (job) => btn(t('cancel'), () => job.ctrl?.abort());

function setPlatform(job, p) {
  job.ui.badge.textContent = p.name;
  job.ui.badge.style.setProperty('--c', p.color);
}

function setThumb(job, url) {
  const src = safeHttp(url);
  if (!src) return;
  const img = h('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => job.ui.thumb.replaceChildren(iconFor(job.result?.items?.[0]?.type)), { once: true });
  job.ui.thumb.replaceChildren(img);
}

function renderMeta(job) {
  const r = job.result;
  setPlatform(job, r.platform);
  const first = r.items[0];
  if (first?.type === 'audio') job.ui.thumb.replaceChildren(icon('audio'));
  setThumb(job, r.items.find((i) => i.thumb)?.thumb || (first?.type === 'photo' ? first.url : null));
  job.translated = null;
  job.showOriginal = false;
  job.canTranslate = false;
  rerenderJob(job);
  autoTranslateTitle(job);
}

/* ---------------- instant translation of titles ---------------- */

async function autoTranslateTitle(job) {
  if (!getSettings().translateTitles || !hasTranslator() || !job.result?.title) return;
  const lang = getLang();
  const res = await translateText(job.result.title);
  if (lang !== getLang() || !jobs.has(job.id)) return;
  job.canTranslate = true; // the API exists: offer the button even when no model is installed yet
  if (res) job.translated = res;
  paintTitle(job);
}

async function toggleTitleTranslation(job) {
  if (job.translated && !job.showOriginal) { job.showOriginal = true; paintTitle(job); return; }
  if (job.translated) { job.showOriginal = false; paintTitle(job); return; }
  job.ui.tr.disabled = true;
  const res = await translateText(job.result?.title, { allowDownload: true }); // click = user gesture → may download a model
  job.ui.tr.disabled = false;
  if (res) { job.translated = res; job.showOriginal = false; }
  else toast(L('errMtUnavailable'));
  paintTitle(job);
}

/* ---------------- progress ---------------- */

/** Progress callback, throttled to one paint per frame. Call .stop() before writing a final status. */
function progressFn(onPaint) {
  let pending = null, raf = 0, stopped = false;
  const fn = (p) => {
    if (stopped) return;
    pending = p;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!stopped) onPaint(pending); });
  };
  fn.stop = () => { stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; };
  return fn;
}

const pct = (f) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;

/** → { frac, parts } for any progress event. */
function progressParts(p) {
  const pre = p.part === 'audio' ? '♪ ' : '';
  if (p.stage === 'load') return { frac: p.total ? p.loaded / p.total : null, parts: [L('statusLoadingConverter', { pct: p.total ? pct(p.loaded / p.total) : formatBytes(p.loaded) })] };
  if (p.stage === 'merge') return { frac: p.frac, parts: [L('statusMerging'), ' ', pct(p.frac || 0)] };
  if (p.stage === 'convert') return { frac: p.frac, parts: [L('statusConverting', { fmt: p.fmt || '' }), ' ', pct(p.frac || 0)] };
  if (p.stage === 'retry') return { frac: null, parts: [L('statusRetrying')] };
  if (p.segments) return { frac: p.done / p.total, parts: [pre, L('statusDownloading'), ` ${p.done}/${p.total} `, L('segments'), ` · ${formatBytes(p.loaded)}`] };
  if (p.total) return { frac: p.loaded / p.total, parts: [pre, L('statusDownloading'), ` ${pct(p.loaded / p.total)} · ${formatBytes(p.loaded)} / ${formatBytes(p.total)}`] };
  return { frac: null, parts: [pre, L('statusDownloading'), ` ${formatBytes(p.loaded)}`] };
}

/* ---------------- running a job ---------------- */

async function runJob(job) {
  job.ctrl?.abort();
  job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  Object.assign(job, { manual: null, done: false, file: null, attempts: [], rows: [] });
  job.ui.sub.hidden = true;
  paintDetails(job);
  setStatus(job, [L('statusDetecting')]);
  setBar(job, 'indet');
  setActions(job, () => [cancelBtn(job)]);
  try {
    const res = await resolve(job.url, {
      settings: getSettings(), signal,
      onStatus: (msg, info) => { if (info?.platform) setPlatform(job, info.platform); setStatus(job, [msg]); },
    });
    if (signal.aborted) throw signal.reason;
    job.result = res;
    job.sel = null;
    renderMeta(job);
    if (res.items.length === 1) {
      if (getSettings().autoDownload) await downloadSingle(job, res.items[0]);
      else { setBar(job, 'hide'); setStatus(job, [L('statusReady')]); setActions(job, () => singleActions(job)); }
    } else {
      setBar(job, 'hide');
      setStatus(job, [L('statusFound', { n: res.items.length }), ' — ', L('statusWaitingChoice')]);
      setActions(job, () => multiActions(job));
      queuePicker(job);
    }
  } catch (e) {
    if (isUserAbort(e) || signal.aborted) {
      setBar(job, 'hide');
      setStatus(job, [L('statusCancelled')], 'warn');
      setActions(job, () => [btn(t('retry'), () => runJob(job), 'primary')]);
      return;
    }
    showError(job, e);
  }
}

function showError(job, e) {
  setBar(job, 'hide');
  if (e.platform) setPlatform(job, e.platform);
  setStatus(job, [errText(e) || L('statusFailed')], 'err');
  job.attempts = e.attempts || [];
  paintDetails(job);
  setActions(job, () => [
    e.needsCobalt ? btn(`⚙ ${t('settings')}`, openSettings, 'primary') : null,
    e.fatal ? null : btn(t('retry'), () => runJob(job), e.needsCobalt ? 'ghost' : 'primary'),
  ]);
}

function saveExtras(extras) {
  (extras || []).forEach((x, i) => setTimeout(() => saveBlob(x.blob, x.filename), 400 * (i + 1)));
}

async function downloadSingle(job, item, variant) {
  if (!job.ctrl || job.ctrl.signal.aborted) job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  job.manual = null;
  job.file = null;
  job.needsSettings = false;
  setActions(job, () => [cancelBtn(job)]);
  setStatus(job, [L('statusDownloading')]);
  setBar(job, 'indet');
  const onProgress = progressFn((p) => {
    const { frac, parts } = progressParts(p);
    setBar(job, frac == null || Number.isNaN(frac) ? 'indet' : frac);
    setStatus(job, parts);
  });
  try {
    const { blob, filename, warning, extras } = await fetchItem(item, { settings: getSettings(), signal, variant, onProgress }).finally(onProgress.stop);
    setStatus(job, [L('statusSaving')]);
    saveBlob(blob, filename);
    saveExtras(extras);
    job.done = true;
    try { job.file = new File([blob], filename, { type: blob.type || 'application/octet-stream' }); } catch { job.file = null; }
    setBar(job, 1);
    setStatus(job, [L('statusDone'), ` · ${filename} · ${formatBytes(blob.size)}`, warning ? [' — ', warning] : ''], warning ? 'warn' : 'ok');
  } catch (e) {
    if (e instanceof ManualDownload) {
      if (e.attachment && safeHttp(e.url)) {
        openUrl(e.url, e.filename, true);
        job.done = true;
        setBar(job, 1);
        setStatus(job, [L('statusDone'), ` · ${e.filename}`], 'ok');
      } else {
        job.manual = e;
        setBar(job, 'hide');
        setStatus(job, [L('statusManual')], 'warn');
      }
    } else if (isUserAbort(e) || signal.aborted) {
      setBar(job, 'hide');
      setStatus(job, [L('statusCancelled')], 'warn');
    } else {
      setBar(job, 'hide');
      job.needsSettings = !!e.needsCobalt;
      setStatus(job, e.needsCobalt ? [errText(e)] : [L('statusFailed'), ': ', errText(e)], 'err');
    }
  }
  setActions(job, () => (job.result.items.length === 1 ? singleActions(job) : multiActions(job)));
}

const canShareFiles = () => !!(navigator.canShare && matchMedia('(pointer: coarse)').matches);

function singleActions(job) {
  const res = job.result;
  const item = res.items[0];
  const acts = [];
  if (job.manual && safeHttp(job.manual.url)) {
    acts.push(btn(t('openPlayer'), () => openViewer(job.manual), 'primary'));
    acts.push(linkBtn(t('openNewTab'), job.manual.url, job.manual.filename, 'ghost'));
  }
  if (job.file && canShareFiles() && navigator.canShare({ files: [job.file] })) {
    acts.push(btn(`⤴ ${t('shareSave')}`, () => navigator.share({ files: [job.file], title: job.file.name }).catch(() => {}), 'primary'));
  }
  if (job.needsSettings) acts.push(btn(`⚙ ${t('settings')}`, openSettings, 'primary'));
  acts.push(btn(job.done ? t('again') : job.needsSettings ? t('retry') : t('download'), () => downloadSingle(job, item), job.done || job.manual || job.needsSettings ? 'ghost' : 'primary'));
  const vars = item.variants || [];
  if (vars.length > 1) vars.slice(0, 8).forEach((v) => acts.push(btn(render(v.label) || '?', () => downloadSingle(job, item, v))));
  (res.extras || []).forEach((x) => acts.push(btn(`♪ ${t('audioExtra')}${x.ext ? ` (${x.ext.toUpperCase()})` : ''}`, () => downloadSingle(job, x))));
  return acts;
}

function multiActions(job) {
  const acts = [btn(t('choose'), () => queuePicker(job, true), 'primary')];
  if (job.manual && safeHttp(job.manual.url)) acts.unshift(btn(t('openPlayer'), () => openViewer(job.manual), 'primary'));
  return acts;
}

async function downloadMany(job, items, zip) {
  job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  setActions(job, () => [cancelBtn(job)]);
  job.rows = items.map((it, i) => {
    const s = h('span', { class: 's' });
    const li = h('li', {}, h('span', { class: 'n', title: render(it.name) || '' }, `${i + 1}. ${render(it.name) || it.filename || typeLabel(it.type)}`), s);
    return { s, li, parts: '…', cls: '' };
  });
  job.ui.sub.replaceChildren(...job.rows.map((r) => r.li));
  job.ui.sub.hidden = false;
  paintRows(job);

  const collected = [];
  let ok = 0, manualCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (signal.aborted) break;
    const row = job.rows[i];
    setStatus(job, [L('statusDownloadingN', { i: i + 1, n: items.length })]);
    setBar(job, i / items.length);
    const onProgress = progressFn((p) => {
      const { frac, parts } = progressParts(p);
      row.parts = parts.filter((x) => !(x && x.key === 'statusDownloading'));
      paintRows(job);
      if (frac != null && !Number.isNaN(frac)) setBar(job, (i + frac) / items.length);
    });
    try {
      const { blob, filename, extras } = await fetchItem(items[i], { settings: getSettings(), signal, onProgress }).finally(onProgress.stop);
      if (zip) { collected.push({ name: filename, blob }); (extras || []).forEach((x) => collected.push({ name: x.filename, blob: x.blob })); }
      else { saveBlob(blob, filename); saveExtras(extras); await sleep(400); }
      ok++;
      Object.assign(row, { parts: `✓ ${formatBytes(blob.size)}`, cls: 'ok' });
    } catch (e) {
      if (isUserAbort(e) || signal.aborted) { Object.assign(row, { parts: [L('statusCancelled')], cls: '' }); break; }
      if (e instanceof ManualDownload && safeHttp(e.url)) {
        if (e.attachment && !zip) {
          openUrl(e.url, e.filename, true);
          ok++;
          Object.assign(row, { parts: '✓', cls: 'ok' });
          await sleep(1500); // give the browser time to start each download
          paintRows(job);
          continue;
        }
        manualCount++;
        row.link = true;
        row.s.className = 's';
        row.s.replaceChildren(h('button', { type: 'button', class: 'linkish', onclick: () => openViewer(e) }, t('openPlayer')));
      } else {
        Object.assign(row, { parts: ['✕ ', errText(e)], cls: 'err' });
        row.s.title = render(errText(e));
      }
    }
    paintRows(job);
  }

  if (signal.aborted) {
    setBar(job, 'hide');
    setStatus(job, [L('statusCancelled')], 'warn');
  } else {
    if (zip && collected.length) {
      setStatus(job, [L('statusZipping')]);
      setBar(job, 'indet');
      try {
        const z = await makeZip(collected);
        saveBlob(z, `${sanitizeFilename(job.result.title, 'getvid')}.zip`);
      } catch (e) {
        ok = 0;
        setStatus(job, [errText(e)], 'err');
      }
    }
    setBar(job, 1);
    const summary = L('statusDoneN', { ok, n: items.length });
    setStatus(job, manualCount ? [summary, ' — ', L('statusManual')] : [summary], ok === items.length ? 'ok' : ok ? 'warn' : 'err');
  }
  setActions(job, () => multiActions(job));
}

/* ------------------------------------------------------------------ */
/* viewer: saving files the source site won't let us fetch             */
/* ------------------------------------------------------------------ */

function openViewer(manual) {
  const box = $('#viewerMedia');
  const url = safeHttp(manual.url);
  if (!url) return;
  const ext = (manual.filename.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const kind = manual.type === 'photo' || /^(jpe?g|png|webp|gif|avif)$/i.test(ext) ? 'img'
    : manual.type === 'audio' || /^(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(ext) ? 'audio' : 'video';
  const el = kind === 'img'
    ? h('img', { src: url, alt: manual.filename, referrerpolicy: 'no-referrer' })
    : h(kind, { src: url, controls: true, playsinline: true, preload: 'metadata', referrerpolicy: 'no-referrer' });
  box.replaceChildren(el);
  $('#viewerName').textContent = manual.filename;
  const link = $('#viewerOpen');
  link.href = url;
  link.download = manual.filename;
  $('#viewer').showModal();
}

/* ------------------------------------------------------------------ */
/* picker                                                              */
/* ------------------------------------------------------------------ */

const pickerQueue = [];
let pickerJob = null;

function queuePicker(job, front = false) {
  if (pickerJob === job) return;
  if (!pickerQueue.includes(job)) front ? pickerQueue.unshift(job) : pickerQueue.push(job);
  if (!pickerJob) nextPicker();
}

function nextPicker() {
  const job = pickerQueue.shift();
  pickerJob = job || null;
  if (!job || !jobs.has(job.id)) { if (pickerQueue.length) nextPicker(); return; }
  renderPicker(job);
  $('#picker').showModal();
}

function renderPicker(job) {
  const items = job.result.items;
  if (!job.sel) job.sel = new Set(items.map((_, i) => i));
  $('#pickerTitle').textContent = t('pickerTitle', { n: items.length });
  const title = job.translated && !job.showOriginal ? job.translated.text : job.result.title;
  $('#pickerSub').textContent = title ? `${job.result.platform.name} · ${title}` : t('pickerSub');
  $('#pickerGrid').replaceChildren(...items.map((it, i) => tile(job, it, i)));
  const note = [render(job.result.note), t('multiNote')].filter(Boolean).join(' ');
  $('#pickerNote').textContent = note;
  $('#pickerNote').hidden = !note;
  updateSel(job);
}

function tile(job, it, i) {
  const media = h('div', { class: 'media' });
  const src = safeHttp(it.thumb || (it.type === 'photo' ? it.url : null));
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(iconFor(it.type)), { once: true });
    media.append(img);
  } else if ((it.type === 'video' || it.type === 'gif') && it.kind === 'file' && safeHttp(it.url)) {
    const v = h('video', { src: `${it.url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true });
    v.muted = true;
    v.addEventListener('error', () => v.replaceWith(icon('video')), { once: true });
    media.append(v);
  } else {
    media.append(iconFor(it.type));
  }
  const extra = [render(it.label), it.duration ? formatDuration(it.duration) : '', it.kind === 'lazy' && !it.label ? t('playlistItem') : '']
    .filter(Boolean).join(' · ');
  const selected = job.sel.has(i);
  const check = icon('check');
  check.className = 'check';
  const li = h('li', { class: `tile${selected ? ' sel' : ''}`, tabindex: '0', role: 'checkbox', 'aria-checked': String(selected) },
    media,
    h('span', { class: 'type' }, typeLabel(it.type)),
    check,
    h('div', { class: 'cap' }, h('b', { title: render(it.name) || '' }, render(it.name) || it.filename || `#${i + 1}`), extra ? h('span', {}, extra) : null));
  const toggle = () => {
    if (job.sel.has(i)) job.sel.delete(i); else job.sel.add(i);
    const on = job.sel.has(i);
    li.classList.toggle('sel', on);
    li.setAttribute('aria-checked', String(on));
    updateSel(job);
  };
  li.addEventListener('click', toggle);
  li.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
  return li;
}

function updateSel(job) {
  const n = job.sel.size;
  $('#selCount').textContent = t('selected', { n });
  $('#dlSelBtn').textContent = t('downloadSelected', { n });
  $('#dlSelBtn').disabled = !n;
  $('#zipBtn').disabled = n < 2;
}

function startPicked(zip) {
  const job = pickerJob;
  if (!job) return;
  const items = [...job.sel].sort((a, b) => a - b).map((i) => job.result.items[i]);
  $('#picker').close();
  if (items.length) downloadMany(job, items, zip);
}

/* ------------------------------------------------------------------ */
/* language                                                            */
/* ------------------------------------------------------------------ */

function fillLangSelect(sel, withAuto, compact = false) {
  const opts = [];
  const native = [...LANGS, ...MT_LANGS].find(([c]) => c === detectLang('auto'))?.[1] || 'English';
  if (withAuto) opts.push(h('option', { value: 'auto' }, `${compact ? 'Auto' : t('langAuto')} · ${native}`));
  const hand = h('optgroup', { label: '✓' }, ...LANGS.map(([c, n]) => h('option', { value: c }, n)));
  opts.push(hand);
  if (hasTranslator()) {
    opts.push(h('optgroup', { label: `🌐 ${t('langMachine')}` }, ...MT_LANGS.map(([c, n]) => h('option', { value: c }, `${n} · ${t('langMachine')}`))));
  }
  sel.replaceChildren(...opts);
}

let langBusy = null;
async function refreshLanguage() {
  const want = detectLang(getSettings().lang);
  const needsMT = !isHandmade(want);
  if (needsMT) toast(L('statusTranslatingUi'), 15000);
  const run = (langBusy = setLang(want, {}));
  const ok = await run;
  if (run !== langBusy) return; // a newer switch is in progress
  if (!ok && needsMT) { toast(L('errMtUnavailable')); saveSettings({ lang: 'auto' }); }
  else if (needsMT) $('#toast').hidden = true;
  applyI18n();
  fillLangSelect($('#langSel'), true, true);
  $('#langSel').value = getSettings().lang === 'auto' ? 'auto' : getLang();
  fillLangSelect(field('lang'), true);
  field('lang').value = getSettings().lang;
  renderPlatforms();
  renderBookmarklet();
  syncQuickOptions();
  jobs.forEach((job) => { rerenderJob(job); if (job.translated) { job.translated = null; autoTranslateTitle(job); } });
  if (pickerJob) renderPicker(pickerJob);
}

function changeLanguage(code) {
  saveSettings({ lang: code });
  refreshLanguage();
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function field(name) { return $('#settingsForm').elements.namedItem(name); }

function fillSettingsForm(s) {
  field('lang').value = s.lang;
  field('audioFormat').value = s.audioFormat;
  field('autoStart').checked = s.autoStart;
  field('useFfmpeg').checked = s.useFfmpeg !== false;
  field('translateTitles').checked = s.translateTitles !== false;
  field('publicCobalt').checked = s.publicCobalt !== false;
  field('cobalt').value = s.cobalt;
  field('corsProxy').value = s.corsProxy;
  field('piped').value = s.piped;
  field('invidious').value = s.invidious;
}

function openSettings() {
  fillSettingsForm(getSettings());
  $('#translateRow').hidden = !hasTranslator();
  $('#settingsDlg').showModal();
}

function syncQuickOptions() {
  const s = getSettings();
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === s.mode)));
  $('#qualitySel').value = s.quality;
  $('#autoChk').checked = s.autoDownload;
}

function renderPlatforms() {
  const hasCobalt = cobaltInstances(getSettings()).length > 0;
  const titles = { native: t('legendNative'), cobalt: t('legendCobalt'), scan: t('legendScan') };
  $('#platformList').replaceChildren(...[...PLATFORMS, DIRECT, HLS].map((p) => {
    const kind = platformKind(p);
    const initials = p.name.replace(/[^A-Za-z0-9+ ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '•';
    return h('li', {
      class: `chip ${kind}${kind === 'cobalt' && !hasCobalt ? ' off' : ''}`, style: `--c:${p.color}`,
      title: `${p.name} — ${titles[kind]}${kind === 'cobalt' && hasCobalt ? ` (${t('legendActive')})` : ''}`,
    }, h('span', { class: 'logo' }, initials), p.name, h('i', { class: 'k' }));
  }));
}

function renderBookmarklet() {
  const base = location.href.split(/[?#]/)[0];
  const code = `javascript:(()=>{window.open(${JSON.stringify(base)}+'?url='+encodeURIComponent(location.href))})()`;
  const a = h('a', { class: 'bm', href: code, title: 'getvid', onclick: (e) => { e.preventDefault(); toast(L('bookmarkletDrag')); } }, 'getvid ⤓');
  const [pre, post] = t('bookmarklet', { link: '\u0000' }).split('\u0000');
  $('#bookmarkletLine').replaceChildren(pre, a, post || '');
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function submit(text) {
  const urls = extractUrls(text);
  if (!urls.length) { toast(L('errNoUrl')); return; }
  $('#input').value = '';
  autoGrow();
  for (const u of urls) {
    const job = createJob(u);
    setStatus(job, [L('statusDetecting')]);
    schedule(() => runJob(job));
  }
}

const isEditable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

async function init() {
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* ignore */ }
  // Don't block the page on a (possibly machine-translated) language: handlers attach right away.
  const langReady = refreshLanguage();
  syncQuickOptions();

  const input = $('#input');
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); submit(input.value); });
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!getSettings().autoStart || !extractUrls(text).length) return;
    e.preventDefault();
    submit(`${input.value}\n${text}`);
  });
  document.addEventListener('paste', (e) => {
    if (isEditable(e.target)) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!extractUrls(text).length) return;
    e.preventDefault();
    if (getSettings().autoStart) submit(text);
    else { input.value = text; autoGrow(); input.focus(); }
  });

  $('#pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (getSettings().autoStart && extractUrls(text).length) submit(text);
      else { input.value = text; autoGrow(); input.focus(); }
    } catch {
      toast(L('clipboardDenied'));
      input.focus();
    }
  });

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { saveSettings({ mode: b.dataset.mode }); syncQuickOptions(); }));
  $('#qualitySel').addEventListener('change', (e) => saveSettings({ quality: e.target.value }));
  $('#autoChk').addEventListener('change', (e) => saveSettings({ autoDownload: e.target.checked }));

  $('#langSel').addEventListener('change', (e) => changeLanguage(e.target.value));
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#settingsBtn').addEventListener('click', openSettings);

  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  });
  $('#viewer').addEventListener('close', () => $('#viewerMedia').replaceChildren());
  $('#picker').addEventListener('close', () => {
    const job = pickerJob;
    pickerJob = null;
    if (job && jobs.has(job.id) && !job.ctrl?.signal.aborted && job.ui.sub.hidden) setStatus(job, [L('statusWaitingChoice')]);
    setTimeout(nextPicker, 120);
  });
  $('#selAll').addEventListener('click', () => { if (!pickerJob) return; pickerJob.sel = new Set(pickerJob.result.items.map((_, i) => i)); renderPicker(pickerJob); });
  $('#selNone').addEventListener('click', () => { if (!pickerJob) return; pickerJob.sel = new Set(); renderPicker(pickerJob); });
  $('#dlSelBtn').addEventListener('click', () => startPicked(false));
  $('#zipBtn').addEventListener('click', () => startPicked(true));

  // Language picked inside the settings dialog switches instantly too.
  field('lang').addEventListener('change', (e) => changeLanguage(e.target.value));
  $('#settingsForm').addEventListener('submit', () => {
    saveSettings({
      lang: field('lang').value,
      audioFormat: field('audioFormat').value,
      autoStart: field('autoStart').checked,
      useFfmpeg: field('useFfmpeg').checked,
      translateTitles: field('translateTitles').checked,
      publicCobalt: field('publicCobalt').checked,
      cobalt: field('cobalt').value.trim(),
      corsProxy: field('corsProxy').value.trim(),
      piped: field('piped').value.trim(),
      invidious: field('invidious').value.trim(),
    });
    refreshLanguage();
    toast(L('saved'));
  });
  $('#resetBtn').addEventListener('click', () => { fillSettingsForm(resetSettings()); syncQuickOptions(); refreshLanguage(); });

  const overlay = $('#dropOverlay');
  let dragDepth = 0;
  const hasText = (e) => [...(e.dataTransfer?.types || [])].some((ty) => ty === 'text/uri-list' || ty === 'text/plain');
  document.addEventListener('dragenter', (e) => { if (!hasText(e)) return; dragDepth++; overlay.hidden = false; });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  document.addEventListener('dragover', (e) => { if (hasText(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasText(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    submit(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
  });

  await langReady;
  const params = new URLSearchParams(location.search);
  const incoming = ['url', 'text', 'title'].map((k) => params.get(k)).filter(Boolean).join('\n');
  if (incoming) {
    history.replaceState(null, '', location.pathname);
    submit(incoming);
  }
}

init();
