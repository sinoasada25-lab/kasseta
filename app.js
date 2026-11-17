'use strict';
/* Кассета — карманный ретро-плеер. Всё хранится в телефоне (IndexedDB), работает без интернета. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const audio = $('#audio');

const CARDS = ['c-red', 'c-black', 'c-yellow', 'c-blue', 'c-silver'];
const JCARDS = ['j-sunset', 'j-grid', 'j-stripe', 'j-chrome', 'j-teal', 'j-red'];
const STAINS = '<svg class="grain-soft" aria-hidden="true" style="opacity: .5"><rect width="100%" height="100%" filter="url(#paperF)"></rect></svg>';
const DOTS = '<svg aria-hidden="true" width="16" height="4" viewBox="0 0 16 4" fill="#3a3c3e"><circle cx="2" cy="2" r="1.6"></circle><circle cx="8" cy="2" r="1.6"></circle><circle cx="14" cy="2" r="1.6"></circle></svg>';

const S = {
  tracks: new Map(), order: [], playlists: [], recent: [],
  queue: [], qi: -1, cur: null, ctx: null,
  tab: 2, playerOpen: false, cassIn: false, seq: 0, url: null,
  hold: null, anim: null, dragging: false, openPl: null, menuId: null, menuCtx: null,
  unlocked: false
};

/* ---------- утилиты ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
function fmt2(sec) { sec = Math.max(0, Math.floor(sec || 0)); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function tilt(id) { return ((hash(id) % 11) - 5) / 10; }
function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b; return c; }
function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

let toastTimer;
function toast(msg, ms = 2200) {
  $('#toastText').textContent = msg.toUpperCase();
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), ms);
}

/* ---------- хранилище ---------- */
let db;
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('kasseta', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('tracks', { keyPath: 'id' }); d.createObjectStore('audio'); d.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('tx')); });
async function kvGet(k) { return rq(db.transaction('kv').objectStore('kv').get(k)); }
async function kvSet(k, v) { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); return txDone(t); }
async function saveLists() { await kvSet('order', S.order); await kvSet('playlists', S.playlists); await kvSet('recent', S.recent); }

function toBlob(v, type) { if (!v) return null; if (v instanceof Blob) return v; if (v.buf) return new Blob([v.buf], { type: v.type || type || '' }); return null; }
async function storable(blob) { if (!blob) return null; return { buf: await blob.arrayBuffer(), type: blob.type }; }

async function putTrack(t) {
  const rec = Object.assign({}, t);
  try { const tx = db.transaction('tracks', 'readwrite'); tx.objectStore('tracks').put(rec); await txDone(tx); }
  catch (e) {
    rec.cover = await storable(toBlob(t.cover)); rec.origCover = await storable(toBlob(t.origCover));
    const tx = db.transaction('tracks', 'readwrite'); tx.objectStore('tracks').put(rec); await txDone(tx);
  }
}
async function putAudio(id, blob) {
  try { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(blob, id); await txDone(tx); }
  catch (e) { const v = await storable(blob); const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(v, id); await txDone(tx); }
}
async function getAudioBlob(id) { const v = await rq(db.transaction('audio').objectStore('audio').get(id)); return toBlob(v, 'audio/mpeg'); }
async function deleteTrackData(id) { const tx = db.transaction(['tracks', 'audio'], 'readwrite'); tx.objectStore('tracks').delete(id); tx.objectStore('audio').delete(id); await txDone(tx); }

const coverUrls = new Map();
function coverURL(t) {
  if (!t || !t.cover) return null;
  if (!coverUrls.has(t.id)) coverUrls.set(t.id, URL.createObjectURL(toBlob(t.cover, 'image/jpeg')));
  return coverUrls.get(t.id);
}
function dropCoverURL(id) { const u = coverUrls.get(id); if (u) URL.revokeObjectURL(u); coverUrls.delete(id); }

/* ---------- чтение тегов ---------- */
const ss = (b, i) => ((b[i] & 127) << 21) | ((b[i + 1] & 127) << 14) | ((b[i + 2] & 127) << 7) | (b[i + 3] & 127);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
function decodeText(enc, data) {
  try {
    let s;
    if (enc === 0) {
      let ascii = true; for (const x of data) if (x > 127) { ascii = false; break; }
      s = new TextDecoder(ascii ? 'utf-8' : 'windows-1251').decode(data);
    } else if (enc === 1) {
      const be = data[0] === 0xFE && data[1] === 0xFF;
      s = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(data);
    } else if (enc === 2) s = new TextDecoder('utf-16be').decode(data);
    else s = new TextDecoder('utf-8').decode(data);
    return s.replace(/^﻿/, '').replace(/\u0000+$/g, '').replace(/\u0000/g, ', ').trim();
  } catch (e) { return ''; }
}
async function readTags(file) {
  const r = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 73 || head[1] !== 68 || head[2] !== 51) return r;
    const ver = head[3], flags = head[5], size = ss(head, 6);
    if (ver < 3 || ver > 4) return r;
    const b = new Uint8Array(await file.slice(0, 10 + size).arrayBuffer());
    let pos = 10;
    if (flags & 0x40) pos += ver === 4 ? ss(b, 10) : u32(b, 10) + 4;
    const end = Math.min(10 + size, b.length);
    while (pos + 10 <= end) {
      const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? ss(b, pos + 4) : u32(b, pos + 4);
      const st = pos + 10;
      if (fs <= 0 || st + fs > end) break;
      const fr = b.subarray(st, st + fs);
      if (id === 'TIT2') r.title = decodeText(fr[0], fr.subarray(1));
      else if (id === 'TPE1') r.artist = decodeText(fr[0], fr.subarray(1));
      else if (id === 'APIC' && !r.cover) {
        const enc = fr[0]; let i = 1;
        while (i < fr.length && fr[i] !== 0) i++;
        let mime = new TextDecoder('latin1').decode(fr.subarray(1, i)).toLowerCase(); i++;
        i++; // тип картинки
        if (enc === 1 || enc === 2) { while (i + 1 < fr.length && !(fr[i] === 0 && fr[i + 1] === 0)) i += 2; i += 2; }
        else { while (i < fr.length && fr[i] !== 0) i++; i++; }
        if (!mime.includes('/')) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
        if (mime === 'image/jpg') mime = 'image/jpeg';
        if (i < fr.length) r.cover = new Blob([fr.slice(i)], { type: mime });
      }
      pos = st + fs;
    }
  } catch (e) { console.warn('tags', e); }
  return r;
}
function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio(); const u = URL.createObjectURL(blob); let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(tm); const d = isFinite(a.duration) ? a.duration : 0; a.removeAttribute('src'); URL.revokeObjectURL(u); res(d); };
    const tm = setTimeout(fin, 4000);
    a.preload = 'metadata'; a.onloadedmetadata = fin; a.onerror = fin; a.src = u;
  });
}
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|mp4|caf)$/i;
function guessType(n) {
  const e = (n.split('.').pop() || '').toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' })[e] || 'audio/mpeg';
}

