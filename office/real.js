// Реалистичный офис: PBR-материалы (Poly Haven, CC0), HDRI-освещение, солнце через окна, мягкие тени, AO.
// API совместим со scene.js: new Office(container, {onAgent, onDesk, onBubble}), update(state), setTheme, focusAgent, highlight.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Humanoid, STATUS } from './humanoid.js';

const ASSETS = '/office/assets';
// цвета команд не пересекаются со статусами (синий/красный/оранжевый/фиолетовый)
const ACCENTS = ['#FFCC00', '#34C759', '#30B0C7', '#A2845E', '#5E5CE6', '#FF6F91', '#9BAA3B'];
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const accentMap = new Map();
export const accentOf = (p) => accentMap.get(p) || ACCENTS[hash(p) % ACCENTS.length];
function assignAccents(projects) {
  const used = new Set();
  for (const p of [...projects].sort()) {
    let i = hash(p) % ACCENTS.length;
    for (let k = 0; k < ACCENTS.length && used.has(ACCENTS[i]); k++) i = (i + 1) % ACCENTS.length;
    used.add(ACCENTS[i]); accentMap.set(p, ACCENTS[i]);
  }
}
const mixHex = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k);
const V = (x, z, y = 0) => new THREE.Vector3(x, y, z);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lerpAngle = (a, b, k) => { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

// раскладка, метры
const SEAT_W = 1.75, POD_PAD = 0.55, POD_D = 5.0, POD_GAP = 1.0, ROW_GAP = 1.8, FRONT_D = 6.8, BAR_W = 2.4, MARGIN = 0.7;
const MIN_W = 18, ROW_MAX = 19.5, WALL_H = 3.0, WALK = 1.5, RUN = 2.3;

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.userData.canvas = c;
  return t;
}

