// 2ch ミキサーの音声グラフ。
//
// 重要な前提: Apple Music / SoundCloud の音声は DRM 保護されていて Web Audio に
// 流し込めない。そのため「チャンネル」は 2 種類の実装を持つ:
//
//   webAudio: true  … ローカル音源。input ノードに繋いで EQ / フィルター / メーターが効く
//   webAudio: false … DRM 音源。ゲイン計算だけ行い、結果を onGain コールバックで
//                     各プレイヤーの volume に反映する (EQ やメーターは不可)
//
// どちらの場合も「トリム × EQ × フェーダー × クロスフェーダー × マスター」という
// 同じ計算モデルに見えるようにして、UI 側が分岐しなくて済むようにしている。

/** クロスフェーダー位置 (0..1) から定パワーカーブのゲインを求める。 */
export function crossfadeGains(position) {
  const x = Math.min(1, Math.max(0, position));
  return { a: Math.cos((x * Math.PI) / 2), b: Math.sin((x * Math.PI) / 2) };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

class Channel {
  /**
   * @param {Mixer} mixer
   * @param {'a'|'b'} id
   */
  constructor(mixer, id) {
    this.mixer = mixer;
    this.id = id;

    this.trim = 1; // 0..1.4 程度 (入力レベル合わせ)
    this.fader = 1; // 0..1 チャンネルフェーダー
    this.crossfade = 1; // 0..1 クロスフェーダーから供給される
    this.muted = false;
    this.webAudio = false;

    /** DRM プレイヤー側に実効音量を渡すコールバック。 */
    this.onGain = null;

    const ctx = mixer.ctx;

    // --- ローカル音源用のチェーン -------------------------------------
    // input -> trim -> low -> mid -> high -> hpf -> lpf -> fader -> xfade -> master
    this.inputNode = ctx.createGain();
    this.trimNode = ctx.createGain();

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 180;

    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;

    // フィルターノブ 1 本で LPF/HPF を両方向に振る。中央では両方素通し。
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.9;

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 22050;
    this.lpf.Q.value = 0.9;

    this.faderNode = ctx.createGain();
    this.xfadeNode = ctx.createGain();

    // メーター用。フェーダー後に挿して「実際に出ている音」を測る。
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this._meterBuf = new Float32Array(this.analyser.fftSize);

    this.inputNode
      .connect(this.trimNode)
      .connect(this.eqLow)
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.hpf)
      .connect(this.lpf)
      .connect(this.faderNode)
      .connect(this.xfadeNode)
      .connect(mixer.masterNode);

    this.xfadeNode.connect(this.analyser);

    this._applyGain();
  }

  /** このチャンネルに載っている音源が Web Audio を通るかどうかを宣言する。 */
  setWebAudio(enabled) {
    this.webAudio = enabled;
    this._applyGain();
  }

  /** @param {'low'|'mid'|'high'} band @param {number} db -26..+8 */
  setEq(band, db) {
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    this._ramp(node.gain, db);
  }

  /** @param {number} value -1 (ローパス全閉) .. 0 (素通し) .. +1 (ハイパス全閉) */
  setFilter(value) {
    const v = Math.min(1, Math.max(-1, value));
    if (v < -0.01) {
      // 20kHz -> 200Hz を対数で下げる
      const f = 200 * Math.pow(22050 / 200, 1 + v);
      this._ramp(this.lpf.frequency, f);
      this._ramp(this.hpf.frequency, 20);
    } else if (v > 0.01) {
      // 20Hz -> 4kHz を対数で上げる
      const f = 20 * Math.pow(4000 / 20, v);
      this._ramp(this.hpf.frequency, f);
      this._ramp(this.lpf.frequency, 22050);
    } else {
      this._ramp(this.lpf.frequency, 22050);
      this._ramp(this.hpf.frequency, 20);
    }
  }

  setTrim(v) {
    this.trim = Math.min(1.4, Math.max(0, v));
    this._applyGain();
  }

  setFader(v) {
    this.fader = clamp01(v);
    this._applyGain();
  }

  setCrossfade(v) {
    this.crossfade = clamp01(v);
    this._applyGain();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._applyGain();
  }

  /** クロスフェーダーとフェーダーを掛けた、このチャンネルの実効ゲイン (0..1.4)。 */
  get effectiveGain() {
    if (this.muted) return 0;
    return this.trim * this.fader * this.crossfade;
  }

  /** メーター用の RMS (0..1)。DRM チャンネルは測れないので null。 */
  readLevel() {
    if (!this.webAudio) return null;
    this.analyser.getFloatTimeDomainData(this._meterBuf);
    let sum = 0;
    for (let i = 0; i < this._meterBuf.length; i++) sum += this._meterBuf[i] * this._meterBuf[i];
    return Math.sqrt(sum / this._meterBuf.length);
  }

  _applyGain() {
    if (this.webAudio) {
      this._ramp(this.trimNode.gain, this.muted ? 0 : this.trim);
      this._ramp(this.faderNode.gain, this.fader);
      this._ramp(this.xfadeNode.gain, this.crossfade);
    } else {
      // DRM プレイヤーには掛け算した結果だけを渡す。
      this._ramp(this.trimNode.gain, 0); // 念のためグラフ側は無音に
      if (this.onGain) this.onGain(clamp01(this.effectiveGain * this.mixer.masterLevel));
    }
  }

  /** クリックノイズを避けるため、値は必ず短いランプで変える。 */
  _ramp(param, value) {
    const now = this.mixer.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.012);
  }
}

export class Mixer {
  constructor() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.masterNode = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    // 荒いリミッター。クロスフェード中の合成でクリップするのを防ぐ。
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;

    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this._masterBuf = new Float32Array(this.masterAnalyser.fftSize);

    this.masterNode.connect(this.limiter).connect(this.ctx.destination);
    this.limiter.connect(this.masterAnalyser);

    this.masterLevel = 0.85;
    this.masterNode.gain.value = this.masterLevel;

    this.channels = {
      a: new Channel(this, 'a'),
      b: new Channel(this, 'b'),
    };

    this.setCrossfade(0.5);
  }

  /** ブラウザの自動再生ポリシー対策。ユーザー操作のたびに呼んで良い。 */
  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setMaster(level) {
    this.masterLevel = clamp01(level);
    const now = this.ctx.currentTime;
    this.masterNode.gain.cancelScheduledValues(now);
    this.masterNode.gain.setTargetAtTime(this.masterLevel, now, 0.015);
    // DRM チャンネルはマスターがグラフに乗らないので再計算が必要。
    for (const ch of Object.values(this.channels)) if (!ch.webAudio) ch._applyGain();
  }

  /** @param {number} position 0 = A 全開, 1 = B 全開 */
  setCrossfade(position) {
    this.crossfadePosition = clamp01(position);
    const { a, b } = crossfadeGains(this.crossfadePosition);
    this.channels.a.setCrossfade(a);
    this.channels.b.setCrossfade(b);
  }

  readMasterLevel() {
    this.masterAnalyser.getFloatTimeDomainData(this._masterBuf);
    let peak = 0;
    for (let i = 0; i < this._masterBuf.length; i++) {
      const v = Math.abs(this._masterBuf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }
}
