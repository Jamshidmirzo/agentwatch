// 3D-офис в изометрии: зоны-проекты вдоль центрального прохода, мой стол спереди.
// Агент со статусом waiting встаёт, идёт по проходам к моему столу и ждёт в очереди.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Robot, STATUS_COLORS } from './robot.js';

const THEMES = {
  light: { bg: 0xeef0f4, slab: 0xfbfbfd, slabSide: 0xe3e4e9, wood: 0xd9bf9a, white: 0xf7f7f9, metal: 0xc4c7cd, chair: 0x2c2c2e, glass: 0xd6e4f0, leaf: 0x4f9a63, pot: 0xf2f2f2, robot: 0xf7f7f9, rugMix: 0.82, rugBase: 0xffffff, hemi: 1.0, sun: 1.7, env: 0.55, shadow: 0.22 },
  dark: { bg: 0x0b0c10, slab: 0x1d1e23, slabSide: 0x141519, wood: 0x6f5a44, white: 0x2b2c31, metal: 0x6b6e75, chair: 0x141416, glass: 0x2b3a4a, leaf: 0x3c7a4c, pot: 0x2f3036, robot: 0xe9eaef, rugMix: 0.9, rugBase: 0x16171b, hemi: 0.55, sun: 1.0, env: 0.35, shadow: 0.5 },
};
const ACCENTS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6', '#66d4cf', '#ff6f3c'];

// раскладка, м
const SEAT_W = 1.7, ZONE_PAD = 0.95, ZONE_D = 4.7, CORRIDOR = 2.6, ROW_GAP = 2.0;
const FRONT_Z = ROW_GAP / 2;        // передний проход (между первым рядом зон и моим столом)
const QUEUE_Z = 3.15, DESK_Z = 4.75, QUEUE_STEP = 0.95, QUEUE_PER_LINE = 7;
const WALK = 1.9, RUN = 2.8;

const mixHex = (a, b, k) => {
  const pa = new THREE.Color(a).getHex(THREE.SRGBColorSpace), pb = new THREE.Color(b).getHex(THREE.SRGBColorSpace);
  const ch = (p, sh) => (p >> sh) & 255;
  return '#' + [16, 8, 0].map((sh) => Math.round(ch(pa, sh) * (1 - k) + ch(pb, sh) * k).toString(16).padStart(2, '0')).join('');
};
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const accentOf = (project) => ACCENTS[hash(project) % ACCENTS.length];
const V = (x, z, y = 0) => new THREE.Vector3(x, y, z);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lerpAngle = (a, b, k) => { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return new THREE.ShapeGeometry(s, 6);
}

// ---------- экраны мониторов (общие текстуры) ----------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.userData.canvas = c;
  return t;
}
function makeScreens() {
  const glyph = (ch, col) => canvasTex(256, 160, (x, w, h) => {
    x.fillStyle = '#1c1c1e'; x.fillRect(0, 0, w, h);
    x.fillStyle = col; x.font = 'bold 110px -apple-system, Helvetica, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, w / 2, h / 2 + 6);
  });
  const code = canvasTex(256, 160, () => {});
  const lines = Array.from({ length: 40 }, (_, i) => ({ indent: (hash(i) % 4) * 14, segs: Array.from({ length: 1 + (hash(i * 7) % 3) }, (_, k) => ({ w: 18 + (hash(i * 13 + k) % 70), c: ['#64d2ff', '#ff9f0a', '#30d158', '#bf5af2', '#e5e5ea', '#ff6482'][hash(i * 3 + k) % 6] })) }));
  code.userData.draw = (off) => {
    const x = code.userData.canvas.getContext('2d');
    x.fillStyle = '#0f1115'; x.fillRect(0, 0, 256, 160);
    x.fillStyle = '#1d2027'; x.fillRect(0, 0, 256, 16);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { x.fillStyle = c; x.beginPath(); x.arc(12 + i * 13, 8, 4, 0, 7); x.fill(); });
    for (let i = 0; i < 12; i++) {
      const L = lines[(i + off) % lines.length]; let cx = 12 + L.indent;
      for (const s of L.segs) { x.fillStyle = s.c; x.globalAlpha = 0.85; x.fillRect(cx, 24 + i * 11, s.w, 5); cx += s.w + 6; }
    }
    x.globalAlpha = 1;
    code.needsUpdate = true;
  };
  code.userData.draw(0);
  const idle = canvasTex(256, 160, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#5e5ce6'); g.addColorStop(0.55, '#bf5af2'); g.addColorStop(1, '#ff9f0a');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  });
  const sleep = canvasTex(64, 40, (x, w, h) => { x.fillStyle = '#050506'; x.fillRect(0, 0, w, h); });
  const mat = (t) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  return { tex: { code }, code: mat(code), ask: mat(glyph('?', '#ff453a')), amber: mat(glyph('!', '#ff9f0a')), plan: mat(glyph('≡', '#ff9f0a')), idle: mat(idle), sleep: mat(sleep) };
}

