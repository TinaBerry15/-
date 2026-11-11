// パラメータから服のメッシュを手続き的に組み立てる。ここがこのアプリの心臓部。
//
// 考え方:
//   身頃 = 体の断面を基準に、ゆとり / 裾の広がり / ウエストの絞りを足し引きして
//          水平な断面を縦に積み上げたロフト。
//   袖   = マネキンの腕の線に沿わせたチューブ。落ち感は「腕からどれだけ離れて
//          垂れるか」として表現する (腕の角度そのものは変えない)。
//   生地のハリ = 体に沿うか形を保つかのブレンド率 + 断面の角の丸さ。
//
// 縫製は度外視。狙いは "頭の中のシルエットが即座に目の前に出ること" だけ。

import * as THREE from 'three';
import { SHOULDER_Y, bodyAt, armPoint, armRadius, smooth, clamp01 } from './anatomy.mjs';

export { SHOULDER_Y };

const HEM_TOP = 1.14;    // 丈 0 のときの裾の高さ (クロップ)
const HEM_BOTTOM = 0.34; // 丈 1 のときの裾の高さ (マキシ)

const RING_SEG = 64;   // 断面の分割数
const BODY_RINGS = 46; // 身頃の縦方向の分割数
const YOKE_RINGS = 10; // 肩まわりの分割数
const SLEEVE_RINGS = 30;

const lerp = (a, b, t) => a + (b - a) * t;

// 高さ y における「服」の断面寸法。
function garmentAt(y, p, hemY, topY) {
  const base = bodyAt(y);
  // 硬い生地は胸の寸法を下まで引きずって、体に沿わず自立する。
  const ref = bodyAt(1.24);
  const hold = p.stiffness * 0.85;
  let w = lerp(base.w, Math.max(base.w, ref.w), hold);
  let d = lerp(base.d, Math.max(base.d, ref.d), hold);

  // ゆとり。服は体より「横に広く」なるので、奥行きへの加算は控えめにする。
  const ease = 0.004 + p.looseness * 0.078;
  w += ease;
  d += ease * 0.58;

  // 裾に向かって広がる (下ほど効くので二次で効かせる)。
  const t = clamp01((topY - y) / Math.max(0.001, topY - hemY));
  const flare = p.hemFlare * 0.26 * t * t;
  w += flare;
  d += flare * 0.60;

  // ウエストの絞り / 出し。硬い生地ほど絞りが効かない。
  const g = Math.exp(-Math.pow((y - 1.085) / 0.105, 2));
  const cinch = p.waist * g * (1 - p.stiffness * 0.5);
  w -= cinch * 0.046;
  d -= cinch * 0.036;

  return { w: Math.max(0.03, w), d: Math.max(0.025, d) };
}

// スーパー楕円の点。n=2 で普通の楕円、n が大きいほど角ばる (硬い生地)。
function sectionPoint(theta, w, d, n) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const e = 2 / n;
  return [
    w * Math.sign(c) * Math.pow(Math.abs(c), e),
    d * Math.sign(s) * Math.pow(Math.abs(s), e),
  ];
}

// 襟ぐりの高さ。+z 側が前なので、前を深く落とす。
function necklineY(theta, p) {
  const front = Math.max(0, Math.sin(theta));
  const back = Math.max(0, -Math.sin(theta));
  // 横 (|cos| が大) では持ち上げない。持ち上げると肩に角が立つ。
  const rise = 0.014 * (1 - 0.75 * Math.abs(Math.cos(theta)));
  return SHOULDER_Y + rise
    - (0.015 + p.neckDepth * 0.30) * Math.pow(front, 1.4)
    - (0.004 + p.neckDepth * 0.025) * Math.pow(back, 1.4);
}

// 肩線の高さ。横 (|cos| が大) ほど落ちる = ドロップショルダー。
function shoulderLineY(theta, p) {
  return SHOULDER_Y - 0.012 - p.shoulderDrop * 0.090 * Math.pow(Math.abs(Math.cos(theta)), 1.4);
}

// 襟ぐりが肩線より下がっている度合い (0=肩まわり, 1=前の開きの底)。
// ここが 1 に近い角度ではヨーク (肩を覆う面) を消さないと、
// 開きより上に身頃の縁が残って前身頃が壁のように立ってしまう。
function openness(theta, p) {
  return clamp01((shoulderLineY(theta, p) - necklineY(theta, p)) / 0.035);
}

