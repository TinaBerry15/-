// アプリ全体の配線。
import { Mixer } from './mixer.js';
import { Deck } from './deck.js';
import { searchAppleMusic, initAppleMusic } from './sources/apple.js';
import { isSoundCloudUrl } from './sources/soundcloud.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const statusEl = $('#status');
let statusTimer = null;
/** @param {string} text @param {'info'|'ok'|'error'} level */
function status(text, level = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.level = level;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => (statusEl.textContent = ''), 6000);
}

const mixer = new Mixer();
const decks = {
  a: new Deck('a', mixer, $('[data-deck="a"]')),
  b: new Deck('b', mixer, $('[data-deck="b"]')),
};
const other = (id) => (id === 'a' ? decks.b : decks.a);

// ---------------------------------------------------------------- 音声解錠
// ブラウザは最初のユーザー操作まで AudioContext を鳴らさない。
const unlockBtn = $('#audio-unlock');
function refreshUnlock() {
  unlockBtn.hidden = mixer.ctx.state === 'running';
}
unlockBtn.addEventListener('click', async () => {
  await mixer.resume();
  refreshUnlock();
});
document.addEventListener('pointerdown', () => mixer.resume().then(refreshUnlock), { once: true });
mixer.ctx.addEventListener?.('statechange', refreshUnlock);
refreshUnlock();

// ---------------------------------------------------------------- デッキ操作
for (const [id, deck] of Object.entries(decks)) {
  const root = deck.root;

  // ホットキューのパッド。空なら今の位置を記録、入っていればそこへ飛ぶ。
  root.addEventListener('click', async (event) => {
    const pad = event.target.closest('button[data-hotcue]');
    if (!pad || pad.disabled) return;
    const index = Number(pad.dataset.hotcue);
    const result = await deck.hotCue(index);
    if (result?.set) status(`デッキ ${id.toUpperCase()}: ホットキュー ${index + 1} を設定`, 'ok');
    saveTrackState(deck);
  });

  // 右クリックでホットキューを消す。
  root.addEventListener('contextmenu', (event) => {
    const pad = event.target.closest('button[data-hotcue]');
    if (!pad || pad.disabled) return;
    event.preventDefault();
    deck.clearHotCue(Number(pad.dataset.hotcue));
    saveTrackState(deck);
    status(`デッキ ${id.toUpperCase()}: ホットキュー ${Number(pad.dataset.hotcue) + 1} を解除`);
  });

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    try {
      switch (btn.dataset.action) {
        case 'play':
          await deck.togglePlay();
          break;
        case 'cue':
          await deck.cue();
          break;
        case 'set-cue':
          deck.setCueHere();
          status(`デッキ ${id.toUpperCase()}: CUE を設定`, 'ok');
          break;
        case 'loop-in':
          loopIn(deck);
          break;
        case 'loop-out':
          loopOut(deck);
          break;
        case 'loop-clear':
          deck.source?.setLoop?.(null);
          deck.render();
          break;
        case 'eject':
          await deck.eject();
          refreshConflictNotices();
          break;
        case 'grid-nudge':
          deck.nudgeGrid(Number(btn.dataset.delta));
          saveTrackState(deck);
          break;
        case 'grid-downbeat':
          deck.setDownbeatHere();
          saveTrackState(deck);
          status(`デッキ ${id.toUpperCase()}: ここを小節頭にしました`, 'ok');
          break;
        case 'sync': {
          const result = deck.syncTo(other(id));
          if (result.ok) {
            status(
              `デッキ ${id.toUpperCase()} を ${other(id).bpm.toFixed(1)} BPM に同期 (${result.percent.toFixed(2)}%)` +
                (result.aligned ? ' / 拍も合わせました' : ' / 拍合わせはグリッドが要ります'),
              'ok',
            );
            const slider = root.querySelector('[data-action="pitch"]');
            if (slider) slider.value = String(Math.round(result.percent * 10));
          } else {
            status(`同期できません: ${result.reason}`, 'error');
          }
          break;
        }
      }
    } catch (err) {
      status(err.message || String(err), 'error');
    }
  });

  root.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.dataset.action) return;
    const value = Number(input.value);
    switch (input.dataset.action) {
      case 'trim':
        deck.channel.setTrim(value / 100);
        break;
      case 'fader':
        deck.channel.setFader(value / 100);
        break;
      case 'eq-low':
        deck.channel.setEq('low', value);
        break;
      case 'eq-mid':
        deck.channel.setEq('mid', value);
        break;
      case 'eq-high':
        deck.channel.setEq('high', value);
        break;
      case 'filter':
        deck.channel.setFilter(value / 100);
        break;
      case 'pitch':
        // スライダーは -80..80 を -8.0%..+8.0% として扱う。
        deck.setPitch(value / 10);
        break;
      case 'bpm-manual':
        deck.setManualBpm(value);
        saveTrackState(deck);
        break;
    }
  });

  // ファイルを直接デッキにドロップ
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) await loadLocalInto(deck, file);
  });
}

