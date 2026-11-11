// 管理画面。写真を整えて送る / 一覧から売り切れ・削除を切り替える / ショップ名を変える。

import { preparePhoto } from './imageprep.mjs';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'rail-shop:admin-token';
const MAX_PHOTOS = 10;

let files = [];     // 選ばれた元ファイル
let prepared = [];  // 送る形に整えた写真 (files と同じ並び)
let prepRun = 0;

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `エラー (${res.status})`);
  return data;
}

function say(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}${el.classList.contains('wide') ? ' wide' : ''}`;
}

// ---- 写真 ----

async function refreshPreviews() {
  const run = ++prepRun;
  const cutout = $('cutout').checked;
  const host = $('previews');
  $('submit').disabled = true;
  say($('formStatus'), files.length ? '写真を準備しています…' : '');

  const out = [];
  const problems = [];
  for (const f of files) {
    try {
      out.push(await preparePhoto(f, { cutout }));
    } catch (err) {
      out.push(null);
      problems.push(err.message);
    }
    if (run !== prepRun) return; // 準備中に選び直された
  }
  // 読めなかったファイルは外す。
  files = files.filter((_, i) => out[i]);
  prepared = out.filter(Boolean);

  host.replaceChildren();
  prepared.forEach((p, i) => {
    const box = document.createElement('div');
    box.className = 'pv';
    const img = document.createElement('img');
    img.src = p.data;
    img.alt = '';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'この写真を外す';
    x.addEventListener('click', () => { files.splice(i, 1); refreshPreviews(); });
    box.append(img, x);
    if (p.cutout) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '透過';
      box.append(tag);
    }
    host.append(box);
  });

  $('submit').disabled = false;
  const failedCut = cutout && prepared.some((p) => !p.cutout);
  if (problems.length) say($('formStatus'), problems.join(' / '), 'err');
  else if (failedCut) say($('formStatus'), '「透過」の印がない写真は背景をうまく抜けなかったので、元のまま使います。');
  else say($('formStatus'), '');
}

function addFiles(list) {
  const images = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  files = files.concat(images).slice(0, MAX_PHOTOS);
  refreshPreviews();
}

$('files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('cutout').addEventListener('change', refreshPreviews);

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---- 追加 ----

$('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!prepared.length) return say($('formStatus'), '写真を 1 枚以上選んでください。', 'err');
  const form = new FormData(e.target);
  const body = Object.fromEntries(form.entries());
  body.price = Number(body.price);
  body.photos = prepared.map((p) => ({ data: p.data, cutout: p.cutout }));

  $('submit').disabled = true;
  say($('formStatus'), '送信しています…');
  try {
    const { item } = await call('POST', '/api/items', body);
    e.target.reset();
    files = [];
    await refreshPreviews();
    say($('formStatus'), `「${item.title}」をラックに掛けました。`, 'ok');
    await loadList();
  } catch (err) {
    say($('formStatus'), err.message, 'err');
  } finally {
    $('submit').disabled = false;
  }
});

// ---- 一覧 ----

async function loadList() {
  const db = await (await fetch('/api/items')).json();
  const host = $('list');
  host.replaceChildren();
  $('count').textContent = db.items.length ? `${db.items.length} 点` : '';

  for (const it of db.items) {
    const row = document.createElement('div');
    row.className = 'row' + (it.sold ? ' sold' : '');
    const img = document.createElement('img');
    img.src = it.photos[0]?.url || '';
    img.alt = '';
    const info = document.createElement('div');
    info.style.minWidth = '0';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.title;
    const p = document.createElement('div');
    p.className = 'p';
    p.textContent = `${Number(it.price) > 0 ? `¥${Number(it.price).toLocaleString('ja-JP')}` : '価格未入力'}${it.sold ? ' ・売り切れ' : ''}${it.mercariUrl ? '' : ' ・購入リンクなし'}`;
    info.append(t, p);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const sold = document.createElement('button');
    sold.type = 'button';
    sold.textContent = it.sold ? '販売中に戻す' : '売り切れにする';
    sold.addEventListener('click', async () => {
      try { await call('PATCH', `/api/items/${it.id}`, { sold: !it.sold }); await loadList(); }
      catch (err) { alert(err.message); }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`「${it.title}」を削除します。写真も消えて元に戻せません。`)) return;
      try { await call('DELETE', `/api/items/${it.id}`); await loadList(); }
      catch (err) { alert(err.message); }
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '編集';
    ops.append(edit, sold, del);
    row.append(img, info, ops);
    host.append(row);

    // 編集欄は行のすぐ下に開く。写真はそのままで、文字の項目だけ直せる。
    const form = document.createElement('form');
    form.className = 'fields editor';
    form.hidden = true;
    const field = (label, name, value, { wide = false, type = 'text', area = false } = {}) => {
      const l = document.createElement('label');
      if (wide) l.className = 'wide';
      l.append(label);
      const input = document.createElement(area ? 'textarea' : 'input');
      if (!area) input.type = type;
      else input.rows = 4;
      input.name = name;
      input.value = value ?? '';
      l.append(input);
      form.append(l);
    };
    field('商品名', 'title', it.title, { wide: true });
    field('価格 (円)', 'price', it.price || '', { type: 'number' });
    field('サイズ', 'size', it.size);
    field('ブランド', 'brand', it.brand);
    field('状態', 'condition', it.condition);
    field('メルカリの商品ページ URL', 'mercariUrl', it.mercariUrl, { wide: true, type: 'url' });
    field('説明', 'description', it.description, { wide: true, area: true });
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'wide';
    save.textContent = '変更を保存';
    form.append(save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      body.price = Number(body.price) || 0;
      try { await call('PATCH', `/api/items/${it.id}`, body); await loadList(); }
      catch (err) { alert(err.message); }
    });
    edit.addEventListener('click', () => { form.hidden = !form.hidden; });
    host.append(form);
  }

  const f = $('shopForm');
  f.name.value = db.shop.name || '';
  f.tagline.value = db.shop.tagline || '';
  f.profileUrl.value = db.shop.profileUrl || '';
}

$('shopForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await call('PUT', '/api/shop', Object.fromEntries(new FormData(e.target).entries()));
    say($('shopStatus'), '保存しました。', 'ok');
  } catch (err) {
    say($('shopStatus'), err.message, 'err');
  }
});

// ---- 起動 ----

async function checkAccess() {
  const cfg = await call('GET', '/api/config');
  $('tokenBox').hidden = !cfg.tokenRequired;
  const notice = $('notice');
  if (cfg.admin) {
    notice.hidden = true;
  } else {
    notice.hidden = false;
    notice.textContent = cfg.tokenRequired
      ? '合言葉が未入力か、違っています。下に入力して保存してください。'
      : 'この端末からは編集できません。サーバを動かしているマシンで開くか、サーバの .env に ADMIN_TOKEN を設定してください。';
  }
}

$('token').value = token();
$('tokenSave').addEventListener('click', async () => {
  try { localStorage.setItem(TOKEN_KEY, $('token').value.trim()); } catch { /* 保存できなくても今回は使える */ }
  await checkAccess();
});

checkAccess();
loadList();