export class Office {
  constructor(container, handlers = {}) {
    this.el = container; this.h = handlers;
    this.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    this.agents = new Map(); this.layoutSig = ''; this.first = true;
    this.hoverKey = null; this.extHover = null; this.clock = new THREE.Clock(); this.codeT = 0; this.codeOff = 0;
    this.ready = false; this.models = {}; this.paused = false;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NeutralToneMapping; r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.5, 400);
    this.camDir = new THREE.Vector3(-0.56, 0.63, 0.54).normalize();
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, screenSpacePanning: true, minPolarAngle: 0.45, maxPolarAngle: 1.2, zoomSpeed: 1.0 });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xcfc6b8, 0.35); scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xfff1de, 3.2);
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.025; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    this.nightLights = new THREE.Group(); scene.add(this.nightLights);

    this.static = new THREE.Group(); scene.add(this.static);
    this.dyn = new THREE.Group(); scene.add(this.dyn);
    this.mats = this.makeMats();
    this.screens = this.makeScreens();

    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.ao = new GTAOPass(scene, this.camera, 1, 1);
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 16 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this.loadAssets();
  }

  // ---------- ассеты ----------
  async loadAssets() {
    const gl = new GLTFLoader();
    const ids = ['modern_arm_chair_01', 'sofa_03', 'Ottoman_01', 'potted_plant_02', 'potted_plant_04', 'modern_coffee_table_01', 'bar_chair_round_01', 'desk_lamp_arm_01', 'side_table_01'];
    const env = (name) => new RGBELoader().loadAsync(`${ASSETS}/hdri/${name}.hdr`).then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; return t; }).catch(() => null);
    const [day, night] = await Promise.all([env('photo_studio_loft_hall'), env('unfinished_office_night'),
      ...ids.map((id) => gl.loadAsync(`${ASSETS}/models/${id}/${id}.gltf`).then((g) => {
        g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.models[id] = g.scene;
      }).catch(() => null))]);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envs = { light: day ? pm.fromEquirectangular(day).texture : null, dark: night ? pm.fromEquirectangular(night).texture : null };
    this.ready = true;
    this.setTheme(this.theme, true);
  }

  tex(name, repeat = [1, 1], tint) {
    const tl = this.texLoader ??= new THREE.TextureLoader();
    const load = (map, srgb) => {
      const t = tl.load(`${ASSETS}/tex/${name}_${map}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    return { map: load('diff', true), normalMap: load('nor'), roughnessMap: load('rough'), color: tint ? new THREE.Color(tint) : new THREE.Color(0xffffff) };
  }

  makeMats() {
    const M = (o) => new THREE.MeshStandardMaterial(o);
    return {
      floor: M({ ...this.tex('laminate_floor_02', [9, 9], 0xf2e6d6), roughness: 1 }),
      oak: M({ ...this.tex('oak_veneer_01', [1, 0.5], 0xfff4e6), roughness: 1 }),
      wall: M({ ...this.tex('plastered_wall_04', [4, 1]), color: new THREE.Color(0xf4f2ee), roughness: 1 }),
      steel: M({ color: 0x1d1e21, roughness: 0.42, metalness: 0.75 }),
      alu: M({ color: 0xc9ccd1, roughness: 0.32, metalness: 0.9 }),
      white: M({ color: 0xf2f1ee, roughness: 0.45 }),
      quartz: new THREE.MeshPhysicalMaterial({ color: 0xf7f6f3, roughness: 0.18, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
      fabric: M({ color: 0x3a3c41, roughness: 0.92 }),
      mesh: M({ color: 0x2b2d31, roughness: 0.85 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.14, envMapIntensity: 1.4, depthWrite: false }),
      black: M({ color: 0x0b0c0e, roughness: 0.25, metalness: 0.2 }),
      ceramic: M({ color: 0xf6f4f0, roughness: 0.3 }),
      espresso: M({ color: 0xb8bcc2, roughness: 0.18, metalness: 1 }),
    };
  }

  makeScreens() {
    const code = canvasTex(512, 320, () => {});
    code.userData.draw = (off) => {
      const x = code.userData.canvas.getContext('2d');
      x.fillStyle = '#0d1117'; x.fillRect(0, 0, 512, 320);
      x.fillStyle = '#161b22'; x.fillRect(0, 0, 512, 26); x.fillRect(0, 26, 92, 294);
      for (let i = 0; i < 9; i++) { x.fillStyle = 'rgba(139,148,158,.45)'; x.fillRect(12, 44 + i * 26, 50 + ((i * 37) % 24), 7); }
      const cols = ['#79c0ff', '#d2a8ff', '#7ee787', '#ffa657', '#a5d6ff', '#f0f6fc'];
      for (let i = 0; i < 13; i++) {
        const k = i + off, ind = (k * 7) % 4;
        x.fillStyle = cols[k % cols.length];
        x.fillRect(112 + ind * 18, 42 + i * 21, 60 + ((k * 53) % 240), 8);
      }
      x.fillStyle = 'rgba(88,166,255,.9)'; x.fillRect(112, 42 + 12 * 21, 4, 12);
      code.needsUpdate = true;
    };
    code.userData.draw(0);
    const glyph = (bg, fg, ch) => canvasTex(512, 320, (x) => {
      x.fillStyle = bg; x.fillRect(0, 0, 512, 320);
      x.fillStyle = fg; x.beginPath(); x.arc(256, 160, 70, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#fff'; x.font = '700 92px -apple-system, Helvetica, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 256, 166);
    });
    const plain = (bg, dot) => canvasTex(512, 320, (x) => {
      const g = x.createLinearGradient(0, 0, 512, 320); g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
      x.fillStyle = g; x.fillRect(0, 0, 512, 320);
      if (dot) { x.fillStyle = 'rgba(255,255,255,.18)'; x.beginPath(); x.arc(256, 160, 16, 0, Math.PI * 2); x.fill(); }
    });
    const B = (t, k = 1) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: new THREE.Color(k, k, k) });
    return {
      code: B(code, 1.05), ask: B(glyph('#1c0f10', '#ff3b30', '?')), amber: B(glyph('#1d140a', '#ff9500', '!')),
      plan: B(glyph('#170f1c', '#af52de', '≡')), done: B(glyph('#0e1a12', '#34c759', '✓')), idle: B(plain(['#1f2a3a', '#2c2640'], true), 0.75), sleep: B(plain(['#050506', '#0a0a0c']), 1),
      tex: { code },
    };
  }

  model(id, x, z, { rot = 0, height, scale = 1, y = 0, parent = this.static, onFloor = true } = {}) {
    const src = this.models[id];
    if (!src) return null;
    const o = src.clone(true);
    o.rotation.y = rot;
    o.scale.setScalar(scale);
    o.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(o);
    if (height) { o.scale.multiplyScalar(height / (box.max.y - box.min.y)); o.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(o); }
    o.position.set(x - (box.min.x + box.max.x) / 2, onFloor ? y - box.min.y : y, z - (box.min.z + box.max.z) / 2);
    parent.add(o);
    return o;
  }

  // ---------- тема ----------
  setTheme(name, force) {
    if (name === this.theme && !force) return;
    this.theme = name;
    const dark = name === 'dark';
    this.scene.background = new THREE.Color(dark ? 0x0b0c10 : 0xe8eaee);
    this.scene.environment = this.envs?.[name] || null;
    this.scene.environmentIntensity = dark ? 0.35 : 0.9;
    this.sun.visible = !dark;
    this.hemi.intensity = dark ? 0.08 : 0.35;
    this.renderer.toneMappingExposure = dark ? 1.2 : 1.0;
    this.bloom.strength = dark ? 0.55 : 0.3;
    this.layoutSig = '';
    if (this.lastState) this.update(this.lastState);
  }

  // ---------- раскладка ----------
  computeLayout(groups) {
    assignAccents(groups.map(([p]) => p));
    const pods = groups.map(([project, list]) => {
      const cols = Math.max(2, Math.ceil(list.length / 2));
      return { project, list, cols, w: cols * SEAT_W + POD_PAD * 2, accent: accentOf(project) };
    });
    const rows = [];
    for (const p of pods) {
      let row = rows[rows.length - 1];
      if (!row || row.w + POD_GAP + p.w > ROW_MAX) { row = { pods: [], w: -POD_GAP }; rows.push(row); }
      row.pods.push(p); row.w += POD_GAP + p.w;
    }
    if (!rows.length) rows.push({ pods: [], w: 0 });
    const innerW = Math.max(MIN_W - BAR_W - MARGIN * 2, ...rows.map((r) => r.w));
    const W = innerW + BAR_W + MARGIN * 2;
    const podsD = rows.length * POD_D + (rows.length - 1) * ROW_GAP;
    const D = MARGIN + podsD + 1.4 + FRONT_D;
    const x0 = -W / 2, z0 = -D / 2;
    const frontZ = z0 + MARGIN + podsD + 1.4;
    const F = frontZ - 0.7;
    rows.forEach((row, ri) => {
      let x = x0 + MARGIN;
      const zb = z0 + MARGIN + ri * (POD_D + ROW_GAP);
      for (const p of row.pods) {
        Object.assign(p, { x0: x, x1: x + p.w, z0: zb, z1: zb + POD_D, cx: x + p.w / 2, cz: zb + POD_D / 2, aisleZ: zb + POD_D + (ri === rows.length - 1 ? 0.7 : ROW_GAP / 2) });
        x += p.w + POD_GAP;
      }
    });
    const seats = new Map();
    for (const p of pods) {
      const edgeX = p.x0 - POD_GAP / 2;
      p.list.forEach((a, i) => {
        const col = i >> 1, north = i % 2 === 0;
        const x = p.x0 + POD_PAD + SEAT_W * (col + 0.5);
        const chairZ = p.cz + (north ? -1.22 : 1.22), standZ = p.cz + (north ? -1.95 : 1.95);
        const out = north ? [V(x, standZ), V(edgeX, standZ), V(edgeX, p.aisleZ), V(edgeX, F)] : [V(x, standZ), V(x, p.aisleZ), V(edgeX, p.aisleZ), V(edgeX, F)];
        seats.set(a.key, { key: a.key, pod: p, x, north, chairZ, pos: V(x, chairZ), face: north ? 0 : Math.PI, out });
      });
    }
    const meet = { x0: x0 + MARGIN, x1: x0 + MARGIN + 4.6, z0: frontZ + 0.4, z1: frontZ + 3.8 };
    const desk = { x: meet.x1 + 5.2, z: D / 2 - 2.3 };
    const lounge = { x0: desk.x + 2.6, x1: W / 2 - 0.3, z0: frontZ + 0.3, z1: D / 2 - 0.4 };
    const lc = (lounge.z0 + lounge.z1) / 2;
    const bar = { x: W / 2 - 0.55, z0: z0 + MARGIN + 0.6, z1: Math.min(frontZ - 1.2, z0 + MARGIN + 5.4) };
    const spots = [
      { kind: 'sofa', pos: V(W / 2 - 0.75, lc - 0.62), face: -Math.PI / 2, seatY: 0.45, pose: 'lounge' },
      { kind: 'sofa', pos: V(W / 2 - 0.75, lc + 0.62), face: -Math.PI / 2, seatY: 0.45, pose: 'lounge' },
      { kind: 'arm', pos: V(lounge.x0 + 1.25, lc - 1.0), face: Math.PI / 2 - 0.3, seatY: 0.42, pose: 'lounge' },
      { kind: 'arm', pos: V(lounge.x0 + 1.25, lc + 1.0), face: Math.PI / 2 + 0.3, seatY: 0.42, pose: 'lounge' },
      { kind: 'pouf', pos: V(lounge.x0 + 0.8, lounge.z1 - 0.75), face: Math.PI * 0.75, seatY: 0.4, pose: 'sleep', sleep: true },
      { kind: 'pouf', pos: V(lounge.x0 + 1.9, lounge.z1 - 0.55), face: Math.PI * 0.9, seatY: 0.4, pose: 'sleep', sleep: true },
      ...[0.25, 0.5, 0.75].map((k) => ({ kind: 'stool', pos: V(W / 2 - 1.35, bar.z0 + (bar.z1 - bar.z0) * k), face: Math.PI / 2, seatY: 0.74, pose: 'lounge' })),
    ];
    for (const s of spots) {
      const ap = s.kind === 'stool' ? V(W / 2 - 2.1, s.pos.z) : s.kind === 'sofa' ? V(s.pos.x - 0.95, s.pos.z) : s.kind === 'arm' ? V(s.pos.x - 0.75, s.pos.z) : V(s.pos.x, s.pos.z - 0.7);
      s.approach = ap;
    }
    const queue = [];
    for (let i = 0; i < 12; i++) { const k = i % 4, line = Math.floor(i / 4); queue.push(V(desk.x - 2.1 - k * 1.25 - line * 0.85, desk.z - 0.6 - k * 1.25 + line * 0.85)); }
    return { pods, seats, W, D, frontZ, F, meet, desk, lounge, bar, spots, queue, door: V(-W / 2 + 0.5, D / 2 - 1.5) };
  }

  // ---------- статика ----------
  rebuildStatic(L) {
    for (const o of [...this.static.children]) { this.static.remove(o); o.traverse?.((c) => { if (c.isCSS2DObject) c.element.remove(); }); }
    for (const o of [...this.nightLights.children]) this.nightLights.remove(o);
    const S = this.static, m = this.mats, dark = this.theme === 'dark';
    const add = (geo, mat, x, y, z, { cast = true, recv = true, parent = S, ud } = {}) => {
      const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = cast; o.receiveShadow = recv; if (ud) Object.assign(o.userData, ud); parent.add(o); return o;
    };
    const { W, D } = L;

    // пол-остров
    m.floor.map.repeat.set(W / 2.4, D / 2.4); m.floor.normalMap.repeat.copy(m.floor.map.repeat); m.floor.roughnessMap.repeat.copy(m.floor.map.repeat);
    const floor = add(new THREE.PlaneGeometry(W, D), m.floor, 0, 0, 0, { cast: false }); floor.rotation.x = -Math.PI / 2;
    add(new THREE.BoxGeometry(W, 0.3, D), new THREE.MeshStandardMaterial({ color: dark ? 0x17181c : 0xd9d6d0, roughness: 0.9 }), 0, -0.151, 0, { cast: false });

    this.buildWalls(L, add);
    for (const p of L.pods) this.buildPod(p, L, add);
    this.buildMeeting(L, add);
    this.buildLounge(L, add);
    this.buildBar(L, add);
    this.buildMyDesk(L, add);
    this.buildDoor(L, add);
    // растения между командами и по углам
    const plants = [[-W / 2 + 0.45, L.frontZ - 0.2, 'potted_plant_02', 1.7], [L.meet.x1 + 0.6, L.meet.z0 + 0.3, 'potted_plant_02', 1.25], [W / 2 - 0.5, D / 2 - 0.5, 'potted_plant_02', 1.8], [L.desk.x + 1.5, L.desk.z + 0.95, 'potted_plant_02', 1.1]];
    for (let i = 0; i < L.pods.length - 1; i++) { const a = L.pods[i], b = L.pods[i + 1]; if (Math.abs(a.z0 - b.z0) < 0.1) plants.push([(a.x1 + b.x0) / 2, a.z0 + 0.45, 'potted_plant_02', 1.3]); }
    for (const [x, z, id, h] of plants) this.model(id, x, z, { height: h, rot: hash(`${x}${z}`) % 6 });

    // солнце и тени под размер офиса
    const s = this.sun;
    s.position.set(W * 0.25 + 7, 13, -D / 2 - 9); s.target.position.set(-W * 0.08, 0, D * 0.12);
    const ext = Math.max(W, D) * 0.78;
    Object.assign(s.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 70 });
    s.shadow.camera.updateProjectionMatrix();
    if (dark) {
      for (const p of L.pods) { const l = new THREE.PointLight(0xffd7a8, 7, 7.5, 1.6); l.position.set(p.cx, 2.7, p.cz); this.nightLights.add(l); }
      for (const [x, z] of [[(L.lounge.x0 + L.lounge.x1) / 2, (L.lounge.z0 + L.lounge.z1) / 2], [L.desk.x, L.desk.z], [(L.meet.x0 + L.meet.x1) / 2, (L.meet.z0 + L.meet.z1) / 2]]) {
        const l = new THREE.PointLight(0xffcf96, 6, 7, 1.6); l.position.set(x, 2.6, z); this.nightLights.add(l);
      }
    }
  }

  outdoorTex(len) {
    const dark = this.theme === 'dark';
    return canvasTex(2048, 512, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      if (dark) { g.addColorStop(0, '#0a1430'); g.addColorStop(0.7, '#1b2a52'); g.addColorStop(1, '#2a3560'); }
      else { g.addColorStop(0, '#9fcbef'); g.addColorStop(0.55, '#d8ebf7'); g.addColorStop(1, '#f3ede2'); }
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.filter = 'blur(10px)';
      x.fillStyle = dark ? '#111a2c' : '#b3c9ad';
      x.beginPath(); x.moveTo(0, h * 0.72);
      for (let i = 0; i <= 12; i++) x.quadraticCurveTo(w * (i + 0.5) / 12, h * (0.6 + 0.08 * Math.sin(i * 1.7 + len)), w * (i + 1) / 12, h * (0.7 + 0.04 * Math.cos(i)));
      x.lineTo(w, h); x.lineTo(0, h); x.fill();
      x.filter = 'blur(4px)';
      for (let i = 0; i < 46; i++) {
        const tx = ((i * 97 + len * 31) % 100) / 100 * w, th = 60 + ((i * 53) % 90);
        x.fillStyle = dark ? '#0b1410' : ['#5f8f5a', '#6f9d63', '#557f51'][i % 3];
        x.beginPath(); x.ellipse(tx, h * 0.86 - th * 0.4, 26 + (i % 5) * 6, th * 0.55, 0, 0, Math.PI * 2); x.fill();
      }
      if (dark) { x.filter = 'none'; for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(255,214,140,${0.3 + (i % 5) / 8})`; x.fillRect((i * 131) % w, h * 0.62 + ((i * 71) % 120), 3, 3); } }
    });
  }

  buildWalls(L, add) {
    const { W, D } = L, m = this.mats, dark = this.theme === 'dark';
    const T = 0.14, SILL = 0.4, HEAD = 2.75, STEP = 1.6;
    const wallRun = (len, solidFrom = Infinity) => {
      const g = new THREE.Group();
      const outdoor = new THREE.MeshBasicMaterial({ map: this.outdoorTex(len), color: dark ? 0xffffff : 0xffffff });
      add(new THREE.BoxGeometry(len, SILL, T), m.wall, len / 2, SILL / 2, 0, { parent: g });
      add(new THREE.BoxGeometry(len, WALL_H - HEAD, T), m.wall, len / 2, (HEAD + WALL_H) / 2, 0, { parent: g });
      add(new THREE.BoxGeometry(len + T, 0.03, T + 0.04), m.white, len / 2, WALL_H + 0.015, 0, { parent: g });
      const glassLen = Math.min(len, solidFrom);
      if (glassLen > 0) {
        add(new THREE.PlaneGeometry(glassLen, HEAD - SILL), m.glass, glassLen / 2, (SILL + HEAD) / 2, 0.01, { cast: false, recv: false, parent: g });
        const back = add(new THREE.PlaneGeometry(glassLen, HEAD - SILL), outdoor, glassLen / 2, (SILL + HEAD) / 2, -0.22, { cast: false, recv: false, parent: g });
        back.material.map.wrapS = THREE.RepeatWrapping;
        for (let x = 0; x <= glassLen + 0.01; x += STEP) add(new THREE.BoxGeometry(0.05, HEAD - SILL, 0.09), m.steel, Math.min(x, glassLen - 0.025), (SILL + HEAD) / 2, 0, { parent: g });
        add(new THREE.BoxGeometry(glassLen, 0.05, 0.09), m.steel, glassLen / 2, SILL + 0.025, 0, { parent: g });
        add(new THREE.BoxGeometry(glassLen, 0.05, 0.09), m.steel, glassLen / 2, HEAD - 0.025, 0, { parent: g });
        add(new THREE.BoxGeometry(glassLen, 0.03, 0.06), m.steel, glassLen / 2, 2.1, 0, { parent: g });
      }
      if (solidFrom < len) {
        const sl = len - solidFrom;
        add(new THREE.BoxGeometry(sl, HEAD - SILL, T), m.wall, solidFrom + sl / 2, (SILL + HEAD) / 2, 0, { parent: g });
      }
      return g;
    };
    const north = wallRun(W); north.position.set(-W / 2, 0, -D / 2 - 0.07); this.static.add(north);
    const solidFrom = L.frontZ - 0.6 + D / 2;
    const east = wallRun(D, solidFrom); east.rotation.y = -Math.PI / 2; east.position.set(W / 2 + 0.07, 0, -D / 2); this.static.add(east);

    // зелёная стена + неон на глухой части восточной стены
    const mossLen = D - solidFrom - 0.4;
    const moss = canvasTex(1024, 512, (x, w, h) => {
      x.fillStyle = '#2f5634'; x.fillRect(0, 0, w, h);
      const greens = ['#3f6d46', '#4f8352', '#5f9a5c', '#35603a', '#6fae68', '#2b4f30'];
      for (let i = 0; i < 4200; i++) {
        const px = (i * 7919) % w, py = (i * 104729) % h, r = 5 + (i % 9);
        x.fillStyle = greens[i % greens.length]; x.beginPath(); x.ellipse(px, py, r, r * 0.6, (i % 31) / 5, 0, Math.PI * 2); x.fill();
      }
    });
    const mossMat = new THREE.MeshStandardMaterial({ map: moss, roughness: 0.95, color: dark ? 0x9fb39a : 0xffffff });
    const mz = solidFrom + 0.2 + mossLen / 2 - D / 2;
    const mw = add(new THREE.BoxGeometry(0.08, HEAD - SILL - 0.2, mossLen), mossMat, W / 2 - 0.02, (SILL + HEAD) / 2, mz);
    void mw;
    const neon = canvasTex(1024, 256, (x, w, h) => {
      x.clearRect(0, 0, w, h);
      x.font = 'italic 600 150px "Snell Roundhand", "Brush Script MT", cursive'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.shadowColor = '#ff4fa3'; x.shadowBlur = 30; x.fillStyle = '#ffd6ea'; x.fillText('ship it', w / 2, h / 2 + 6);
      x.shadowBlur = 8; x.fillStyle = '#ffffff'; x.fillText('ship it', w / 2, h / 2 + 6);
    });
    const nm = new THREE.MeshBasicMaterial({ map: neon, transparent: true, toneMapped: false, color: new THREE.Color(2.2, 2.2, 2.2), depthWrite: false });
    const n = add(new THREE.PlaneGeometry(2.8, 0.7), nm, W / 2 - 0.09, 1.9, mz, { cast: false, recv: false }); n.rotation.y = -Math.PI / 2;
    const glow = new THREE.PointLight(0xff5fae, dark ? 2.5 : 0.8, 4, 2); glow.position.set(W / 2 - 0.5, 1.9, mz); this.static.add(glow);
  }

  taskChair(x, z, rot, parent, { tall = false } = {}) {
    const m = this.mats, g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; parent.add(g);
    const add = (geo, mat, px, py, pz, rx = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(px, py, pz); o.rotation.x = rx; o.castShadow = o.receiveShadow = true; g.add(o); return o; };
    const C = Office.chairGeo ??= {
      seat: new RoundedBoxGeometry(0.5, 0.08, 0.47, 4, 0.035), back: new RoundedBoxGeometry(0.47, 0.56, 0.06, 4, 0.03), backT: new RoundedBoxGeometry(0.47, 0.72, 0.06, 4, 0.03),
      post: new THREE.CylinderGeometry(0.025, 0.03, 0.3, 14), leg: new THREE.BoxGeometry(0.035, 0.03, 0.3), wheel: new THREE.SphereGeometry(0.025, 10, 8),
      arm: new RoundedBoxGeometry(0.05, 0.035, 0.26, 2, 0.015), armPost: new THREE.BoxGeometry(0.03, 0.2, 0.03), spine: new THREE.BoxGeometry(0.05, 0.36, 0.03),
    };
    add(C.seat, m.fabric, 0, 0.44, 0);
    add(C.post, m.alu, 0, 0.26, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2, leg = add(C.leg, m.steel, Math.sin(a) * 0.15, 0.06, Math.cos(a) * 0.15); leg.rotation.y = a;
      add(C.wheel, m.steel, Math.sin(a) * 0.29, 0.025, Math.cos(a) * 0.29);
    }
    add(C.spine, m.steel, 0, 0.6, -0.27);
    add(tall ? C.backT : C.back, m.mesh, 0, tall ? 0.9 : 0.82, -0.29, -0.1);
    for (const s of [-1, 1]) { add(C.armPost, m.steel, s * 0.26, 0.56, -0.02); add(C.arm, m.fabric, s * 0.26, 0.67, 0.0); }
    return g;
  }

  monitor(x, y, z, rot, parent, screenMat, { w = 0.62, h = 0.36 } = {}) {
    const m = this.mats, g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rot; parent.add(g);
    const add = (geo, mat, px, py, pz, rx = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(px, py, pz); o.rotation.x = rx; o.castShadow = true; o.receiveShadow = true; g.add(o); return o; };
    add(new RoundedBoxGeometry(0.2, 0.008, 0.16, 2, 0.003), m.alu, 0, 0.004, 0);
    add(new THREE.BoxGeometry(0.075, 0.28, 0.012), m.alu, 0, 0.15, -0.035, -0.18);
    add(new RoundedBoxGeometry(w + 0.025, h + 0.025, 0.022, 3, 0.008), m.alu, 0, 0.12 + h / 2, -0.005);
    const bezel = add(new THREE.PlaneGeometry(w + 0.012, h + 0.012), m.black, 0, 0.12 + h / 2, 0.0065); bezel.castShadow = false;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.012, h - 0.012), screenMat); scr.position.set(0, 0.12 + h / 2, 0.0075); g.add(scr);
    return { g, scr };
  }

  buildPod(p, L, add) {
    const m = this.mats, S = this.static, dark = this.theme === 'dark';
    // ковёр команды
    const rugTex = this.tex('poly_wool_herringbone', [p.w / 1.2, POD_D / 1.2]);
    const rugMat = new THREE.MeshStandardMaterial({ ...rugTex, color: mixHex(p.accent, '#ffffff', dark ? 0.55 : 0.72), roughness: 1 });
    const rug = add(new THREE.PlaneGeometry(p.w - 0.2, POD_D - 0.3), rugMat, p.cx, 0.006, p.cz, { cast: false }); rug.rotation.x = -Math.PI / 2;
    // войлочная перегородка по центру скамьи
    const feltMat = new THREE.MeshStandardMaterial({ ...this.tex('poly_wool_herringbone', [3, 0.6]), color: mixHex(p.accent, dark ? '#202020' : '#ffffff', dark ? 0.35 : 0.42), roughness: 1 });
    const benchW = p.cols * SEAT_W - 0.1;
    add(new RoundedBoxGeometry(benchW, 0.42, 0.035, 2, 0.012), feltMat, p.cx, 0.755 + 0.21, p.cz);
    for (let c = 0; c < p.cols; c++) {
      const x = p.x0 + POD_PAD + SEAT_W * (c + 0.5);
      for (const north of [true, false]) {
        const dz = p.cz + (north ? -0.4 : 0.4);
        const top = add(new RoundedBoxGeometry(1.6, 0.03, 0.78, 2, 0.008), m.oak, x, 0.74, dz);
        top.userData.seatKey = null;
      }
      // общая рама на две столешницы
      for (const sx of [-0.74, 0.74]) {
        add(new THREE.BoxGeometry(0.05, 0.72, 0.05), m.steel, x + sx, 0.36, p.cz - 0.7);
        add(new THREE.BoxGeometry(0.05, 0.72, 0.05), m.steel, x + sx, 0.36, p.cz + 0.7);
        add(new THREE.BoxGeometry(0.05, 0.05, 1.45), m.steel, x + sx, 0.7, p.cz);
        add(new THREE.BoxGeometry(0.05, 0.03, 1.45), m.steel, x + sx, 0.03, p.cz);
      }
    }
    for (let i = 0; i < p.cols * 2; i++) {
      const a = p.list[i], c = i >> 1, north = i % 2 === 0;
      const x = p.x0 + POD_PAD + SEAT_W * (c + 0.5), s = north ? -1 : 1;
      const seat = a ? L.seats.get(a.key) : null;
      const mon = this.monitor(x, 0.755, p.cz + s * 0.2, north ? Math.PI : 0, S, this.screens.sleep);
      mon.scr.userData.seatKey = a?.key;
      add(new RoundedBoxGeometry(0.29, 0.012, 0.1, 2, 0.005), m.white, x - 0.03, 0.761, p.cz + s * 0.56, { ud: { seatKey: a?.key } });
      add(new RoundedBoxGeometry(0.06, 0.018, 0.1, 2, 0.008), m.white, x + 0.25, 0.763, p.cz + s * 0.56);
      const hv = hash(`${p.project}${i}`);
      if (hv % 3 === 0) { add(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 18), m.ceramic, x - 0.55, 0.805, p.cz + s * 0.45); }
      if (hv % 4 === 1) this.model('potted_plant_04', x + 0.6, p.cz + s * 0.25, { height: 0.22, y: 0.755 });
      if (hv % 5 === 2) add(new RoundedBoxGeometry(0.21, 0.015, 0.29, 2, 0.004), new THREE.MeshStandardMaterial({ color: [0x2c4a6e, 0xc8553d, 0x3d6b4f][hv % 3], roughness: 0.7 }), x + 0.5, 0.763, p.cz + s * 0.5).rotation.y = 0.2;
      const chair = this.taskChair(x, p.cz + s * 1.22, north ? 0 : Math.PI, S);
      if (seat) { seat.screen = mon.scr; seat.chair = chair; chair.traverse((o) => { o.userData.seatKey = a.key; }); }
      if (a) {
        // мягкое синее свечение под работающим — видно с любого ракурса
        const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), this.haloMat()); halo.rotation.x = -Math.PI / 2;
        halo.position.set(x, 0.012, p.cz + s * 1.3); halo.visible = false; halo.renderOrder = 2; S.add(halo);
        if (seat) seat.halo = halo;
        const el = document.createElement('div'); el.className = 'seat-tag';
        el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onAgent?.(a.key); });
        el.addEventListener('mouseenter', () => this.setHover(a.key));
        el.addEventListener('mouseleave', () => this.setHover(null));
        const tag = new CSS2DObject(el); tag.position.set(x, 1.72, p.cz + s * 1.22); S.add(tag);
        if (seat) seat.tagEl = el;
      }
    }
    const el = document.createElement('div'); el.className = 'zone-label';
    el.innerHTML = `<i style="background:${p.accent}"></i><b>${esc(p.project)}</b><span class="zs"></span>`;
    p.labelEl = el;
    const lab = new CSS2DObject(el); lab.position.set(p.cx, 2.35, p.z0 + 0.2); S.add(lab);
  }

  haloMat() {
    return this._halo ??= new THREE.MeshBasicMaterial({
      map: canvasTex(128, 128, (x) => { const g = x.createRadialGradient(64, 64, 4, 64, 64, 64); g.addColorStop(0, 'rgba(10,132,255,.55)'); g.addColorStop(0.55, 'rgba(10,132,255,.2)'); g.addColorStop(1, 'rgba(10,132,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }),
      transparent: true, depthWrite: false, toneMapped: false,
    });
  }

  buildMeeting(L, add) {
    const m = this.mats, R = L.meet, cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2, w = R.x1 - R.x0, d = R.z1 - R.z0;
    const rug = add(new THREE.PlaneGeometry(w - 0.1, d - 0.1), new THREE.MeshStandardMaterial({ ...this.tex('poly_wool_herringbone', [w / 1.2, d / 1.2]), color: new THREE.Color(this.theme === 'dark' ? 0x4a4d55 : 0xd9dde3), roughness: 1 }), cx, 0.006, cz, { cast: false }); rug.rotation.x = -Math.PI / 2;
    const H = 2.45;
    const pane = (len, x, z, rot) => {
      const p = add(new THREE.PlaneGeometry(len, H), m.glass, x, H / 2, z, { cast: false, recv: false }); p.rotation.y = rot;
      const fr = add(new THREE.BoxGeometry(rot ? 0.04 : len, 0.04, rot ? len : 0.04), m.steel, x, H, z); void fr;
      add(new THREE.BoxGeometry(rot ? 0.04 : len, 0.04, rot ? len : 0.04), m.steel, x, 0.02, z);
    };
    pane(w, cx, R.z0, 0); pane(w - 1.0, cx + 0.5, R.z1, 0); pane(d, R.x0, cz, Math.PI / 2); pane(d, R.x1, cz, Math.PI / 2);
    for (const [x, z] of [[R.x0, R.z0], [R.x1, R.z0], [R.x0, R.z1], [R.x1, R.z1], [R.x0 + 1.0, R.z1]]) add(new THREE.BoxGeometry(0.05, H, 0.05), m.steel, x, H / 2, z);
    add(new RoundedBoxGeometry(2.4, 0.04, 1.05, 3, 0.015), m.oak, cx, 0.74, cz + 0.1);
    add(new THREE.BoxGeometry(0.12, 0.72, 0.6), m.steel, cx - 0.8, 0.36, cz + 0.1); add(new THREE.BoxGeometry(0.12, 0.72, 0.6), m.steel, cx + 0.8, 0.36, cz + 0.1);
    for (const [dx, dz, r] of [[-0.75, -0.75, 0], [0, -0.75, 0], [0.75, -0.75, 0], [-0.75, 0.95, Math.PI], [0, 0.95, Math.PI], [0.75, 0.95, Math.PI]]) this.taskChair(cx + dx, cz + 0.1 + dz, r, this.static);
    // экран на стойке
    const scr = this.monitor(cx, 0, R.z0 + 0.35, 0, this.static, new THREE.MeshBasicMaterial({ map: canvasTex(512, 288, (x) => { const g = x.createLinearGradient(0, 0, 512, 288); g.addColorStop(0, '#1d2b45'); g.addColorStop(1, '#3a2d5c'); x.fillStyle = g; x.fillRect(0, 0, 512, 288); x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '600 34px -apple-system, Helvetica, sans-serif'; x.fillText('Sprint review', 36, 70); x.fillStyle = 'rgba(255,255,255,.35)'; for (let i = 0; i < 4; i++) x.fillRect(36, 110 + i * 34, 260 + ((i * 70) % 160), 14); }), toneMapped: false }), { w: 1.4, h: 0.8 });
    scr.g.children.forEach((o) => { if (o.geometry?.type === 'BoxGeometry') o.scale.set(1, 4.2, 1); });
    scr.g.position.y = 0.3;
    this.areaLabel('Переговорка', cx, R.z1 + 0.35);
  }

  buildLounge(L, add) {
    const m = this.mats, R = L.lounge, cz = (R.z0 + R.z1) / 2, dark = this.theme === 'dark';
    const rug = add(new THREE.PlaneGeometry(R.x1 - R.x0 - 0.3, R.z1 - R.z0 - 0.4), new THREE.MeshStandardMaterial({ ...this.tex('poly_wool_herringbone', [4, 4]), color: new THREE.Color(dark ? 0x6b5446 : 0xe7cdb7), roughness: 1 }), (R.x0 + R.x1) / 2, 0.006, cz, { cast: false }); rug.rotation.x = -Math.PI / 2;
    const sx = L.W / 2 - 0.55;
    if (!this.model('sofa_03', sx, cz, { rot: -Math.PI / 2 })) add(new RoundedBoxGeometry(0.9, 0.8, 2.2, 3, 0.08), m.fabric, sx, 0.4, cz);
    this.model('modern_coffee_table_01', R.x0 + 2.55, cz, { rot: Math.PI / 2 });
    this.model('modern_arm_chair_01', R.x0 + 1.25, cz - 1.0, { rot: Math.PI / 2 - 0.3 });
    this.model('modern_arm_chair_01', R.x0 + 1.25, cz + 1.0, { rot: Math.PI / 2 + 0.3 });
    this.model('Ottoman_01', R.x0 + 0.8, R.z1 - 0.75, { rot: 0.3 });
    this.model('Ottoman_01', R.x0 + 1.9, R.z1 - 0.55, { rot: -0.2 });
    this.model('side_table_01', L.W / 2 - 0.5, cz + 1.55, {});
    this.areaLabel('Лаунж', (R.x0 + R.x1) / 2, R.z1 - 0.05);
  }

  buildBar(L, add) {
    const m = this.mats, B = L.bar, len = B.z1 - B.z0, cz = (B.z0 + B.z1) / 2, x = B.x;
    add(new RoundedBoxGeometry(0.62, 0.04, len, 2, 0.01), m.quartz, x, 1.04, cz);
    add(new THREE.BoxGeometry(0.5, 1.0, len - 0.04), m.white, x + 0.04, 0.5, cz);
    // фасад из дубовых реек
    const n = Math.floor(len / 0.1);
    const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.025, 1.0, 0.06), m.oak, n);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < n; i++) { mm.makeTranslation(x - 0.225, 0.5, B.z0 + 0.05 + i * 0.1); slats.setMatrixAt(i, mm); }
    slats.castShadow = slats.receiveShadow = true; this.static.add(slats);
    // кофемашина, чашки, полка
    add(new RoundedBoxGeometry(0.42, 0.42, 0.5, 3, 0.02), m.espresso, x + 0.05, 1.27, B.z0 + 0.6);
    add(new THREE.BoxGeometry(0.3, 0.04, 0.34), m.black, x - 0.05, 1.5, B.z0 + 0.6);
    add(new RoundedBoxGeometry(0.16, 0.36, 0.16, 2, 0.02), m.black, x + 0.1, 1.24, B.z0 + 1.05);
    for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.035, 0.03, 0.08, 16), m.ceramic, x - 0.05, 1.1, B.z0 + 1.4 + i * 0.1);
    add(new THREE.BoxGeometry(0.28, 0.03, len * 0.6), m.oak, L.W / 2 - 0.16, 1.75, cz);
    for (let i = 0; i < 6; i++) add(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 16), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.35 }), L.W / 2 - 0.16, 1.86, cz - len * 0.25 + i * len * 0.1);
    for (const s of L.spots.filter((s) => s.kind === 'stool')) this.model('bar_chair_round_01', s.pos.x - 0.05, s.pos.z, { height: 0.78 });
    this.model('potted_plant_02', x - 0.1, B.z1 + 0.55, { height: 1.6 });
    this.areaLabel('Кофе-бар', x - 1.0, B.z1 + 0.2);
  }

  buildMyDesk(L, add) {
    const m = this.mats, { x, z } = L.desk, dark = this.theme === 'dark';
    const ud = { myDesk: true };
    const rug = add(new THREE.PlaneGeometry(4.6, 3.2), new THREE.MeshStandardMaterial({ ...this.tex('poly_wool_herringbone', [4, 3]), color: new THREE.Color(dark ? 0x3b3f48 : 0xdfe3e8), roughness: 1 }), x - 0.9, 0.006, z + 0.3, { cast: false }); rug.rotation.x = -Math.PI / 2;
    add(new RoundedBoxGeometry(2.2, 0.04, 0.95, 3, 0.012), m.oak, x, 0.745, z, { ud });
    for (const sx of [-1.02, 1.02]) { add(new THREE.BoxGeometry(0.05, 0.72, 0.85), m.steel, x + sx, 0.36, z, { ud }); }
    add(new THREE.BoxGeometry(0.5, 0.6, 0.6), m.white, x + 0.65, 0.3, z - 0.05, { ud });
    this.deskTex = canvasTex(640, 360, () => {});
    const mon = this.monitor(x - 0.1, 0.765, z - 0.22, 0, this.static, new THREE.MeshBasicMaterial({ map: this.deskTex, toneMapped: false }), { w: 0.82, h: 0.47 });
    mon.g.traverse((o) => { o.userData.myDesk = true; });
    add(new RoundedBoxGeometry(0.32, 0.012, 0.11, 2, 0.005), m.white, x - 0.12, 0.771, z + 0.18, { ud });
    add(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 18), m.ceramic, x + 0.62, 0.815, z + 0.12, { ud });
    if (!this.model('desk_lamp_arm_01', x - 0.88, z - 0.2, { height: 0.55, y: 0.765, rot: 0.6 })) add(new THREE.CylinderGeometry(0.02, 0.06, 0.5, 12), m.steel, x - 0.88, 1.0, z - 0.2);
    this.model('potted_plant_04', x + 0.85, z - 0.25, { height: 0.26, y: 0.765 });
    this.taskChair(x - 0.05, z + 0.8, Math.PI, this.static, { tall: true }).traverse((o) => { o.userData.myDesk = true; });
    const el = document.createElement('div'); el.className = 'desk-label';
    el.innerHTML = 'Мой стол <span class="badge" hidden>0</span>';
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onDesk?.(); });
    this.deskLabel = el;
    const lab = new CSS2DObject(el); lab.position.set(x + 0.2, 1.75, z - 0.2); this.static.add(lab);
    this.drawDeskScreen();
  }

  buildDoor(L, add) {
    const m = this.mats, d = L.door;
    for (const dz of [-0.55, 0.55]) add(new THREE.BoxGeometry(0.08, 2.4, 0.08), m.steel, -L.W / 2 + 0.04, 1.2, d.z + dz);
    add(new THREE.BoxGeometry(0.08, 0.08, 1.18), m.steel, -L.W / 2 + 0.04, 2.4, d.z);
    const g = add(new THREE.PlaneGeometry(1.02, 2.32), m.glass, -L.W / 2 + 0.05, 1.18, d.z, { cast: false, recv: false }); g.rotation.y = Math.PI / 2;
    const mat = add(new THREE.PlaneGeometry(0.9, 1.3), new THREE.MeshStandardMaterial({ color: 0x2b2c30, roughness: 1 }), -L.W / 2 + 0.6, 0.007, d.z, { cast: false }); mat.rotation.x = -Math.PI / 2;
    this.areaLabel('Вход', -L.W / 2 + 0.6, d.z + 1.0);
  }

  areaLabel(text, x, z) {
    const el = document.createElement('div'); el.className = 'area-label'; el.textContent = text;
    const o = new CSS2DObject(el); o.position.set(x, 0.02, z); this.static.add(o);
  }

  drawDeskScreen() {
    if (!this.deskTex) return;
    const c = this.deskTex.userData.canvas, x = c.getContext('2d'), n = this.inboxCount || 0;
    const g = x.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, '#0e1116'); g.addColorStop(1, n ? '#2a1418' : '#10283a');
    x.fillStyle = g; x.fillRect(0, 0, 640, 360);
    x.fillStyle = 'rgba(255,255,255,.92)'; x.font = '600 34px -apple-system, Helvetica, sans-serif'; x.textAlign = 'left';
    x.fillText('Входящие', 36, 64);
    x.font = '700 120px -apple-system, Helvetica, sans-serif'; x.fillStyle = n ? '#ff6961' : '#5be08a';
    x.fillText(String(n), 36, 200);
    x.font = '500 26px -apple-system, Helvetica, sans-serif';
    (this.deskLines || []).slice(0, 5).forEach(([s, col], i) => {
      x.fillStyle = col; x.beginPath(); x.arc(262, 128 + i * 46, 9, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(255,255,255,.82)'; x.fillText(s.length > 24 ? s.slice(0, 23) + '…' : s, 284, 137 + i * 46);
    });
    if (!n) { x.fillStyle = 'rgba(255,255,255,.7)'; x.fillText('Все работают', 262, 150); }
    this.deskTex.needsUpdate = true;
  }

  // ---------- данные ----------
  update(state) {
    this.lastState = state;
    if (!this.ready) return;
    const agents = state.agents.filter((a) => a.status !== 'stopped');
    const byProject = new Map();
    for (const a of agents) { if (!byProject.has(a.project)) byProject.set(a.project, []); byProject.get(a.project).push(a); }
    for (const l of byProject.values()) l.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0) || String(x.key).localeCompare(y.key));
    const groups = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const sig = this.theme + '|' + groups.map(([p, l]) => p + ':' + l.map((a) => a.key).join(',')).join('|');
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      this.L = this.computeLayout(groups);
      this.rebuildStatic(this.L);
      this.fit();
    }
    const L = this.L;
    const waiting = agents.filter((a) => a.status === 'waiting').sort((a, b) => (a.statusUpdatedAt || 0) - (b.statusUpdatedAt || 0));
    // закончил задачу — подходит показать результат, пока не нажмут «Посмотрел»
    const done = agents.filter((a) => a.status === 'idle' && a.report).sort((a, b) => a.report.at - b.report.at);
    const qIndex = new Map([...waiting, ...done].slice(0, 12).map((a, i) => [a.key, i]));
    // свободные — в лаунж: дольше 10 минут — дремать на пуф, остальные на диван/кресла/бар
    const idle = agents.filter((a) => a.status === 'idle' && !qIndex.has(a.key)).sort((a, b) => (a.statusUpdatedAt || 0) - (b.statusUpdatedAt || 0));
    const free = new Set(L.spots.map((_, i) => i)), spotOf = new Map();
    for (const a of idle) {
      const long = Date.now() - (a.statusUpdatedAt || 0) > 10 * 60e3;
      const prev = this.agents.get(a.key)?.spot;
      let i = prev != null && free.has(prev) ? prev : [...free].find((k) => !!L.spots[k].sleep === long) ?? [...free][0];
      if (i == null) continue;
      free.delete(i); spotOf.set(a.key, i);
    }
    const seen = new Set();
    for (const a of agents) {
      seen.add(a.key);
      let A = this.agents.get(a.key);
      const seat = L.seats.get(a.key);
      if (!A) {
        const robot = new Humanoid(accentOf(a.project), { hosted: a.kind === 'hosted' });
        robot.key = a.key; this.dyn.add(robot.root);
        A = { key: a.key, robot, path: [], at: this.first ? 'seat' : 'door', pos: (this.first ? seat.pos : L.door).clone(), leaving: false };
        A.bubble = this.makeBubble(A); A.zz = this.makeZz(A); A.name = this.makeName(A);
        this.agents.set(a.key, A);
        if (this.first) robot.root.rotation.y = seat.face;
      }
      A.leaving = false;
      const wasWaiting = A.data?.status === 'waiting';
      A.data = a; A.seat = seat;
      A.want = qIndex.has(a.key) ? 'queue' : spotOf.has(a.key) ? 'spot' : 'seat';
      A.wantQ = qIndex.get(a.key) ?? 0;
      A.wantSpot = spotOf.get(a.key);
      if (this.first && A.want !== 'seat') { // первый кадр: сразу на месте, без прогулок
        const p = A.want === 'queue' ? L.queue[A.wantQ] : L.spots[A.wantSpot].pos;
        A.pos.copy(p); A.at = A.want; A.q = A.wantQ; A.spot = A.wantSpot;
        A.robot.root.rotation.y = A.want === 'queue' ? -Math.PI / 4 : L.spots[A.wantSpot].face;
      }
      if (wasWaiting && a.status !== 'waiting') A.happyUntil = performance.now() + 2500;
      A.robot.setDrones((a.subagents || []).length);
      this.paintSeat(A);
    }
    for (const A of this.agents.values()) if (!seen.has(A.key) && !A.leaving) { A.leaving = true; A.want = 'door'; }
    this.first = false;
    this.paintZones(L, agents);
    this.inboxCount = waiting.length + done.length;
    const col = (a) => a.report && a.status !== 'waiting' ? '#34c759' : a.attention?.kind === 'plan' ? '#af52de' : a.attention?.kind === 'permission' ? '#ff9500' : '#ff3b30';
    this.deskLines = [...waiting, ...done].map((a) => [a.title || a.name || a.project, col(a)]);
    this.drawDeskScreen();
    const badge = this.deskLabel?.querySelector('.badge');
    if (badge) { badge.hidden = !this.inboxCount; badge.textContent = this.inboxCount; badge.classList.toggle('green', !waiting.length); }
    this.deskLabel?.classList.toggle('alert', waiting.length > 0);
  }

  paintZones(L, agents) {
    for (const p of L.pods) {
      if (!p.labelEl) continue;
      const list = agents.filter((a) => a.project === p.project);
      const busy = list.filter((a) => a.status === 'busy').length, wait = list.filter((a) => a.status === 'waiting').length, fin = list.filter((a) => a.status === 'idle' && a.report).length;
      const html = (wait ? `<em class="w"><s></s>${wait} ${wait === 1 ? 'ждёт' : 'ждут'}</em>` : '')
        + (fin ? `<em class="d"><s></s>${fin} готово</em>` : '')
        + (busy ? `<em class="b"><s></s>${busy} ${busy === 1 ? 'работает' : 'работают'}</em>` : '')
        + (busy || wait || fin ? `<span>из ${list.length}</span>` : `<span>${list.length === 1 ? 'свободен' : `${list.length} свободны`}</span>`);
      const box = p.labelEl.querySelector('.zs');
      if (box._html !== html) { box.innerHTML = html; box._html = html; }
      p.labelEl.classList.toggle('active', busy > 0); p.labelEl.classList.toggle('alert', wait > 0);
    }
  }

  paintSeat(A) {
    const a = A.data, s = A.seat;
    if (!s) return;
    const att = a.attention?.kind, amber = att === 'permission' || att === 'plan';
    const longIdle = Date.now() - (a.statusUpdatedAt || 0) > 10 * 60e3;
    if (s.screen) s.screen.material = a.status === 'waiting' ? (att === 'plan' ? this.screens.plan : amber ? this.screens.amber : this.screens.ask)
      : a.status === 'busy' ? this.screens.code : a.report ? this.screens.done : longIdle ? this.screens.sleep : this.screens.idle;
    if (s.halo) s.halo.visible = a.status === 'busy';
    if (s.tagEl) {
      const title = a.title || a.name || 'Агент', busy = a.status === 'busy', away = A.want !== 'seat';
      const where = a.status === 'waiting' || a.report ? '<small>у вашего стола</small>' : away ? '<small class="m">в лаунже</small>' : '';
      const html = `<i class="st ${a.status}${amber ? ' amber' : ''}"></i>${a.kind === 'hosted' ? '<em>★</em>' : ''}<span>${esc(title.length > 28 ? title.slice(0, 27) + '…' : title)}</span>${busy ? '<u class="dots"><b></b><b></b><b></b></u>' : ''}${where}`;
      if (s.tagEl._html !== html) { s.tagEl.innerHTML = html; s.tagEl._html = html; }
      const hl = this.hoverKey === a.key || this.extHover === a.key;
      s.tagEl.className = `seat-tag ${a.status}${away ? ' away' : ''}${hl ? ' hl' : ''}`;
      s.tagEl.hidden = away;
      const t = a.transcript || {};
      s.tagEl.title = busy ? (t.pendingTool ? `Работает · ${t.pendingTool.name}: ${t.pendingTool.summary || ''}` : 'Работает') : '';
    }
  }

  makeBubble(A) {
    const el = document.createElement('div'); el.className = 'bubble'; el.hidden = true;
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onBubble?.(A.key); });
    el.addEventListener('mouseenter', () => this.setHover(A.key));
    el.addEventListener('mouseleave', () => this.setHover(null));
    const o = new CSS2DObject(el); o.position.set(0, 2.05, 0); A.robot.root.add(o);
    return el;
  }
  makeName(A) {
    const el = document.createElement('div'); el.className = 'seat-tag robot-name'; el.hidden = true;
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onAgent?.(A.key); });
    const o = new CSS2DObject(el); o.position.set(0, 2.0, 0); A.robot.root.add(o); A.nameObj = o;
    return el;
  }
  makeZz(A) {
    const el = document.createElement('div'); el.className = 'zz'; el.innerHTML = '<span>z</span><span>z</span><span>z</span>'; el.hidden = true;
    const o = new CSS2DObject(el); o.position.set(0.3, 1.45, 0); A.robot.root.add(o);
    return el;
  }

  // ---------- маршруты ----------
  exitPts(A) {
    const L = this.L;
    if (A.at === 'seat' && A.seat) return [...A.seat.out];
    if (A.at === 'queue') { const q = L.queue[A.q ?? 0]; return [V(q.x, L.F)]; }
    if (A.at === 'spot' && A.spot != null) { const s = L.spots[A.spot]; return [s.approach.clone(), V(s.approach.x, L.F)]; }
    if (A.at === 'door') return [V(L.door.x + 0.8, L.door.z), V(L.door.x + 0.8, L.F)];
    return [V(A.pos.x, L.F)];
  }
  entryPts(to, A) {
    const L = this.L;
    if (to === 'seat' && A.seat) return [...[...A.seat.out].reverse(), A.seat.pos.clone()];
    if (to === 'queue') { const q = L.queue[A.wantQ]; return [V(q.x, L.F), q.clone()]; }
    if (to === 'spot') { const s = L.spots[A.wantSpot]; return [V(s.approach.x, L.F), s.approach.clone(), s.pos.clone()]; }
    if (to === 'door') return [V(L.door.x + 0.8, L.F), V(L.door.x + 0.8, L.door.z), L.door.clone()];
    return [];
  }
  route(A, to) {
    const pts = [...this.exitPts(A), ...this.entryPts(to, A)];
    return pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.01);
  }

  stepAgent(A, dt, now) {
    const r = A.robot, a = A.data, L = this.L;
    if (!A.path.length) {
      const w = A.want;
      const moved = w !== A.at || (w === 'queue' && A.q !== A.wantQ) || (w === 'spot' && A.spot !== A.wantSpot) || (w === 'seat' && A.seat && A.pos.distanceTo(A.seat.pos) > 0.05);
      if (moved) {
        if (w === 'seat' && A.at === 'seat' && A.seat) A.pos.copy(A.seat.pos);
        else if (w === 'queue' && A.at === 'queue') { A.path = [L.queue[A.wantQ].clone()]; A.dest = 'queue'; A.at = 'moving'; }
        else { A.path = this.route(A, w); A.dest = w; A.at = 'moving'; }
      }
    }
    if (A.path.length) {
      const tgt = A.path[0], d = new THREE.Vector3().subVectors(tgt, A.pos); d.y = 0;
      const dist = d.length(), spd = a?.status === 'waiting' && !A.leaving ? RUN : WALK, step = spd * dt;
      if (dist > 0.001) r.root.rotation.y = lerpAngle(r.root.rotation.y, Math.atan2(d.x, d.z), Math.min(1, dt * 10));
      if (dist <= step) { A.pos.copy(tgt); A.path.shift(); } else A.pos.addScaledVector(d.normalize(), step);
      r.pose = 'walk'; r.speedK = spd / WALK;
      if (!A.path.length) { A.at = A.dest; if (A.dest === 'queue') A.q = A.wantQ; if (A.dest === 'spot') A.spot = A.wantSpot; if (A.dest === 'door' && A.leaving) A.gone = true; }
    } else if (A.at === 'seat' && A.seat) {
      r.root.rotation.y = lerpAngle(r.root.rotation.y, A.seat.face, Math.min(1, dt * 8));
      r.seatY = 0.47; r.pose = a?.status === 'busy' ? 'sit-work' : 'sit-idle';
    } else if (A.at === 'spot' && A.spot != null) {
      const s = L.spots[A.spot];
      r.root.rotation.y = lerpAngle(r.root.rotation.y, s.face, Math.min(1, dt * 8));
      r.seatY = s.seatY; r.pose = s.sleep ? 'sleep' : 'lounge';
    } else if (A.at === 'queue') {
      r.root.rotation.y = lerpAngle(r.root.rotation.y, -Math.PI / 4, Math.min(1, dt * 6));
      r.pose = (A.q ?? 0) === 0 || ((now / 1000 + hash(A.key) % 7) % 7 < 2) ? 'wave' : 'stand';
    } else r.pose = 'stand';
    r.root.position.copy(A.pos);

    const att = a?.attention?.kind, amber = att === 'permission' || att === 'plan';
    const fin = a?.status === 'idle' && !!a.report;
    if (fin || (A.happyUntil && now < A.happyUntil)) r.setMood('happy');
    else if (a?.status === 'waiting') r.setMood(amber ? 'ask-amber' : 'ask');
    else if (r.pose === 'sleep') r.setMood('sleep');
    else if (r.pose === 'sit-work') r.setMood('work');
    else r.setMood('calm');
    r.setStatus(a?.status === 'waiting' ? (att === 'plan' ? STATUS.plan : amber ? STATUS.permission : STATUS.question) : a?.status === 'busy' ? STATUS.busy : fin ? STATUS.done : STATUS.idle, a?.status === 'waiting' || fin);
    const hl = this.hoverKey === A.key || this.extHover === A.key ? 1 : 0;
    r.highlight += (hl - r.highlight) * Math.min(1, dt * 12);
    r.update(dt);

    const showB = (a?.status === 'waiting' || fin) && !A.leaving;
    if (A.bubble.hidden === showB) A.bubble.hidden = !showB;
    if (showB) {
      const mins = Math.max(0, Math.floor((Date.now() - (a.statusUpdatedAt || Date.now())) / 60000));
      const label = fin ? 'Готово' : att === 'plan' ? 'План' : att === 'permission' ? 'Разрешение' : 'Вопрос';
      const icon = fin ? '✓' : att === 'permission' ? '!' : att === 'plan' ? '≡' : '?';
      const html = fin ? '<i class="done">✓</i><span>Готово</span>' : `<i class="${att === 'plan' ? 'plan' : amber ? 'amber' : ''}">${icon}</i><span>${mins ? `${mins} мин` : 'сейчас'}</span>`;
      if (A.bubble._html !== html) { A.bubble.innerHTML = html; A.bubble._html = html; A.bubble.title = `${label}: ${a.title || a.name || ''}`; }
      A.bubble.className = `bubble compact${hl ? ' hl' : ''}`;
    }
    const zz = r.pose === 'sleep';
    if (A.zz.hidden === zz) A.zz.hidden = !zz;
    const showN = hl > 0 && A.at !== 'seat' && !showB;
    if (A.name.hidden === showN) A.name.hidden = !showN;
    if (showN) {
      const seated = r.pose === 'lounge' || r.pose === 'sleep';
      A.nameObj.position.y = seated ? 1.55 : 2.0;
      const html = `<i class="st ${a?.status || 'idle'}"></i>${a?.kind === 'hosted' ? '<em>★</em>' : ''}<span>${esc(a?.title || a?.name || 'Агент')}</span><small class="m">${esc(a?.project || '')}</small>`;
      if (A.name._html !== html) { A.name.innerHTML = html; A.name._html = html; }
    }
  }

  // ---------- камера ----------
  fit() {
    const L = this.L, cam = this.camera;
    const pts = [];
    for (const x of [-L.W / 2, L.W / 2]) for (const z of [-L.D / 2, L.D / 2]) for (const y of [0, WALL_H]) pts.push(new THREE.Vector3(x, y, z));
    const target = new THREE.Vector3(0, 0.6, 0);
    let dist = 50;
    for (let it = 0; it < 6; it++) {
      cam.position.copy(target).addScaledVector(this.camDir, dist); cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const ndc = pts.map((p) => p.clone().project(cam));
      const minX = Math.min(...ndc.map((p) => p.x)), maxX = Math.max(...ndc.map((p) => p.x)), minY = Math.min(...ndc.map((p) => p.y)), maxY = Math.max(...ndc.map((p) => p.y));
      const h = this.el.clientHeight || 1, inset = Math.min(0.3, (this.topInset ?? 84) / h) * 2;
      const needX = (maxX - minX) / 1.96, needY = (maxY - minY) / (1.94 - inset);
      // сдвиг цели к центру картинки (с учётом шапки сверху)
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist, halfW = halfH * cam.aspect;
      target.addScaledVector(right, ((minX + maxX) / 2) * halfW).addScaledVector(up, ((minY + maxY) / 2 + inset / 2) * halfH);
      dist *= Math.max(needX, needY);
    }
    cam.position.copy(target).addScaledVector(this.camDir, dist); cam.lookAt(target);
    this.controls.target.copy(target);
    this.controls.minDistance = dist * 0.3; this.controls.maxDistance = dist * 1.35;
    const az = this.controls.getAzimuthalAngle();
    this.controls.minAzimuthAngle = az - 0.8; this.controls.maxAzimuthAngle = az + 0.8;
    this.controls.update();
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.labels.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.L) this.fit();
  }
  focusAgent(key) {
    const A = this.agents.get(key);
    if (!A) return;
    this.extHover = key;
    this.flyTo = { from: this.controls.target.clone(), to: A.pos.clone().setY(0.8), t: 0 };
    setTimeout(() => { if (this.extHover === key) this.extHover = null; }, 2200);
  }
  highlight(key) { this.extHover = key; }
  setPaused(p) { this.paused = !!p; }

  // ---------- указатель ----------
  bindPointer() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const hit = this.pick(e);
      this.setHover(hit?.key || (hit?.desk ? '__desk' : null));
      dom.style.cursor = hit ? 'pointer' : 'grab';
    });
    dom.addEventListener('pointerleave', () => this.setHover(null));
    dom.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const hit = this.pick(e);
      if (!hit) return this.h.onEmpty?.();
      if (hit.desk) return this.h.onDesk?.();
      const A = this.agents.get(hit.key);
      if (A?.data?.status === 'waiting' || (A?.data?.status === 'idle' && A.data.report)) this.h.onBubble?.(hit.key); else this.h.onAgent?.(hit.key);
    });
  }
  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    for (const h of this.raycaster.intersectObjects([this.dyn, this.static], true)) {
      let o = h.object;
      while (o) {
        if (o.userData.robot) return { key: o.userData.robot.key };
        if (o.userData.seatKey) return { key: o.userData.seatKey };
        if (o.userData.myDesk) return { desk: true };
        o = o.parent;
      }
    }
    return null;
  }
  setHover(key) {
    this.hoverKey = key === '__desk' ? null : key;
    this.deskLabel?.classList.toggle('hover', key === '__desk');
    this.h.onHover?.(this.hoverKey);
    for (const A of this.agents.values()) if (A.seat?.tagEl) A.seat.tagEl.classList.toggle('hl', this.hoverKey === A.key || this.extHover === A.key);
  }

  // ---------- цикл ----------
  loop(nowMs) {
    requestAnimationFrame(this.loop);
    if (document.hidden || this.paused || !this.el.clientWidth) { this.clock.getDelta(); return; }
    const dt = Math.min(0.1, this.clock.getDelta());
    this.codeT += dt;
    if (this.codeT > 0.16) { this.codeT = 0; this.codeOff++; this.screens.tex.code.userData.draw(this.codeOff); }
    if (this._halo) this._halo.opacity = 0.75 + 0.25 * Math.sin(nowMs / 1000 * 2.6);
    for (const A of [...this.agents.values()]) {
      this.stepAgent(A, dt, nowMs);
      if (A.gone) {
        A.robot.root.traverse((c) => { if (c.isCSS2DObject) c.element.remove(); });
        this.dyn.remove(A.robot.root); A.robot.dispose(); this.agents.delete(A.key);
      }
    }
    if (this.flyTo) {
      this.flyTo.t = Math.min(1, this.flyTo.t + dt * 2.2);
      const k = 1 - Math.pow(1 - this.flyTo.t, 3), nt = this.flyTo.from.clone().lerp(this.flyTo.to, k);
      const delta = nt.clone().sub(this.controls.target);
      this.controls.target.add(delta); this.camera.position.add(delta);
      if (this.flyTo.t >= 1) this.flyTo = null;
    }
    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