function loopIn(deck) {
  const s = deck.source;
  if (!s?.caps.cue) return;
  deck._loopStart = s.position;
  status(`ループ開始 ${deck._loopStart.toFixed(2)}s — OUT で確定`);
}

function loopOut(deck) {
  const s = deck.source;
  if (!s?.caps.cue) return;
  const start = deck._loopStart;
  if (start === undefined) {
    status('先に IN を押してください', 'error');
    return;
  }
  const end = s.position;
  if (end <= start + 0.05) {
    status('ループが短すぎます', 'error');
    return;
  }
  s.setLoop({ start, end });
  deck.render();
  status(`ループ ${(end - start).toFixed(2)} 秒`, 'ok');
}

// ---------------------------------------------------------------- クロスフェーダー / マスター
const crossfader = $('#crossfader');
crossfader.addEventListener('input', () => mixer.setCrossfade(Number(crossfader.value) / 100));

function setCrossfade(value01) {
  crossfader.value = String(Math.round(value01 * 100));
  mixer.setCrossfade(value01);
}

$('#xfade-a').addEventListener('click', () => setCrossfade(0));
$('#xfade-center').addEventListener('click', () => setCrossfade(0.5));
$('#xfade-b').addEventListener('click', () => setCrossfade(1));

const master = $('#master');
master.addEventListener('input', () => mixer.setMaster(Number(master.value) / 100));
mixer.setMaster(Number(master.value) / 100);

// オートフェード: 反対側へ指定秒でクロスフェーダーを動かす。
let autofadeHandle = null;
function autoFade(seconds) {
  if (autofadeHandle) cancelAnimationFrame(autofadeHandle);
  const from = mixer.crossfadePosition;
  const to = from < 0.5 ? 1 : 0;
  const started = performance.now();
  const duration = Math.max(0.2, seconds) * 1000;

  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    // ease-in-out で端の張り付きを和らげる。
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    setCrossfade(from + (to - from) * eased);
    if (t < 1) autofadeHandle = requestAnimationFrame(step);
    else autofadeHandle = null;
  };
  autofadeHandle = requestAnimationFrame(step);
}
$('#autofade-run').addEventListener('click', () => autoFade(Number($('#autofade-time').value)));

// ---------------------------------------------------------------- メーター更新
function meterLoop() {
  decks.a.renderMeter();
  decks.b.renderMeter();
  decks.a.renderSilentBadge();
  decks.b.renderSilentBadge();
  const m = $('[data-master-meter]');
  m.style.setProperty('--level', Math.min(1, mixer.readMasterLevel()).toFixed(3));
  // ローカル音源の再生位置はイベントが飛ばないのでここで更新する。
  for (const deck of Object.values(decks)) {
    if (deck.source?.kind === 'local' && deck.source.playing) deck.renderProgress();
  }
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ---------------------------------------------------------------- タブ
for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
  });
}

// ---------------------------------------------------------------- ロード系
/**
 * 両デッキの組み合わせを見て、同時に鳴らせない状態なら警告を出す。
 *
 * 検証済みの組み合わせ:
 *   ローカル × ローカル          … 同時に鳴る
 *   ローカル × SoundCloud        … 同時に鳴る
 *   SoundCloud × SoundCloud      … 鳴らない (SoundCloud のプレイヤーが互いを止める)
 *   Apple Music × Apple Music    … 載せられない (MusicKit が 1 インスタンスのみ)
 */
function refreshConflictNotices() {
  const a = decks.a.source?.kind;
  const b = decks.b.source?.kind;
  const bothSoundCloud = a === 'soundcloud' && b === 'soundcloud';
  const notice = bothSoundCloud
    ? 'SoundCloud 同士。各プレイヤーは別ページに隔離してあるので同時に鳴るはずだが、'
      + '片方を再生してもう片方が止まるようなら、片方をローカル音源か Apple Music にしてください'
    : '';
  for (const deck of Object.values(decks)) {
    if (deck.conflictNotice === notice) continue;
    deck.conflictNotice = notice;
    deck.render();
  }
}