/* ---------- запись (импорт) ---------- */
async function importFiles(files) {
  const list = Array.from(files).filter(f => (f.type && f.type.startsWith('audio')) || AUDIO_EXT.test(f.name));
  if (!list.length) { toast('Это не аудиофайлы'); return; }
  $('#recLed').classList.add('recblink');
  let added = 0, skipped = 0, i = 0;
  for (const f of list) {
    i++;
    $('#recStatus').textContent = `Запись ${i}/${list.length}…`;
    try {
      if (Array.from(S.tracks.values()).some(t => t.fname === f.name && t.size === f.size)) { skipped++; continue; }
      const type = f.type || guessType(f.name);
      const blob = new Blob([f], { type });
      const tags = await readTags(f);
      const dur = await probeDuration(blob);
      const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      let title = tags.title, artist = tags.artist || '';
      if (!title) { const m = base.split(/\s+[-–—]\s+/); if (m.length > 1) { artist = artist || m[0]; title = m.slice(1).join(' - '); } else title = base; }
      const id = uid('t');
      const t = { id, title, artist, dur, fname: f.name, size: f.size, type, added: Date.now(), card: CARDS[hash(id) % CARDS.length], loop: false, cover: tags.cover || null, origCover: tags.cover || null };
      await putAudio(id, blob);
      await putTrack(t);
      S.tracks.set(id, t); S.order.unshift(id); S.recent.unshift(id); S.recent = S.recent.slice(0, 6);
      await saveLists();
      added++;
      renderRecent(); renderShelf(); renderPlaylists();
    } catch (e) { console.error(e); toast('Не записалось: ' + f.name); }
  }
  $('#recLed').classList.remove('recblink');
  $('#recStatus').textContent = 'Запись · rec';
  updateStorage();
  if (added) toast(`Записано: ${added} ${plural(added, 'трек', 'трека', 'треков')}` + (skipped ? ` · уже были: ${skipped}` : ''));
  else if (skipped) toast('Эти треки уже на полке');
}

/* ---------- отрисовка ---------- */
function spineEl(t) {
  const el = document.createElement('div');
  el.className = 'spine' + (t.id === S.cur ? ' now' : '');
  el.dataset.id = t.id;
  el.dataset.tilt = tilt(t.id);
  el.style.transform = `rotate(${el.dataset.tilt}deg)`;
  el.innerHTML = `<div class="jc ${t.card}"><div class="jc-stripe"></div><div class="jc-label"><span class="hand"></span><span class="led nowled on"></span></div><span class="typed"></span>${STAINS}</div><div class="gloss"></div><button class="knob" aria-label="Настройки трека"><span class="knob-cap">${DOTS}</span></button>`;
  el.querySelector('.hand').textContent = t.title;
  el.querySelector('.typed').textContent = fmt(t.dur);
  const cu = coverURL(t);
  if (cu) { const s = el.querySelector('.jc-stripe'); s.classList.add('cover'); s.style.backgroundImage = `url("${cu}")`; }
  return el;
}
function emptyNote(text) { return `<div class="paper empty-note">${STAINS}<div class="hand">${text}</div></div>`; }

function renderShelf() {
  const box = $('#shelf'); box.innerHTML = '';
  const ids = S.order.filter(id => S.tracks.has(id));
  $('#shelfCount').textContent = `Полка · ${ids.length} ${plural(ids.length, 'кассета', 'кассеты', 'кассет')}`;
  if (!ids.length) { box.innerHTML = emptyNote('Полка пустая. Открой «Папку» и жми красную кнопку — добавь свои треки.'); return; }
  ids.forEach(id => box.appendChild(spineEl(S.tracks.get(id))));
}
function renderPlShelf() {
  const pl = S.playlists.find(p => p.id === S.openPl); if (!pl) return;
  $('#plName').textContent = pl.name;
  const box = $('#plShelf'); box.innerHTML = '';
  pl.tracks = pl.tracks.filter(id => S.tracks.has(id));
  if (!pl.tracks.length) { box.innerHTML = emptyNote('Кассета пустая. На «Главной» зажми трек и брось на эту кассету, или ⋯ → «В плейлист».'); return; }
  pl.tracks.forEach(id => box.appendChild(spineEl(S.tracks.get(id))));
}
function caseEl(p) {
  const el = document.createElement('button');
  el.className = 'case bare'; el.dataset.pl = p.id;
  el.style.transform = `rotate(${tilt(p.id) * 1.2}deg)`;
  const n = p.tracks.filter(id => S.tracks.has(id)).length;
  el.innerHTML = `<div class="hinge"></div><div class="jcf ${p.style}"><div class="jl"><span class="hand case-name"></span></div><span class="jt typed">C-90 · ${n} ${plural(n, 'трек', 'трека', 'треков')}</span>${STAINS}</div><div class="case-gloss"></div>`;
  el.querySelector('.case-name').textContent = p.name;
  return el;
}
function renderPlaylists() {
  const g = $('#plGrid'); g.innerHTML = '';
  S.playlists.forEach(p => g.appendChild(caseEl(p)));
  const add = document.createElement('button');
  add.className = 'case bare'; add.id = 'plNew'; add.style.background = '#1c1c1e';
  add.innerHTML = '<div class="hinge"></div><div style="position: absolute; left: 16px; right: 5px; top: 5px; bottom: 5px; border: 1px dashed rgba(233,226,208,.35); display: flex; align-items: center; justify-content: center"><span class="hand" style="font-size: 22px; color: #e9e2d0">+ новая кассета</span></div><div class="case-gloss"></div>';
  g.appendChild(add);
  if (S.openPl) renderPlShelf();
}
function renderRecent() {
  const box = $('#recentList'); box.innerHTML = '';
  const ids = S.recent.filter(id => S.tracks.has(id));
  if (!ids.length) { box.innerHTML = '<div class="recent-row"><span class="hand" style="color: #6a5a40">пока пусто…</span></div>'; return; }
  ids.forEach(id => {
    const t = S.tracks.get(id);
    const r = document.createElement('div'); r.className = 'recent-row';
    r.innerHTML = '<span class="hand"></span><span class="typed"></span>';
    r.firstChild.textContent = t.title;
    r.lastChild.textContent = t.origCover ? 'обложка: из файла' : 'обложка: нет';
    box.appendChild(r);
  });
}
function markNow() { $$('.spine').forEach(el => el.classList.toggle('now', el.dataset.id === S.cur)); }
function renderAll() { renderShelf(); renderPlaylists(); renderRecent(); renderNow(); }

