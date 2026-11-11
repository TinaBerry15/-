// 3D のハンガーラック。
//
// 服 (= 写真のカード) がレールに掛かって並び、横に流すと慣性で揺れる。
// 正面に来た 1 着だけがこちらを向き、両隣は横を向いて「掛かっている」見え方になる。
// 詳細を開くと、その 1 着だけが残って寄り、ドラッグで回せる。
//
// 写真は MeshBasicMaterial でそのまま出す (照明で色が変わると商品写真として嘘になるため)。

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

const FOV = 30;
const RAIL_Y = 1.95;
const FLOOR_Y = -1.95;
const SPACING = 1.85;
const CARD_H = 2.45;
const CARD_MAX_W = 2.25;
const HOOK = 0.5; // レールから服の上端までの距離
const BG = 0x06070a;
const ACCENT = 0xc8ff4d;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };
const damp = (dt, rate) => 1 - Math.exp(-dt * rate);

// レールは中央が低く、両端が奥へ逃げる緩い弧。
function railPoint(x, out = new THREE.Vector3()) {
  return out.set(x, RAIL_Y + 0.011 * x * x, -0.045 * x * x);
}

function glowTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ---- 写真 -> テクスチャ -----------------------------------------------------

const textureCache = new Map();

function cardTexture(photo) {
  if (textureCache.has(photo.url)) return textureCache.get(photo.url);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(2, Math.round(img.naturalWidth * scale));
      const h = Math.max(2, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      if (!photo.cutout) {
        // 背景つきの写真は角を落として「カード」に見せる。
        g.beginPath();
        g.roundRect(0, 0, w, h, Math.min(w, h) * 0.035);
        g.clip();
      }
      g.drawImage(img, 0, 0, w, h);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      resolve({ tex, aspect: w / h });
    };
    img.onerror = () => reject(new Error(`写真を読めません: ${photo.url}`));
    img.src = photo.url;
  });
  textureCache.set(photo.url, promise);
  return promise;
}

// ---- 本体 -----------------------------------------------------------------

export class Rail {
  constructor(host, { onFocus = () => {}, onSelect = () => {} } = {}) {
    this.host = host;
    this.onFocus = onFocus;
    this.onSelect = onSelect;

    this.entries = [];
    this.pos = 0;       // いま正面にある位置 (小数)
    this.target = 0;    // 落ち着く先 (整数)
    this.vel = 0;
    this.detail = 0;    // 0 = 並び, 1 = 詳細
    this.detailTarget = 0;
    this.spin = 0;      // 詳細でドラッグして回した角度
    this.flip = null;
    this.pointer = new THREE.Vector2();
    this.time = 0;
    this.lastFocus = -1;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(BG);
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(BG, 9, 24);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.75;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);

    this.chrome = new THREE.MeshStandardMaterial({ color: 0xe4e9f2, metalness: 1, roughness: 0.16 });

    this.#buildStage();
    this.#bindInput();

