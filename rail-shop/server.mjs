// Rail Shop を配信する小さなサーバ。依存ゼロ。
//
//   node server.mjs            -> http://127.0.0.1:8790
//
// 役割:
//   1. public/ を静的配信する
//   2. 商品データ (data/items.json) と写真 (data/uploads/) を読み書きする API
//      書き込み系は管理者だけ。ADMIN_TOKEN があればその合言葉を要求し、
//      無ければ「このマシン自身からのアクセス」だけを通す。

import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir, unlink, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, 'public');
const DATA = resolve(import.meta.dirname, 'data');
const UPLOADS = join(DATA, 'uploads');
const DB = join(DATA, 'items.json');

const envFile = resolve(import.meta.dirname, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CATEGORIES = ['tops', 'outer', 'bottoms', 'other'];

const DEFAULT_SHOP = { name: 'ARCHIVE RAIL', tagline: 'ONE OF ONE / PRE-OWNED SELECTION', profileUrl: '' };

// ---- データ ---------------------------------------------------------------

async function loadDb() {
  try {
    const db = JSON.parse(await readFile(DB, 'utf8'));
    return { shop: { ...DEFAULT_SHOP, ...(db.shop || {}) }, items: Array.isArray(db.items) ? db.items : [] };
  } catch {
    return { shop: { ...DEFAULT_SHOP }, items: [] };
  }
}

// 書き込みは一時ファイル経由にして、途中で落ちても items.json が壊れないようにする。
let writeChain = Promise.resolve();
function saveDb(db) {
  writeChain = writeChain.then(async () => {
    await mkdir(DATA, { recursive: true });
    const tmp = `${DB}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, DB);
  });
  return writeChain;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function httpUrl(v) {
  const s = text(v, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

function itemFields(input, base = {}) {
  const out = { ...base };
  if ('title' in input) out.title = text(input.title, 80);
  if ('price' in input) out.price = Math.max(0, Math.min(99999999, Math.round(Number(input.price) || 0)));
  if ('size' in input) out.size = text(input.size, 20);
  if ('condition' in input) out.condition = text(input.condition, 40);
  if ('brand' in input) out.brand = text(input.brand, 40);
  if ('description' in input) out.description = text(input.description, 2000);
  if ('category' in input) out.category = CATEGORIES.includes(input.category) ? input.category : 'other';
  if ('mercariUrl' in input) out.mercariUrl = httpUrl(input.mercariUrl);
  if ('sold' in input) out.sold = Boolean(input.sold);
  return out;
}

async function savePhoto(id, index, photo) {
  const m = typeof photo?.data === 'string' && photo.data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw fail(400, `写真 ${index + 1} の形式が読めません (JPEG / PNG / WebP のみ)。`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO_BYTES) throw fail(413, `写真 ${index + 1} が大きすぎます。`);
  const name = `${id}-${index}${IMAGE_EXT[m[1]]}`;
  await mkdir(UPLOADS, { recursive: true });
  await writeFile(join(UPLOADS, name), buf);
  return { url: `/uploads/${name}`, cutout: Boolean(photo.cutout) };
}

// ---- HTTP まわり ----------------------------------------------------------

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 96 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, '送信データが大きすぎます。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail(400, 'JSON として読めません。');
  }
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function isAdmin(req) {
  if (ADMIN_TOKEN) {
    const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(ADMIN_TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  // 合言葉を決めていない間は、このマシン自身からの操作だけ許す。
  return isLoopback(req);
}

async function serveFile(res, base, pathname, cache) {
  const filePath = join(base, normalize(pathname));
  if (!filePath.startsWith(base)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const payload = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

async function api(req, res, url) {
  const path = url.pathname;

  if (path === '/api/config' && req.method === 'GET') {
    return json(res, 200, { tokenRequired: Boolean(ADMIN_TOKEN), admin: isAdmin(req) });
  }

  if (path === '/api/items' && req.method === 'GET') {
    return json(res, 200, await loadDb());
  }

  // ここから下は書き込み。
  if (!isAdmin(req)) {
    throw fail(401, ADMIN_TOKEN ? '合言葉が違います。' : '管理操作はこのサーバを動かしているマシンからだけ行えます (.env に ADMIN_TOKEN を設定すると外からも可能)。');
  }

  if (path === '/api/shop' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const db = await loadDb();
    db.shop = {
      name: text(body.name, 40) || DEFAULT_SHOP.name,
      tagline: text(body.tagline, 80),
      profileUrl: httpUrl(body.profileUrl),
    };
    await saveDb(db);
    return json(res, 200, { shop: db.shop });
  }

  if (path === '/api/items' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
    if (!photos.length) throw fail(400, '写真を 1 枚以上つけてください。');
    const fields = itemFields({ category: 'other', sold: false, ...body });
    if (!fields.title) throw fail(400, '商品名を入れてください。');

    const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const saved = [];
    for (let i = 0; i < photos.length; i++) saved.push(await savePhoto(id, i, photos[i]));

    const item = { id, ...fields, photos: saved, createdAt: new Date().toISOString() };
    const db = await loadDb();
    db.items.unshift(item);
    await saveDb(db);
    return json(res, 201, { item });
  }

  const m = path.match(/^\/api\/items\/([a-z0-9]+)$/);
  if (m && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const db = await loadDb();
    const index = db.items.findIndex((it) => it.id === m[1]);
    if (index < 0) throw fail(404, 'その商品は見つかりません。');

    if (req.method === 'DELETE') {
      const [gone] = db.items.splice(index, 1);
      await saveDb(db);
      for (const p of gone.photos || []) {
        const name = String(p.url || '').replace(/^\/uploads\//, '');
        if (/^[a-z0-9-]+\.(jpg|png|webp)$/.test(name)) await unlink(join(UPLOADS, name)).catch(() => {});
      }
      return json(res, 200, { ok: true });
    }

    db.items[index] = itemFields(await readJsonBody(req), db.items[index]);
    await saveDb(db);
    return json(res, 200, { item: db.items[index] });
  }

  throw fail(404, 'そんな API はありません。');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await api(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      json(res, status, { message: status === 500 ? 'サーバ側でエラーが起きました。' : err.message });
    }
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    return serveFile(res, UPLOADS, pathname.slice('/uploads'.length), 'public, max-age=31536000, immutable');
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  return serveFile(res, ROOT, pathname, 'no-cache');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ポート ${PORT} は既に使われています。別のポートなら PORT=8791 node server.mjs\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Rail Shop  ->  http://${HOST}:${PORT}`);
  console.log(`  管理画面   ->  http://${HOST}:${PORT}/admin`);
  console.log(`  管理の保護: ${ADMIN_TOKEN ? '合言葉 (ADMIN_TOKEN)' : 'このマシンからのみ'}`);
  console.log('  Ctrl+C で停止\n');
});