async function updateStorage() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const e = await navigator.storage.estimate();
    const mb = (e.usage || 0) / 1048576;
    $('#storeInfo').textContent = `На полке ${S.tracks.size} ${plural(S.tracks.size, 'трек', 'трека', 'треков')} · занято ${mb < 1024 ? mb.toFixed(0) + ' МБ' : (mb / 1024).toFixed(1) + ' ГБ'}`;
  } catch (e) { }
}

/* ---------- вкладки и свайп ---------- */
const track = $('#track');
function goTab(i, anim = true) {
  S.tab = clamp(i, 0, 2);
  track.style.transition = anim ? '' : 'none';
  track.style.transform = `translateX(${-S.tab * 100 / 3}%)`;
  $$('.tab').forEach((b, k) => { b.querySelector('.led').classList.toggle('on', k === S.tab); b.querySelector('.tab-key').classList.toggle('on', k === S.tab); });
}
$$('.tab').forEach(b => b.addEventListener('click', () => goTab(+b.dataset.tab)));
(function swipe() {
  const box = $('#screens'); let st = null;
  box.addEventListener('touchstart', (e) => {
    if (S.dragging || e.touches.length > 1) return;
    const t = e.touches[0]; st = { x: t.clientX, y: t.clientY, dx: 0, dir: null, t0: Date.now() };
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!st || S.dragging) { st = null; return; }
    const t = e.touches[0]; const dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.dir) { if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) st.dir = 'h'; else if (Math.abs(dy) > 12) st.dir = 'v'; }
    if (st.dir !== 'h') return;
    e.preventDefault();
    const W = box.clientWidth; let off = dx;
    if ((S.tab === 0 && dx > 0) || (S.tab === 2 && dx < 0)) off = dx / 3;
    st.dx = dx; track.style.transition = 'none';
    track.style.transform = `translateX(${-S.tab * W + off}px)`;
  }, { passive: false });
  const end = () => {
    if (!st) return;
    if (st.dir === 'h') {
      const W = box.clientWidth; const v = Math.abs(st.dx) / Math.max(1, Date.now() - st.t0);
      let i = S.tab; if (st.dx < -W * 0.22 || (st.dx < -30 && v > 0.5)) i++; else if (st.dx > W * 0.22 || (st.dx > 30 && v > 0.5)) i--;
      goTab(i);
    }
    st = null;
  };
  box.addEventListener('touchend', end); box.addEventListener('touchcancel', end);
})();

