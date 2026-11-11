// 画面の組み立てと操作。
//   スライダー / 言葉での指示 / プリセット のどれを触っても
//   同じ params オブジェクトを書き換えて再描画する、という一方向の流れにしてある。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { PARAM_DEFS, defaults, clampParams } from './params.mjs';
import { buildGarment } from './garment.mjs';
import { buildBody } from './body.mjs';

const PRESETS = {
  'ゆるロンT': { length: 0.52, looseness: 0.62, hemFlare: 0.10, waist: 0, shoulderDrop: 0.70, sleeveLength: 0.85, sleeveWidth: 0.52, sleeveDroop: 0.60, neckWidth: 0.34, neckDepth: 0.20, stiffness: 0.18, color: '#d9d4ca' },
  'ロングコート': { length: 0.86, looseness: 0.55, hemFlare: 0.26, waist: 0.1, shoulderDrop: 0.42, sleeveLength: 1.0, sleeveWidth: 0.44, sleeveDroop: 0.30, neckWidth: 0.26, neckDepth: 0.42, stiffness: 0.80, color: '#4a4740' },
  'タイトニット': { length: 0.38, looseness: 0.06, hemFlare: 0.0, waist: 0.45, shoulderDrop: 0.05, sleeveLength: 0.92, sleeveWidth: 0.10, sleeveDroop: 0.18, neckWidth: 0.18, neckDepth: 0.12, stiffness: 0.10, color: '#8a4f4a' },
  'Aラインワンピ': { length: 0.74, looseness: 0.22, hemFlare: 0.82, waist: 0.30, shoulderDrop: 0.10, sleeveLength: 0.22, sleeveWidth: 0.30, sleeveDroop: 0.30, neckWidth: 0.52, neckDepth: 0.30, stiffness: 0.45, color: '#3f5a6b' },
  'オーバーシャツ': { length: 0.58, looseness: 0.78, hemFlare: 0.14, waist: -0.2, shoulderDrop: 0.88, sleeveLength: 0.95, sleeveWidth: 0.62, sleeveDroop: 0.55, neckWidth: 0.30, neckDepth: 0.34, stiffness: 0.52, color: '#6e7b6a' },
  'ノースリーブ': { length: 0.40, looseness: 0.18, hemFlare: 0.06, waist: 0.25, shoulderDrop: 0.0, sleeveLength: 0.0, sleeveWidth: 0.2, sleeveDroop: 0.3, neckWidth: 0.58, neckDepth: 0.38, stiffness: 0.25, color: '#e3ddd1' },
};

const FAV_KEY = 'garment-viz:favorites';

let params = defaults();
let garment = null;
let spinning = false;

// ---- シーン -------------------------------------------------------------

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17181b);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
camera.position.set(1.5, 1.35, 2.9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.1;
controls.maxDistance = 7;
controls.maxPolarAngle = Math.PI * 0.52;

scene.add(new THREE.HemisphereLight(0xdfe6ef, 0x2a2622, 0.65));

const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
key.position.set(2.2, 3.4, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -2;
key.shadow.camera.right = 2;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0008;
scene.add(key);

const fill = new THREE.DirectionalLight(0xc9dcff, 0.75);
fill.position.set(-2.8, 1.6, -1.4);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 0.9);
rim.position.set(-0.6, 2.0, -3.0);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4, 64),
  new THREE.MeshStandardMaterial({ color: 0x23252a, roughness: 0.95, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const body = buildBody();
scene.add(body);

// ---- 再描画 -------------------------------------------------------------

function rebuild() {
  if (garment) {
    scene.remove(garment);
    garment.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material.dispose) o.material.dispose();
      }
    });
  }
  garment = buildGarment(params);
  scene.add(garment);
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (spinning && garment) garment.rotation.y += dt * 0.5;
  if (spinning) body.rotation.y = garment ? garment.rotation.y : 0;
  controls.update();
  renderer.render(scene, camera);
});

// ---- スライダー UI ------------------------------------------------------

const sliderEls = new Map();
const controlsHost = document.getElementById('controls');

const groups = [];
for (const d of PARAM_DEFS) {
  let g = groups.find((x) => x.name === d.group);
  if (!g) { g = { name: d.group, items: [] }; groups.push(g); }
  g.items.push(d);
}