    new ResizeObserver(() => this.#resize()).observe(host);
    this.#resize();

    let last = performance.now();
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.#update(dt);
      renderer.render(scene, this.camera);
    });
  }

  // ---- 舞台 ----

  #buildStage() {
    const pts = [];
    for (let x = -18; x <= 18; x += 1.5) pts.push(railPoint(x));
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.032, 14),
      this.chrome,
    );
    this.scene.add(rail);

    // レールを走る光。
    this.pulse = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(200,255,77,1)', 'rgba(200,255,77,0)'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    this.pulse.scale.set(0.9, 0.22, 1);
    this.scene.add(this.pulse);

    // 床のグリッド。
    this.gridMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0x9fb4ff) }, uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uTime;
        varying vec3 vPos;
        void main() {
          vec2 c = vPos.xz / 0.85;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          float fade = smoothstep(12.0, 1.0, length(vPos.xz - vec2(0.0, 2.0)));
          float sweep = 0.5 + 0.5 * sin(vPos.z * 0.9 + uTime * 0.7);
          gl_FragColor = vec4(uColor, line * fade * (0.11 + 0.12 * sweep));
        }`,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), this.gridMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    this.scene.add(floor);

    // 正面の 1 着の足元に落ちる光。
    this.spot = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 2.6),
      new THREE.MeshBasicMaterial({
        map: glowTexture('rgba(200,255,77,0.55)', 'rgba(200,255,77,0)'),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.spot.rotation.x = -Math.PI / 2;
    this.spot.position.set(0, FLOOR_Y + 0.01, 0.1);
    this.scene.add(this.spot);

    // 漂う塵。
    const N = 240;
    const p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      p[i * 3] = (Math.random() - 0.5) * 18;
      p[i * 3 + 1] = FLOOR_Y + Math.random() * 5.5;
      p[i * 3 + 2] = -7 + Math.random() * 9;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xc9d6ff, size: 0.028, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.scene.add(this.dust);
  }

  #hanger(width) {
    const g = new THREE.Group();
    const hw = clamp(width * 0.36, 0.3, 0.64);

    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.011, 8, 24, Math.PI * 1.55), this.chrome);
    hook.rotation.set(0, Math.PI / 2, Math.PI * 0.72);
    g.add(hook);

    const stemLen = HOOK - 0.2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, stemLen, 8), this.chrome);
    stem.position.y = -0.05 - stemLen / 2;
    g.add(stem);

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-hw, -HOOK + 0.03, 0),
      new THREE.Vector3(-hw * 0.45, -HOOK + 0.13, 0),
      new THREE.Vector3(0, -HOOK + 0.2, 0),
      new THREE.Vector3(hw * 0.45, -HOOK + 0.13, 0),
      new THREE.Vector3(hw, -HOOK + 0.03, 0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.014, 8), this.chrome));
    return g;
  }

  // ---- 商品の出し入れ ----

  setItems(items) {
    for (const e of this.entries) {
      this.scene.remove(e.group);
      e.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      e.mat.dispose();
    }
    this.entries = [];
    this.flip = null;
    this.spin = 0;

    // 服らしく、わずかに反らせた板。
    items.forEach((item, i) => {
      const geo = new THREE.PlaneGeometry(1, 1, 24, 1);
      const pa = geo.getAttribute('position');
      for (let k = 0; k < pa.count; k++) pa.setZ(k, -0.22 * Math.pow(pa.getX(k), 2));
      geo.computeVertexNormals();

      const mat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, side: THREE.DoubleSide, toneMapped: false, alphaTest: 0.01,
      });
      const card = new THREE.Mesh(geo, mat);
      card.userData.index = i;

      const pivot = new THREE.Group();
      pivot.add(card);
      const group = new THREE.Group();
      group.add(pivot);
      this.scene.add(group);

      const entry = {
        item, group, pivot, card, mat, hanger: null,
        loaded: false, fade: 0, sw: 0, swV: 0, phase: Math.random() * 6.28, photoIndex: 0,
      };
      this.entries.push(entry);
      this.#applyPhoto(entry, 0).catch((err) => console.warn(err.message));
    });

    this.target = clamp(Math.round(this.target), 0, Math.max(0, items.length - 1));
    this.pos = this.target;
    this.lastFocus = -1;
  }

  async #applyPhoto(entry, k) {
    const photo = entry.item.photos[k];
    if (!photo) return;
    const { tex, aspect } = await cardTexture(photo);
    if (!this.entries.includes(entry)) return; // 読み込み中に並びが変わった

    let h = CARD_H;
    let w = h * aspect;
    if (w > CARD_MAX_W) { w = CARD_MAX_W; h = w / aspect; }
    entry.mat.map = tex;
    entry.mat.needsUpdate = true;
    entry.card.scale.set(w, h, 1);
    entry.card.position.set(0, -(HOOK - 0.06 + h / 2), 0.012);
    entry.photoIndex = k;

    if (entry.hanger) {
      entry.pivot.remove(entry.hanger);
      entry.hanger.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    entry.hanger = this.#hanger(w);
    entry.pivot.add(entry.hanger);
    entry.loaded = true;
  }

  // ---- 外から操作する ----

  get focus() { return clamp(Math.round(this.target), 0, Math.max(0, this.entries.length - 1)); }

  goTo(i) { this.target = clamp(i, 0, Math.max(0, this.entries.length - 1)); }
  next() { this.goTo(this.focus + 1); }
  prev() { this.goTo(this.focus - 1); }

  setDetail(open) {
    this.detailTarget = open ? 1 : 0;
    if (!open) this.spin = 0;
  }

  // 写真を切り替える。半回転のあいだに差し替えて、裏返したように見せる。
  async setPhoto(k) {
    const entry = this.entries[this.focus];
    if (!entry || !entry.item.photos[k] || k === entry.photoIndex || this.flip) return;
    await cardTexture(entry.item.photos[k]).catch(() => null);
    this.flip = { entry, to: k, t: 0, swapped: false };
  }

  // ---- 入力 ----

  #bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'pan-y';
    el.style.cursor = 'grab';
    let drag = null;

    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, startPos: this.pos, startSpin: this.spin, moved: 0, lastX: e.clientX, lastT: performance.now(), v: 0 };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });

    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      if (!drag) return;
      const dx = e.clientX - drag.x;
      drag.moved = Math.max(drag.moved, Math.abs(dx), Math.abs(e.clientY - drag.y));
      const now = performance.now();
      drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
      drag.lastX = e.clientX;
      drag.lastT = now;

      if (this.detailTarget) {
        this.spin = drag.startSpin + dx * 0.008;
      } else {
        const next = drag.startPos - dx / this.pxPerItem;
        this.pos = clamp(next, -0.35, this.entries.length - 0.65);
        this.target = this.pos;
      }
    });

    const end = (e) => {
      if (!drag) return;
      el.style.cursor = 'grab';
      const d = drag;
      drag = null;
      if (d.moved < 6) return this.#tap(e);
      if (this.detailTarget) {
        // 正面か真裏か、近いほうへ戻す。
        this.spin = Math.round(this.spin / Math.PI) * Math.PI;
        return;
      }
      // 弾いた勢いのぶんだけ先へ進めてから、最寄りの 1 着に吸着する。
      this.goTo(Math.round(this.pos - (d.v * 160) / this.pxPerItem));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { drag = null; this.goTo(Math.round(this.pos)); });

    el.addEventListener('wheel', (e) => {
      if (this.detailTarget) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 縦はページのスクロールに譲る
      e.preventDefault();
      this.pos = clamp(this.pos + e.deltaX / this.pxPerItem, -0.35, this.entries.length - 0.65);
      this.target = this.pos;
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => this.goTo(Math.round(this.pos)), 120);
    }, { passive: false });
  }

  #tap(e) {
    if (this.detailTarget) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.entries.filter((en) => en.group.visible).map((en) => en.card))[0];
    if (!hit) return;
    const i = hit.object.userData.index;
    if (i === this.focus) this.onSelect(i);
    else this.goTo(i);
  }

  // ---- 毎フレーム ----

  #resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.wide = w >= 820;

    // 横幅が狭いときは引いて、最低でも左右の服が少し見える幅を確保する。
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.dist = Math.max(9.2, 3.5 / (2 * tan * this.camera.aspect));
    this.viewW = 2 * tan * this.dist * this.camera.aspect;
    this.viewH = 2 * tan * this.dist;
    this.pxPerItem = (w / this.viewW) * SPACING;
    this.camera.updateProjectionMatrix();
  }

  #update(dt) {
    this.time += dt;
    const n = this.entries.length;

    const before = this.pos;
    this.pos += (this.target - this.pos) * damp(dt, 7);
    this.vel = lerp(this.vel, (this.pos - before) / Math.max(dt, 1e-4), damp(dt, 14));
    this.detail += (this.detailTarget - this.detail) * damp(dt, 6);

    const focus = this.focus;
    if (focus !== this.lastFocus && n) {
      this.lastFocus = focus;
      this.onFocus(focus);
    }

    // 写真の差し替え (半回転 -> 差し替え -> 逆側から戻る)
    let flipAngle = 0;
    if (this.flip) {
      const f = this.flip;
      f.t += dt / 0.5;
      if (f.t >= 0.5 && !f.swapped) {
        f.swapped = true;
        this.#applyPhoto(f.entry, f.to).catch(() => {});
      }
      flipAngle = f.t < 0.5 ? smooth(f.t / 0.5) * (Math.PI / 2) : -(1 - smooth((f.t - 0.5) / 0.5)) * (Math.PI / 2);
      if (f.t >= 1) { this.flip = null; flipAngle = 0; }
    }

    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      const d = i - this.pos;
      const ad = Math.abs(d);
      const isFocus = i === focus;

      e.group.visible = ad < 5.4;
      if (!e.group.visible) continue;

      e.group.position.copy(railPoint(d * SPACING, tmp));

      // 正面の 1 着だけこちらを向く。離れるほど横向き。
      let rotY = -Math.sign(d) * smooth(ad) * 1.24;
      if (isFocus) rotY += this.spin * this.detail + (this.flip?.entry === e ? flipAngle : 0);
      e.pivot.rotation.y = rotY;

      // レールを流すと、服は遅れてついてくる (振り子)。
      e.swV += (-42 * e.sw - 5.5 * e.swV + this.vel * 2.3) * dt;
      e.sw = clamp(e.sw + e.swV * dt, -0.6, 0.6);
      e.group.rotation.z = e.sw + Math.sin(this.time * 0.9 + e.phase) * 0.012;

      const s = lerp(1, 0.9, Math.min(ad, 1)) * (isFocus && this.wide ? 1 + 0.1 * this.detail : 1);
      e.pivot.scale.setScalar(s);

      const want = (e.loaded ? 1 : 0) * smooth((4.9 - ad) / 1.3) * (isFocus ? 1 : 1 - this.detail);
      e.fade += (want - e.fade) * damp(dt, 9);
      e.mat.opacity = e.fade;
      if (e.hanger) e.hanger.visible = e.fade > 0.5;

      const bright = lerp(1, 0.42, smooth(ad)) * (e.item.sold ? 0.55 : 1);
      e.mat.color.setScalar(bright);
    }

    // 演出
    this.pulse.position.copy(railPoint(((this.time * 2.2) % 22) - 11, tmp));
    this.gridMat.uniforms.uTime.value = this.time;
    this.spot.material.opacity = n ? 0.55 + 0.25 * this.detail : 0;

    const dp = this.dust.geometry.getAttribute('position');
    for (let i = 0; i < dp.count; i++) {
      let y = dp.getY(i) + dt * 0.06;
      if (y > FLOOR_Y + 5.5) y = FLOOR_Y;
      dp.setY(i, y);
    }
    dp.needsUpdate = true;

    // カメラ: 詳細では、パネルを避ける方向へ平行移動して少し寄る。
    //   広い画面: パネルは右 -> 服を左へ寄せて少し近づく
    //   狭い画面: パネルは下からのシート -> 少し引いて、服を画面の上側に収める
    const zoom = this.wide ? 1 - 0.13 * this.detail : 1 + 0.14 * this.detail;
    const shiftX = this.wide ? this.viewW * 0.2 * this.detail : 0;
    const shiftY = this.wide ? 0 : -this.viewH * zoom * 0.245 * this.detail;
    const px = this.pointer.x * 0.22 * (1 - this.detail);
    const py = this.pointer.y * 0.1 * (1 - this.detail);
    const baseY = 0.34; // レールが上の見出しに被らない高さ
    this.camera.position.set(shiftX + px, baseY + 0.15 + shiftY + py, this.dist * zoom);
    this.camera.lookAt(shiftX, baseY + shiftY, 0);
  }
}