/* ---------- полка: тап, ручка, зажать-и-тащить ---------- */
function attachShelf(box, getCtx) {
  let st = null, lastTouch = 0;
  const begin = (x, y, target) => {
    const sp = target.closest('.spine'); if (!sp || !box.contains(sp)) return;
    st = { sp, knob: !!target.closest('.knob'), x0: x, y0: y, x, y, moved: false, drag: false, scroll0: scroller().scrollTop };
    st.timer = setTimeout(() => { if (st && !st.moved) startDrag(); }, 380);
  };
  const scroller = () => box.closest('.content');
  const move = (x, y, e) => {
    if (!st) return; st.x = x; st.y = y;
    if (!st.drag) { if (Math.hypot(x - st.x0, y - st.y0) > 9) { st.moved = true; clearTimeout(st.timer); } return; }
    if (e && e.cancelable) e.preventDefault();
    updDrag();
  };
  const finish = () => {
    if (!st) return; clearTimeout(st.timer);
    const s = st; st = null;
    if (s.drag) { endDrag(s); return; }
    if (s.moved) return;
    const id = s.sp.dataset.id;
    if (s.knob) { const cap = s.sp.querySelector('.knob-cap'); cap.style.transition = 'transform .3s'; cap.style.transform = 'rotate(120deg)'; setTimeout(() => { cap.style.transform = ''; }, 500); openMenu(id, getCtx()); }
    else { const ids = getCtx().ids(); playFrom(ids, ids.indexOf(id), getCtx()); }
  };
  function startDrag() {
    const s = st; s.drag = true; S.dragging = true;
    s.rows = $$('.spine', box); s.idx = s.rows.indexOf(s.sp); s.ti = s.idx;
    s.rowH = s.rows.length > 1 ? s.rows[1].offsetTop - s.rows[0].offsetTop : s.sp.offsetHeight + 8;
    const r = s.sp.getBoundingClientRect(); s.r0 = r;
    const g = s.sp.cloneNode(true); g.classList.add('ghost');
    g.style.cssText = `position: fixed; left: ${r.left}px; top: ${r.top}px; width: ${r.width}px; height: ${r.height}px; margin: 0; z-index: 55; pointer-events: none; transition: none; transform: scale(1.05) rotate(-2deg); box-shadow: 0 16px 26px rgba(0,0,0,.9)`;
    document.body.appendChild(g); s.ghost = g;
    s.rows.forEach(rw => { rw.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1), opacity .2s'; });
    s.sp.style.opacity = '.3';
    showDropBar(getCtx());
    updDrag();
    s.auto = setInterval(() => {
      if (!st || !st.drag) return;
      const sc = scroller(), rr = sc.getBoundingClientRect();
      if (st.y > rr.bottom - 150) sc.scrollTop += 8; else if (st.y < rr.top + 60 && !$('#dropBar').classList.contains('show')) sc.scrollTop -= 8; else return;
      updDrag();
    }, 16);
  }
  function updDrag() {
    const s = st; if (!s) return;
    const fx = s.x - s.x0, fy = s.y - s.y0;
    const dy = fy + (scroller().scrollTop - s.scroll0);
    const hot = hitDrop(s.x, s.y);
    s.ghost.style.transition = 'opacity .15s';
    s.ghost.style.opacity = hot ? '.55' : '1';
    s.ghost.style.transform = `translate(${fx}px, ${fy}px) scale(${hot ? .55 : 1.05}) rotate(-2deg)`;
    const n = s.rows.length;
    const ti = hot ? s.idx : clamp(s.idx + Math.round(dy / s.rowH), 0, n - 1); s.ti = ti;
    s.rows.forEach((r, i) => {
      let sh = 0;
      if (i === s.idx) sh = (ti - s.idx) * s.rowH;
      else if (s.idx < ti && i > s.idx && i <= ti) sh = -s.rowH;
      else if (s.idx > ti && i < s.idx && i >= ti) sh = s.rowH;
      r.style.transform = `translateY(${sh}px) rotate(${r.dataset.tilt}deg)`;
    });
  }
  async function endDrag(s) {
    clearInterval(s.auto); S.dragging = false;
    const hot = hitDrop(s.x, s.y); hideDropBar();
    const ctx = getCtx(); const id = s.sp.dataset.id; const g = s.ghost;
    if (hot) {
      g.style.transition = 'transform .35s ease-in, opacity .35s'; g.style.opacity = '0';
      g.style.transform += ' scale(.3)';
      await addToPlaylist(id, hot, ctx.type === 'pl' ? ctx.id : null);
      setTimeout(() => { g.remove(); ctx.render(); }, 360);
      return;
    }
    const arr = ctx.list();
    const from = arr.indexOf(id);
    if (from >= 0 && s.ti !== s.idx) {
      const realTo = clamp(from + (s.ti - s.idx), 0, arr.length - 1);
      arr.splice(from, 1); arr.splice(realTo, 0, id);
      await saveLists();
    }
    const tr = s.sp.getBoundingClientRect();
    g.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    g.style.transform = `translate(${tr.left - s.r0.left}px, ${tr.top - s.r0.top}px)`;
    setTimeout(() => { g.remove(); ctx.render(); }, 230);
  }
  box.addEventListener('touchstart', (e) => { lastTouch = Date.now(); const t = e.touches[0]; begin(t.clientX, t.clientY, e.target); }, { passive: true });
  box.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY, e); }, { passive: false });
  box.addEventListener('touchend', (e) => { lastTouch = Date.now(); if (st && !st.moved && e.cancelable) e.preventDefault(); finish(); }, { passive: false });
  box.addEventListener('touchcancel', () => { if (st && st.drag) finish(); else { if (st) clearTimeout(st.timer); st = null; } });
  box.addEventListener('mousedown', (e) => { if (Date.now() - lastTouch < 800) return; begin(e.clientX, e.clientY, e.target); });
  window.addEventListener('mousemove', (e) => { if (Date.now() - lastTouch < 800) return; move(e.clientX, e.clientY, e); });
  window.addEventListener('mouseup', () => { if (Date.now() - lastTouch < 800) return; finish(); });
  box.addEventListener('contextmenu', (e) => e.preventDefault());
}
const ctxAll = { type: 'all', list: () => S.order, ids: () => S.order.filter(id => S.tracks.has(id)), render: () => renderShelf() };
const ctxPl = () => {
  const pl = S.playlists.find(p => p.id === S.openPl) || { tracks: [] };
  return { type: 'pl', id: pl.id, list: () => pl.tracks, ids: () => pl.tracks.filter(id => S.tracks.has(id)), render: () => { renderPlShelf(); renderPlaylists(); } };
};
attachShelf($('#shelf'), () => ctxAll);
attachShelf($('#plShelf'), ctxPl);

/* ---------- кассеты-цели при перетаскивании ---------- */
function showDropBar(ctx) {
  const targets = S.playlists.filter(p => !(ctx.type === 'pl' && p.id === ctx.id));
  const box = $('#dropTargets'); box.innerHTML = '';
  if (!targets.length) return;
  targets.forEach(p => {
    const m = document.createElement('div'); m.className = 'mini ' + p.style; m.dataset.pl = p.id;
    m.innerHTML = '<div class="jl"><span class="hand"></span></div><div class="case-gloss"></div>';
    m.querySelector('.hand').textContent = p.name; box.appendChild(m);
  });
  $('#dropBar').classList.add('show');
}
function hideDropBar() { $('#dropBar').classList.remove('show'); $$('.mini').forEach(m => m.classList.remove('hot')); }
function hitDrop(x, y) {
  if (!$('#dropBar').classList.contains('show')) return null;
  let hit = null;
  $$('.mini').forEach(m => { const r = m.getBoundingClientRect(); const on = x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 10 && y <= r.bottom + 14; m.classList.toggle('hot', on); if (on) hit = m.dataset.pl; });
  return hit;
}
async function addToPlaylist(id, plId, fromPlId) {
  const pl = S.playlists.find(p => p.id === plId); if (!pl) return;
  if (!pl.tracks.includes(id)) pl.tracks.push(id);
  if (fromPlId) { const from = S.playlists.find(p => p.id === fromPlId); if (from) from.tracks = from.tracks.filter(x => x !== id); }
  await saveLists(); renderPlaylists();
  const c = $(`.case[data-pl="${pl.id}"]`); if (c) restartAnim(c, 'bump');
  toast((fromPlId ? 'Перенёс в «' : 'Добавил в «') + pl.name + '»');
}

