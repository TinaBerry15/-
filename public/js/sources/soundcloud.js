// SoundCloud デッキ (公式 Widget / iframe API を隔離フレーム経由で使う)。
//
// ■ なぜ Widget API なのか
//   SoundCloud は新規 API クライアント登録を長年停止しているため、client_id を
//   前提にした /tracks などの REST API は現実的に使えない。Widget API は
//   client_id 不要で、トラック URL さえあれば再生・シーク・音量を操作できる。
//
// ■ なぜ sc-frame.html に入れ子にするのか
//   SoundCloud のウィジェットは、同じページに 2 つ置くと互いを止め合う
//   (片方を再生するともう片方が一時停止する)。別タブなら同時に鳴ることを
//   実機で確認したので、止め合いはページ単位で起きている。そこでデッキごとに
//   sc-frame.html を挟み、ウィジェットを 1 ページ 1 台に隔離して、
//   親とは postMessage でやりとりする。
//
// ■ 制約 (隔離しても変わらない)
//   - 再生は iframe の中なので Web Audio に取り込めない (EQ・波形・ピッチ不可)。
//   - カタログ検索 API も使えないので、曲は「URL を貼る」か「クレート」から選ぶ。
//   - 非公開トラックや埋め込み禁止トラックは再生できない。

import { Source } from './base.js';

const FRAME_SRC = '/sc-frame.html';
const READY_TIMEOUT_MS = 20000;

/** 入力が SoundCloud のトラック URL として使えそうか判定する。 */
export function isSoundCloudUrl(value) {
  try {
    const url = new URL(value.trim());
    return /(^|\.)soundcloud\.com$/.test(url.hostname) && url.pathname.split('/').length >= 3;
  } catch {
    return false;
  }
}

export class SoundCloudSource extends Source {
  /** @param {HTMLElement} mount iframe を置くコンテナ */
  constructor(mount) {
    super();
    this.kind = 'soundcloud';
    this.caps = {
      webAudio: false,
      eq: false,
      filter: false,
      pitch: false,
      waveform: false,
      cue: false,
      grid: false,
      meter: false,
    };
    this.mount = mount;
    /** @type {HTMLIFrameElement|null} */
    this.frame = null;
    this._position = 0;
    this._gain = 1;
    this._onMessage = null;
    /** フレームから来るイベントを待つための解決関数。 */
    this._pending = null;
  }

  /** @param {string} trackUrl soundcloud.com のトラック URL */
  async load(trackUrl) {
    this._ensureFrame();
    await this._waitFor('frame-ready', 'SoundCloud の再生枠を開けませんでした');

    const ready = this._waitFor(
      'ready',
      'SoundCloud のトラックを読み込めませんでした (URL か公開設定を確認してください)',
    );
    this._post({ type: 'load', url: trackUrl });
    const info = await ready;

    this.title = info.title;
    this.artist = info.artist;
    this.artwork = info.artwork;
    this.duration = info.duration;

    this.setGain(this._gain);
    this.playing = false;
    this._position = 0;
    this.emit('change');
    return this;
  }

  get position() {
    return this._position;
  }

  async play() {
    this._post({ type: 'play' });
  }

  async pause() {
    this._post({ type: 'pause' });
  }

  async seek(seconds) {
    const target = Math.min(this.duration || Infinity, Math.max(0, seconds));
    this._post({ type: 'seek', seconds: target });
    this._position = target;
    this.emit('change');
  }

  setGain(gain) {
    this._gain = Math.min(1, Math.max(0, gain));
    this._post({ type: 'volume', gain: this._gain });
  }

  // --- 隔離フレームとのやりとり ---------------------------------------

  _ensureFrame() {
    if (this.frame) return;

    this.frame = document.createElement('iframe');
    this.frame.className = 'sc-widget';
    this.frame.allow = 'autoplay';
    this.frame.setAttribute('scrolling', 'no');
    this.frame.setAttribute('frameborder', 'no');
    this.frame.src = FRAME_SRC;
    this.mount.append(this.frame);

    this._onMessage = (event) => {
      // 自分のフレームから来たものだけを受け取る (デッキが 2 つあるので必須)。
      if (event.origin !== location.origin) return;
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data;
      if (!data || data.solodj !== true) return;
      this._handle(data);
    };
    window.addEventListener('message', this._onMessage);
  }

  _post(message) {
    this.frame?.contentWindow?.postMessage({ solodj: true, ...message }, location.origin);
  }

  _handle(data) {
    // 待ち合わせ中のイベントなら、先にそちらを解決する。
    if (this._pending) {
      if (data.type === this._pending.type) {
        const resolve = this._pending.resolve;
        this._pending = null;
        resolve(data);
        return;
      }
      if (data.type === 'error') {
        const reject = this._pending.reject;
        this._pending = null;
        reject(new Error(data.message || 'SoundCloud でエラーが発生しました'));
        return;
      }
    }

    switch (data.type) {
      case 'play':
        this.playing = true;
        this.emit('change');
        break;
      case 'pause':
        this.playing = false;
        this.emit('change');
        break;
      case 'finish':
        this.playing = false;
        this.emit('ended');
        this.emit('change');
        break;
      case 'progress':
        this._position = data.position ?? 0;
        this.emit('position', this._position);
        break;
      case 'error':
        this.emit('error', new Error(data.message));
        break;
    }
  }

  /**
   * フレームから特定の種類のメッセージが来るのを待つ。
   * @param {string} type
   * @param {string} timeoutMessage
   */
  _waitFor(type, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending?.timer === timer) this._pending = null;
        reject(new Error(timeoutMessage));
      }, READY_TIMEOUT_MS);

      this._pending = {
        type,
        timer,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  async destroy() {
    this._post({ type: 'pause' });
    if (this._onMessage) {
      window.removeEventListener('message', this._onMessage);
      this._onMessage = null;
    }
    if (this._pending) {
      clearTimeout(this._pending.timer);
      this._pending = null;
    }
    if (this.frame) {
      this.frame.remove();
      this.frame = null;
    }
  }
}
