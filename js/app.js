import { t, setLang, detectLang, applyI18n, getLang } from './i18n.js';
import { getSettings, saveSettings, resetSettings, cobaltInstances } from './settings.js';
import { PLATFORMS, DIRECT, HLS, platformKind } from './platforms.js';
import { resolve } from './resolvers.js';
import { fetchItem, saveBlob, openUrl, ManualDownload } from './download.js';
import { makeZip } from './zip.js';
import { extractUrls, formatBytes, formatDuration, isUserAbort, sanitizeFilename, sleep } from './util.js';

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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
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
const typeLabel = (type) => ({ video: t('typeVideo'), audio: t('typeAudio'), photo: t('typePhoto'), gif: t('typeGif') }[type] || t('typeLink'));

/* ------------------------------------------------------------------ */
/* toast / theme                                                       */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
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
/* jobs                                                                */
/* ------------------------------------------------------------------ */

const jobs = new Map();
let jobSeq = 0;

// At most 3 links are analysed/downloaded at the same time.
const MAX_PARALLEL = 3;
let running = 0;
const waiting = [];
function schedule(fn) {
  waiting.push(fn);
  pump();
}
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
    title: h('h3', { class: 'title' }, url),
    src: h('div', { class: 'src' }, url),
    status: h('p', { class: 'status' }),
    bar: h('div', { class: 'bar indet' }, h('i')),
    sub: h('ul', { class: 'sublist', hidden: true }),
    details: h('details', { hidden: true }, h('summary', {}, t('details')), h('ul')),
    actions: h('div', { class: 'actions' }),
  };
  const job = { id, url, ui, ctrl: null, result: null, manual: null, done: false };
  const close = h('button', { class: 'close', type: 'button', 'aria-label': t('remove'), title: t('remove'), onclick: () => removeJob(job) }, '×');
  job.el = h('article', { class: 'job' },
    ui.thumb,
    h('div', { class: 'body' }, h('div', { class: 'meta' }, ui.badge, ui.via), ui.title, ui.src, ui.status, ui.bar, ui.sub, ui.details, ui.actions),
    close);
  $('#jobs').prepend(job.el);
  jobs.set(id, job);
  return job;
}

function removeJob(job) {
  job.ctrl?.abort();
  job.el.remove();
  jobs.delete(job.id);
  const qi = pickerQueue.indexOf(job);
  if (qi >= 0) pickerQueue.splice(qi, 1);
}

function setStatus(job, text, cls = '') {
  job.ui.status.textContent = text;
  job.el.classList.remove('ok', 'err', 'warn');
  if (cls) job.el.classList.add(cls);
}

function setBar(job, v) {
  const b = job.ui.bar;
  if (v === 'hide') { b.hidden = true; return; }
  b.hidden = false;
  b.classList.toggle('indet', v === 'indet');
  b.firstChild.style.width = typeof v === 'number' ? `${Math.max(2, Math.round(v * 100))}%` : '';
}

function setActions(job, list) { job.ui.actions.replaceChildren(...list.filter(Boolean)); }

const btn = (label, onclick, kind = 'ghost') => h('button', { type: 'button', class: `btn ${kind}`, onclick }, label);
const linkBtn = (label, href, filename, kind = 'primary') => h('a', { class: `btn ${kind}`, href, target: '_blank', rel: 'noopener noreferrer', download: filename || true }, label);

function setPlatform(job, p) {
  job.ui.badge.textContent = p.name;
  job.ui.badge.style.setProperty('--c', p.color);
}