/** Apple Music は 1 インスタンスしか持てないので、片方に載せたら相手を降ろす。 */
async function loadAppleInto(deck, track) {
  const otherDeck = other(deck.id);
  if (otherDeck.source?.kind === 'apple') {
    await otherDeck.eject();
    status(
      `MusicKit はプレイヤーを 1 つしか持てないため、デッキ ${otherDeck.id.toUpperCase()} の Apple Music を降ろしました`,
      'info',
    );
  }
  await mixer.resume();
  await deck.loadAppleTrack(track);
  refreshConflictNotices();
}

async function loadScInto(deck, url) {
  await mixer.resume();
  await deck.loadSoundCloudUrl(url);
  refreshConflictNotices();
  if (other(deck.id).source?.kind === 'soundcloud') {
    status('SoundCloud 同士です。両方が同時に鳴るか確かめてください。', 'info');
  }
}

// --- 曲ごとの状態 (ホットキュー / ビートグリッド) ---------------------
// ローカルファイルは File ハンドル自体を保存できないので、
// 「ファイル名:サイズ」をキーにして localStorage に覚えておく。
const TRACKS_KEY = 'solo-dj.tracks.v1';

function readTracks() {
  try {
    return JSON.parse(localStorage.getItem(TRACKS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveTrackState(deck) {
  const s = deck.source;
  if (!s?.fileKey || !s.caps.grid) return;
  const tracks = readTracks();
  tracks[s.fileKey] = {
    cues: s.hotCues,
    bpm: s.grid?.bpm ?? 0,
    offset: s.grid?.offset ?? 0,
    cuePoint: s.cuePoint,
  };
  try {
    localStorage.setItem(TRACKS_KEY, JSON.stringify(tracks));
  } catch (err) {
    status(`保存できませんでした: ${err.message}`, 'error');
  }
}

function restoreTrackState(deck) {
  const s = deck.source;
  if (!s?.fileKey) return false;
  const saved = readTracks()[s.fileKey];
  if (!saved) return false;

  if (Array.isArray(saved.cues)) {
    saved.cues.forEach((at, i) => s.setHotCue(i, typeof at === 'number' ? at : null));
  }
  if (saved.bpm && s.grid) {
    s.baseBpm = saved.bpm;
    s.bpm = Math.round(saved.bpm * s.rate * 10) / 10;
    s.grid = { ...s.grid, bpm: saved.bpm, offset: saved.offset ?? s.grid.offset };
  }
  if (typeof saved.cuePoint === 'number') s.setCuePoint(saved.cuePoint);
  deck.render();
  return true;
}

async function loadLocalInto(deck, file) {
  await mixer.resume();
  status(`${file.name} を解析中…`);
  await deck.loadLocalFile(file);
  refreshConflictNotices();
  const restored = restoreTrackState(deck);
  const bpm = deck.source?.bpm;
  status(
    `デッキ ${deck.id.toUpperCase()}: ${deck.source.title}` +
      (bpm ? ` / ${restored ? '保存済み' : '推定'} ${bpm} BPM` : '') +
      (restored ? ' (ホットキュー復元)' : ''),
    'ok',
  );
}

/** 結果リストの 1 行を作る。 */
function resultRow({ title, sub, artwork, onLoad, onSave, onRemove }) {
  const li = document.createElement('li');

  if (artwork) {
    const img = document.createElement('img');
    img.src = artwork;
    img.alt = '';
    li.append(img);
  }

  const meta = document.createElement('div');
  meta.className = 'result__meta';
  const t = document.createElement('div');
  t.className = 'result__title';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'result__sub';
  s.textContent = sub;
  meta.append(t, s);
  li.append(meta);

  for (const id of ['a', 'b']) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = `→ ${id.toUpperCase()}`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await onLoad(decks[id]);
      } catch (err) {
        status(err.message || String(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
    li.append(btn);
  }

  if (onSave) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.textContent = '★';
    btn.title = 'クレートに追加';
    btn.addEventListener('click', () => onSave());
    li.append(btn);
  }
  if (onRemove) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.textContent = '✕';
    btn.addEventListener('click', () => onRemove());
    li.append(btn);
  }
  return li;
}

// ---------------------------------------------------------------- Apple Music
const appleSearch = $('#apple-search');
const appleResults = $('#apple-results');
const appleHint = $('#apple-hint');
const appleSignIn = $('#apple-signin');
let appleReady = false;

async function initAppleUi() {
  const config = await fetch('/api/config')
    .then((r) => r.json())
    .catch(() => ({ appleMusic: false }));

  if (!config.appleMusic) {
    appleHint.textContent = '未設定: .env に APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY_PATH を入れて再起動';
    appleSignIn.disabled = true;
    return;
  }
  appleHint.textContent = 'サインインすると検索できます';
}

appleSignIn.addEventListener('click', async () => {
  appleSignIn.disabled = true;
  try {
    const music = await initAppleMusic();
    if (!music.isAuthorized) await music.authorize();
    appleReady = music.isAuthorized;
    if (appleReady) {
      appleSearch.disabled = false;
      appleHint.textContent = 'サインイン済み';
      appleSignIn.textContent = '✓ サインイン済み';
      status('Apple Music にサインインしました', 'ok');
    } else {
      appleHint.textContent = 'サインインできませんでした';
      appleSignIn.disabled = false;
    }
  } catch (err) {
    appleHint.textContent = err.message;
    status(err.message, 'error');
    appleSignIn.disabled = false;
  }
});

let searchTimer = null;
appleSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const term = appleSearch.value.trim();
  if (!term) {
    appleResults.replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const tracks = await searchAppleMusic(term);
      appleResults.replaceChildren(
        ...tracks.map((track) =>
          resultRow({
            title: track.title,
            sub: `${track.artist}${track.album ? ` — ${track.album}` : ''}`,
            artwork: track.artwork,
            onLoad: (deck) => loadAppleInto(deck, track),
            onSave: () => {
              addToCrate({
                kind: 'apple',
                id: track.id,
                title: track.title,
                artist: track.artist,
                artwork: track.artwork,
                duration: track.duration,
              });
              status('クレートに追加しました', 'ok');
            },
          }),
        ),
      );
      if (!tracks.length) appleResults.replaceChildren(emptyRow('該当なし'));
    } catch (err) {
      status(`検索に失敗: ${err.message}`, 'error');
    }
  }, 350);
});

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'hint';
  li.textContent = text;
  return li;
}

