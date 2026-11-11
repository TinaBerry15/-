// Garment Viz を配信する小さなサーバ。依存ゼロ。
//
//   node server.mjs            -> http://127.0.0.1:8788
//   PORT=9000 node server.mjs
//
// 役割は 3 つだけ:
//   1. public/ を静的配信する
//   2. POST /api/interpret で、感覚的な日本語を服のパラメータに翻訳する
//      (API キーをブラウザに出さないため、サーバ側から Claude を呼ぶ)
//   3. GET /api/config でフロントに機能フラグを渡す

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { toolInputSchema, clampParams, PARAM_DEFS } from './public/js/params.mjs';

const ROOT = resolve(import.meta.dirname, 'public');
const PORT = Number(process.env.PORT || 8788);
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

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// 低レイテンシが欲しいので effort は low。精度を上げたいなら medium に。
const MODEL = process.env.GARMENT_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.GARMENT_EFFORT || 'low';

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
};

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('リクエストが大きすぎます');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const SYSTEM = `あなたは服のシルエットを数値パラメータに翻訳する担当です。

ユーザーは感覚的な日本語で服のイメージを伝えます。曖昧でも推測で構いません。
必ず set_garment ツールを 1 回呼び出して、全パラメータを返してください。

守ること:
- ユーザーが触れていない項目は、渡された「現在の値」をそのまま返す。
  「もっと袖を長く」のような相対的な指示では、現在の値を基準に動かす。
- 「だらっと」「とろみ」のような質感の言葉は stiffness を下げ、
  「かっちり」「ハリのある」「コート地」は stiffness を上げる。
- 「手が隠れるくらい」は sleeveLength を 1 に近づけ sleeveDroop も上げる。
- note には、何をどう解釈したかを日本語で一行だけ書く。数値は書かなくてよい。
- 色の指定が読み取れないときは、現在の色をそのまま返す。`;

async function interpret(text, current) {
  const body = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    output_config: { effort: EFFORT },
    tools: [
      {
        name: 'set_garment',
        description: '服のシルエットのパラメータを設定して画面に反映する。',
        strict: true,
        input_schema: toolInputSchema(),
      },
    ],
    // 強制の tool_choice (any / tool) は現行モデルでは 400 になるため auto を使い、
    // 必ず呼ぶことは system 側で指示している。
    tool_choice: { type: 'auto' },
    messages: [
      {
        role: 'user',
        content:
          `現在の値:\n${JSON.stringify(current, null, 0)}\n\n` +
          `パラメータの意味:\n${PARAM_DEFS.map((d) => `- ${d.key} (${d.label}): ${d.desc}`).join('\n')}\n\n` +
          `指示:\n${text}`,
      },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status });
  }

  // 安全側の判定に引っかかると HTTP 200 のまま refusal で返ってくる。
  if (data.stop_reason === 'refusal') {
    throw Object.assign(new Error('この指示には応答できませんでした。言い換えてみてください。'), { status: 422 });
  }

  const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'set_garment');
  if (!call) {
    const said = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    throw Object.assign(new Error(said || 'パラメータを読み取れませんでした。もう少し具体的に書いてみてください。'), { status: 422 });
  }

  const note = typeof call.input.note === 'string' ? call.input.note : '';
  return { ...clampParams(call.input), note };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/config') {
    return json(res, 200, { claude: Boolean(API_KEY), model: API_KEY ? MODEL : null });
  }

  if (url.pathname === '/api/interpret') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    if (!API_KEY) {
      return json(res, 503, {
        error: 'not_configured',
        message: '言葉での指示は未設定です。.env に ANTHROPIC_API_KEY を入れてサーバを再起動してください。',
      });
    }
    try {
      const { text, current } = await readJsonBody(req);
      if (typeof text !== 'string' || !text.trim()) {
        return json(res, 400, { error: 'bad_request', message: '指示が空です。' });
      }
      const params = await interpret(text.slice(0, 2000), clampParams(current));
      return json(res, 200, { params });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return json(res, status, { error: 'interpret_failed', message: err.message });
    }
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
    const payload = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(payload);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ポート ${PORT} は既に使われています。` +
        '\n  別のポートで動かすなら PORT=8789 node server.mjs\n',
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Garment Viz  ->  http://${HOST}:${PORT}`);
  console.log(`  言葉での指示: ${API_KEY ? `有効 (${MODEL}, effort=${EFFORT})` : '未設定 (.env を参照)'}`);
  console.log('  Ctrl+C で停止\n');
});
