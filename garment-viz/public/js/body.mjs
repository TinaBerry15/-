// 服を着せる土台のマネキン。服の寸法と同じ体の寸法表から作るので、
// 「ゆとり 0 なら体に貼りつく」が目で確認できる。
// 服より一段地味なマテリアルにして、視線が服に行くようにしてある。

import * as THREE from 'three';
import { PROFILE as FULL_PROFILE, ARM, smooth } from './anatomy.mjs';

// 胴だけ使う (脚は別に円柱で作る)。
const PROFILE = FULL_PROFILE.slice(0, 6);

const SEG = 48;
const lerp = (a, b, t) => a + (b - a) * t;

function torsoGeometry() {
  const rings = [];
  const ROWS = 40;
  for (let i = 0; i <= ROWS; i++) {
    const t = i / ROWS;
    const y = lerp(PROFILE[0].y + 0.01, PROFILE[PROFILE.length - 1].y, t);
    let w = PROFILE[0].w;
    let d = PROFILE[0].d;
    for (let s = 0; s < PROFILE.length - 1; s++) {
      const a = PROFILE[s];
      const b = PROFILE[s + 1];
      if (y <= a.y && y >= b.y) {
        const k = smooth((a.y - y) / (a.y - b.y));
        w = lerp(a.w, b.w, k);
        d = lerp(a.d, b.d, k);
        break;
      }
    }
    // 肩のてっぺんは丸めておく (角張った板に見えないように)
    const cap = y > 1.40 ? Math.sqrt(Math.max(0, 1 - Math.pow((y - 1.40) / 0.06, 2))) : 1;
    const ring = [];
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      ring.push(new THREE.Vector3(
        Math.cos(th) * w * cap,
        y,
        Math.sin(th) * d * cap,
      ));
    }
    rings.push(ring);
  }

  const rows = rings.length;
  const cols = rings[0].length;
  const pos = new Float32Array(rows * cols * 3);
  let k = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = rings[i][j];
      pos[k++] = v.x; pos[k++] = v.y; pos[k++] = v.z;
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
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// 先細りの円柱。腕と脚に使う。
function limb(from, to, r0, r1) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r1, r0, len, 20, 1, false);
  geo.translate(0, -len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, -1, 0),
    dir.clone().normalize(),
  );
  geo.applyQuaternion(q);
  geo.translate(from.x, from.y, from.z);
  return geo;
}

export function buildBody() {
  const group = new THREE.Group();
  group.name = 'body';

  const skin = new THREE.MeshStandardMaterial({
    color: 0x8d8880,
    roughness: 0.82,
    metalness: 0.0,
  });

  const parts = [torsoGeometry()];

  // 腕: 肩先からやや外へ下ろす。袖がない時に腕が見えてシルエットが読みやすくなる。
  for (const side of [-1, 1]) {
    const sh = ARM.shoulder.clone(); sh.x *= side;
    const el = ARM.elbow.clone(); el.x *= side;
    const wr = ARM.wrist.clone(); wr.x *= side;
    parts.push(limb(sh, el, ARM.rShoulder, ARM.rElbow));
    parts.push(limb(el, wr, ARM.rElbow, ARM.rWrist));
  }

  // 脚
  for (const side of [-1, 1]) {
    parts.push(limb(
      new THREE.Vector3(side * 0.078, 0.84, 0),
      new THREE.Vector3(side * 0.095, 0.03, 0),
      0.082, 0.040,
    ));
  }

  // 首と頭
  parts.push(limb(
    new THREE.Vector3(0, 1.49, 0),
    new THREE.Vector3(0, 1.38, 0),
    0.045, 0.052,
  ));
  const head = new THREE.SphereGeometry(0.094, 28, 20);
  head.scale(1, 1.18, 1.02);
  head.translate(0, 1.585, 0);
  parts.push(head);

  for (const g of parts) {
    const mesh = new THREE.Mesh(g, skin);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}
