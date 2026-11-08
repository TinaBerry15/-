// SoundCloud デッキ (公式 Widget / iframe API)。
//
// ■ なぜ Widget API なのか
//   SoundCloud は新規 API クライアント登録を長年停止しているため、client_id を
//   前提にした /tracks などの REST API は現実的に使えない。Widget API は
//   client_id 不要で、トラック URL さえあれば再生・シーク・音量を操作できる。
//
// ■ 制約
//   - 再生は iframe の中なので Web Audio に取り込めない (EQ・波形・ピッチ不可)。
//   - カタログ検索 API も使えないので、曲は「URL を貼る」か「クレート (localStorage)」
//     から選ぶ方式にしている。
//   - 非公開トラックや埋め込み禁止トラックは再生できない。

import { Source } from './base.js';

const WIDGET_API = 'https://w.soundcloud.com/player/api.js';

let apiPromise = null;

function loadWidgetApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.SC?.Widget) return resolve(window.SC);
    const script = document.createElement('script');
    script.src = WIDGET_API;
    script.async = true;
    script.addEventListener('load', () => resolve(window.SC));
    script.addEventListener('error', () =>
      reject(new Error('SoundCloud Widget API の読み込みに失敗しました')),
    );
    document.head.append(script);
  });
  apiPromise.catch(() => {
    apiPromise = null;
  });
  return apiPromise;
}

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
    this.iframe = null;
    this.widget = null;
    this._position = 0;
    this._gain = 1;
  }

  /** @param {string} trackUrl soundcloud.com のトラック URL */
  async load(trackUrl) {
    const SC = await loadWidgetApi();

    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.className = 'sc-widget';
      this.iframe.allow = 'autoplay';
      this.iframe.setAttribute('scrolling', 'no');
      this.iframe.setAttribute('frameborder', 'no');
      this.mount.append(this.iframe);
    }

    const params = new URLSearchParams({
      url: trackUrl,
      auto_play: 'false',
      show_artwork: 'false',
      visual: 'false',
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'true',
      sharing: 'false',
      download: 'false',
      buying: 'false',
    });
    this.iframe.src = `https://w.soundcloud.com/player/?${params.toString()}`;

    this.widget = SC.Widget(this.iframe);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('SoundCloud のトラックを読み込めませんでした (URL か公開設定を確認)')),
        15000,
      );
      this.widget.bind(SC.Widget.Events.READY, () => {
        clearTimeout(timer);
        resolve();
      });
      this.widget.bind(SC.Widget.Events.ERROR, () => {
        clearTimeout(timer);
        reject(new Error('SoundCloud が再生を拒否しました (非公開/埋め込み禁止トラック?)'));
      });
    });

    await this._readMetadata();
    this._bindEvents(SC);
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
    this.widget?.play();
  }

  async pause() {
    this.widget?.pause();
  }

  async seek(seconds) {
    if (!this.widget) return;
    const target = Math.min(this.duration || Infinity, Math.max(0, seconds));
    this.widget.seekTo(target * 1000);
    this._position = target;
    this.emit('change');
  }

  /** Widget API の音量は 0〜100。 */
  setGain(gain) {
    this._gain = Math.min(1, Math.max(0, gain));
    this.widget?.setVolume(this._gain * 100);
  }

  _readMetadata() {
    return new Promise((resolve) => {
      this.widget.getCurrentSound((sound) => {
        if (sound) {
          this.title = sound.title ?? '(no title)';
          this.artist = sound.user?.username ?? 'SoundCloud';
          this.artwork = sound.artwork_url ?? sound.user?.avatar_url ?? null;
          this.duration = (sound.duration ?? 0) / 1000;
        }
        resolve();
      });
    });
  }

  _bindEvents(SC) {
    const E = SC.Widget.Events;
    this.widget.bind(E.PLAY, () => {
      this.playing = true;
      this.emit('change');
    });
    this.widget.bind(E.PAUSE, () => {
      this.playing = false;
      this.emit('change');
    });
    this.widget.bind(E.FINISH, () => {
      this.playing = false;
      this.emit('ended');
      this.emit('change');
    });
    this.widget.bind(E.PLAY_PROGRESS, (data) => {
      this._position = (data?.currentPosition ?? 0) / 1000;
      this.emit('position', this._position);
    });
  }

  async destroy() {
    try {
      this.widget?.pause();
    } catch {
      /* ignore */
    }
    this.widget = null;
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
  }
}
