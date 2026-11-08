// 波形ピークと BPM の推定。ローカル音源 (AudioBuffer) 専用。
// Apple Music / SoundCloud は生サンプルが取れないので解析できない。

/**
 * 波形描画用のピーク配列を作る。
 * @param {AudioBuffer} buffer
 * @param {number} bucketCount 横方向の解像度
 * @returns {{min: Float32Array, max: Float32Array, rms: Float32Array}}
 */
export function computePeaks(buffer, bucketCount = 2000) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  const rms = new Float32Array(bucketCount);
  const samplesPerBucket = Math.max(1, Math.floor(buffer.length / bucketCount));

  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(buffer.length, start + samplesPerBucket);
    let lo = 0;
    let hi = 0;
    let sum = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      // チャンネルを平均してモノラル相当で見る。
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][i];
      v /= channels.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v * v;
      n++;
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = n ? Math.sqrt(sum / n) : 0;
  }
  return { min, max, rms };
}

// BPM 推定用のホップ。テンポの自己相関にはこの粗さで足りる。
const HOP = 512;
// 位相 (1 拍目の位置) 推定用のホップ。512 だと刻みが 11.6ms になり、
// 1 拍 469ms (128 BPM) に対して数十 ms ずれる。ここだけ細かく取る。
const PHASE_HOP = 128;

/**
 * オンセット強度エンベロープ。ホップごとのエネルギーの増分 (半波整流) を取り、
 * 平均を引いて 0 中心にしたもの。BPM 推定とグリッド位相推定の共通の土台。
 *
 * @param {AudioBuffer} buffer
 * @param {number} [hop] ホップ幅 (サンプル)
 * @returns {{onset: Float32Array, framesPerSecond: number}}
 */
export function computeOnsetEnvelope(buffer, hop = HOP) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const frameCount = Math.floor(data.length / hop);

  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) sum += data[i] * data[i];
    energy[f] = sum / hop;
  }

  const onset = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  let mean = 0;
  for (let f = 0; f < frameCount; f++) mean += onset[f];
  mean /= frameCount || 1;
  for (let f = 0; f < frameCount; f++) onset[f] -= mean;

  return { onset, framesPerSecond: sr / hop };
}

/**
 * BPM を推定する。
 *
 * 手法: オンセット強度エンベロープの自己相関を 70〜180 BPM に対応するラグ範囲で
 * 取り、最大のラグを選ぶ。4つ打ち系なら実用的な精度が出るが、生ドラムや変拍子は外す。
 * あくまで「目安」として表示し、手動で上書きできるようにしている。
 *
 * @param {AudioBuffer} buffer
 * @param {{onset: Float32Array, framesPerSecond: number}} [envelope] 計算済みの包絡
 * @returns {{bpm: number, confidence: number}}
 */