// 身頃のいちばん上の縁は肩線。前の開きは襟ぐりとの間の面 (胸板) で表現する。
const topEdgeY = shoulderLineY;

function shoulderSize(p) {
  const sh = bodyAt(SHOULDER_Y);
  const ease = 0.004 + p.looseness * 0.078;
  return { w: sh.w + ease, d: sh.d + ease * 0.58 };
}

// ---- 身頃 --------------------------------------------------------------

function buildShell(p) {
  const hemY = lerp(HEM_TOP, HEM_BOTTOM, p.length);
  const n = 2.0 + p.stiffness * 0.75;
  const rings = [];

  const neckW = 0.046 + p.neckWidth * 0.108;
  const neckD = 0.040 + p.neckWidth * 0.072;
  const sh = shoulderSize(p);
  const topY = SHOULDER_Y - 0.012 - p.shoulderDrop * 0.045;

  // 1) 襟ぐり -> 肩線。水平には遅く、垂直には先に落として肩を丸くする。
  //    前の開きが深い角度ではヨークの幅をゼロに潰す (壁を立てないため)。
  for (let i = 0; i < YOKE_RINGS; i++) {
    const t = i / (YOKE_RINGS - 1);
    const e = smooth(t);
    const tH = Math.pow(e, 1.25);
    const tV = Math.pow(e, 0.75);
    const ring = [];
    for (let j = 0; j <= RING_SEG; j++) {
      const th = (j / RING_SEG) * Math.PI * 2;
      // 肩まわり (g=0) は「先に落ちてから広がる」で肩を丸く。
      // 前の開き (g=1) は襟ぐりが肩線より下にあるので、まっすぐ結んで胸板にする。
      // ここを緩急つきのままにすると、開きの縁から面が立ち上がって壁になる。
      const g = openness(th, p);
      const eH = lerp(tH, e, g);
      const eV = lerp(tV, e, g);

      const [nx, nz] = sectionPoint(th, neckW, neckD, 2.1);
      const [sx, sz] = sectionPoint(th, sh.w, sh.d, n);
      ring.push(new THREE.Vector3(
        lerp(nx, sx, eH),
        lerp(necklineY(th, p), shoulderLineY(th, p), eV),
        lerp(nz, sz, eH),
      ));
    }
    rings.push(ring);
  }

  // 2) 肩線 -> 裾。断面の寸法は代表の高さから引き、頂点の高さだけ
  //    上の縁 -> 平らな裾へ滑らかに寄せる (肩に折れ目を作らないため)。
  for (let i = 1; i <= BODY_RINGS; i++) {
    const t = smooth(i / BODY_RINGS);
    const yRef = lerp(topY, hemY, t);
    const { w, d } = garmentAt(yRef, p, hemY, topY);
    const ring = [];
    for (let j = 0; j <= RING_SEG; j++) {
      const th = (j / RING_SEG) * Math.PI * 2;
      const [x, z] = sectionPoint(th, w, d, n);
      ring.push(new THREE.Vector3(x, lerp(topEdgeY(th, p), hemY, t), z));
    }
    rings.push(ring);
  }

  return { geometry: loft(rings), hemY };
}

// ---- 袖 ----------------------------------------------------------------