function setThumb(job, url) {
  const src = safeHttp(url);
  if (!src) return;
  const img = h('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => job.ui.thumb.replaceChildren(icon(job.result?.items?.[0]?.type === 'audio' ? 'audio' : 'video')), { once: true });
  job.ui.thumb.replaceChildren(img);
}

function renderMeta(job) {
  const r = job.result;
  setPlatform(job, r.platform);
  job.ui.via.textContent = t('via', { via: r.via });
  job.ui.title.textContent = r.title || job.url;
  job.ui.title.title = r.title || '';
  const first = r.items[0];
  if (first?.type === 'audio') job.ui.thumb.replaceChildren(icon('audio'));
  setThumb(job, r.items.find((i) => i.thumb)?.thumb || (first?.type === 'photo' ? first.url : null));
}

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
function progressText(p) {
  if (p.segments) return { frac: p.done / p.total, text: `${p.done}/${p.total} ${t('segments')} · ${formatBytes(p.loaded)}` };
  if (p.total) return { frac: p.loaded / p.total, text: `${Math.round((p.loaded / p.total) * 100)}% · ${formatBytes(p.loaded)} / ${formatBytes(p.total)}` };
  return { frac: null, text: formatBytes(p.loaded) };
}

async function runJob(job) {
  job.ctrl?.abort();
  job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  job.manual = null;
  job.done = false;
  job.ui.details.hidden = true;
  job.ui.sub.hidden = true;
  setStatus(job, t('statusDetecting'));
  setBar(job, 'indet');
  setActions(job, [btn(t('cancel'), () => job.ctrl.abort())]);
  try {
    const res = await resolve(job.url, {
      settings: getSettings(), signal,
      onStatus: (msg, info) => { if (info?.platform) setPlatform(job, info.platform); setStatus(job, msg); },
    });
    if (signal.aborted) throw signal.reason;
    job.result = res;
    job.sel = null;
    renderMeta(job);
    if (res.items.length === 1) {
      if (getSettings().autoDownload) await downloadSingle(job, res.items[0]);
      else { setBar(job, 'hide'); setStatus(job, t('statusReady')); renderSingleActions(job); }
    } else {
      setBar(job, 'hide');
      setStatus(job, `${t('statusFound', { n: res.items.length })} — ${t('statusWaitingChoice')}`);
      renderMultiActions(job);
      queuePicker(job);
    }
  } catch (e) {
    if (isUserAbort(e) || signal.aborted) {
      setBar(job, 'hide');
      setStatus(job, t('statusCancelled'), 'warn');
      setActions(job, [btn(t('retry'), () => runJob(job), 'primary')]);
      return;
    }
    showError(job, e);
  }
}

function showError(job, e) {
  setBar(job, 'hide');
  if (e.platform) setPlatform(job, e.platform);
  setStatus(job, e.message || t('statusFailed'), 'err');
  const attempts = e.attempts || [];
  job.ui.details.querySelector('ul').replaceChildren(...attempts.map((a) => h('li', {}, h('b', {}, a.via), ': ', a.error)));
  job.ui.details.hidden = !attempts.length;
  setActions(job, [
    e.needsCobalt ? btn(`⚙ ${t('settings')}`, openSettings, 'primary') : null,
    e.fatal ? null : btn(t('retry'), () => runJob(job), e.needsCobalt ? 'ghost' : 'primary'),
  ]);
}

async function downloadSingle(job, item, variant) {
  if (!job.ctrl || job.ctrl.signal.aborted) job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  job.manual = null;
  setActions(job, [btn(t('cancel'), () => job.ctrl.abort())]);
  setStatus(job, t('statusDownloading'));
  setBar(job, 'indet');
  const onProgress = progressFn((p) => {
    const { frac, text } = progressText(p);
    setBar(job, frac == null ? 'indet' : frac);
    setStatus(job, `${t('statusDownloading')} ${text}`);
  });
  try {
    const { blob, filename } = await fetchItem(item, { settings: getSettings(), signal, variant, onProgress }).finally(onProgress.stop);
    setStatus(job, t('statusSaving'));
    saveBlob(blob, filename);
    job.done = true;
    setBar(job, 1);
    setStatus(job, `${t('statusDone')} · ${filename} · ${formatBytes(blob.size)}`, 'ok');
  } catch (e) {
    if (e instanceof ManualDownload) {
      if (e.attachment && safeHttp(e.url)) {
        openUrl(e.url, e.filename, true);
        job.done = true;
        setBar(job, 1);
        setStatus(job, `${t('statusDone')} · ${e.filename}`, 'ok');
      } else {
        job.manual = e;
        setBar(job, 'hide');
        setStatus(job, t('statusManual'), 'warn');
      }
    } else if (isUserAbort(e) || signal.aborted) {
      setBar(job, 'hide');
      setStatus(job, t('statusCancelled'), 'warn');
    } else {
      setBar(job, 'hide');
      setStatus(job, `${t('statusFailed')}: ${e.message || e}`, 'err');
    }
  }
  if (job.result.items.length === 1) renderSingleActions(job);
  else renderMultiActions(job);
}

function renderSingleActions(job) {
  const res = job.result;
  const item = res.items[0];
  const acts = [];
  if (job.manual && safeHttp(job.manual.url)) acts.push(linkBtn(t('openFile'), job.manual.url, job.manual.filename));
  acts.push(btn(job.done ? t('again') : t('download'), () => downloadSingle(job, item), job.done || job.manual ? 'ghost' : 'primary'));
  const vars = item.variants || [];
  if (vars.length > 1) vars.slice(0, 8).forEach((v) => acts.push(btn(v.label || '?', () => downloadSingle(job, item, v))));
  (res.extras || []).forEach((x) => acts.push(btn(`♪ ${t('audioExtra')}${x.ext ? ` (${x.ext.toUpperCase()})` : ''}`, () => downloadSingle(job, x))));
  setActions(job, acts);
}

function renderMultiActions(job) {
  const acts = [btn(t('choose'), () => queuePicker(job, true), 'primary')];
  if (job.manual && safeHttp(job.manual.url)) acts.unshift(linkBtn(t('openFile'), job.manual.url, job.manual.filename));
  setActions(job, acts);
}

async function downloadMany(job, items, zip) {
  job.ctrl = new AbortController();
  const { signal } = job.ctrl;
  setActions(job, [btn(t('cancel'), () => job.ctrl.abort())]);
  const rows = items.map((it, i) => {
    const s = h('span', { class: 's' }, '…');
    return { s, li: h('li', {}, h('span', { class: 'n', title: it.name || '' }, `${i + 1}. ${it.name || it.filename || typeLabel(it.type)}`), s) };
  });
  job.ui.sub.replaceChildren(...rows.map((r) => r.li));
  job.ui.sub.hidden = false;

  const collected = [];
  let ok = 0, manualCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (signal.aborted) break;
    const row = rows[i];
    setStatus(job, t('statusDownloadingN', { i: i + 1, n: items.length }));
    setBar(job, i / items.length);
    const onProgress = progressFn((p) => {
      const { frac, text } = progressText(p);
      row.s.textContent = text;
      if (frac != null) setBar(job, (i + frac) / items.length);
    });
    try {
      const { blob, filename } = await fetchItem(items[i], { settings: getSettings(), signal, onProgress }).finally(onProgress.stop);
      if (zip) collected.push({ name: filename, blob });
      else { saveBlob(blob, filename); await sleep(400); }
      ok++;
      row.s.textContent = `✓ ${formatBytes(blob.size)}`;
      row.s.className = 's ok';
    } catch (e) {
      if (isUserAbort(e) || signal.aborted) { row.s.textContent = t('statusCancelled'); break; }
      if (e instanceof ManualDownload && safeHttp(e.url)) {
        if (e.attachment && !zip) {
          openUrl(e.url, e.filename, true);
          ok++;
          row.s.textContent = '✓';
          row.s.className = 's ok';
          await sleep(1500); // give the browser time to start each download
          continue;
        }
        manualCount++;
        row.s.replaceChildren(h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', download: e.filename }, t('openFile')));
      } else {
        row.s.textContent = `✕ ${e.message || ''}`.slice(0, 80);
        row.s.title = e.message || '';
        row.s.className = 's err';
      }
    }
  }

  if (signal.aborted) {
    setBar(job, 'hide');
    setStatus(job, t('statusCancelled'), 'warn');
  } else {
    if (zip && collected.length) {
      setStatus(job, t('statusZipping'));
      setBar(job, 'indet');
      try {
        const z = await makeZip(collected);
        saveBlob(z, `${sanitizeFilename(job.result.title, 'getvid')}.zip`);
      } catch (e) {
        ok = 0;
        setStatus(job, e.message, 'err');
      }
    }
    setBar(job, 1);
    const summary = t('statusDoneN', { ok, n: items.length });
    setStatus(job, manualCount ? `${summary} — ${t('statusManual')}` : summary, ok === items.length ? 'ok' : ok ? 'warn' : 'err');
  }
  renderMultiActions(job);
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
  $('#pickerSub').textContent = job.result.title ? `${job.result.platform.name} · ${job.result.title}` : t('pickerSub');
  $('#pickerGrid').replaceChildren(...items.map((it, i) => tile(job, it, i)));
  const note = [job.result.note, t('multiNote')].filter(Boolean).join(' ');
  $('#pickerNote').textContent = note;
  $('#pickerNote').hidden = !note;
  updateSel(job);
}

function tile(job, it, i) {
  const media = h('div', { class: 'media' });
  const src = safeHttp(it.thumb || (it.type === 'photo' ? it.url : null));
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(icon(it.type === 'photo' ? 'photo' : it.type === 'audio' ? 'audio' : 'video')), { once: true });
    media.append(img);
  } else if ((it.type === 'video' || it.type === 'gif') && it.kind === 'file' && safeHttp(it.url)) {
    const v = h('video', { src: `${it.url}#t=0.5`, muted: true, preload: 'metadata', playsinline: true });
    v.muted = true;
    v.addEventListener('error', () => v.replaceWith(icon('video')), { once: true });
    media.append(v);
  } else {
    media.append(icon(it.type === 'photo' ? 'photo' : it.type === 'audio' ? 'audio' : 'video'));
  }
  const extra = [it.label, it.duration ? formatDuration(it.duration) : '', it.kind === 'lazy' && !it.label ? t('playlistItem') : '']
    .filter(Boolean).join(' · ');
  const selected = job.sel.has(i);
  const li = h('li', { class: `tile${selected ? ' sel' : ''}`, tabindex: '0', role: 'checkbox', 'aria-checked': String(selected) },
    media,
    h('span', { class: 'type' }, typeLabel(it.type)),
    (() => { const c = icon('check'); c.className = 'check'; return c; })(),
    h('div', { class: 'cap' }, h('b', { title: it.name || '' }, it.name || it.filename || `#${i + 1}`), extra ? h('span', {}, extra) : null));
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
/* settings                                                            */
/* ------------------------------------------------------------------ */

