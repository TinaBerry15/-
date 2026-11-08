// ローカル音源デッキ。これだけが Web Audio のフル機能を使える。
//
// AudioBufferSourceNode は一度 stop すると再利用できないので、
// 再生/一時停止/シークのたびに作り直し、位置は AudioContext の時計から計算する。

import { Source } from './base.js';
import { computePeaks, detectBpm } from '../analysis.js';

export class LocalSource extends Source {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination チャンネルの input ノード
   */
  constructor(ctx, destination) {
    super();
    this.kind = 'local';
    this.ctx = ctx;
    this.destination = destination;
    this.caps = {
      webAudio: true,
      eq: true,
      filter: true,
      pitch: true,
      waveform: true,
      cue: true,
      meter: true,
    };

    /** @type {AudioBuffer|null} */
    this.buffer = null;
    /** @type {AudioBufferSourceNode|null} */
    this.node = null;
    this.peaks = null;
    this.rate = 1; // ピッチ (再生速度)
    this.loop = null; // {start, end} 秒
    this.cuePoint = 0;
    this.baseBpm = 0; // 解析された元の BPM

    this._offset = 0; // バッファ内の再生開始位置 (秒)
    this._startedAt = 0; // 再生開始時の ctx.currentTime
  }

  /**
   * File / Blob を読み込んでデコードし、波形と BPM を解析する。
   * @param {File|Blob} file
   */
  async load(file) {
    const arrayBuffer = await file.arrayBuffer();
    await this.stopNode();

    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.duration = this.buffer.duration;
    this.title = (file.name || 'Untitled').replace(/\.[^.]+$/, '');
    this.artist = 'ローカルファイル';
    this.peaks = computePeaks(this.buffer, 2400);

    const { bpm } = detectBpm(this.buffer);
    this.baseBpm = bpm;
    this.bpm = bpm;

    this._offset = 0;
    this._startedAt = 0;
    this.cuePoint = 0;
    this.playing = false;
    this.emit('change');
    return this;
  }

  get position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this._offset;
    const elapsed = (this.ctx.currentTime - this._startedAt) * this.rate;
    return Math.min(this.duration, this._offset + elapsed);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this._startNode(this._offset);
    this.playing = true;
    this.emit('change');
  }

  async pause() {
    if (!this.playing) return;
    const pos = this.position;
    await this.stopNode();
    this._offset = pos;
    this.playing = false;
    this.emit('change');
  }

  async seek(seconds) {
    if (!this.buffer) return;
    const target = Math.min(this.duration, Math.max(0, seconds));
    if (this.playing) {
      await this.stopNode();
      this._startNode(target);
    } else {
      this._offset = target;
    }
    this.emit('change');
  }

  /** ピッチ (再生速度)。1 = 原曲。 */
  setRate(rate) {
    const r = Math.min(2, Math.max(0.5, rate));
    // 位置が飛ばないように、今の位置を確定させてから倍率を変える。
    const pos = this.position;
    this.rate = r;
    if (this.playing) {
      this._offset = pos;
      this._startedAt = this.ctx.currentTime;
      if (this.node) this.node.playbackRate.setTargetAtTime(r, this.ctx.currentTime, 0.02);
    }
    this.bpm = this.baseBpm ? Math.round(this.baseBpm * r * 10) / 10 : 0;
    this.emit('change');
  }

  /** @param {{start: number, end: number}|null} range */
  setLoop(range) {
    this.loop = range;
    if (!this.node) return;
    if (range) {
      this.node.loop = true;
      this.node.loopStart = range.start;
      this.node.loopEnd = range.end;
    } else {
      this.node.loop = false;
    }
  }

  setCuePoint(seconds) {
    this.cuePoint = Math.min(this.duration, Math.max(0, seconds));
    this.emit('change');
  }

  /** Web Audio 側のゲインはミキサーのグラフが持つので、ここでは何もしない。 */
  setGain() {}

  async stopNode() {
    if (!this.node) return;
    const node = this.node;
    this.node = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* 既に停止済み */
    }
    node.disconnect();
  }

  _startNode(offset) {
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.playbackRate.value = this.rate;
    if (this.loop) {
      node.loop = true;
      node.loopStart = this.loop.start;
      node.loopEnd = this.loop.end;
    }
    node.connect(this.destination);
    node.onended = () => {
      // シーク等で自分が差し替えられた後の ended は無視する。
      if (this.node !== node) return;
      this.playing = false;
      this._offset = this.duration;
      this.node = null;
      this.emit('ended');
      this.emit('change');
    };
    node.start(0, offset);
    this.node = node;
    this._offset = offset;
    this._startedAt = this.ctx.currentTime;
  }

  async destroy() {
    await this.stopNode();
    this.buffer = null;
    this.peaks = null;
  }
}
