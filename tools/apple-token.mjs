// MusicKit デベロッパートークン (ES256 JWT) を生成する。
// 依存ゼロ: Node 標準の crypto だけで署名する。
//
// 必要なもの (Apple Developer Program のメンバーシップが前提):
//   1. Certificates, Identifiers & Profiles > Keys で "Media Services (MusicKit)" を
//      有効にした鍵を作り、AuthKey_XXXXXXXXXX.p8 をダウンロード
//   2. その Key ID (10文字) と、自分の Team ID (10文字)
//
// 使い方:
//   APPLE_TEAM_ID=XXXXXXXXXX APPLE_KEY_ID=YYYYYYYYYY \
//   APPLE_PRIVATE_KEY_PATH=./secrets/AuthKey_YYYYYYYYYY.p8 \
//   node tools/apple-token.mjs
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * @param {{teamId: string, keyId: string, privateKey: string, ttlSeconds?: number}} opts
 * @returns {string} 署名済み JWT
 */
export function createDeveloperToken({ teamId, keyId, privateKey, ttlSeconds = 60 * 60 * 24 * 180 }) {
  if (!teamId || !keyId || !privateKey) {
    throw new Error('teamId / keyId / privateKey はすべて必須です');
  }
  // Apple の上限は 6 ヶ月。
  const maxTtl = 60 * 60 * 24 * 180;
  if (ttlSeconds > maxTtl) ttlSeconds = maxTtl;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat: now, exp: now + ttlSeconds };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // JOSE は r||s の生署名を要求するので ieee-p1363 を指定する (既定の DER では弾かれる)。
  const signature = createSign('SHA256').update(signingInput).sign({
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${b64url(signature)}`;
}

export function createDeveloperTokenFromEnv(env = process.env) {
  const teamId = env.APPLE_TEAM_ID;
  const keyId = env.APPLE_KEY_ID;
  const keyPath = env.APPLE_PRIVATE_KEY_PATH;
  const inlineKey = env.APPLE_PRIVATE_KEY;

  const privateKey = inlineKey
    ? inlineKey.replace(/\\n/g, '\n')
    : keyPath
      ? readFileSync(keyPath, 'utf8')
      : null;

  if (!teamId || !keyId || !privateKey) return null;
  return createDeveloperToken({ teamId, keyId, privateKey });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = createDeveloperTokenFromEnv();
  if (!token) {
    console.error(
      'APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY_PATH が設定されていません。.env.example を参照。',
    );
    process.exit(1);
  }
  console.log(token);
}
