// 体の寸法。服 (garment.mjs) とマネキン (body.mjs) が同じ数字を見ることで、
// 「ゆとり 0 なら体に貼りつく」が成立する。身長 1.70 相当。

import * as THREE from 'three';

export const SHOULDER_Y = 1.45;

// y: 高さ, w: 左右の半幅, d: 前後の半奥行き
export const PROFILE = [
  { y: 1.45, w: 0.200, d: 0.102 }, // 肩
  { y: 1.30, w: 0.186, d: 0.108 }, // 胸の上
  { y: 1.21, w: 0.176, d: 0.112 }, // バスト
  { y: 1.08, w: 0.142, d: 0.097 }, // ウエスト
  { y: 0.96, w: 0.170, d: 0.113 }, // ヒップ
  { y: 0.80, w: 0.156, d: 0.112 }, // 腿の付け根
  { y: 0.50, w: 0.120, d: 0.104 },
  { y: 0.10, w: 0.078, d: 0.082 },
];

// 腕は下ろした姿勢。袖はこの線に沿わせる。
export const ARM = {
  shoulder: new THREE.Vector3(0.185, 1.400, 0.000),
  elbow: new THREE.Vector3(0.255, 0.845, 0.010),
  wrist: new THREE.Vector3(0.278, 0.695, 0.020),
  rShoulder: 0.052,
  rElbow: 0.034,
  rWrist: 0.026,
};

const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const clamp01 = (t) => Math.min(1, Math.max(0, t));

// 高さ y における体の断面寸法。
export function bodyAt(y) {
  if (y >= PROFILE[0].y) return { w: PROFILE[0].w, d: PROFILE[0].d };
  const last = PROFILE[PROFILE.length - 1];
  if (y <= last.y) return { w: last.w, d: last.d };
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const a = PROFILE[i];
    const b = PROFILE[i + 1];
    if (y <= a.y && y >= b.y) {
      const t = smooth((a.y - y) / (a.y - b.y));
      return { w: lerp(a.w, b.w, t), d: lerp(a.d, b.d, t) };
    }
  }
  return { w: last.w, d: last.d };
}

// 肩から手首までを 1 本の折れ線として扱い、距離 s (0..1) の点を返す。
const UPPER = ARM.shoulder.distanceTo(ARM.elbow);
const FORE = ARM.elbow.distanceTo(ARM.wrist);
export const ARM_LENGTH = UPPER + FORE;

export function armPoint(s, side = 1) {
  const d = clamp01(s) * ARM_LENGTH;
  const p = d <= UPPER
    ? ARM.shoulder.clone().lerp(ARM.elbow, d / UPPER)
    : ARM.elbow.clone().lerp(ARM.wrist, (d - UPPER) / Math.max(1e-6, FORE));
  p.x *= side;
  return p;
}

export function armRadius(s) {
  const t = clamp01(s);
  return t <= 0.55
    ? lerp(ARM.rShoulder, ARM.rElbow, t / 0.55)
    : lerp(ARM.rElbow, ARM.rWrist, (t - 0.55) / 0.45);
}