export function detectBpm(buffer, envelope = computeOnsetEnvelope(buffer)) {
  const { onset, framesPerSecond } = envelope;
  const frameCount = onset.length;
  const minLag = Math.floor((framesPerSecond * 60) / 180); // 180 BPM
  const maxLag = Math.ceil((framesPerSecond * 60) / 70); //  70 BPM

  const lagCount = Math.min(maxLag, frameCount - 1) - minLag + 1;
  if (lagCount <= 2) return { bpm: 0, confidence: 0 };

  const scores = new Float32Array(lagCount);
  let bestIndex = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;

  for (let i = 0; i < lagCount; i++) {
    const lag = minLag + i;
    let sum = 0;
    for (let f = 0; f < frameCount - lag; f++) sum += onset[f] * onset[f + lag];
    const score = sum / (frameCount - lag);
    scores[i] = score;
    scoreSum += score;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // 整数ラグのままだと刻みが粗い (128 BPM が 129.2 BPM になる程度の誤差が出る)。
  // ピークの左右を放物線で補間して小数のラグを求める。
  let bestLag = minLag + bestIndex;
  if (bestIndex > 0 && bestIndex < lagCount - 1) {
    const yl = scores[bestIndex - 1];
    const y0 = scores[bestIndex];
    const yr = scores[bestIndex + 1];
    const denom = yl - 2 * y0 + yr;
    if (denom !== 0) {
      const delta = (0.5 * (yl - yr)) / denom;
      if (Math.abs(delta) <= 1) bestLag += delta;
    }
  }

  if (!bestLag) return { bpm: 0, confidence: 0 };

  let bpm = (framesPerSecond * 60) / bestLag;

  // よくある倍/半分の取り違えを 80〜160 BPM に寄せて補正する。
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;

  const avg = scoreSum / lagCount;
  const confidence = avg > 0 ? Math.min(1, Math.max(0, (bestScore - avg) / (bestScore || 1))) : 0;

  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * 1 拍ごとの櫛 (comb) をオンセット包絡に当て、いちばん乗る位相を探す。
 * @returns {{phase: number, score: number, scores: Float32Array}} phase は小数フレーム
 */
function combFit(onset, period) {
  const frameCount = onset.length;
  const phaseCount = Math.max(1, Math.round(period));
  const scores = new Float32Array(phaseCount);

  // フレーム間を線形補間して読む。位相は小数なので、丸めると精度を捨てることになる。
  const sampleAt = (x) => {
    if (x < 0 || x >= frameCount - 1) return 0;
    const i = Math.floor(x);
    const t = x - i;
    return onset[i] * (1 - t) + onset[i + 1] * t;
  };

  let bestPhase = 0;
  let bestScore = -Infinity;

  for (let p = 0; p < phaseCount; p++) {
    let sum = 0;
    let n = 0;
    for (let f = p; f < frameCount - 1; f += period) {
      sum += sampleAt(f);
      n++;
    }
    const score = n ? sum / n : 0;
    scores[p] = score;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = p;
    }
  }

  // 位相は 1 拍で巡回するので、端でも左右が取れる。
  let refined = bestPhase;
  const yl = scores[(bestPhase - 1 + phaseCount) % phaseCount];
  const y0 = scores[bestPhase];
  const yr = scores[(bestPhase + 1) % phaseCount];
  const denom = yl - 2 * y0 + yr;
  if (denom !== 0) {
    const delta = (0.5 * (yl - yr)) / denom;
    if (Math.abs(delta) <= 1) refined += delta;
  }

  return { phase: refined, score: bestScore, scores };
}

/**
 * BPM が決まっているときに、ビートグリッドの位相 (= 最初の拍の時刻) だけを求める。
 * 手動で BPM を入力し直したときに使う。
 *
 * @param {AudioBuffer} buffer
 * @param {number} bpm
 * @returns {{offset: number, confidence: number}} offset は秒
 */
export function detectBeatOffset(buffer, bpm) {
  const { onset, framesPerSecond } = computeOnsetEnvelope(buffer, PHASE_HOP);
  if (!bpm || onset.length < 8) return { offset: 0, confidence: 0 };

  const period = (framesPerSecond * 60) / bpm;
  const { phase, score, scores } = combFit(onset, period);

  let mean = 0;
  for (let i = 0; i < scores.length; i++) mean += scores[i];
  mean /= scores.length;

  return {
    offset: phaseToOffset(phase, framesPerSecond, bpm),
    confidence: score > 0 ? Math.round(Math.min(1, Math.max(0, (score - mean) / score)) * 100) / 100 : 0,
  };
}

/** 小数フレームの位相を「0 以上 1 拍未満」の秒数に直す。 */
function phaseToOffset(phase, framesPerSecond, bpm) {
  // エネルギーの立ち上がりは実際のアタックより 1 フレームぶん遅れて出るので戻す。
  let offset = (phase - 1) / framesPerSecond;
  const beatSeconds = 60 / bpm;
  offset %= beatSeconds;
  if (offset < 0) offset += beatSeconds;
  return offset;
}

/**
 * BPM と位相を同時に求める。
 *
 * 自己相関だけだと BPM が 0.3% ほどずれることがあり (128.0 を 128.4 と出すなど)、
 * 5 分の曲ではグリッドが 1 秒近く歩いてしまう。そこで自己相関の値を出発点に、
 * その周辺 ±1.5% の BPM を総当たりして「曲全体で拍にいちばん乗る BPM と位相」を選ぶ。
 * 曲が長いほどテンポが強く拘束されるので、長い曲ほど精度が上がる。
 *
 * @param {AudioBuffer} buffer
 * @returns {{bpm: number, offset: number, confidence: number}}
 */
export function detectBeatGrid(buffer) {
  const coarse = detectBpm(buffer);
  if (!coarse.bpm) return { bpm: 0, offset: 0, confidence: 0 };

  const { onset, framesPerSecond } = computeOnsetEnvelope(buffer, PHASE_HOP);
  if (onset.length < 8) return { bpm: coarse.bpm, offset: 0, confidence: 0 };

  const STEPS = 120; // 片側のステップ数
  const SPAN = 0.015; // ±1.5%
  const candidates = [];

  let best = null;
  for (let i = -STEPS; i <= STEPS; i++) {
    const bpm = coarse.bpm * (1 + (SPAN * i) / STEPS);
    const period = (framesPerSecond * 60) / bpm;
    const fit = combFit(onset, period);
    candidates.push({ bpm, score: fit.score, phase: fit.phase, scores: fit.scores });
    if (!best || fit.score > best.score) best = candidates[candidates.length - 1];
  }

  // BPM 軸でもピーク周辺を放物線補間する。
  const index = candidates.indexOf(best);
  let bpm = best.bpm;
  if (index > 0 && index < candidates.length - 1) {
    const yl = candidates[index - 1].score;
    const y0 = best.score;
    const yr = candidates[index + 1].score;
    const denom = yl - 2 * y0 + yr;
    if (denom !== 0) {
      const delta = (0.5 * (yl - yr)) / denom;
      if (Math.abs(delta) <= 1) {
        const step = candidates[index + 1].bpm - best.bpm;
        bpm = best.bpm + delta * step;
      }
    }
  }

  let mean = 0;
  for (let i = 0; i < best.scores.length; i++) mean += best.scores[i];
  mean /= best.scores.length;
  const confidence = best.score > 0 ? Math.min(1, Math.max(0, (best.score - mean) / best.score)) : 0;

  return {
    bpm: Math.round(bpm * 100) / 100,
    offset: phaseToOffset(best.phase, framesPerSecond, bpm),
    confidence: Math.round(confidence * 100) / 100,
  };
}
