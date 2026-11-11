// デッキ 1 台分。ミキサーのチャンネル 1 本と音源 1 つを束ねて、
// トランスポート操作・波形描画・BPM シンクを提供する。

import { LocalSource } from './sources/local.js';
import { AppleSource } from './sources/apple.js';
import { SoundCloudSource } from './sources/soundcloud.js';

/** ホットキュー 1〜4 の色。デッキ色と混同しないよう固定。 */
const HOTCUE_COLORS = ['#ffd166', '#06d6a0', '#8d99ff', '#ff8fab'];

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export class Deck {
  /**
   * @param {'a'|'b'} id
   * @param {import('./mixer.js').Mixer} mixer
   * @param {HTMLElement} root このデッキの DOM ルート
   */
  constructor(id, mixer, root) {
    this.id = id;
    this.mixer = mixer;
    this.channel = mixer.channels[id];
    this.root = root;

    /** @type {import('./sources/base.js').Source|null} */
    this.source = null;
    this.bpmOverride = 0; // 手動で入れた BPM (解析が外れたとき用)

    this.el = {
      title: root.querySelector('[data-deck-title]'),
      artist: root.querySelector('[data-deck-artist]'),
      badge: root.querySelector('[data-deck-badge]'),
      time: root.querySelector('[data-deck-time]'),
      remain: root.querySelector('[data-deck-remain]'),
      bpm: root.querySelector('[data-deck-bpm]'),
      canvas: root.querySelector('canvas[data-deck-waveform]'),
      playBtn: root.querySelector('[data-action="play"]'),
      scMount: root.querySelector('[data-sc-mount]'),
      meter: root.querySelector('[data-deck-meter]'),
      pitchValue: root.querySelector('[data-pitch-value]'),
      notice: root.querySelector('[data-deck-notice]'),
      pads: [...root.querySelectorAll('[data-hotcue]')],
      gridInfo: root.querySelector('[data-grid-info]'),
      silent: root.querySelector('[data-deck-silent]'),
    };

    /** 無音バッジの文言。毎フレーム DOM を触らないよう、変わったときだけ書く。 */
    this._silentLabel = null;

    this.ctx2d = this.el.canvas.getContext('2d');
    this._resizeCanvas();
    new ResizeObserver(() => this._resizeCanvas()).observe(this.el.canvas);

    // DRM 音源のときは、ミキサーが計算した実効ゲインをプレイヤー音量に流す。
    this.channel.onGain = (gain) => this.source?.setGain(gain);

    this._bindWaveformScrub();
    this.render();
  }

  // --- 読み込み -------------------------------------------------------

  async loadLocalFile(file) {
    await this._swapSource(new LocalSource(this.mixer.ctx, this.channel.inputNode));
    this._notice('');
    await this.source.load(file);
    this.bpmOverride = 0;
    this.render();
  }

  /** @param {{id: string, title: string, artist: string, artwork?: string|null, duration?: number}} track */
  async loadAppleTrack(track) {
    await this._swapSource(new AppleSource());
    this._notice('Apple Music は再生・シーク・音量のみ (EQ / 波形 / ピッチは不可)');
    await this.source.load(track);
    this.render();
  }

  /** @param {string} url */
  async loadSoundCloudUrl(url) {
    await this._swapSource(new SoundCloudSource(this.el.scMount));
    this._notice('SoundCloud は再生・シーク・音量のみ (EQ / 波形 / ピッチは不可)');
    await this.source.load(url);
    this.render();
  }

  async eject() {
    await this._swapSource(null);
    this._notice('');
    this.render();
  }

  async _swapSource(next) {
    if (this.source) {
      await this.source.destroy();
      this.source = null;
    }
    if (this.el.scMount) this.el.scMount.replaceChildren();

    this.source = next;
    this.channel.setWebAudio(Boolean(next?.caps.webAudio));

    if (next) {
      next.on('change', () => this.render());
      next.on('position', () => this.renderProgress());
      next.on('ended', () => this.render());
      // DRM 音源には今のゲインをすぐ渡す。
      if (!next.caps.webAudio) next.setGain(this.channel.effectiveGain * this.mixer.masterLevel);
    }
  }

  // --- トランスポート -------------------------------------------------

  async togglePlay() {
    if (!this.source) return;
    await this.mixer.resume();
    if (this.source.playing) await this.source.pause();
    else await this.source.play();
  }

  /** CUE: 止まっていればキュー位置へ戻る、鳴っていれば止めてキュー位置へ。 */
  async cue() {
    if (!this.source) return;
    if (!this.source.caps.cue) {
      await this.source.seek(0);
      return;
    }
    if (this.source.playing) {
      await this.source.pause();
      await this.source.seek(this.source.cuePoint ?? 0);
    } else if (Math.abs(this.source.position - (this.source.cuePoint ?? 0)) < 0.05) {
      // すでにキュー位置 -> ここを新しいキューにはせず、頭から再生
      await this.source.play();
    } else {
      await this.source.seek(this.source.cuePoint ?? 0);
    }
  }

  // --- ホットキュー --------------------------------------------------

  /**
   * パッドを押したときの動作。
   * 空なら今の位置を記録し、入っていればそこへ飛んで再生する。
   * @param {number} index 0..3
   */
  async hotCue(index) {
    const s = this.source;
    if (!s?.caps.cue) return;
    const at = s.hotCues?.[index];
    if (at === null || at === undefined) {
      s.setHotCue(index, s.position);
      this.render();
      return { set: true, at: s.position };
    }
    await s.seek(at);
    if (!s.playing) await this.togglePlay();
    return { set: false, at };
  }

  /** @param {number} index 0..3 */
  clearHotCue(index) {
    this.source?.setHotCue?.(index, null);
    this.render();
  }

  // --- ビートグリッド --------------------------------------------------

  /** @param {number} deltaSeconds 正で後ろへ */
  nudgeGrid(deltaSeconds) {
    this.source?.nudgeGrid?.(deltaSeconds);
    this.render();
  }

  setDownbeatHere() {
    this.source?.setDownbeatHere?.();
    this.render();
  }

  /**
   * BPM を手で入れ直す。ローカル音源ならグリッドごと取り直し、
   * DRM 音源は表示と SYNC の参照値としてだけ覚える。
   * @param {number} bpm 0 で解除
   */
  setManualBpm(bpm) {
    if (this.source?.caps.grid && bpm) {
      this.bpmOverride = 0;
      this.source.setBaseBpm(bpm);
    } else {
      this.bpmOverride = bpm > 0 ? bpm : 0;
    }
    this.render();
  }

  /** 今の位置を CUE として覚える (ローカル音源のみ)。 */
  setCueHere() {
    if (this.source?.caps.cue) this.source.setCuePoint(this.source.position);
    this.render();
  }

  async nudge(seconds) {
    if (!this.source) return;
    await this.source.seek(this.source.position + seconds);
  }

  /** @param {number} percent -8..+8 (%) */
  setPitch(percent) {
    if (!this.source?.caps.pitch) return;
    this.source.setRate(1 + percent / 100);
    if (this.el.pitchValue) {
      this.el.pitchValue.textContent = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
    }
    this.render();
  }

  /** 表示中の BPM。ローカル音源はグリッドの値、DRM 音源は手入力値。 */
  get bpm() {
    if (this.source?.caps.grid) return this.source.bpm ?? 0;
    if (this.bpmOverride) {
      const rate = this.source?.rate ?? 1;
      return Math.round(this.bpmOverride * rate * 10) / 10;
    }
    return this.source?.bpm ?? 0;
  }

  /** 元 BPM (ピッチ 0% 相当)。 */
  get baseBpm() {
    return this.bpmOverride || this.source?.baseBpm || 0;
  }

  /**
   * 相手デッキの BPM に合わせてピッチを動かす。
   * ローカル音源同士でのみ可能 (DRM 音源は再生速度を変えられない)。
   * @param {Deck} other
   * @returns {{ok: boolean, reason?: string, percent?: number}}
   */
  syncTo(other) {
    if (!this.source?.caps.pitch) {
      return { ok: false, reason: 'このデッキの音源はピッチを変えられません (DRM)' };
    }
    const target = other.bpm;
    const mine = this.baseBpm;
    if (!target || !mine) {
      return { ok: false, reason: 'BPM が取れていません (手動で入力してください)' };
    }
    let ratio = target / mine;
    // 倍 / 半分で近い方に寄せる。
    while (ratio > 1.35) ratio /= 2;
    while (ratio < 0.74) ratio *= 2;
    const percent = (ratio - 1) * 100;
    if (Math.abs(percent) > 16) {
      return { ok: false, reason: `差が大きすぎます (${percent.toFixed(1)}%)` };
    }
    this.setPitch(percent);

    // テンポを合わせただけでは拍の頭は揃わないので、位相も合わせる。
    const aligned = this.alignBeatTo(other);
    return { ok: true, percent, aligned };
  }

  /**
   * 相手デッキと拍の頭を揃える。テンポが合っている前提で、
   * 半拍を超えない範囲でこのデッキの再生位置をずらす。
   * @param {Deck} other
   * @returns {boolean} 揃えられたか
   */
  alignBeatTo(other) {
    const mine = this.source;
    const theirs = other.source;
    if (!mine?.grid || !theirs?.grid) return false;

    const myPhase = mine.beatPhase();
    const theirPhase = theirs.beatPhase();
    if (myPhase === null || theirPhase === null) return false;

    // 位相差を -0.5..0.5 に畳む (遠回りしない)。
    let delta = theirPhase - myPhase;
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;

    mine.seek(mine.position + delta * mine.beatSeconds);
    return true;
  }

  // --- 描画 -----------------------------------------------------------

  render() {
    const s = this.source;
    this.el.title.textContent = s?.title || '— 空 —';
    this.el.artist.textContent = s?.artist || '';
    this.el.badge.textContent = s
      ? { local: 'LOCAL', apple: 'APPLE MUSIC', soundcloud: 'SOUNDCLOUD' }[s.kind]
      : '';
    this.el.badge.dataset.kind = s?.kind ?? '';
    this.el.bpm.textContent = this.bpm ? this.bpm.toFixed(1) : '--';
    this.el.playBtn.textContent = s?.playing ? '❚❚' : '▶';
    this.el.playBtn.classList.toggle('is-playing', Boolean(s?.playing));
    this.root.classList.toggle('deck--loaded', Boolean(s));
    this.root.dataset.sourceKind = s?.kind ?? 'none';

    // できないことは UI 上も無効にする (黙って効かないのを防ぐ)。
    for (const el of this.root.querySelectorAll('[data-requires]')) {
      const cap = el.dataset.requires;
      const ok = Boolean(s?.caps?.[cap]);
      el.toggleAttribute('disabled', !ok);
      el.closest('.control')?.classList.toggle('control--disabled', !ok);
    }

    this.renderPads();
    this.renderGridInfo();
    this.renderSilentBadge();
    this.drawWaveform();
    this.renderProgress();
  }

  renderPads() {
    const s = this.source;
    this.el.pads.forEach((pad, i) => {
      const at = s?.hotCues?.[i];
      const isSet = at !== null && at !== undefined;
      pad.classList.toggle('is-set', isSet);
      pad.style.setProperty('--pad-color', HOTCUE_COLORS[i]);
      const time = pad.querySelector('[data-pad-time]');
      if (time) time.textContent = isSet ? fmtTime(at) : '空';
    });
  }

  renderGridInfo() {
    if (!this.el.gridInfo) return;
    const g = this.source?.grid;
    this.el.gridInfo.textContent = g
      ? `1拍目 ${(g.offset * 1000).toFixed(0)}ms / 信頼度 ${g.confidence.toFixed(2)}`
      : 'グリッドなし';
  }

  renderProgress() {
    const s = this.source;
    const pos = s?.position ?? 0;
    const dur = s?.duration ?? 0;
    this.el.time.textContent = fmtTime(pos);
    this.el.remain.textContent = `-${fmtTime(Math.max(0, dur - pos))}`;
    this.drawWaveform();
  }

  /**
   * このデッキが今なぜ無音なのかを示す。
   *
   * クロスフェーダーが反対側に振り切っているだけで音が出ないのは正しい動作だが、
   * 画面に何も出ないと「壊れている」ようにしか見えないので、理由を出す。
   * @returns {string|null}
   */
  silentReason() {
    if (!this.source) return null;
    const ch = this.channel;
    if (ch.muted) return '無音: MUTE';
    if (ch.crossfade < 0.02) return `無音: クロスフェーダーが ${this.id === 'a' ? 'B' : 'A'} 側`;
    if (ch.fader < 0.02) return '無音: フェーダーが 0';
    if (ch.trim < 0.02) return '無音: TRIM が 0';
    if (this.mixer.masterLevel < 0.02) return '無音: マスターが 0';
    return null;
  }

  renderSilentBadge() {
    if (!this.el.silent) return;
    const label = this.silentReason();
    if (label === this._silentLabel) return;
    this._silentLabel = label;
    this.el.silent.textContent = label ?? '';
    this.el.silent.hidden = !label;
  }

  /** メーターはローカル音源のときだけ動く。 */
  renderMeter() {
    if (!this.el.meter) return;
    const level = this.channel.readLevel();
    if (level === null) {
      this.el.meter.style.setProperty('--level', '0');
      this.el.meter.dataset.state = 'na';
      return;
    }
    this.el.meter.dataset.state = 'ok';
    // RMS をおおよそ dB 感のあるスケールに。
    const scaled = Math.min(1, Math.pow(level * 2.4, 0.6));
    this.el.meter.style.setProperty('--level', scaled.toFixed(3));
  }

  drawWaveform() {
    const ctx = this.ctx2d;
    const { width, height } = this._canvasSize;
    if (!width || !height) return;
    const s = this.source;

    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const progress = s && s.duration ? Math.min(1, s.position / s.duration) : 0;

    if (s?.caps.waveform && s.peaks) {
      const { min, max } = s.peaks;
      const buckets = min.length;
      const playedX = progress * width;

      for (let x = 0; x < width; x++) {
        const b = Math.min(buckets - 1, Math.floor((x / width) * buckets));
        const top = mid - max[b] * mid * 0.92;
        const bottom = mid - min[b] * mid * 0.92;
        ctx.fillStyle = x <= playedX ? 'rgba(255,255,255,0.28)' : this._accent;
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }

      // ビートグリッド。拍が詰まりすぎたら小節線だけ、それも詰まるなら 4 小節ごと。
      if (s.grid?.bpm) {
        const beat = 60 / s.grid.bpm;
        const beatPx = (beat / s.duration) * width;
        let every = 0;
        if (beatPx >= 5) every = 1;
        else if (beatPx * 4 >= 5) every = 4;
        else if (beatPx * 16 >= 5) every = 16;

        if (every) {
          for (let k = 0; ; k += every) {
            const t = s.grid.offset + k * beat;
            if (t > s.duration) break;
            const gx = (t / s.duration) * width;
            const isBar = k % 4 === 0;
            ctx.fillStyle = isBar ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.17)';
            ctx.fillRect(gx, isBar ? 0 : height * 0.2, 1, isBar ? height : height * 0.6);
          }
        }
      }

      // ループ範囲
      if (s.loop) {
        const x1 = (s.loop.start / s.duration) * width;
        const x2 = (s.loop.end / s.duration) * width;
        ctx.fillStyle = 'rgba(255, 209, 102, 0.16)';
        ctx.fillRect(x1, 0, x2 - x1, height);
      }

      // キュー位置
      if (s.cuePoint) {
        const cx = (s.cuePoint / s.duration) * width;
        ctx.fillStyle = '#ffffff88';
        ctx.fillRect(cx - 1, 0, 2, height);
      }

      // ホットキュー
      s.hotCues?.forEach((at, i) => {
        if (at === null || at === undefined) return;
        const hx = (at / s.duration) * width;
        ctx.fillStyle = HOTCUE_COLORS[i];
        ctx.fillRect(hx - 1, 0, 2, height);
        ctx.fillRect(hx - 1, 0, 13, 13);
        ctx.fillStyle = '#0b0d12';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.fillText(String(i + 1), hx + 2, 10);
      });
    } else if (s) {
      // 波形が取れない音源は、進捗バーだけ描く (偽の波形は描かない)。
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, mid - 3, width, 6);
      ctx.fillStyle = this._accent;
      ctx.fillRect(0, mid - 3, width * progress, 6);

      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('波形なし (DRM 音源)', 8, 14);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, mid - 1, width, 2);
      return;
    }

    // プレイヘッド
    const px = progress * width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(px - 1, 0, 2, height);
  }

  _notice(text) {
    if (this.el.notice) {
      this.el.notice.textContent = text;
      this.el.notice.hidden = !text;
    }
  }

  get _accent() {
    return this.id === 'a' ? '#4cc9f0' : '#f72585';
  }

  _resizeCanvas() {
    const rect = this.el.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.el.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._canvasSize = { width: rect.width, height: rect.height };
    this.drawWaveform();
  }

  /** 波形をクリック / ドラッグでシークする。 */
  _bindWaveformScrub() {
    const canvas = this.el.canvas;
    const seekFromEvent = (event) => {
      if (!this.source?.duration) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.source.seek(ratio * this.source.duration);
    };

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      seekFromEvent(event);
      const onMove = (e) => seekFromEvent(e);
      const onUp = () => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
    });
  }
}
