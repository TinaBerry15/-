// ストア画面。データを取ってきて、3D ラック / 詳細パネル / 一覧グリッドに流す。

import { Rail } from './rail.mjs';
import { sampleItems } from './samples.mjs';

const $ = (id) => document.getElementById(id);
// 価格が未入力 (0) の商品は、金額の代わりに案内を出す。¥0 と出すと無料に見えてしまう。
const yen = (n) => (Number(n) > 0 ? `¥${Number(n).toLocaleString('ja-JP')}` : '価格はメルカリで');
const pad = (n) => String(n).padStart(2, '0');

const CATEGORY_LABEL = { all: 'ALL', tops: 'TOPS', outer: 'OUTER', bottoms: 'BOTTOMS', shoes: 'SHOES', other: 'OTHER' };

let allItems = [];
let items = [];      // いまラックに掛かっているもの (絞り込み後)
let category = 'all';
let detailIndex = -1;
let photoIndex = 0;

const rail = new Rail($('stage'), {
  onFocus: (i) => showFocus(i),
  onSelect: (i) => openDetail(i),
});

// ---- 正面の 1 着のラベル ----

function showFocus(i) {
  const it = items[i];
  if (!it) return;
  $('focusTitle').textContent = it.title;
  $('focusPrice').textContent = it.sold ? 'SOLD OUT' : yen(it.price);
  $('focusMeta').textContent = [it.brand, it.size && `SIZE ${it.size}`].filter(Boolean).join('  /  ');
  $('counter').textContent = `${pad(i + 1)} / ${pad(items.length)}`;
  $('prev').disabled = i <= 0;
  $('next').disabled = i >= items.length - 1;
  $('focus').classList.toggle('sold', Boolean(it.sold));
}

// ---- 詳細パネル ----

function openDetail(i) {
  const it = items[i];
  if (!it) return;
  detailIndex = i;
  photoIndex = 0;
  rail.goTo(i);
  rail.setDetail(true);

  $('dIndex').textContent = `ITEM ${pad(i + 1)} / ${pad(items.length)}`;
  $('dTitle').textContent = it.title;
  $('dPrice').textContent = yen(it.price);
  $('dBrand').textContent = it.brand || '';
  $('dDesc').textContent = it.description || '';

  const specs = $('dSpecs');
  specs.replaceChildren();
  for (const [k, v] of [['SIZE', it.size], ['CONDITION', it.condition], ['CATEGORY', CATEGORY_LABEL[it.category]]]) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    specs.append(dt, dd);
  }

  const buy = $('dBuy');
  if (it.sold) {
    buy.textContent = 'SOLD OUT';
    buy.removeAttribute('href');
    buy.classList.add('disabled');
  } else if (it.mercariUrl) {
    buy.textContent = 'メルカリで購入する ↗';
    buy.href = it.mercariUrl;
    buy.classList.remove('disabled');
  } else {
    buy.textContent = it.sample ? '見本のため購入できません' : '購入リンク未設定';
    buy.removeAttribute('href');
    buy.classList.add('disabled');
  }

  renderThumbs(it);
  document.body.classList.add('detail-open');
  $('panel').setAttribute('aria-hidden', 'false');
}

function renderThumbs(it) {
  const host = $('dThumbs');
  host.replaceChildren();
  it.photos.forEach((p, k) => {
    const b = document.createElement('button');
    b.className = 'thumb' + (k === photoIndex ? ' on' : '');
    b.setAttribute('aria-label', `写真 ${k + 1}`);
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = '';
    b.append(img);
    b.addEventListener('click', () => setPhoto(k));
    host.append(b);
  });
  $('photoNav').hidden = it.photos.length < 2;
  $('photoCount').textContent = `${photoIndex + 1} / ${it.photos.length}`;
}

function setPhoto(k) {
  const it = items[detailIndex];
  if (!it) return;
  photoIndex = (k + it.photos.length) % it.photos.length;
  rail.setPhoto(photoIndex);
  renderThumbs(it);
}