/* ---------- плейлисты ---------- */
$('#plGrid').addEventListener('click', (e) => {
  const c = e.target.closest('.case'); if (!c) return;
  if (c.id === 'plNew') { newPlaylist(); return; }
  openPlaylist(c.dataset.pl);
});
function newPlaylist(after) {
  dialog('Новая кассета', `<input class="paper-input" id="dlgIn" maxlength="40" placeholder="название…">`, [
    { label: 'Отмена' },
    { label: 'Создать', main: true, run: async () => {
      const name = ($('#dlgIn').value || '').trim() || 'Без названия';
      const p = { id: uid('p'), name, style: JCARDS[S.playlists.length % JCARDS.length], tracks: [] };
      S.playlists.push(p); await saveLists(); renderPlaylists(); if (after) after(p);
    } }
  ]);
  setTimeout(() => { const i = $('#dlgIn'); if (i) i.focus(); }, 60);
}
function openPlaylist(id) { S.openPl = id; renderPlShelf(); $('#plView').classList.add('open'); }
$('#plBack').addEventListener('click', () => { $('#plView').classList.remove('open'); S.openPl = null; });
$('#plPlay').addEventListener('click', () => { const c = ctxPl(); const ids = c.ids(); if (!ids.length) return toast('Кассета пустая'); playFrom(ids, 0, c); });
$('#plShuffle').addEventListener('click', () => { const c = ctxPl(); const ids = shuffle(c.ids()); if (!ids.length) return toast('Кассета пустая'); playFrom(ids, 0, c); });
$('#plMore').addEventListener('click', () => {
  const pl = S.playlists.find(p => p.id === S.openPl); if (!pl) return;
  dialog('Кассета', `<input class="paper-input" id="dlgIn" maxlength="40">`, [
    { label: 'Удалить', danger: true, run: async () => {
      S.playlists = S.playlists.filter(p => p.id !== pl.id); await saveLists();
      $('#plView').classList.remove('open'); S.openPl = null; renderPlaylists(); toast('Кассета удалена · треки остались на полке');
    } },
    { label: 'Сохранить', main: true, run: async () => { pl.name = ($('#dlgIn').value || '').trim() || pl.name; await saveLists(); renderPlaylists(); } }
  ]);
  $('#dlgIn').value = pl.name;
});

/* ---------- диалог ---------- */
function dialog(title, bodyHtml, buttons) {
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = bodyHtml;
  const bb = $('#dlgBtns'); bb.innerHTML = '';
  buttons.forEach(b => {
    const el = document.createElement('button');
    el.className = b.danger ? 'redbtn' : 'chrome-btn';
    if (b.danger) { el.style.cssText = 'width: auto; padding: 0 14px; color: #fff; font-family: Oswald, sans-serif; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; font-size: 12px; height: 42px'; }
    el.textContent = b.label;
    el.addEventListener('click', async () => { if (b.run) { const keep = await b.run(); if (keep === true) return; } closeDialog(); });
    bb.appendChild(el);
  });
  $('#dlgOv').classList.add('open');
}
function closeDialog() { $('#dlgOv').classList.remove('open'); }
$('#dlgOv').addEventListener('click', (e) => { if (e.target.id === 'dlgOv') closeDialog(); });
$('#dlgX').addEventListener('click', closeDialog);

/* ---------- меню трека ---------- */
let delArmed = null;
function openMenu(id, ctx) {
  const t = S.tracks.get(id); if (!t) return;
  S.menuId = id; S.menuCtx = ctx;
  fillMenu();
  $('#mOutRow').style.display = ctx && ctx.type === 'pl' ? '' : 'none';
  disarmDel();
  S.menuAt = Date.now();
  $('#sheetOv').classList.add('open'); $('#sheet').classList.add('open');
}
function fillMenu() {
  const t = S.tracks.get(S.menuId); if (!t) return;
  $('#mTitle').textContent = t.title; $('#mArtist').textContent = t.artist || 'без названия';
  $('#mDur').textContent = fmt2(t.dur);
  const cu = coverURL(t);
  const pic = $('#mPic'); pic.className = 'pic' + (cu ? '' : ' pic-a'); pic.style.backgroundImage = cu ? `url("${cu}")` : '';
  $('#mLed').classList.toggle('on', !!t.loop);
  $('#mLever').style.transform = t.loop ? 'rotate(-14deg)' : 'rotate(194deg)';
  $('#mOrig').style.display = t.origCover && t.cover !== t.origCover ? '' : 'none';
}
function closeMenu() { $('#sheetOv').classList.remove('open'); $('#sheet').classList.remove('open'); disarmDel(); }
$('#sheetOv').addEventListener('click', () => { if (Date.now() - S.menuAt > 450) closeMenu(); });
$('#mClose').addEventListener('click', closeMenu);
$('#mLoop').addEventListener('click', async () => {
  const t = S.tracks.get(S.menuId); if (!t) return;
  t.loop = !t.loop; await putTrack(t); fillMenu();
  if (t.id === S.cur) { updateKeys(); if (t.loop && !audio.paused) rewindAnim(); }
});
$('#mPhoto').addEventListener('click', () => $('#imgIn').click());
$('#imgIn').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const t = S.tracks.get(S.menuId); if (!t) return;
  try {
    t.cover = await shrinkImage(f, 700); dropCoverURL(t.id); await putTrack(t);
    fillMenu(); renderAll(); if (t.id === S.cur) setMediaMeta(t); toast('Обложка на месте');
  } catch (err) { toast('Не получилось открыть фото'); }
});
$('#mOrig').addEventListener('click', async () => {
  const t = S.tracks.get(S.menuId); if (!t || !t.origCover) return;
  t.cover = t.origCover; dropCoverURL(t.id); await putTrack(t); fillMenu(); renderAll(); if (t.id === S.cur) setMediaMeta(t);
});
function shrinkImage(file, max) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
      c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('img')); };
    img.src = u;
  });
}
$('#mPl').addEventListener('click', () => {
  const id = S.menuId;
  const draw = () => {
    let h = S.playlists.map(p => {
      const inIt = p.tracks.includes(id);
      return `<button class="chrome-btn pick" data-pl="${p.id}"><span class="case-name" style="max-width: 170px">${esc(p.name)}</span><span class="st ${inIt ? 'in' : 'out'}">${inIt ? '✓ УЖЕ ТУТ · УБРАТЬ' : '+ ДОБАВИТЬ'}</span></button>`;
    }).join('');
    h += `<button class="chrome-btn pick" data-new="1"><span>+ Новая кассета</span><span></span></button>`;
    $('#dlgBody').innerHTML = h;
  };
  dialog('В плейлист', '', [{ label: 'Готово', main: true }]);
  draw();
  $('#dlgBody').onclick = async (e) => {
    const b = e.target.closest('.pick'); if (!b) return;
    if (b.dataset.new) { newPlaylist(async (p) => { p.tracks.push(id); await saveLists(); renderPlaylists(); toast('Добавил в «' + p.name + '»'); }); return; }
    const p = S.playlists.find(x => x.id === b.dataset.pl); if (!p) return;
    if (p.tracks.includes(id)) { p.tracks = p.tracks.filter(x => x !== id); toast('Убрал из «' + p.name + '»'); }
    else { p.tracks.push(id); toast('Добавил в «' + p.name + '»'); }
    await saveLists(); renderPlaylists(); draw();
    const c = $(`.case[data-pl="${p.id}"]`); if (c) restartAnim(c, 'bump');
  };
});
$('#mRename').addEventListener('click', () => {
  const t = S.tracks.get(S.menuId); if (!t) return;
  dialog('Название', `<input class="paper-input" id="dlgIn" maxlength="80" placeholder="название"><input class="paper-input" id="dlgIn2" maxlength="80" placeholder="исполнитель">`, [
    { label: 'Отмена' },
    { label: 'Сохранить', main: true, run: async () => {
      t.title = ($('#dlgIn').value || '').trim() || t.title; t.artist = ($('#dlgIn2').value || '').trim();
      await putTrack(t); fillMenu(); renderAll(); if (t.id === S.cur) { renderLabel(t); setMediaMeta(t); }
    } }
  ]);
  $('#dlgIn').value = t.title; $('#dlgIn2').value = t.artist || '';
});
$('#mOut').addEventListener('click', async () => {
  const ctx = S.menuCtx; if (!ctx || ctx.type !== 'pl') return;
  const p = S.playlists.find(x => x.id === ctx.id); if (!p) return;
  p.tracks = p.tracks.filter(x => x !== S.menuId); await saveLists(); renderPlaylists(); closeMenu(); toast('Убрал из «' + p.name + '»');
});
function disarmDel() { clearTimeout(delArmed); delArmed = null; $('#mDel').classList.remove('armed'); $('#mDelLbl').textContent = 'Удалить песню'; }
$('#mDel').addEventListener('click', async () => {
  if (!delArmed) { $('#mDel').classList.add('armed'); $('#mDelLbl').textContent = 'Точно? Жми ещё'; delArmed = setTimeout(disarmDel, 3000); return; }
  const id = S.menuId; disarmDel(); closeMenu();
  if (id === S.cur) stopAll(true);
  S.tracks.delete(id); dropCoverURL(id);
  S.order = S.order.filter(x => x !== id); S.recent = S.recent.filter(x => x !== id);
  S.playlists.forEach(p => p.tracks = p.tracks.filter(x => x !== id));
  S.queue = S.queue.filter(x => x !== id); S.qi = S.queue.indexOf(S.cur);
  await deleteTrackData(id); await saveLists(); renderAll(); updateStorage(); toast('Удалено');
});