function field(name) { return $('#settingsForm').elements.namedItem(name); }

function fillSettingsForm(s) {
  field('lang').value = s.lang;
  field('audioFormat').value = s.audioFormat;
  field('autoStart').checked = s.autoStart;
  field('cobalt').value = s.cobalt;
  field('corsProxy').value = s.corsProxy;
  field('piped').value = s.piped;
  field('invidious').value = s.invidious;
}

function openSettings() {
  fillSettingsForm(getSettings());
  $('#settingsDlg').showModal();
}

function syncQuickOptions() {
  const s = getSettings();
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === s.mode)));
  $('#qualitySel').value = s.quality;
  $('#autoChk').checked = s.autoDownload;
}

function refreshLanguage() {
  setLang(detectLang(getSettings().lang));
  applyI18n();
  $('#langBtn').textContent = getLang().toUpperCase();
  renderPlatforms();
  renderBookmarklet();
  if (pickerJob) renderPicker(pickerJob);
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
  const a = h('a', { class: 'bm', href: code, title: 'getvid', onclick: (e) => { e.preventDefault(); toast(t('tipMulti')); } }, 'getvid ⤓');
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
  if (!urls.length) { toast(t('errNoUrl')); return; }
  $('#input').value = '';
  autoGrow();
  for (const u of urls) {
    const job = createJob(u);
    setStatus(job, t('statusDetecting'));
    schedule(() => runJob(job));
  }
}