function closeDetail() {
  detailIndex = -1;
  rail.setDetail(false);
  document.body.classList.remove('detail-open');
  $('panel').setAttribute('aria-hidden', 'true');
}

// ---- 絞り込みと一覧 ----

function applyCategory(next) {
  category = next;
  items = category === 'all' ? allItems : allItems.filter((it) => it.category === category);
  closeDetail();
  rail.setItems(items);
  document.body.classList.toggle('empty', items.length === 0);
  if (items.length) showFocus(rail.focus);
  for (const b of $('filters').children) b.classList.toggle('on', b.dataset.cat === category);
}

function renderFilters() {
  const host = $('filters');
  host.replaceChildren();
  const present = new Set(allItems.map((it) => it.category));
  for (const cat of ['all', 'tops', 'outer', 'bottoms', 'shoes', 'other']) {
    if (cat !== 'all' && !present.has(cat)) continue;
    const b = document.createElement('button');
    b.dataset.cat = cat;
    b.textContent = CATEGORY_LABEL[cat];
    b.addEventListener('click', () => applyCategory(cat));
    host.append(b);
  }
}

function renderGrid() {
  const host = $('grid');
  host.replaceChildren();
  allItems.forEach((it) => {
    const a = document.createElement('button');
    a.className = 'tile' + (it.sold ? ' sold' : '');
    const frame = document.createElement('span');
    frame.className = 'tile-photo' + (it.photos[0]?.cutout ? ' cutout' : '');
    const img = document.createElement('img');
    img.src = it.photos[0]?.url || '';
    img.alt = it.title;
    img.loading = 'lazy';
    frame.append(img);
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = it.title;
    const price = document.createElement('span');
    price.className = 'tile-price';
    price.textContent = it.sold ? 'SOLD OUT' : yen(it.price);
    a.append(frame, name, price);
    a.addEventListener('click', () => {
      if (category !== 'all') applyCategory('all');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      openDetail(allItems.indexOf(it));
    });
    host.append(a);
  });
  $('gridCount').textContent = `${pad(allItems.length)} ITEMS`;
}

// ---- 操作 ----

$('prev').addEventListener('click', () => rail.prev());
$('next').addEventListener('click', () => rail.next());
$('view').addEventListener('click', () => openDetail(rail.focus));
$('close').addEventListener('click', closeDetail);
$('photoPrev').addEventListener('click', () => setPhoto(photoIndex - 1));
$('photoNext').addEventListener('click', () => setPhoto(photoIndex + 1));

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') closeDetail();
  else if (detailIndex >= 0) {
    if (e.key === 'ArrowRight') setPhoto(photoIndex + 1);
    if (e.key === 'ArrowLeft') setPhoto(photoIndex - 1);
  } else {
    if (e.key === 'ArrowRight') rail.next();
    if (e.key === 'ArrowLeft') rail.prev();
    if (e.key === 'Enter') openDetail(rail.focus);
  }
});

// ---- 起動 ----

async function boot() {
  let db = { shop: { name: 'ARCHIVE RAIL', tagline: '', profileUrl: '' }, items: [] };
  try {
    const res = await fetch('/api/items');
    if (res.ok) db = await res.json();
  } catch { /* サーバに繋がらなくても見本で動かす */ }

  const sample = db.items.length === 0;
  allItems = sample ? sampleItems() : db.items;
  document.body.classList.toggle('sample', sample);

  document.title = db.shop.name;
  for (const el of document.querySelectorAll('[data-shop-name]')) el.textContent = db.shop.name;
  $('tagline').textContent = db.shop.tagline || '';
  const profile = $('profile');
  if (db.shop.profileUrl) profile.href = db.shop.profileUrl;
  else profile.hidden = true;

  const words = [db.shop.name, db.shop.tagline, `${allItems.filter((i) => !i.sold).length} ITEMS AVAILABLE`, 'ONE OF ONE', 'SHIPS FROM JAPAN'].filter(Boolean);
  $('ticker').textContent = Array(8).fill(words.join('   ✦   ')).join('   ✦   ');

  renderFilters();
  renderGrid();
  applyCategory('all');
}

boot();
