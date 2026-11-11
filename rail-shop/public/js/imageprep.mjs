// 登録前に写真をブラウザ側で整える。
//   - 長辺 1400px に縮める (スマホの写真はそのままだと重すぎる)
//   - 希望があれば背景を透かす
//
// 背景の透過は「四辺から、縁の色に近い画素を塗りつぶしていく」だけの単純な方法。
// 白い壁や床に平置きした写真ではきれいに抜けるが、柄のある背景や、
// 服と背景の色が近い写真では抜けない / 服まで欠ける。その場合は使わないこと。

const MAX_EDGE = 1400;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} を画像として開けません (HEIC は Safari 以外では読めません)`)); };
    img.src = url;
  });
}

function removeBackground(ctx, w, h, tolerance) {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  // 縁の画素の平均を「背景色」とみなす。
  let r = 0, g = 0, b = 0, n = 0;
  const sample = (x, y) => { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; };
  for (let x = 0; x < w; x += 4) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += 4) { sample(0, y); sample(w - 1, y); }
  r /= n; g /= n; b /= n;

  const near = (i, tol) => {
    const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
    return dr * dr + dg * dg + db * db <= tol * tol;
  };

  // 四辺から塗りつぶし。
  const mask = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const k = y * w + x;
    if (mask[k] || !near(k * 4, tolerance)) return;
    mask[k] = 1;
    stack.push(k);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop();
    const x = k % w, y = (k - x) / w;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  // 抜いた領域に接する画素は半透明にして、縁のギザギザを和らげる。
  let removed = 0;
  for (let k = 0; k < w * h; k++) {
    if (mask[k]) { d[k * 4 + 3] = 0; removed++; continue; }
    const x = k % w, y = (k - x) / w;
    const edge = (x > 0 && mask[k - 1]) || (x < w - 1 && mask[k + 1]) || (y > 0 && mask[k - w]) || (y < h - 1 && mask[k + w]);
    if (edge) d[k * 4 + 3] = 150;
  }
  ctx.putImageData(image, 0, 0);

  // 服が写っている範囲 (透けていない画素の外接矩形)。余白の切り詰めに使う。
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { removed: removed / (w * h), box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

// 戻り値: { data: dataURL, cutout: 実際に透過したか, removed: 抜けた割合 }
export async function preparePhoto(file, { cutout = false, tolerance = 42 } = {}) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  let canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: cutout });
  ctx.drawImage(img, 0, 0, w, h);

  let removed = 0;
  if (cutout) {
    const result = removeBackground(ctx, w, h, tolerance);
    removed = result.removed;
    // ほとんど抜けなかった / ほぼ全部消えた、は失敗とみなして元の写真を使う。
    if (removed < 0.08 || removed > 0.93 || !result.box) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      cutout = false;
    } else {
      // 余白を切り詰める。残したままだと、ハンガーと服のあいだが空いて浮いて見える。
      const { box } = result;
      const tight = document.createElement('canvas');
      tight.width = box.w;
      tight.height = box.h;
      tight.getContext('2d').drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      canvas = tight;
    }
  }

  // WebP に対応していないブラウザは別形式を返してくるので、その場合は PNG / JPEG にする。
  let data = canvas.toDataURL('image/webp', 0.86);
  if (!data.startsWith('data:image/webp')) {
    data = cutout ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86);
  }
  return { data, cutout, removed };
}
