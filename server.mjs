// 自分専用のローカル DJ アプリを配信する小さなサーバ。依存ゼロ。
//
//   node server.mjs            -> http://127.0.0.1:8787
//   PORT=9000 node server.mjs
//
// 役割は 3 つだけ:
//   1. public/ を静的配信する
//   2. GET /api/apple-token で MusicKit のデベロッパートークンを返す
//      (.p8 秘密鍵をブラウザに出さないため、サーバ側で署名する)
//   3. GET /api/config でフロントに機能フラグを渡す
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createDeveloperTokenFromEnv } from './tools/apple-token.mjs';

const ROOT = resolve(import.meta.dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// .env があれば読む (依存を増やさないための最小パーサ)。
const envFile = resolve(import.meta.dirname, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// トークンは半年有効なので毎リクエスト署名せずキャッシュする。
let tokenCache = null;
function developerToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const token = createDeveloperTokenFromEnv();
  if (!token) return null;
  tokenCache = { token, expiresAt: Date.now() + 1000 * 60 * 60 * 12 };
  return token;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/apple-token') {
    const token = developerToken();
    if (!token) {
      return json(res, 503, {
        error: 'not_configured',
        message:
          'Apple Music は未設定です。.env に APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY_PATH を入れてサーバを再起動してください。',
      });
    }
    return json(res, 200, { token });
  }

  if (url.pathname === '/api/config') {
    return json(res, 200, {
      appleMusic: Boolean(developerToken()),
      appName: 'Solo DJ',
      appBuild: '1.0.0',
    });
  }

  // 静的ファイル。パストラバーサルを防ぐため normalize 後に ROOT 配下か確認する。
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = join(ROOT, normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      // 自分用に即反映してほしいのでキャッシュさせない。
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

// ダブルクリックで二重起動されがちなので、分かる形で止める。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ポート ${PORT} は既に使われています。` +
        '\n  Solo DJ が既に起動しているなら、そのブラウザのタブをそのまま使ってください。' +
        `\n  別のポートで動かすなら PORT=8788 node server.mjs\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const configured = Boolean(developerToken());
  console.log(`\n  Solo DJ  ->  http://${HOST}:${PORT}`);
  console.log(`  Apple Music: ${configured ? '設定済み' : '未設定 (.env を参照)'}`);
  console.log('  Ctrl+C で停止\n');
});
