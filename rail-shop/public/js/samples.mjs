// まだ 1 着も登録していないときに掛けておく見本。
// 写真の代わりに canvas で服の形を描く (背景が透けた「切り抜き」の見え方の見本にもなる)。
// 本物の商品を 1 つでも登録すると、見本は出なくなる。

const W = 640;
const H = 800;

const SHAPES = {
  tee(g) {
    g.moveTo(235, 130); g.quadraticCurveTo(320, 190, 405, 130);
    g.lineTo(525, 185); g.lineTo(610, 335); g.lineTo(525, 380); g.lineTo(480, 310);
    g.lineTo(486, 705); g.quadraticCurveTo(320, 725, 154, 705);
    g.lineTo(160, 310); g.lineTo(115, 380); g.lineTo(30, 335); g.lineTo(115, 185);
  },
  hoodie(g) {
    g.moveTo(230, 150); g.quadraticCurveTo(200, 40, 320, 34); g.quadraticCurveTo(440, 40, 410, 150);
    g.lineTo(520, 195); g.quadraticCurveTo(600, 400, 612, 640); g.lineTo(538, 660);
    g.quadraticCurveTo(520, 480, 478, 350);
    g.lineTo(484, 735); g.quadraticCurveTo(320, 755, 156, 735);
    g.lineTo(162, 350); g.quadraticCurveTo(120, 480, 102, 660); g.lineTo(28, 640);
    g.quadraticCurveTo(40, 400, 120, 195);
  },
  coat(g) {
    g.moveTo(250, 70); g.lineTo(320, 110); g.lineTo(390, 70);
    g.lineTo(510, 120); g.quadraticCurveTo(585, 380, 598, 650); g.lineTo(528, 668);
    g.quadraticCurveTo(512, 460, 480, 320);
    g.lineTo(500, 785); g.lineTo(140, 785);
    g.lineTo(160, 320); g.quadraticCurveTo(128, 460, 112, 668); g.lineTo(42, 650);
    g.quadraticCurveTo(55, 380, 130, 120);
  },
  pants(g) {
    g.moveTo(185, 40); g.lineTo(455, 40);
    g.quadraticCurveTo(480, 400, 492, 780); g.lineTo(352, 780);
    g.lineTo(322, 290); g.lineTo(318, 290);
    g.lineTo(288, 780); g.lineTo(148, 780);
    g.quadraticCurveTo(160, 400, 185, 40);
  },
};

const DETAILS = {
  tee(g) {
    g.moveTo(235, 130); g.quadraticCurveTo(320, 205, 405, 130);
  },
  hoodie(g) {
    g.moveTo(232, 152); g.quadraticCurveTo(320, 250, 408, 152);
    g.moveTo(215, 520); g.lineTo(245, 640); g.lineTo(395, 640); g.lineTo(425, 520); g.closePath();
    g.moveTo(300, 215); g.lineTo(296, 330); g.moveTo(340, 215); g.lineTo(344, 330);
  },
  coat(g) {
    g.moveTo(250, 70); g.lineTo(300, 300); g.lineTo(320, 110);
    g.moveTo(390, 70); g.lineTo(340, 300); g.lineTo(320, 110);
    g.moveTo(320, 300); g.lineTo(320, 785);
    g.moveTo(190, 520); g.lineTo(265, 520); g.moveTo(375, 520); g.lineTo(450, 520);
  },
  pants(g) {
    g.moveTo(185, 78); g.lineTo(455, 78);
    g.moveTo(320, 78); g.lineTo(320, 290);
    g.moveTo(205, 100); g.quadraticCurveTo(250, 170, 190, 190);
    g.moveTo(435, 100); g.quadraticCurveTo(390, 170, 450, 190);
  },
};

function draw(shape, color, back) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (back) { g.translate(W, 0); g.scale(-1, 1); }

  g.beginPath();
  SHAPES[shape](g);
  g.closePath();
  g.fillStyle = color;
  g.fill();

  // 立体感: 左右の縁を落とし、上から光を当てる。
  g.save();
  g.clip();
  const side = g.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.42)');
  side.addColorStop(0.28, 'rgba(0,0,0,0)');
  side.addColorStop(0.62, 'rgba(255,255,255,0.07)');
  side.addColorStop(1, 'rgba(0,0,0,0.46)');
  g.fillStyle = side;
  g.fillRect(0, 0, W, H);
  const top = g.createLinearGradient(0, 0, 0, H);
  top.addColorStop(0, 'rgba(255,255,255,0.14)');
  top.addColorStop(0.5, 'rgba(255,255,255,0)');
  top.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = top;
  g.fillRect(0, 0, W, H);

  if (!back) {
    g.beginPath();
    DETAILS[shape](g);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.stroke();
  }
  g.restore();
  return c.toDataURL('image/png');
}

const LIST = [
  ['hoodie', '#474b54', 'Heavy Hoodie / Coal', 6800, 'L', 'tops'],
  ['tee', '#8fb4d9', 'Box Tee / Sky', 2900, 'M', 'tops'],
  ['coat', '#5b4a3c', 'Long Coat / Umber', 14800, 'M', 'outer'],
  ['hoodie', '#7a1f2b', 'Heavy Hoodie / Wine', 6400, 'XL', 'tops'],
  ['pants', '#4d5a6e', 'Wide Denim / Slate', 5200, '32', 'bottoms'],
  ['tee', '#e8e3d6', 'Box Tee / Bone', 2600, 'L', 'tops'],
  ['coat', '#1f3d33', 'Long Coat / Forest', 15800, 'L', 'outer'],
];

export function sampleItems() {
  return LIST.map(([shape, color, title, price, size, category], i) => ({
    id: `sample-${i}`,
    sample: true,
    title,
    price,
    size,
    category,
    brand: 'SAMPLE',
    condition: '目立った傷や汚れなし',
    description: 'これは見本です。管理画面から自分の商品を 1 つ登録すると、見本は表示されなくなります。',
    mercariUrl: '',
    sold: false,
    photos: [
      { url: draw(shape, color, false), cutout: true },
      { url: draw(shape, color, true), cutout: true },
    ],
  }));
}