/* ---------- звук: разблокировка на iPhone ---------- */
const SILENT = (() => {
  const sr = 8000, n = 400, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(b, 44).fill(128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();
function unlock() {
  if (S.unlocked) return; S.unlocked = true;
  if (audio.src) return;
  audio.src = SILENT; S.silent = true;
  const p = audio.play(); if (p) p.then(() => { if (S.silent) audio.pause(); }).catch(() => { });
}
document.addEventListener('touchend', unlock, { capture: true, passive: true });
document.addEventListener('click', unlock, { capture: true });

/* ---------- плеер ---------- */
const cass = $('#cass'), door = $('#door');
function fitStage() { const b = $('#stageBox'); const w = b.clientWidth || window.innerWidth, h = b.clientHeight || window.innerHeight; const s = Math.min(w / 390, h / 844); $('#stage').style.setProperty('--s', s.toFixed(4)); }
window.addEventListener('resize', fitStage); window.addEventListener('orientationchange', () => setTimeout(fitStage, 300)); fitStage(); setTimeout(fitStage, 300);
function openPlayer() { fitStage(); S.playerOpen = true; $('#player').classList.add('open'); }
function closePlayer() { S.playerOpen = false; $('#player').classList.remove('open'); }
$('#pBack').addEventListener('click', closePlayer);
$('#vfd').addEventListener('click', () => { if (S.cur) openPlayer(); else { toast('Сначала выбери трек на полке'); } });
$('#pEject').addEventListener('click', async () => { await stopAll(false); closePlayer(); });
$('#shuffleAll').addEventListener('click', () => { const ids = shuffle(ctxAll.ids()); if (!ids.length) return toast('Полка пустая'); playFrom(ids, 0, ctxAll); });

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const animOK = () => !document.hidden && S.playerOpen;

function renderLabel(t) {
  $('#cassTitle').textContent = t ? t.title : '';
  $('#pTitle').textContent = t ? t.title : '—';
  $('#pArtist').textContent = t ? (t.artist || 'без названия') : '—';
  $('#tDur').textContent = fmt(t && t.dur);
}
async function cassetteOut() {
  if (!S.cassIn) return;
  S.cassIn = false;
  if (animOK()) { door.className = 'opened'; await sleep(250); restartAnim(cass, 'eject'); await sleep(450); }
  cass.className = 'out';
}
async function cassetteIn() {
  S.cassIn = true;
  if (animOK()) { cass.className = ''; door.className = ''; restartAnim(cass, 'in'); restartAnim(door, 'closing'); await sleep(1300); }
  cass.className = ''; door.className = '';
}

async function playFrom(ids, i, ctx) {
  if (!ids.length || i < 0) return;
  S.queue = ids.slice(); S.ctx = ctx;
  const wasOpen = S.playerOpen;
  openPlayer();
  if (!wasOpen && !document.hidden) await sleep(420);
  startTrack(i);
}
async function startTrack(i, opts = {}) {
  if (i < 0 || i >= S.queue.length) return;
  const seq = ++S.seq;
  S.qi = i; const id = S.queue[i]; const t = S.tracks.get(id); if (!t) return;
  stopHold(true); S.anim = null;
  setMode('load');
  const blob = await getAudioBlob(id);
  if (seq !== S.seq) return;
  if (!blob) { toast('Файл трека не найден'); return; }
  S.silent = false;
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(blob);
  audio.src = S.url; audio.load();
  S.cur = id; markNow(); setMediaMeta(t);
  if (animOK()) {
    await cassetteOut(); if (seq !== S.seq) return;
    renderLabel(t);
    await cassetteIn(); if (seq !== S.seq) return;
  } else { renderLabel(t); S.cassIn = true; cass.className = ''; door.className = ''; }
  updateTime(); renderNow();
  try { await audio.play(); }
  catch (e) { setMode('pause'); toast('Нажми ▶ чтобы играть'); }
}
async function stopAll(quick) {
  S.seq++; stopHold(true); S.anim = null;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  S.cur = null; S.queue = []; S.qi = -1;
  setMode('stop'); markNow(); renderNow();
  if (!quick) await cassetteOut(); else { S.cassIn = false; cass.className = 'out'; door.className = 'opened'; }
  renderLabel(null); updateTime();
  if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
}
function nextTrack(auto) {
  if (!S.queue.length) return;
  if (S.qi + 1 < S.queue.length) startTrack(S.qi + 1);
  else if (auto) { setMode('stop'); audio.currentTime = 0; updateTime(); }
  else startTrack(0);
}
function prevTrack() { if (!S.queue.length) return; startTrack(S.qi > 0 ? S.qi - 1 : S.queue.length - 1); }

/* состояние клавиш и бобин */
function setMode(m) { S.mode = m; updateKeys(); }
function updateKeys() {
  const t = S.tracks.get(S.cur);
  const k = (id, on) => $('#k-' + id).classList.toggle('down', !!on);
  const hold = S.hold && S.hold.active ? S.hold.dir : 0;
  k('play', S.mode === 'play' && !hold && S.anim !== 'rew');
  k('pause', S.mode === 'pause');
  k('rew', hold < 0);
  k('ff', hold > 0);
  k('loop', t && t.loop);
  $('#ledLoop').classList.toggle('on', !!(t && t.loop));
  let rc = 'reel';
  if (hold < 0 || S.anim === 'rew') rc = 'reel spin-rew';
  else if (hold > 0) rc = 'reel spin-ff';
  else if (S.mode === 'play') rc = 'reel spin';
  else if (S.mode === 'pause') rc = 'reel spin paused';
  $$('#cass .reel').forEach(r => { if (r.getAttribute('class') !== rc) r.setAttribute('class', rc); });
  const on = S.mode === 'play' && !hold;
  $('#vfd').classList.toggle('on', on);
  $('#vfdState').textContent = S.cur ? (hold < 0 || S.anim === 'rew' ? '<< ПЕРЕМОТКА' : hold > 0 ? '>> ВПЕРЁД' : S.mode === 'play' ? '> СЕЙЧАС ИГРАЕТ' : S.mode === 'load' ? '… ВСТАВКА' : S.mode === 'pause' ? '|| ПАУЗА' : '■ СТОП') : '> ВСТАВЬ КАССЕТУ';
  renderMini();
}
function updateTime() {
  const d = audio.duration && isFinite(audio.duration) ? audio.duration : ((S.tracks.get(S.cur) || {}).dur || 0);
  const c = S.cur ? audio.currentTime || 0 : 0;
  $('#tCur').textContent = fmt(c);
  if (d) $('#tDur').textContent = fmt(d);
  const g = $('#groove'); const w = g.clientWidth - 24;
  $('#gKnob').style.left = (d ? clamp(c / d, 0, 1) * w : 0) + 'px';
  $('#vfdTime').textContent = fmt2(c) + ' / ' + fmt2(d);
}
function renderMini() {
  const t = S.tracks.get(S.cur);
  document.body.classList.toggle('has-mini', !!t);
  if (!t) return;
  $('#miniTitle').textContent = (t.title + (t.artist ? ' · ' + t.artist : '')).toUpperCase();
  const playing = S.mode === 'play';
  $('#miniIco').innerHTML = playing ? '<rect x="1" y="1" width="4" height="14"></rect><rect x="9" y="1" width="4" height="14"></rect>' : '<path d="M1 1l12 7-12 7z"></path>';
  $$('#mini .reel').forEach(r => r.setAttribute('class', playing ? 'reel spin' : 'reel'));
}
$('#mini').addEventListener('click', (e) => {
  if (e.target.closest('#miniPP')) {
    if (S.mode === 'play') { audio.pause(); setMode('pause'); }
    else if (S.cur) { if (S.mode === 'stop') audio.currentTime = 0; audio.play().catch(() => toast('Нажми ▶ в деке')); }
    return;
  }
  openPlayer();
});
function renderNow() {
  const t = S.tracks.get(S.cur);
  $('#vfdTitle').textContent = t ? (t.title + (t.artist ? ' · ' + t.artist : '')).toUpperCase() : '— — —';
  updateKeys(); updateTime();
}

audio.addEventListener('play', () => { if (S.silent) return; if (!S.hold || !S.hold.active) if (S.anim !== 'rew') setMode('play'); });
audio.addEventListener('playing', () => { if (S.silent) return; if (!S.hold || !S.hold.active) if (S.anim !== 'rew') setMode('play'); });
audio.addEventListener('pause', () => { if (S.silent || (S.hold && S.hold.active) || S.anim === 'rew' || S.mode === 'load' || S.mode === 'stop') return; setMode('pause'); });
let lastPos = 0;
audio.addEventListener('timeupdate', () => {
  if (S.silent) return; updateTime();
  const now = Date.now();
  if (now - lastPos > 1000 && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration) && audio.duration > 0) {
    lastPos = now; try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 }); } catch (e) { }
  }
});
audio.addEventListener('loadedmetadata', async () => {
  if (S.silent) return;
  const t = S.tracks.get(S.cur);
  if (t && isFinite(audio.duration) && Math.abs((t.dur || 0) - audio.duration) > 1) { t.dur = audio.duration; await putTrack(t); }
  updateTime();
});
audio.addEventListener('ended', () => {
  if (S.silent) return;
  const t = S.tracks.get(S.cur);
  if (t && t.loop) rewindAnim(); else nextTrack(true);
});
audio.addEventListener('error', () => { if (S.silent || !S.cur) return; toast('Этот формат телефон не играет'); setMode('pause'); });