for (const g of groups) {
  const section = document.createElement('section');
  section.className = 'group';
  const h = document.createElement('h3');
  h.textContent = g.name;
  section.appendChild(h);

  for (const d of g.items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <label for="s-${d.key}">
        <span class="name">${d.label}</span>
        <output id="o-${d.key}"></output>
      </label>
      <input id="s-${d.key}" type="range" min="${d.min}" max="${d.max}" step="0.01">
      <div class="ends"><span>${d.low}</span><span>${d.high}</span></div>
    `;
    section.appendChild(row);
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      params[d.key] = Number(input.value);
      out.textContent = Number(input.value).toFixed(2);
      rebuild();
    });
    sliderEls.set(d.key, { input, out });
  }
  controlsHost.appendChild(section);
}

const colorInput = document.getElementById('color');
colorInput.addEventListener('input', () => {
  params.color = colorInput.value;
  rebuild();
});

function syncUI() {
  for (const d of PARAM_DEFS) {
    const el = sliderEls.get(d.key);
    el.input.value = params[d.key];
    el.out.textContent = Number(params[d.key]).toFixed(2);
  }
  colorInput.value = params.color;
}

function apply(next, note) {
  params = clampParams({ ...params, ...next });
  syncUI();
  rebuild();
  if (note) status(note, 'ok');
}

// ---- 言葉から作る -------------------------------------------------------

const promptInput = document.getElementById('prompt');
const askBtn = document.getElementById('ask');
const statusEl = document.getElementById('status');

function status(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

async function interpret() {
  const text = promptInput.value.trim();
  if (!text) return;
  askBtn.disabled = true;
  status('考えています…', 'busy');
  try {
    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, current: params }),
    });
    const data = await res.json();
    if (!res.ok) {
      status(data.message || `エラー (${res.status})`, 'err');
      return;
    }
    const { note, ...next } = data.params;
    apply(next, note || '反映しました');
    promptInput.value = '';
  } catch (err) {
    status(`通信に失敗しました: ${err.message}`, 'err');
  } finally {
    askBtn.disabled = false;
  }
}

askBtn.addEventListener('click', interpret);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) interpret();
});

// ---- プリセットとお気に入り ---------------------------------------------

const presetHost = document.getElementById('presets');
for (const [name, preset] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = name;
  b.addEventListener('click', () => apply(preset, `プリセット: ${name}`));
  presetHost.appendChild(b);
}

function loadFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveFavs(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch { /* 無視 */ }
}

const favHost = document.getElementById('favorites');
function renderFavs() {
  const list = loadFavs();
  favHost.innerHTML = '';
  if (!list.length) {
    favHost.innerHTML = '<p class="hint">まだありません。気に入った形が出たら「この形を保存」。</p>';
    return;
  }
  list.forEach((fav, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'chip fav';
    const b = document.createElement('button');
    b.textContent = fav.name;
    b.addEventListener('click', () => apply(fav.params, `呼び出し: ${fav.name}`));
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = '削除';
    x.addEventListener('click', () => {
      const l = loadFavs();
      l.splice(i, 1);
      saveFavs(l);
      renderFavs();
    });
    wrap.append(b, x);
    favHost.appendChild(wrap);
  });
}
renderFavs();

document.getElementById('save').addEventListener('click', () => {
  const name = prompt('この形の名前', `案 ${loadFavs().length + 1}`);
  if (!name) return;
  const list = loadFavs();
  list.push({ name, params: { ...params } });
  saveFavs(list);
  renderFavs();
  status(`保存しました: ${name}`, 'ok');
});

// ---- 書き出し -----------------------------------------------------------

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

document.getElementById('png').addEventListener('click', () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (blob) download(blob, `garment-${stamp()}.png`);
  }, 'image/png');
});

document.getElementById('glb').addEventListener('click', () => {
  if (!garment) return;
  new GLTFExporter().parse(
    garment,
    (result) => download(new Blob([result], { type: 'model/gltf-binary' }), `garment-${stamp()}.glb`),
    (err) => status(`GLB の書き出しに失敗: ${err}`, 'err'),
    { binary: true },
  );
});

document.getElementById('spin').addEventListener('click', (e) => {
  spinning = !spinning;
  e.currentTarget.classList.toggle('on', spinning);
  if (!spinning && garment) { garment.rotation.y = 0; body.rotation.y = 0; }
});

document.getElementById('reset').addEventListener('click', () => {
  apply(defaults(), '初期状態に戻しました');
});

// ---- 起動 ---------------------------------------------------------------

syncUI();
rebuild();

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (!cfg.claude) {
      promptInput.disabled = true;
      askBtn.disabled = true;
      promptInput.placeholder = 'ANTHROPIC_API_KEY を .env に入れると、言葉で指示できます';
      status('言葉での指示は未設定 (スライダーとプリセットはそのまま使えます)', 'warn');
    }
  })
  .catch(() => { /* 設定が取れなくてもスライダーは動く */ });