export class Office {
  constructor(container, handlers = {}) {
    this.el = container;
    this.h = handlers;
    this.theme = 'light';
    this.agents = new Map();    // key -> Agent3D
    this.seats = new Map();     // key -> seat
    this.layoutSig = '';
    this.first = true;
    this.inboxCount = 0;
    this.hoverKey = null;
    this.extHover = null;
    this.clock = new THREE.Clock();
    this.codeOff = 0; this.codeT = 0;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NeutralToneMapping; r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);

    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    const scene = this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.camDir = new THREE.Vector3(0.62, 0.95, 1.0).normalize();
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, screenSpacePanning: true, minZoom: 0.45, maxZoom: 4, minPolarAngle: 0.5, maxPolarAngle: 1.15, zoomSpeed: 1.1 });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 1);
    scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    this.mats = this.makeMats();
    this.screens = makeScreens();
    this.static = new THREE.Group(); scene.add(this.static);
    this.dyn = new THREE.Group(); scene.add(this.dyn);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---------- материалы / тема ----------
  makeMats() {
    const std = (o) => new THREE.MeshStandardMaterial(o);
    return {
      robot: new THREE.MeshPhysicalMaterial({ color: 0xf7f7f9, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
      metal: std({ color: 0xc4c7cd, metalness: 0.85, roughness: 0.28 }),
      metalDark: std({ color: 0x3a3a3c, metalness: 0.6, roughness: 0.35 }),
      wood: std({ color: 0xd9bf9a, roughness: 0.55 }),
      white: std({ color: 0xf7f7f9, roughness: 0.4 }),
      chair: std({ color: 0x2c2c2e, roughness: 0.65 }),
      slab: std({ color: 0xfbfbfd, roughness: 0.92 }),
      slabSide: std({ color: 0xe3e4e9, roughness: 0.9 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xd6e4f0, roughness: 0.08, transparent: true, opacity: 0.32, depthWrite: false }),
      leaf: std({ color: 0x4f9a63, roughness: 0.7 }),
      pot: std({ color: 0xf2f2f2, roughness: 0.55 }),
      mug: std({ color: 0xff9f0a, roughness: 0.4 }),
      black: std({ color: 0x0a0a0c, roughness: 0.2, metalness: 0.3 }),
    };
  }

  setTheme(name) {
    if (!THEMES[name]) return;
    this.theme = name;
    const T = THEMES[name], m = this.mats;
    this.scene.background = new THREE.Color(T.bg);
    m.slab.color.setHex(T.slab); m.slabSide.color.setHex(T.slabSide); m.wood.color.setHex(T.wood); m.white.color.setHex(T.white);
    m.metal.color.setHex(T.metal); m.chair.color.setHex(T.chair); m.glass.color.setHex(T.glass); m.leaf.color.setHex(T.leaf);
    m.pot.color.setHex(T.pot); m.robot.color.setHex(T.robot);
    this.hemi.intensity = T.hemi; this.sun.intensity = T.sun; this.scene.environmentIntensity = T.env;
    this.hemi.groundColor.setHex(name === 'dark' ? 0x202024 : 0xd8d2c8);
    this.layoutSig = ''; // перестроить ковры под тему
    if (this.lastState) this.update(this.lastState);
  }

  // ---------- раскладка ----------
  computeLayout(groups) {
    const zones = groups.map(([project, list]) => {
      const cols = Math.max(2, Math.ceil(list.length / 2));
      return { project, list, cols, w: cols * SEAT_W + ZONE_PAD * 2, d: ZONE_D, accent: accentOf(project) };
    });
    const perSide = zones.length <= 4 ? 1 : zones.length <= 8 ? 2 : 3;
    const rows = [];
    zones.forEach((z, i) => {
      const r = Math.floor(i / (perSide * 2));
      rows[r] ??= { left: [], right: [] };
      (i % 2 === 0 ? rows[r].right : rows[r].left).push(z);
    });
    rows.forEach((row, ri) => {
      const zSouth = -ri * (ZONE_D + ROW_GAP);
      row.aisleZ = zSouth + ROW_GAP / 2;
      let x = CORRIDOR / 2;
      for (const z of row.right) { z.x0 = x; z.x1 = x + z.w; x = z.x1 + 0.6; }
      x = -CORRIDOR / 2;
      for (const z of row.left) { z.x1 = x; z.x0 = x - z.w; x = z.x0 - 0.6; }
      for (const z of [...row.left, ...row.right]) {
        z.row = ri; z.z1 = zSouth; z.z0 = zSouth - ZONE_D; z.cx = (z.x0 + z.x1) / 2; z.cz = (z.z0 + z.z1) / 2; z.aisleZ = row.aisleZ;
      }
    });
    const seats = new Map();
    for (const z of zones) {
      const nearX = Math.abs(z.x0) < Math.abs(z.x1) ? z.x0 + 0.4 : z.x1 - 0.4; // край зоны ближе к проходу
      z.list.forEach((a, i) => {
        const col = Math.floor(i / 2), north = i % 2 === 0;
        const x = z.x0 + ZONE_PAD + SEAT_W * (col + 0.5);
        const deskZ = z.cz + (north ? -0.4 : 0.4);
        const seatZ = z.cz + (north ? -1.3 : 1.3);
        const standZ = z.cz + (north ? -1.95 : 1.95);
        const out = north
          ? [V(x, standZ), V(nearX, standZ), V(nearX, z.aisleZ), V(0, z.aisleZ)]
          : [V(x, standZ), V(x, z.aisleZ), V(0, z.aisleZ)];
        if (z.row === 0) out.pop(); // первый ряд выходит прямо в передний проход
        seats.set(a.key, { key: a.key, zone: z, x, deskZ, seatZ, north, pos: V(x, seatZ), face: north ? 0 : Math.PI, out });
      });
    }
    const all = zones.length ? zones : [{ x0: -3, x1: 3, z0: -ZONE_D, z1: 0 }];
    // content — то, что должно влезть в кадр; bounds — плита пола (чуть шире, с дверью)
    const content = { minX: Math.min(-3.6, ...all.map((z) => z.x0)), maxX: Math.max(3.6, ...all.map((z) => z.x1)), minZ: Math.min(...all.map((z) => z.z0)), maxZ: DESK_Z + 1.2 };
    const b = { minX: content.minX - 1.5, maxX: content.maxX + 0.8, minZ: content.minZ - 0.7, maxZ: content.maxZ + 0.6 };
    return { zones, seats, bounds: b, content, door: V(b.minX + 0.75, FRONT_Z) };
  }

  // ---------- статика: пол, зоны, столы, мой стол ----------
  rebuildStatic(L) {
    for (const o of [...this.static.children]) { this.static.remove(o); o.traverse?.((c) => { if (c.isCSS2DObject) c.element.remove(); }); }
    const T = THEMES[this.theme], m = this.mats, S = this.static, b = L.bounds;
    const mesh = (geo, mat, x = 0, y = 0, z = 0, parent = S, shadow = true) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = shadow; o.receiveShadow = true; parent.add(o); return o; };

    // плита-остров
    const W = b.maxX - b.minX, D = b.maxZ - b.minZ, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const slab = mesh(new RoundedBoxGeometry(W, 0.32, D, 4, 0.3), m.slab, cx, -0.16, cz, S, false);
    slab.receiveShadow = true;
    const skirt = mesh(new RoundedBoxGeometry(W + 0.02, 0.26, D + 0.02, 4, 0.3), m.slabSide, cx, -0.2, cz, S, false);
    skirt.receiveShadow = false;
    // мягкая тень под островом
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.35, D * 1.35), new THREE.MeshBasicMaterial({ map: canvasTex(128, 128, (x) => { const g = x.createRadialGradient(64, 64, 10, 64, 64, 64); g.addColorStop(0, `rgba(0,0,0,${T.shadow})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(cx + 0.6, -0.9, cz + 0.6); S.add(sh);

    // зоны
    for (const z of L.zones) {
      const col = new THREE.Color(mixHex(z.accent, T.rugBase, T.rugMix)); // смешиваем в sRGB, иначе акцент «перебивает»
      const rug = new THREE.Mesh(roundedRect(z.w - 0.3, z.d - 0.3, 0.35), new THREE.MeshStandardMaterial({ color: col, roughness: 0.95 }));
      rug.rotation.x = -Math.PI / 2; rug.position.set(z.cx, 0.006, z.cz); rug.receiveShadow = true; S.add(rug);
      // стеклянная перегородка сзади
      const gw = z.w - 0.7;
      mesh(new THREE.BoxGeometry(gw, 1.15, 0.03), m.glass, z.cx, 0.6, z.z0 + 0.18, S, false);
      mesh(new THREE.BoxGeometry(gw + 0.04, 0.035, 0.05), m.metal, z.cx, 1.18, z.z0 + 0.18);
      mesh(new THREE.BoxGeometry(gw + 0.04, 0.035, 0.05), m.metal, z.cx, 0.03, z.z0 + 0.18);
      const strip = mesh(new THREE.BoxGeometry(gw * 0.9, 0.02, 0.031), new THREE.MeshBasicMaterial({ color: z.accent, toneMapped: false }), z.cx, 0.97, z.z0 + 0.18, S, false);
      strip.receiveShadow = false;
      // растения по углам
      const farX = Math.abs(z.x0) < Math.abs(z.x1) ? z.x1 - 0.42 : z.x0 + 0.42;
      this.plant(farX, z.z0 + 0.5, 1); this.plant(farX, z.z1 - 0.45, 0.85);
      // табличка
      const el = document.createElement('div'); el.className = 'zone-label';
      el.innerHTML = `<i style="background:${z.accent}"></i><b>${esc(z.project)}</b><span>${z.list.length}</span>`;
      const lab = new CSS2DObject(el); lab.position.set(z.cx, 2.75, z.z0 + 0.18); S.add(lab);
    }
    for (const seat of L.seats.values()) this.buildDesk(seat);
    this.buildMyDesk(L);
    this.buildDoor(L);

    // тени по размеру офиса
    const s = this.sun;
    s.position.set(cx + 9, 16, cz + 11); s.target.position.set(cx, 0, cz);
    const ext = Math.max(W, D) * 0.75;
    Object.assign(s.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 60 });
    s.shadow.camera.updateProjectionMatrix();
  }

  plant(x, z, k = 1, parent = this.static) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(k); parent.add(g);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.36, 24), this.mats.pot); pot.position.y = 0.18; pot.castShadow = pot.receiveShadow = true; g.add(pot);
    const leafG = new THREE.IcosahedronGeometry(0.22, 1);
    [[0, 0.62, 0, 1.1], [0.13, 0.85, 0.05, 0.9], [-0.12, 0.8, -0.06, 0.85], [0.02, 1.05, -0.02, 0.7]].forEach(([lx, ly, lz, s]) => {
      const l = new THREE.Mesh(leafG, this.mats.leaf); l.position.set(lx, ly, lz); l.scale.setScalar(s); l.castShadow = true; g.add(l);
    });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.4, 6), this.mats.metalDark); stem.position.y = 0.48; g.add(stem);
  }

  buildDesk(seat) {
    const m = this.mats;
    const g = new THREE.Group(); g.position.set(seat.x, 0, seat.deskZ); g.rotation.y = seat.north ? Math.PI : 0;
    // локально: робот сидит на +z и смотрит на монитор (−z)
    const add = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; o.userData.seatKey = seat.key; g.add(o); return o; };
    add(new RoundedBoxGeometry(1.5, 0.05, 0.78, 3, 0.02), m.wood, 0, 0.745, 0);
    add(new THREE.BoxGeometry(0.04, 0.72, 0.68), m.white, -0.7, 0.36, 0);
    add(new THREE.BoxGeometry(0.04, 0.72, 0.68), m.white, 0.7, 0.36, 0);
    add(new THREE.BoxGeometry(1.36, 0.16, 0.02), m.white, 0, 0.6, -0.3);
    // iMac
    add(new THREE.BoxGeometry(0.16, 0.012, 0.14), m.metal, 0, 0.776, -0.2);
    add(new THREE.BoxGeometry(0.1, 0.22, 0.02), m.metal, 0, 0.88, -0.24);
    add(new RoundedBoxGeometry(0.68, 0.47, 0.03, 3, 0.012), m.metal, 0, 1.12, -0.22);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), this.screens.sleep);
    screen.position.set(0, 1.15, -0.203); screen.userData.seatKey = seat.key; g.add(screen);
    add(new THREE.BoxGeometry(0.42, 0.014, 0.13), m.white, 0, 0.776, 0.12);
    add(new THREE.BoxGeometry(0.07, 0.014, 0.11), m.white, 0.32, 0.776, 0.13);
    if (hash(seat.key) % 3 === 0) { const mug = add(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 16), m.mug, -0.5, 0.82, 0.05); mug.userData.seatKey = seat.key; }
    // кресло
    const ch = new THREE.Group(); ch.position.set(0, 0, 0.98); g.add(ch);
    const cadd = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; ch.add(o); return o; };
    cadd(new RoundedBoxGeometry(0.54, 0.09, 0.5, 3, 0.04), m.chair, 0, 0.47, 0);
    cadd(new RoundedBoxGeometry(0.52, 0.55, 0.07, 3, 0.04), m.chair, 0, 0.82, 0.25).rotation.x = -0.08;
    cadd(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), m.metal, 0, 0.24, 0);
    for (let i = 0; i < 5; i++) { const leg = cadd(new THREE.BoxGeometry(0.035, 0.03, 0.3), m.metal, 0, 0.04, 0); leg.rotation.y = (i / 5) * Math.PI * 2; leg.translateZ(0.13); }
    this.static.add(g);
    seat.screen = screen;
    // табличка с именем — на краю стола со стороны прохода
    const el = document.createElement('div'); el.className = 'seat-tag';
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onAgent?.(seat.key); });
    el.addEventListener('mouseenter', () => this.setHover(seat.key));
    el.addEventListener('mouseleave', () => this.setHover(null));
    const tag = new CSS2DObject(el); tag.position.set(seat.x, 1.85, seat.seatZ); this.static.add(tag);
    seat.tagEl = el;
  }

  buildMyDesk(L) {
    const m = this.mats, S = this.static;
    const g = new THREE.Group(); g.position.set(0, 0, DESK_Z); S.add(g);
    const add = (geo, mat, x, y, z, p = g) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; o.userData.myDesk = true; p.add(o); return o; };
    // «ковёр ожидания» перед столом
    const wait = new THREE.Mesh(roundedRect(QUEUE_PER_LINE * QUEUE_STEP + 0.4, 2.3, 1.1), new THREE.MeshStandardMaterial({ color: this.theme === 'dark' ? 0x24252b : 0xf1f2f5, roughness: 0.95 }));
    wait.rotation.x = -Math.PI / 2; wait.position.set(0, 0.006, QUEUE_Z - 0.45); wait.receiveShadow = true; S.add(wait);
    add(new RoundedBoxGeometry(2.8, 0.06, 1.15, 3, 0.03), m.wood, 0, 0.76, 0);
    add(new RoundedBoxGeometry(0.06, 0.74, 1.0, 2, 0.02), m.white, -1.3, 0.37, 0);
    add(new RoundedBoxGeometry(0.06, 0.74, 1.0, 2, 0.02), m.white, 1.3, 0.37, 0);
    add(new THREE.BoxGeometry(2.5, 0.2, 0.03), m.white, 0, 0.6, -0.45);
    // большой дисплей с входящими — к «моему» креслу (+z)
    add(new THREE.BoxGeometry(0.22, 0.015, 0.18), m.metal, 0, 0.795, -0.12);
    add(new THREE.BoxGeometry(0.06, 0.34, 0.03), m.metal, 0, 0.96, -0.18);
    add(new RoundedBoxGeometry(1.28, 0.76, 0.04, 3, 0.02), m.black, 0, 1.36, -0.16);
    this.deskTex = canvasTex(640, 360, () => {});
    this.deskScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.68), new THREE.MeshBasicMaterial({ map: this.deskTex, toneMapped: false }));
    this.deskScreen.position.set(0, 1.36, -0.137); this.deskScreen.userData.myDesk = true; g.add(this.deskScreen);
    this.drawDeskScreen();
    add(new THREE.BoxGeometry(0.5, 0.016, 0.16), m.white, 0, 0.8, 0.25);
    add(new THREE.CylinderGeometry(0.045, 0.04, 0.11, 18), m.mug, 0.8, 0.84, 0.2);
    // лампа
    add(new THREE.CylinderGeometry(0.09, 0.1, 0.02, 24), m.metalDark, -1.05, 0.8, -0.25);
    const arm = add(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 8), m.metalDark, -1.05, 1.1, -0.25); arm.rotation.z = 0.25;
    const shade = add(new THREE.ConeGeometry(0.12, 0.14, 24, 1, true), m.metalDark, -0.93, 1.4, -0.2); shade.rotation.z = 0.9;
    const bulb = new THREE.PointLight(0xffe2b0, this.theme === 'dark' ? 3 : 0.8, 3.5, 2); bulb.position.set(-0.86, 1.3, -0.15); g.add(bulb);
    this.plant(1.75, DESK_Z - 0.2, 1.15);
    this.plant(-1.85, DESK_Z + 0.35, 0.9);
    // моё кресло (пустое)
    const ch = new THREE.Group(); ch.position.set(0, 0, 1.0); ch.rotation.y = Math.PI; g.add(ch);
    add(new RoundedBoxGeometry(0.62, 0.1, 0.56, 3, 0.05), m.white, 0, 0.48, 0, ch);
    add(new RoundedBoxGeometry(0.6, 0.66, 0.08, 3, 0.05), m.white, 0, 0.88, 0.27, ch).rotation.x = -0.1;
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), m.metal, 0, 0.24, 0, ch);
    // подпись + бейдж
    const el = document.createElement('div'); el.className = 'desk-label';
    el.innerHTML = '<b>Мой стол</b><span class="badge" hidden>0</span>';
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onDesk?.(); });
    const lab = new CSS2DObject(el); lab.position.set(0, 2.05, DESK_Z - 0.16); S.add(lab);
    this.deskLabel = el;
  }

  buildDoor(L) {
    const m = this.mats, d = L.door;
    const g = new THREE.Group(); g.position.copy(d); g.position.x -= 0.55; this.static.add(g);
    const add = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
    add(new THREE.BoxGeometry(0.06, 2.2, 0.06), m.metal, 0, 1.1, -0.75);
    add(new THREE.BoxGeometry(0.06, 2.2, 0.06), m.metal, 0, 1.1, 0.75);
    add(new THREE.BoxGeometry(0.06, 0.06, 1.56), m.metal, 0, 2.2, 0);
    add(new THREE.BoxGeometry(0.02, 2.1, 0.7), m.glass, 0, 1.08, -0.38);
    add(new THREE.BoxGeometry(0.02, 2.1, 0.7), m.glass, 0, 1.08, 0.38);
  }

  drawDeskScreen() {
    const c = this.deskTex.userData.canvas, x = c.getContext('2d'), n = this.inboxCount;
    const g = x.createLinearGradient(0, 0, 640, 360);
    if (n) { g.addColorStop(0, '#2b0f12'); g.addColorStop(1, '#4a1418'); } else { g.addColorStop(0, '#0f2a1d'); g.addColorStop(1, '#14384f'); }
    x.fillStyle = g; x.fillRect(0, 0, 640, 360);
    x.fillStyle = 'rgba(255,255,255,.9)'; x.font = '600 34px -apple-system, Helvetica, sans-serif'; x.textAlign = 'left';
    x.fillText('Входящие', 40, 70);
    x.font = '700 150px -apple-system, Helvetica, sans-serif'; x.fillStyle = n ? '#ff6961' : '#5be08a';
    x.fillText(String(n), 40, 230);
    x.font = '500 28px -apple-system, Helvetica, sans-serif'; x.fillStyle = 'rgba(255,255,255,.75)';
    (this.deskLines || []).slice(0, 4).forEach((s, i) => x.fillText(s.length > 26 ? s.slice(0, 25) + '…' : s, 280, 150 + i * 44));
    if (!n) x.fillText('Все агенты работают', 280, 170);
    this.deskTex.needsUpdate = true;
  }

  // ---------- данные ----------
  update(state) {
    this.lastState = state;
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

    // очередь у стола: по времени ожидания
    const waiting = agents.filter((a) => a.status === 'waiting').sort((a, b) => (a.statusUpdatedAt || 0) - (b.statusUpdatedAt || 0));
    const qIndex = new Map(waiting.map((a, i) => [a.key, i]));

    const seen = new Set();
    for (const a of agents) {
      seen.add(a.key);
      let A = this.agents.get(a.key);
      const seat = L.seats.get(a.key);
      if (!A) {
        const robot = new Robot(this.mats, accentOf(a.project), { hosted: a.kind === 'hosted' });
        robot.key = a.key;
        this.dyn.add(robot.root);
        A = { key: a.key, robot, path: [], at: this.first ? 'seat' : 'door', pos: (this.first ? seat.pos : L.door).clone(), leaving: false };
        A.bubble = this.makeBubble(A); A.zz = this.makeZz(A);
        this.agents.set(a.key, A);
        if (this.first) robot.root.rotation.y = seat.face;
      }
      if (A.leaving) { A.leaving = false; }
      const wasWaiting = A.data && A.data.status === 'waiting';
      A.data = a; A.seat = seat;
      A.want = a.status === 'waiting' ? 'queue' : 'seat';
      A.wantQ = qIndex.get(a.key) ?? 0;
      if (wasWaiting && a.status !== 'waiting') A.happyUntil = performance.now() + 2500;
      A.robot.setDrones((a.subagents || []).length);
      this.paintSeat(A);
    }
    for (const A of this.agents.values()) if (!seen.has(A.key) && !A.leaving) { A.leaving = true; A.want = 'door'; }
    this.first = false;

    this.inboxCount = waiting.length;
    this.deskLines = waiting.map((a) => a.title || a.name || a.project);
    this.drawDeskScreen();
    const badge = this.deskLabel?.querySelector('.badge');
    if (badge) { badge.hidden = !waiting.length; badge.textContent = waiting.length; }
    this.deskLabel?.classList.toggle('alert', waiting.length > 0);
  }

  paintSeat(A) {
    const a = A.data, s = A.seat;
    if (!s) return;
    const att = a.attention && a.attention.kind;
    const amber = att === 'permission' || att === 'plan';
    s.screen.material = a.status === 'waiting' ? (att === 'plan' ? this.screens.plan : amber ? this.screens.amber : this.screens.ask)
      : a.status === 'busy' ? this.screens.code : (Date.now() - (a.statusUpdatedAt || 0) > 10 * 60e3 ? this.screens.sleep : this.screens.idle);
    if (s.tagEl) {
      const title = a.title || a.name || 'Агент';
      const away = a.status === 'waiting';
      const html = `<i class="st ${a.status}${amber ? ' amber' : ''}"></i>${a.kind === 'hosted' ? '<em>★</em>' : ''}<span>${esc(title.length > 28 ? title.slice(0, 27) + '…' : title)}</span>${away ? '<small>у вашего стола</small>' : ''}`;
      if (s.tagEl._html !== html) { s.tagEl.innerHTML = html; s.tagEl._html = html; }
      s.tagEl.className = `seat-tag ${a.status}${this.hoverKey === a.key || this.extHover === a.key ? ' hl' : ''}`;
    }
  }

  makeBubble(A) {
    const el = document.createElement('div'); el.className = 'bubble'; el.hidden = true;
    el.addEventListener('click', (e) => { e.stopPropagation(); this.h.onBubble?.(A.key); });
    el.addEventListener('mouseenter', () => this.setHover(A.key));
    el.addEventListener('mouseleave', () => this.setHover(null));
    const o = new CSS2DObject(el); o.position.set(0, 2.15, 0); A.robot.root.add(o);
    return el;
  }
  makeZz(A) {
    const el = document.createElement('div'); el.className = 'zz'; el.innerHTML = '<span>z</span><span>z</span><span>z</span>'; el.hidden = true;
    const o = new CSS2DObject(el); o.position.set(0.32, 1.5, 0); A.robot.root.add(o);
    return el;
  }

  // ---------- маршруты ----------
  queuePos(i) {
    const line = Math.floor(i / QUEUE_PER_LINE), k = i % QUEUE_PER_LINE;
    const n = QUEUE_PER_LINE;
    // сначала центр, потом наружу: 0, +1, −1, +2 …
    const order = [3, 4, 2, 5, 1, 6, 0][k] ?? k;
    return V((order - (n - 1) / 2) * QUEUE_STEP, QUEUE_Z - line * 0.95);
  }
  route(A, to) {
    const L = this.L, seat = A.seat, F = V(0, FRONT_Z);
    const pts = [];
    if (A.at === 'seat' && seat) pts.push(...seat.out);
    if (to === 'seat' && seat) {
      if (A.at !== 'seat') { if (A.at === 'door') pts.push(V(L.door.x + 0.6, FRONT_Z)); pts.push(F); }
      pts.push(...[...seat.out].reverse(), seat.pos.clone());
    } else if (to === 'queue') {
      if (A.at === 'seat') pts.push(F);
      if (A.at === 'door') pts.push(V(L.door.x + 0.6, FRONT_Z), F);
      pts.push(this.queuePos(A.wantQ));
    } else if (to === 'door') {
      if (A.at !== 'door') pts.push(F);
      pts.push(L.door.clone());
    }
    // убираем точки-дубли
    return pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.01);
  }

  stepAgent(A, dt, now) {
    const r = A.robot, a = A.data;
    if (!A.path.length) {
      const want = A.want;
      const needMove = want !== A.at || (want === 'queue' && A.q !== A.wantQ) || (want === 'seat' && A.seat && A.pos.distanceTo(A.seat.pos) > 0.05);
      if (needMove) {
        if (want === 'seat' && A.at === 'seat' && A.seat) { A.pos.copy(A.seat.pos); } // раскладка поменялась — пересаживаем
        else if (want === 'queue' && A.at === 'queue') { A.path = [this.queuePos(A.wantQ)]; A.dest = 'queue'; }
        else { A.path = this.route(A, want); A.dest = want; }
        A.at = 'moving';
      }
    }
    if (A.path.length) {
      const tgt = A.path[0];
      const d = new THREE.Vector3().subVectors(tgt, A.pos); d.y = 0;
      const dist = d.length();
      const spd = (a && a.status === 'waiting' && !A.leaving ? RUN : WALK);
      const step = spd * dt;
      if (dist > 0.001) r.root.rotation.y = lerpAngle(r.root.rotation.y, Math.atan2(d.x, d.z), Math.min(1, dt * 12));
      if (dist <= step) { A.pos.copy(tgt); A.path.shift(); } else A.pos.addScaledVector(d.normalize(), step);
      r.pose = 'walk'; r.speedK = spd / WALK;
      if (!A.path.length) {
        A.at = A.dest;
        if (A.dest === 'queue') A.q = A.wantQ;
        if (A.dest === 'door' && A.leaving) A.gone = true;
      }
    } else if (A.at === 'seat' && A.seat) {
      r.root.rotation.y = lerpAngle(r.root.rotation.y, A.seat.face, Math.min(1, dt * 10));
      r.pose = a.status === 'busy' ? 'sit-work' : 'sit-idle';
    } else if (A.at === 'queue') {
      r.root.rotation.y = lerpAngle(r.root.rotation.y, 0, Math.min(1, dt * 8));
      r.pose = (now / 1000 + hash(A.key) % 7) % 6 < 2.2 ? 'wave' : 'stand';
    } else r.pose = 'stand';
    r.root.position.copy(A.pos);

    // настроение / статус
    const att = a?.attention?.kind, amber = att === 'permission' || att === 'plan';
    if (A.happyUntil && now < A.happyUntil) r.setMood('happy');
    else if (a?.status === 'waiting') r.setMood(amber ? 'ask-amber' : 'ask');
    else if (r.pose === 'sit-work') r.setMood('work');
    else if (r.pose === 'sit-idle') r.setMood(Date.now() - (a?.statusUpdatedAt || 0) > 3 * 60e3 ? 'sleep' : 'calm');
    else r.setMood('calm');
    r.setStatusColor(a?.status === 'waiting' ? (amber ? STATUS_COLORS.waitAmber : STATUS_COLORS.waitRed) : a?.status === 'busy' ? STATUS_COLORS.busy : STATUS_COLORS.idle, a?.status === 'waiting');
    const hl = this.hoverKey === A.key || this.extHover === A.key ? 1 : 0;
    r.highlight += (hl - r.highlight) * Math.min(1, dt * 12);
    r.update(dt);

    // пузырь и zz
    const showB = a?.status === 'waiting' && !A.leaving;
    if (A.bubble.hidden === showB) A.bubble.hidden = !showB;
    if (showB) {
      const mins = Math.max(0, Math.floor((Date.now() - (a.statusUpdatedAt || Date.now())) / 60000));
      const label = { question: 'Вопрос', permission: 'Разрешение', plan: 'План', input: 'Ждёт ответа' }[att] || 'Ждёт';
      const icon = att === 'permission' ? '!' : att === 'plan' ? '≡' : '?';
      const html = `<i class="${amber ? 'amber' : ''}">${icon}</i><div><b>${esc((a.title || a.name || '').slice(0, 34))}</b><span>${label} · ${mins ? mins + ' мин' : 'только что'}</span></div>`;
      if (A.bubble._html !== html) { A.bubble.innerHTML = html; A.bubble._html = html; }
      A.bubble.classList.toggle('hl', hl > 0);
    }
    const showZ = r.pose === 'sit-idle' && r.mood === 'sleep';
    if (A.zz.hidden === showZ) A.zz.hidden = !showZ;
  }

  // ---------- камера ----------
  fit() {
    const b = this.L.content;
    const center = V((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2 + 0.6);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(this.camDir, 60);
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
    const corners = [];
    for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) for (const y of [0, 1.8]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse));
    const e = {
      minX: Math.min(...corners.map((c) => c.x)), maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)), maxY: Math.max(...corners.map((c) => c.y)),
    };
    // сдвигаем цель так, чтобы офис оказался ровно по центру кадра
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const shift = right.multiplyScalar((e.minX + e.maxX) / 2).add(up.multiplyScalar((e.minY + e.maxY) / 2));
    this.controls.target.add(shift); this.camera.position.add(shift);
    this.ext = { w: e.maxX - e.minX, h: e.maxY - e.minY };
    this.applyFrustum();
    const az = this.controls.getAzimuthalAngle();
    this.controls.minAzimuthAngle = az - 0.75; this.controls.maxAzimuthAngle = az + 0.75;
    this.controls.update();
  }
  applyFrustum() {
    if (!this.ext) return;
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    // сверху — плавающая шапка: вписываем офис в область под ней, лишнее место уходит наверх
    const inset = Math.min(h * 0.3, this.topInset ?? 84), avail = (h - inset) / h;
    const pad = this.padK || 1.04;
    let ew = this.ext.w * pad, eh = this.ext.h * pad;
    if (ew / eh > w / (h - inset)) eh = ew / (w / (h - inset)); else ew = eh * (w / (h - inset));
    const total = eh / avail;
    this.camera.left = -ew / 2; this.camera.right = ew / 2; this.camera.bottom = -eh / 2; this.camera.top = -eh / 2 + total;
    this.camera.updateProjectionMatrix();
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.labels.setSize(w, h);
    this.applyFrustum();
  }
  focusAgent(key) {
    const A = this.agents.get(key);
    if (!A) return;
    this.extHover = key;
    this.flyTo = { from: this.controls.target.clone(), to: A.pos.clone().setY(0.6), t: 0 };
    setTimeout(() => { if (this.extHover === key) this.extHover = null; }, 2200);
  }
  highlight(key) { this.extHover = key; }

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
      if (A?.data?.status === 'waiting') this.h.onBubble?.(hit.key); else this.h.onAgent?.(hit.key);
    });
  }
  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([this.dyn, this.static], true);
    for (const h of hits) {
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
    if (document.hidden) { this.clock.getDelta(); return; }
    const dt = Math.min(0.1, this.clock.getDelta());
    this.codeT += dt;
    if (this.codeT > 0.14) { this.codeT = 0; this.codeOff++; this.screens.tex.code.userData.draw(this.codeOff); }
    for (const A of [...this.agents.values()]) {
      this.stepAgent(A, dt, nowMs);
      if (A.gone) {
        A.robot.root.traverse((c) => { if (c.isCSS2DObject) c.element.remove(); });
        this.dyn.remove(A.robot.root); A.robot.dispose(); this.agents.delete(A.key);
      }
    }
    if (this.flyTo) {
      this.flyTo.t = Math.min(1, this.flyTo.t + dt * 2.2);
      const k = 1 - Math.pow(1 - this.flyTo.t, 3);
      const nt = this.flyTo.from.clone().lerp(this.flyTo.to, k);
      const delta = nt.clone().sub(this.controls.target);
      this.controls.target.add(delta); this.camera.position.add(delta);
      if (this.flyTo.t >= 1) this.flyTo = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