/* бесконечно: катушки мотаются назад ~1 сек и трек заново */
function rewindAnim() {
  if (!S.cur) return;
  if (!animOK()) { audio.currentTime = 0; audio.play().catch(() => { }); return; }
  const seq = S.seq;
  S.anim = 'rew'; updateKeys();
  const from = audio.currentTime || 0; audio.pause();
  const t0 = performance.now(), D = 1000;
  const step = (now) => {
    if (seq !== S.seq || S.anim !== 'rew') return;
    const p = clamp((now - t0) / D, 0, 1);
    const pos = from * (1 - p);
    $('#tCur').textContent = fmt(pos);
    const d = audio.duration || 1, w = $('#groove').clientWidth - 24;
    $('#gKnob').style.left = clamp(pos / d, 0, 1) * w + 'px';
    if (p < 1) requestAnimationFrame(step);
    else { audio.currentTime = 0; S.anim = null; audio.play().then(() => setMode('play')).catch(() => setMode('pause')); }
  };
  requestAnimationFrame(step);
}

/* клавиши */
function pressKey(id) { const k = $('#k-' + id); k.classList.add('down'); }
$('#k-play').addEventListener('click', () => {
  if (!S.cur) { const ids = ctxAll.ids(); if (ids.length) playFrom(ids, 0, ctxAll); else toast('Полка пустая'); return; }
  if (S.anim) return;
  if (S.mode === 'stop') audio.currentTime = 0;
  audio.play().catch(() => toast('Не играет — попробуй ещё раз'));
});
$('#k-pause').addEventListener('click', () => {
  if (!S.cur) return;
  if (S.mode === 'pause') { audio.play().catch(() => { }); return; }
  S.anim = null; audio.pause(); setMode('pause');
});
$('#k-loop').addEventListener('click', async () => {
  const t = S.tracks.get(S.cur); if (!t) { toast('Сначала вставь кассету'); return; }
  t.loop = !t.loop; await putTrack(t); updateKeys();
  if (t.loop) { toast('∞ Трек по кругу'); if (S.mode === 'play') rewindAnim(); else audio.currentTime = 0; }
});
function holdKey(btn, dir) {
  const down = (e) => {
    if (e.cancelable) e.preventDefault();
    if (!S.cur || S.anim) return;
    stopHold(true);
    S.hold = { dir, t0: Date.now(), active: false, was: S.mode === 'play' };
    btn.classList.add('down');
    S.hold.iv = setInterval(() => {
      const h = S.hold; if (!h) return;
      if (!h.active && Date.now() - h.t0 > 260) { h.active = true; audio.pause(); updateKeys(); }
      if (h.active) { const d = audio.duration || 0; audio.currentTime = clamp((audio.currentTime || 0) + dir * 2.5, 0, Math.max(0, d - 0.3)); updateTime(); }
    }, 100);
  };
  const up = () => {
    const h = S.hold; if (!h || h.dir !== dir) return;
    clearInterval(h.iv); S.hold = null;
    if (!h.active) {
      if (dir < 0) { if ((audio.currentTime || 0) > 3) { audio.currentTime = 0; updateTime(); } else prevTrack(); }
      else nextTrack(false);
      updateKeys();
    } else { if (h.was) audio.play().catch(() => { }); else setMode(S.mode); updateKeys(); }
  };
  btn.addEventListener('touchstart', down, { passive: false });
  btn.addEventListener('mousedown', (e) => { if (e.button === 0) down(e); });
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => btn.addEventListener(ev, up));
}
function stopHold(silent) { if (S.hold) { clearInterval(S.hold.iv); S.hold = null; if (!silent) updateKeys(); } }
holdKey($('#k-rew'), -1); holdKey($('#k-ff'), 1);

