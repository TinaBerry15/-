// ローカル音楽ライブラリ。フォルダを丸ごと読み込んで一覧にする。
//
// 2 通りの入り口がある:
//   1. File System Access API (showDirectoryPicker) … Chrome 系。
//      フォルダの「ハンドル」を IndexedDB に保存できるので、ブラウザを閉じても
//      次回「再接続」を押すだけで同じライブラリが戻る。
//   2. <input type="file" webkitdirectory> … 上が使えないブラウザ用のフォールバック。
//      そのセッション限りで、閉じると消える。
//
// どちらも File 本体は必要になるまで読まない (getFile を遅延させる)。
// 1000 曲あるフォルダを選んだ瞬間に全部デコードし始めたら使い物にならないため。

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|opus|webm)$/i;
const MAX_FILES = 5000;

const DB_NAME = 'solo-dj';
const STORE = 'handles';
const HANDLE_KEY = 'library';

export const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** フォルダを再帰的に歩いて音声ファイルだけを拾う。 */
async function* walk(dirHandle, prefix = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue; // .DS_Store など
    if (handle.kind === 'directory') {
      yield* walk(handle, `${prefix}${name}/`);
    } else if (AUDIO_EXTENSIONS.test(name)) {
      yield { name, path: `${prefix}${name}`, getFile: () => handle.getFile() };
    }
  }
}

/**
 * @typedef {{name: string, path: string, size?: number, getFile: () => Promise<File>}} LibraryTrack
 */

/**
 * フォルダを選んでもらい、中の音声ファイルを一覧にする。
 * @param {(count: number) => void} [onProgress]
 * @returns {Promise<{name: string, tracks: LibraryTrack[], truncated: boolean}>}
 */
export async function pickDirectory(onProgress) {
  const dirHandle = await window.showDirectoryPicker({ id: 'solo-dj-library', mode: 'read' });
  await idbPut(HANDLE_KEY, dirHandle);
  return scanDirectory(dirHandle, onProgress);
}

/** 保存してあるフォルダのハンドルを返す (無ければ null)。 */
export async function savedDirectory() {
  try {
    return (await idbGet(HANDLE_KEY)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 保存済みのフォルダを読み直す。権限が切れていれば、この呼び出し
 * (ユーザー操作の中で呼ぶこと) で再許可を求める。
 * @returns {Promise<{name: string, tracks: LibraryTrack[], truncated: boolean}|null>}
 */
export async function reconnectSavedDirectory(onProgress) {
  const dirHandle = await savedDirectory();
  if (!dirHandle) return null;

  let permission = await dirHandle.queryPermission({ mode: 'read' });
  if (permission !== 'granted') {
    permission = await dirHandle.requestPermission({ mode: 'read' });
  }
  if (permission !== 'granted') {
    throw new Error('フォルダへのアクセスが許可されませんでした');
  }
  return scanDirectory(dirHandle, onProgress);
}

async function scanDirectory(dirHandle, onProgress) {
  const tracks = [];
  let truncated = false;
  for await (const track of walk(dirHandle)) {
    tracks.push(track);
    if (onProgress && tracks.length % 50 === 0) onProgress(tracks.length);
    if (tracks.length >= MAX_FILES) {
      truncated = true;
      break;
    }
  }
  tracks.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  return { name: dirHandle.name, tracks, truncated };
}

/** 保存したフォルダを忘れる。 */
export async function forgetDirectory() {
  await idbPut(HANDLE_KEY, undefined);
}

/**
 * <input type="file" webkitdirectory> で選ばれた FileList を一覧にする。
 * @param {FileList|File[]} fileList
 * @returns {{name: string, tracks: LibraryTrack[], truncated: boolean}}
 */
export function tracksFromFileList(fileList) {
  const files = [...fileList].filter((file) => AUDIO_EXTENSIONS.test(file.name));
  const truncated = files.length > MAX_FILES;
  const tracks = files.slice(0, MAX_FILES).map((file) => ({
    name: file.name,
    path: file.webkitRelativePath || file.name,
    size: file.size,
    getFile: async () => file,
  }));
  tracks.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  const first = tracks[0]?.path ?? '';
  return { name: first.includes('/') ? first.split('/')[0] : 'フォルダ', tracks, truncated };
}
