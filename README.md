# Solo DJ

自分だけが使う、ブラウザで動く 2 デッキ DJ ミキサー。
**ローカル音源 / Apple Music / SoundCloud** の 3 種類を A / B のデッキに自由に載せて、
クロスフェーダーで繋ぐ。ビルド工程なし・依存パッケージなしの素の ES モジュール。

```bash
npm start          # http://127.0.0.1:8787
```

---

## 先に知っておくこと（DRM の制約）

ここは誤魔化せない部分なので最初に書く。

| | ローカル音源 | Apple Music | SoundCloud |
|---|---|---|---|
| 再生 / 一時停止 / シーク | ✅ | ✅ | ✅ |
| 音量・クロスフェード | ✅ | ✅ | ✅ |
| 3バンド EQ・フィルター | ✅ | ❌ | ❌ |
| 波形表示 | ✅ | ❌ | ❌ |
| BPM 検出・ピッチ・SYNC | ✅ | ❌ | ❌ |
| レベルメーター | ✅ | ❌ | ❌ |
| A/B 両デッキに同時ロード | ✅ | ❌ (1 つだけ) | ✅ |

理由:

- **Apple Music / SoundCloud の音声は DRM で保護されていて Web Audio API に取り込めない。**
  だから波形も解析できないし、EQ もスクラッチもかけられない。これは実装の手抜きではなく、
  MusicKit / SoundCloud の仕様上どうにもならない。iOS ネイティブの MusicKit でも同じ。
- **MusicKit はページに 1 インスタンスしか作れない。** よって Apple Music の曲 2 つを
  重ねることは不可能。アプリ側では「片方に載せたらもう片方を自動で降ろす」挙動にしてある。
- したがって Apple Music / SoundCloud 同士の「ミックス」は、
  **クロスフェーダーによる音量の交差だけ**。ビートマッチは手動（相手の BPM を見て待つ）になる。

本格的に EQ を掘ったり SYNC したいトラックは、**ダウンロードしたローカルファイル**として
読み込むこと。これだけが全機能に対応する。

---

## セットアップ

### 1. 起動

```bash
npm start
```

ローカル音源と SoundCloud はこれだけで使える。

### 2. Apple Music を使う場合

Apple Developer Program（年 $99）のメンバーシップが必要。

1. [Certificates, Identifiers & Profiles > Keys](https://developer.apple.com/account/resources/authkeys/list)
   で **Media Services (MusicKit)** を有効にした鍵を作り、`AuthKey_XXXXXXXXXX.p8` をダウンロード
2. `./secrets/` に置く（`.gitignore` 済み）
3. `.env` を作る

```bash
cp .env.example .env
```

```ini
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_KEY_ID=YYYYYYYYYY
APPLE_PRIVATE_KEY_PATH=./secrets/AuthKey_YYYYYYYYYY.p8
```

4. サーバを再起動し、Apple Music タブで「サインイン」。再生には Apple Music のサブスクリプションが必要。

`.p8` 秘密鍵はブラウザに渡さず、サーバ側で ES256 の JWT に署名して
`/api/apple-token` でトークンだけを返す。トークン単体で見たいときは:

```bash
npm run token
```

### 3. SoundCloud

設定不要。SoundCloud は新規 API クライアント登録を長年停止しているため、
client_id の要らない**公式 Widget（iframe）API** を使っている。

その代わりカタログ検索ができないので、曲は**トラック URL を貼る**方式。
よく使うものは「クレートに追加」で localStorage に保存される。
非公開トラックと埋め込み禁止トラックは再生できない。

---

## 使い方

- **ローカル音源**: ファイルをウィンドウにドラッグ＆ドロップ（画面の左半分 → デッキ A、右半分 → B）。
  デッキの上に直接落としてもよい。読み込み時に波形と BPM を解析する。
- **波形**: クリック / ドラッグでシーク。黄色の線が CUE、黄色の帯がループ区間。
- **SYNC**: 相手デッキの BPM にピッチを合わせる（ローカル音源同士のみ、±16% まで）。
- **BPM 手動入力**: 解析が外れたとき（生ドラム・変拍子など）は数値を直接入れると SYNC がその値を使う。
- **オートフェード**: 指定秒数でクロスフェーダーを反対側へ自動で振る。

### キーボードショートカット

| キー | 動作 |
|---|---|
| `Q` / `P` | デッキ A / B 再生・一時停止 |
| `W` / `O` | デッキ A / B CUE |
| `E` / `I` | 今の位置を CUE に設定 |
| `←` `→` | クロスフェーダー（`Shift` で微調整） |
| `↑` `↓` | マスター音量 |
| `S` / `L` | A を B に / B を A に BPM シンク |
| `F` | 反対側へオートフェード |
| `Space` | 全デッキ停止（非常停止） |
| `?` | ショートカット一覧 |

---

## 構成

```
server.mjs              静的配信 + /api/apple-token（.p8 で ES256 署名）
tools/apple-token.mjs   MusicKit デベロッパートークン生成（依存ゼロ）
public/
  index.html
  css/app.css
  js/
    app.js              全体の配線（ライブラリ・クレート・ショートカット・ドロップ）
    mixer.js            音声グラフ。trim → EQ → filter → fader → crossfader → limiter
    deck.js             デッキ 1 台（トランスポート・波形描画・BPM シンク）
    analysis.js         波形ピーク + BPM 推定（オンセット自己相関 + 放物線補間）
    sources/
      base.js           共通インターフェース（caps で「できること」を宣言）
      local.js          ローカル音源。Web Audio のフル機能
      apple.js          MusicKit JS v3
      soundcloud.js     SoundCloud Widget API
```

設計の要は `sources/base.js` の `caps`。音源ごとに「EQ が使えるか」「波形があるか」を
宣言し、デッキはそれを見て**使えないコントロールを disabled にする**。
黙って効かないつまみを作らないための仕組み。

ミキサーも 2 系統を同じ計算モデルに見せている:

- Web Audio 音源 … ゲインをノードのパラメータに書く
- DRM 音源 … `trim × fader × crossfader × master` を掛け算し、
  その結果をプレイヤーの `volume` に書く（`Channel.onGain`）

### BPM 推定について

オンセット強度エンベロープの自己相関。ホップ 512 サンプルだとラグが整数刻みになり
128 BPM が 129.2 BPM になる程度の誤差が出るので、ピーク周辺を放物線補間している
（128 BPM のテスト信号で 128.4 BPM）。4つ打ちなら実用域だが、生ドラムや変拍子は外す。
外したら手動入力で上書きする前提。

---

## 動作確認済み

Chromium（Playwright）で以下を確認:

- ローカル音源の読み込み → 波形描画 → BPM 128.4（実測 128.0）
- 再生位置の進行、EQ / フィルター / ピッチ操作、SYNC（B を A に 3.04% で追従）
- クロスフェーダー、オートフェード、チャンネル / マスターのレベルメーター
- JS エラーなし

Apple Music と SoundCloud の実通信は、それぞれ Apple Developer の鍵と
ネットワークが必要なため、このリポジトリでは自動テストしていない。