/* ползунок позиции */
(function groove() {
  const g = $('#groove'); let on = false;
  const seek = (x) => { const r = g.getBoundingClientRect(); const d = audio.duration; if (!d || !S.cur) return; audio.currentTime = clamp((x - r.left - 12) / (r.width - 24), 0, 1) * d; updateTime(); };
  g.addEventListener('pointerdown', (e) => { on = true; g.setPointerCapture(e.pointerId); seek(e.clientX); });
  g.addEventListener('pointermove', (e) => { if (on) seek(e.clientX); });
  g.addEventListener('pointerup', () => { on = false; });
  g.addEventListener('pointercancel', () => { on = false; });
})();

/* экран блокировки / пульт */
function setMediaMeta(t) {
  if (!('mediaSession' in navigator) || !t) return;
  const cu = coverURL(t);
  const art = cu ? [{ src: cu, sizes: '512x512', type: (toBlob(t.cover) || {}).type || 'image/jpeg' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }];
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || 'Кассета', album: 'Кассета', artwork: art }); } catch (e) { }
}
if ('mediaSession' in navigator) {
  /* Пауза/Play/перемотка на экране блокировки работают нативно (без нашего кода),
     потому что при паузе iPhone усыпляет приложение и наш код бы не сработал. */
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { } };
  ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'stop'].forEach(a => set(a, null));
  set('previoustrack', () => prevTrack());
  set('nexttrack', () => nextTrack(false));
}

/* ---------- папка ---------- */
$('#recBtn').addEventListener('click', () => { const b = $('#recBtn'); restartAnim(b, 'pressed'); setTimeout(() => b.classList.remove('pressed'), 200); $('#fileIn').click(); });
$('#fileIn').addEventListener('change', (e) => { const fs = e.target.files; if (fs && fs.length) importFiles(Array.from(fs)); e.target.value = ''; });

/* ---------- запуск ---------- */
(async function boot() {
  goTab(2, false);
  try { db = await idbOpen(); }
  catch (e) { toast('Хранилище недоступно. Открой приложение в Safari, не в приватном режиме', 8000); return; }
  try {
    const all = await rq(db.transaction('tracks').objectStore('tracks').getAll());
    all.forEach(t => S.tracks.set(t.id, t));
    const order = (await kvGet('order')) || [];
    S.order = order.filter(id => S.tracks.has(id));
    all.sort((a, b) => b.added - a.added).forEach(t => { if (!S.order.includes(t.id)) S.order.push(t.id); });
    S.playlists = (await kvGet('playlists')) || [];
    S.recent = (await kvGet('recent')) || [];
  } catch (e) { console.error(e); toast('Не смог прочитать полку'); }
  renderAll(); renderLabel(null); updateStorage();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { }
})();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
function syncFromAudio() {
  if (!S.cur || S.silent || S.anim || (S.hold && S.hold.active) || S.mode === 'load') return;
  if (!audio.paused && S.mode !== 'play') setMode('play');
  else if (audio.paused && S.mode === 'play') setMode(audio.ended ? 'stop' : 'pause');
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncFromAudio(); updateTime(); updateKeys(); } });
window.addEventListener('pageshow', () => { syncFromAudio(); updateTime(); updateKeys(); });
window.addEventListener('focus', () => { syncFromAudio(); updateKeys(); });