function buildSleeve(p, side) {
  if (p.sleeveLength < 0.035) return null;

  const sMax = p.sleeveLength * 1.02;
  // 落ち感 = 腕からどれだけ離れて垂れるか。腕の角度そのものは動かさない。
  const drape = 0.006 + p.sleeveDroop * 0.045 + p.looseness * 0.014;
  const sag = p.sleeveDroop * 0.060;
  const easeTop = 0.006 + p.sleeveWidth * 0.045 + p.looseness * 0.018;
  const easeCuff = easeTop * (0.45 + p.sleeveWidth * 0.75);

  // 袖は「腕に巻いたチューブ」ではなく「アームホールから手首へのロフト」。
  // 腕を中心にした筒では、胴と腕のあいだの楔 (脇) がどうしても塞がらない。
  // 付け根のリングは胴の横に立つ縦向きの輪にして、そこから手首の丸へ捻りながら繋ぐ。
  const sh = shoulderSize(p);
  const scyeCenter = new THREE.Vector3(
    side * (sh.w - 0.045),
    SHOULDER_Y - 0.100 - p.shoulderDrop * 0.060,
    0,
  );
  const scyeUp = 0.100;   // アームホールの縦半径
  const scyeFore = 0.075; // 同じく前後の半径
  const scyeNormal = new THREE.Vector3(side, -0.35, 0).normalize();
  const BLEND = 0.38; // ここまでで腕に沿う筒に移行する

  const Z = new THREE.Vector3(0, 0, 1);
  const rings = [];
  // 袖が身頃の上の縁より高く出ると肩からヒレが生えるので切る。
  const clampToArmhole = (v) => {
    const lim = topEdgeY(Math.atan2(v.z, v.x), p) - 0.004;
    if (v.y > lim) v.y = lim;
    return v;
  };

  for (let i = 0; i <= SLEEVE_RINGS; i++) {
    const t = i / SLEEVE_RINGS;
    const s = t * sMax;
    const b = smooth(clamp01(t / BLEND));

    const armC = armPoint(s, side);
    armC.x += side * drape * Math.pow(Math.sin(Math.PI * Math.min(1, t)), 0.8);
    armC.y -= sag * Math.pow(t, 1.5);
    const center = scyeCenter.clone().lerp(armC, b);

    // 腕の接線 (前後差分)。リング面の法線をアームホール面からここへ寄せる。
    const ds = 0.01;
    const tan = armPoint(Math.min(1.1, s + ds), side)
      .sub(armPoint(Math.max(0, s - ds), side))
      .normalize();
    const nrm = scyeNormal.clone().lerp(tan, b).normalize();
    const a1 = new THREE.Vector3().crossVectors(nrm, Z).normalize();
    const a2 = new THREE.Vector3().crossVectors(nrm, a1).normalize();

    const r = armRadius(s) + lerp(easeTop, easeCuff, smooth(t));
    const r1 = lerp(scyeUp, r, b);
    const r2 = lerp(scyeFore, r, b);

    const ring = [];
    for (let j = 0; j <= RING_SEG; j++) {
      const th = (j / RING_SEG) * Math.PI * 2;
      ring.push(clampToArmhole(new THREE.Vector3()
        .copy(center)
        .addScaledVector(a1, Math.cos(th) * r1)
        .addScaledVector(a2, Math.sin(th) * r2)));
    }
    rings.push(ring);
  }
  return loft(rings);
}

// ---- リング列 -> BufferGeometry ----------------------------------------

function loft(rings) {
  const rows = rings.length;
  const cols = rings[0].length;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  let k = 0;
  let u = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = rings[i][j];
      positions[k * 3] = v.x;
      positions[k * 3 + 1] = v.y;
      positions[k * 3 + 2] = v.z;
      uvs[u++] = j / (cols - 1);
      uvs[u++] = i / (rows - 1);
      k++;
    }
  }
  const index = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();

  // 断面は閉じているので、先頭列と末尾列は同じ位置にある別頂点になる。
  // 法線を平均して書き戻さないと、そこだけ縦の筋として見えてしまう。
  const nrm = geo.getAttribute('normal');
  for (let i = 0; i < rows; i++) {
    const a = i * cols;
    const b = a + cols - 1;
    const nx = (nrm.getX(a) + nrm.getX(b)) / 2;
    const ny = (nrm.getY(a) + nrm.getY(b)) / 2;
    const nz = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / len, ny / len, nz / len);
    nrm.setXYZ(b, nx / len, ny / len, nz / len);
  }
  nrm.needsUpdate = true;
  return geo;
}

// ---- 外から呼ぶ入口 -----------------------------------------------------

export function buildGarment(p) {
  const group = new THREE.Group();
  group.name = 'garment';

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.color),
    roughness: lerp(0.92, 0.55, p.stiffness),
    metalness: 0.0,
    sheen: lerp(0.8, 0.15, p.stiffness),
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(p.color).offsetHSL(0, -0.1, 0.18),
    side: THREE.DoubleSide,
  });

  const { geometry, hemY } = buildShell(p);
  const shell = new THREE.Mesh(geometry, material);
  shell.name = 'shell';
  shell.castShadow = true;
  group.add(shell);

  for (const side of [-1, 1]) {
    const g = buildSleeve(p, side);
    if (!g) continue;
    const m = new THREE.Mesh(g, material);
    m.name = side < 0 ? 'sleeve_left' : 'sleeve_right';
    m.castShadow = true;
    group.add(m);
  }

  group.userData.hemY = hemY;
  return group;
}