function isEditable(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function init() {
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* ignore */ }
  refreshLanguage();
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
      toast(t('clipboardDenied'));
      input.focus();
    }
  });

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { saveSettings({ mode: b.dataset.mode }); syncQuickOptions(); }));
  $('#qualitySel').addEventListener('change', (e) => saveSettings({ quality: e.target.value }));
  $('#autoChk').addEventListener('change', (e) => saveSettings({ autoDownload: e.target.checked }));

  $('#langBtn').addEventListener('click', () => { saveSettings({ lang: getLang() === 'pt' ? 'en' : 'pt' }); refreshLanguage(); });
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#settingsBtn').addEventListener('click', openSettings);

  // dialogs: close buttons + click on backdrop
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  });
  $('#picker').addEventListener('close', () => {
    const job = pickerJob;
    pickerJob = null;
    if (job && jobs.has(job.id) && !job.ctrl?.signal.aborted && job.ui.sub.hidden) setStatus(job, t('statusWaitingChoice'));
    setTimeout(nextPicker, 120);
  });
  $('#selAll').addEventListener('click', () => { if (!pickerJob) return; pickerJob.sel = new Set(pickerJob.result.items.map((_, i) => i)); renderPicker(pickerJob); });
  $('#selNone').addEventListener('click', () => { if (!pickerJob) return; pickerJob.sel = new Set(); renderPicker(pickerJob); });
  $('#dlSelBtn').addEventListener('click', () => startPicked(false));
  $('#zipBtn').addEventListener('click', () => startPicked(true));

  $('#settingsForm').addEventListener('submit', () => {
    saveSettings({
      lang: field('lang').value,
      audioFormat: field('audioFormat').value,
      autoStart: field('autoStart').checked,
      cobalt: field('cobalt').value.trim(),
      corsProxy: field('corsProxy').value.trim(),
      piped: field('piped').value.trim(),
      invidious: field('invidious').value.trim(),
    });
    refreshLanguage();
    toast(t('saved'));
  });
  $('#resetBtn').addEventListener('click', () => { fillSettingsForm(resetSettings()); syncQuickOptions(); });

  // Drag & drop a link anywhere on the page.
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

  // Links handed over by the bookmarklet or the mobile share sheet (?url= / ?text=).
  const params = new URLSearchParams(location.search);
  const incoming = ['url', 'text', 'title'].map((k) => params.get(k)).filter(Boolean).join('\n');
  if (incoming) {
    history.replaceState(null, '', location.pathname);
    submit(incoming);
  }
}

init();
