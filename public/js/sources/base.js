// すべての音源が満たす共通インターフェース。
//
// デッキ UI はこの形だけを見るので、Apple Music / SoundCloud / ローカルの
// 違いは caps (できること) の差としてだけ表に出る。

export class Source {
  constructor() {
    /** @type {'local'|'apple'|'soundcloud'} */
    this.kind = 'local';
    this.title = '';
    this.artist = '';
    this.artwork = null;
    this.duration = 0;
    this.playing = false;
    /** BPM は解析できたときだけ数値が入る。 */
    this.bpm = 0;

    /**
     * できること。false のものは UI 側で無効表示にする。
     * webAudio が false の音源は EQ・フィルター・メーター・ピッチが一切効かない。
     */
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

    this._listeners = new Map();
  }

  /** @param {'change'|'position'|'ended'|'error'} event */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[${this.kind}] listener error on "${event}"`, err);
      }
    }
  }

  // --- 以下はサブクラスが実装する ------------------------------------
  /** 再生位置 (秒)。 */
  get position() {
    return 0;
  }
  async play() {}
  async pause() {}
  async seek(_seconds) {}
  /** @param {number} _gain 0..1。Web Audio 音源はここで何もしない (グラフ側で処理)。 */
  setGain(_gain) {}
  async destroy() {}
}
