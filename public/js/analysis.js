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

/**
 * BPM を推定する。
 *
 * 手法: オンセット強度エンベロープ (ホップごとのエネルギー増分) を作り、
 * 70〜180 BPM に対応するラグ範囲で自己相関を取って最大のラグを選ぶ。
 * 4つ打ち系なら実用的な精度が出るが、生ドラムや変拍子は外す。
 * あくまで「目安」として表示し、手動で上書きできるようにしている。
 *
 * @param {AudioBuffer} buffer
 * @returns {{bpm: number, confidence: number}}
 */
export function detectBpm(buffer) {
  const sr = buffer.sampleRate;
  const hop = 512;
  const data = buffer.getChannelData(0);
  const frameCount = Math.floor(data.length / hop);

  // 1. ホップごとのエネルギー
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) sum += data[i] * data[i];
    energy[f] = sum / hop;
  }

  // 2. 増分だけ残す (半波整流) = オンセット強度
  const onset = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  // 3. 平均を引いて正規化
  let mean = 0;
  for (let f = 0; f < frameCount; f++) mean += onset[f];
  mean /= frameCount || 1;
  for (let f = 0; f < frameCount; f++) onset[f] -= mean;

  // 4. 自己相関
  const framesPerSecond = sr / hop;
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

  // 5. よくある倍/半分の取り違えを 80〜160 BPM に寄せて補正する。
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;

  const avg = scoreSum / lagCount;
  const confidence = avg > 0 ? Math.min(1, Math.max(0, (bestScore - avg) / (bestScore || 1))) : 0;

  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}