// ---------------------------------------------------------------- SoundCloud
const scUrl = $('#sc-url');
for (const btn of $$('[data-load-kind="sc"]')) {
  btn.addEventListener('click', async () => {
    const url = scUrl.value.trim();
    if (!isSoundCloudUrl(url)) {
      status('SoundCloud のトラック URL を貼ってください', 'error');
      return;
    }
    btn.disabled = true;
    try {
      await loadScInto(decks[btn.dataset.loadDeck], url);
      status(`デッキ ${btn.dataset.loadDeck.toUpperCase()} に読み込みました`, 'ok');
    } catch (err) {
      status(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

$('#sc-save').addEventListener('click', () => {
  const url = scUrl.value.trim();
  if (!isSoundCloudUrl(url)) {
    status('SoundCloud のトラック URL を貼ってください', 'error');
    return;
  }
  // 再生前は曲名が取れないので、URL のパスから仮の名前を作る。
  const path = new URL(url).pathname.split('/').filter(Boolean);
  addToCrate({
    kind: 'soundcloud',
    url,
    title: decodeURIComponent(path[1] ?? url),
    artist: decodeURIComponent(path[0] ?? 'SoundCloud'),
  });
  status('クレートに追加しました', 'ok');
});

// ---------------------------------------------------------------- ローカル音源
const localResults = $('#local-results');
/** File はブラウザを閉じると失われるので、このセッション限りのリスト。 */
const localFiles = [];

$('#local-files').addEventListener('change', (event) => {
  for (const file of event.target.files) localFiles.push(file);
  renderLocal();
});

function renderLocal() {
  if (!localFiles.length) {
    localResults.replaceChildren(emptyRow('ファイルを選ぶか、デッキにドロップしてください'));
    return;
  }
  localResults.replaceChildren(
    ...localFiles.map((file) =>
      resultRow({
        title: file.name,
        sub: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
        onLoad: (deck) => loadLocalInto(deck, file),
      }),
    ),
  );
}
renderLocal();

// ---------------------------------------------------------------- クレート
const CRATE_KEY = 'solo-dj.crate.v1';
const crateResults = $('#crate-results');

function readCrate() {
  try {
    const raw = localStorage.getItem(CRATE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeCrate(items) {
  try {
    localStorage.setItem(CRATE_KEY, JSON.stringify(items));
  } catch (err) {
    status(`クレートを保存できませんでした: ${err.message}`, 'error');
  }
  renderCrate();
}

function addToCrate(item) {
  const items = readCrate();
  const key = item.kind === 'apple' ? `apple:${item.id}` : `sc:${item.url}`;
  if (items.some((i) => (i.kind === 'apple' ? `apple:${i.id}` : `sc:${i.url}`) === key)) return;
  items.unshift(item);
  writeCrate(items.slice(0, 300));
}

function renderCrate() {
  const items = readCrate();
  if (!items.length) {
    crateResults.replaceChildren(
      emptyRow('空です。Apple Music の検索結果の ★、または SoundCloud の「クレートに追加」で貯まります。'),
    );
    return;
  }
  crateResults.replaceChildren(
    ...items.map((item) =>
      resultRow({
        title: item.title,
        sub: `${item.kind === 'apple' ? 'Apple Music' : 'SoundCloud'} — ${item.artist ?? ''}`,
        artwork: item.artwork,
        onLoad: (deck) =>
          item.kind === 'apple' ? loadAppleInto(deck, item) : loadScInto(deck, item.url),
        onRemove: () => {
          const key = item.kind === 'apple' ? `apple:${item.id}` : `sc:${item.url}`;
          writeCrate(
            readCrate().filter((i) => (i.kind === 'apple' ? `apple:${i.id}` : `sc:${i.url}`) !== key),
          );
        },
      }),
    ),
  );
}

$('#crate-clear').addEventListener('click', () => {
  if (confirm('クレートを全部消しますか?')) writeCrate([]);
});
renderCrate();

// ---------------------------------------------------------------- 画面全体のドロップ
const dropzone = $('#dropzone');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (event) => {
  dragDepth = 0;
  dropzone.hidden = true;
  if (event.target.closest('[data-deck]')) return; // デッキ側で処理済み
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  // 画面の左半分なら A、右半分なら B。
  const deck = event.clientX < window.innerWidth / 2 ? decks.a : decks.b;
  try {
    await loadLocalInto(deck, files[0]);
    for (const file of files.slice(1)) localFiles.push(file);
    renderLocal();
  } catch (err) {
    status(err.message, 'error');
  }
});

// ---------------------------------------------------------------- ヘルプ
const help = $('#help');
$('#help-toggle').addEventListener('click', () => help.showModal());
$('#help-close').addEventListener('click', () => help.close());

// ---------------------------------------------------------------- キーボード
window.addEventListener('keydown', async (event) => {
  // 入力中は横取りしない。
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.metaKey || event.ctrlKey) return;

  const step = event.shiftKey ? 0.02 : 0.08;
  try {
    switch (event.key.toLowerCase()) {
      case 'q':
        await decks.a.togglePlay();
        break;
      case 'p':
        await decks.b.togglePlay();
        break;
      case 'w':
        await decks.a.cue();
        break;
      case 'o':
        await decks.b.cue();
        break;
      case 'e':
        decks.a.setCueHere();
        break;
      case 'i':
        decks.b.setCueHere();
        break;
      case '1':
      case '2':
      case '3':
      case '4': {
        const index = Number(event.key) - 1;
        const r = await decks.a.hotCue(index);
        if (r?.set) status(`デッキ A: ホットキュー ${index + 1} を設定`, 'ok');
        saveTrackState(decks.a);
        break;
      }
      case '6':
      case '7':
      case '8':
      case '9': {
        const index = Number(event.key) - 6;
        const r = await decks.b.hotCue(index);
        if (r?.set) status(`デッキ B: ホットキュー ${index + 1} を設定`, 'ok');
        saveTrackState(decks.b);
        break;
      }
      case 's': {
        const r = decks.a.syncTo(decks.b);
        status(r.ok ? `A を同期 (${r.percent.toFixed(2)}%)` : `同期できません: ${r.reason}`, r.ok ? 'ok' : 'error');
        break;
      }
      case 'l': {
        const r = decks.b.syncTo(decks.a);
        status(r.ok ? `B を同期 (${r.percent.toFixed(2)}%)` : `同期できません: ${r.reason}`, r.ok ? 'ok' : 'error');
        break;
      }
      case 'f':
        autoFade(Number($('#autofade-time').value));
        break;
      case 'arrowleft':
        setCrossfade(mixer.crossfadePosition - step);
        break;
      case 'arrowright':
        setCrossfade(mixer.crossfadePosition + step);
        break;
      case 'arrowup':
        master.value = String(Math.min(100, Number(master.value) + 5));
        mixer.setMaster(Number(master.value) / 100);
        break;
      case 'arrowdown':
        master.value = String(Math.max(0, Number(master.value) - 5));
        mixer.setMaster(Number(master.value) / 100);
        break;
      case ' ':
        event.preventDefault();
        await Promise.all(Object.values(decks).map((d) => d.source?.pause()));
        status('全デッキ停止', 'info');
        break;
      case '?':
        help.showModal();
        break;
      default:
        return;
    }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' '].includes(event.key.toLowerCase())) {
      event.preventDefault();
    }
  } catch (err) {
    status(err.message || String(err), 'error');
  }
});

initAppleUi();
status('ローカル音源はドロップするだけで使えます。? でショートカット一覧。');
