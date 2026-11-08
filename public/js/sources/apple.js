// Apple Music デッキ (MusicKit JS v3)。
//
// ■ 制約 (回避不可)
//   - 音声は DRM 保護され Web Audio に取り込めない。EQ・フィルター・波形・
//     ピッチ・メーターは原理的に不可。できるのは再生 / 一時停止 / シーク / 音量。
//   - MusicKit はページに 1 インスタンスしか持てない。したがって Apple Music の
//     曲を A/B 両デッキに載せて重ねることはできない (アプリ側でロックしている)。
//   - 再生には Apple Music の有効なサブスクリプションが必要。
//
// ■ 必要なもの
//   サーバの /api/apple-token が返すデベロッパートークン (Apple Developer
//   Program のメンバーシップで作った .p8 鍵をサーバ側で署名したもの)。

import { Source } from './base.js';

const MUSICKIT_SRC = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

let configurePromise = null;

/** MusicKit JS を読み込み、configure まで済ませた共有インスタンスを返す。 */
export function initAppleMusic({ appName = 'Solo DJ', appBuild = '1.0.0' } = {}) {
  if (configurePromise) return configurePromise;

  configurePromise = (async () => {
    const res = await fetch('/api/apple-token');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'デベロッパートークンを取得できませんでした');
    }
    const { token } = await res.json();

    if (!window.MusicKit) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MUSICKIT_SRC;
        script.async = true;
        script.addEventListener('load', () => {
          // musickitloaded が既に飛んでいる場合もあるので両方見る。
          if (window.MusicKit) resolve();
          else document.addEventListener('musickitloaded', () => resolve(), { once: true });
        });
        script.addEventListener('error', () =>
          reject(new Error('MusicKit JS の読み込みに失敗しました (ネットワーク?)')),
        );
        document.head.append(script);
      });
    }

    await window.MusicKit.configure({
      developerToken: token,
      app: { name: appName, build: appBuild },
    });
    return window.MusicKit.getInstance();
  })();

  configurePromise.catch(() => {
    // 失敗したら次回やり直せるようにキャッシュを捨てる。
    configurePromise = null;
  });

  return configurePromise;
}

/** Apple Music カタログを検索する。 */
export async function searchAppleMusic(term, { limit = 25 } = {}) {
  const music = await initAppleMusic();
  const result = await music.api.music('/v1/catalog/{{storefrontId}}/search', {
    term,
    types: ['songs'],
    limit,
  });
  const songs = result?.data?.results?.songs?.data ?? [];
  return songs.map((song) => ({
    kind: 'apple',
    id: song.id,
    title: song.attributes?.name ?? '(no title)',
    artist: song.attributes?.artistName ?? '',
    album: song.attributes?.albumName ?? '',
    duration: (song.attributes?.durationInMillis ?? 0) / 1000,
    artwork: song.attributes?.artwork
      ? window.MusicKit.formatArtworkURL(song.attributes.artwork, 120, 120)
      : null,
  }));
}

export class AppleSource extends Source {
  constructor() {
    super();
    this.kind = 'apple';
    this.caps = {
      webAudio: false,
      eq: false,
      filter: false,
      pitch: false,
      waveform: false,
      cue: false,
      meter: false,
    };
    /** @type {any} MusicKit インスタンス */
    this.music = null;
    this._unbind = [];
    this._position = 0;
  }

  /** サインインを求める。既に許可済みなら即座に返る。 */
  async authorize() {
    this.music = await initAppleMusic();
    if (!this.music.isAuthorized) await this.music.authorize();
    return this.music.isAuthorized;
  }

  /** @param {{id: string, title: string, artist: string, artwork?: string|null, duration?: number}} track */
  async load(track) {
    await this.authorize();
    const music = this.music;

    this.title = track.title;
    this.artist = track.artist;
    this.artwork = track.artwork ?? null;
    this.duration = track.duration ?? 0;
    this.trackId = track.id;

    await music.setQueue({ song: track.id, startPlaying: false });

    // 実際の長さはキューに入った後の nowPlayingItem から取るのが確実。
    const item = music.nowPlayingItem;
    if (item?.attributes?.durationInMillis) {
      this.duration = item.attributes.durationInMillis / 1000;
    }

    this._bindEvents();
    this.playing = false;
    this._position = 0;
    this.emit('change');
    return this;
  }

  get position() {
    return this._position;
  }

  async play() {
    if (!this.music) return;
    await this.music.play();
  }

  async pause() {
    if (!this.music) return;
    await this.music.pause();
  }

  async seek(seconds) {
    if (!this.music) return;
    const target = Math.min(this.duration || Infinity, Math.max(0, seconds));
    await this.music.seekToTime(target);
    this._position = target;
    this.emit('change');
  }

  /** ミキサーの実効ゲインをプレイヤー音量にそのまま反映する。 */
  setGain(gain) {
    if (!this.music) return;
    this.music.volume = Math.min(1, Math.max(0, gain));
  }

  _bindEvents() {
    this._unbindAll();
    const music = this.music;
    const MK = window.MusicKit;

    const onState = () => {
      this.playing = music.playbackState === MK.PlaybackStates.playing;
      this.emit('change');
      if (music.playbackState === MK.PlaybackStates.completed) this.emit('ended');
    };
    const onTime = (e) => {
      this._position = e?.currentPlaybackTime ?? music.currentPlaybackTime ?? 0;
      if (!this.duration && music.currentPlaybackDuration) {
        this.duration = music.currentPlaybackDuration;
      }
      this.emit('position', this._position);
    };

    music.addEventListener(MK.Events.playbackStateDidChange, onState);
    music.addEventListener(MK.Events.playbackTimeDidChange, onTime);
    this._unbind = [
      () => music.removeEventListener(MK.Events.playbackStateDidChange, onState),
      () => music.removeEventListener(MK.Events.playbackTimeDidChange, onTime),
    ];
  }

  _unbindAll() {
    for (const fn of this._unbind) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this._unbind = [];
  }

  async destroy() {
    this._unbindAll();
    if (this.music) {
      try {
        await this.music.stop();
      } catch {
        /* ignore */
      }
    }
    this.music = null;
  }
}
