// Реалистичный робот-сотрудник: глянцевый белый корпус, тёмный визор, суставы графит.
// Иерархия костей для поз: сидит/печатает, стоит, машет, идёт, отдыхает с кружкой, дремлет.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const STATUS = { busy: 0x0a84ff, question: 0xff3b30, permission: 0xff9500, plan: 0xaf52de, idle: 0x8e8e93, done: 0x34c759 };

let G = null;
function geos() {
  if (G) return G;
  G = {
    head: new RoundedBoxGeometry(0.25, 0.23, 0.24, 5, 0.09),
    visor: new RoundedBoxGeometry(0.205, 0.125, 0.04, 4, 0.045),
    eye: new THREE.CapsuleGeometry(0.014, 0.022, 4, 10),
    ear: new THREE.CylinderGeometry(0.035, 0.035, 0.03, 20),
    neck: new THREE.CylinderGeometry(0.038, 0.048, 0.09, 16),
    torso: new THREE.CapsuleGeometry(0.155, 0.2, 10, 24),
    band: new THREE.TorusGeometry(0.128, 0.014, 10, 40),
    chest: new THREE.CircleGeometry(0.022, 20),
    pelvis: new RoundedBoxGeometry(0.27, 0.13, 0.18, 4, 0.055),
    shoulder: new THREE.SphereGeometry(0.058, 20, 14),
    upperArm: new THREE.CapsuleGeometry(0.041, 0.19, 6, 14),
    foreArm: new THREE.CapsuleGeometry(0.036, 0.18, 6, 14),
    joint: new THREE.SphereGeometry(0.043, 16, 12),
    hand: new RoundedBoxGeometry(0.06, 0.085, 0.035, 3, 0.016),
    thigh: new THREE.CapsuleGeometry(0.062, 0.28, 6, 16),
    shin: new THREE.CapsuleGeometry(0.052, 0.3, 6, 16),
    foot: new RoundedBoxGeometry(0.095, 0.055, 0.19, 3, 0.024),
    mug: new THREE.CylinderGeometry(0.035, 0.03, 0.09, 20),
    mugHandle: new THREE.TorusGeometry(0.022, 0.007, 8, 16, Math.PI),
    drone: new THREE.SphereGeometry(0.05, 20, 14),
    droneRing: new THREE.TorusGeometry(0.075, 0.009, 8, 32),
    headband: new THREE.TorusGeometry(0.15, 0.011, 8, 32, Math.PI),
    earcup: new THREE.CylinderGeometry(0.045, 0.045, 0.04, 20),
    mic: new THREE.CylinderGeometry(0.005, 0.005, 0.12, 8),
  };
  return G;
}

const shared = {};
function sharedMats() {
  if (shared.joint) return shared;
  shared.joint = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.45, metalness: 0.55 });
  shared.visor = new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.08, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  shared.ceramic = new THREE.MeshStandardMaterial({ color: 0xf6f4f0, roughness: 0.35 });
  shared.headset = new THREE.MeshStandardMaterial({ color: 0x1f2024, roughness: 0.5, metalness: 0.2 });
  return shared;
}

export class Humanoid {
  constructor(accent, { hosted = false } = {}) {
    const g = geos(), m = sharedMats();
    this.shell = new THREE.MeshPhysicalMaterial({ color: 0xf3f4f6, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18, emissive: 0x000000 });
    this.accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.35, emissive: accent, emissiveIntensity: 0.25 });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0x64d2ff, toneMapped: false });
    this.ledMat = new THREE.MeshBasicMaterial({ color: STATUS.idle, toneMapped: false });
    const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; o.userData.robot = this; parent.add(o); return o;
    };
    const grp = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Group(); o.position.set(x, y, z); parent.add(o); return o; };

    this.root = new THREE.Group();
    this.hips = grp(this.root, 0, 0.88, 0);
    mesh(g.pelvis, this.shell, this.hips);
    this.spine = grp(this.hips, 0, 0.05, 0);
    const torso = mesh(g.torso, this.shell, this.spine, 0, 0.26, 0); torso.scale.set(1, 1, 0.74);
    const band = mesh(g.band, this.accentMat, this.spine, 0, 0.1, 0); band.rotation.x = Math.PI / 2; band.scale.set(1, 0.74, 1);
    this.chest = mesh(g.chest, this.ledMat, this.spine, 0.055, 0.36, 0.116); this.chest.castShadow = false;
    this.neck = grp(this.spine, 0, 0.5, 0);
    mesh(g.neck, m.joint, this.neck, 0, 0.03, 0);
    this.head = grp(this.neck, 0, 0.17, 0);
    mesh(g.head, this.shell, this.head);
    mesh(g.visor, m.visor, this.head, 0, 0.005, 0.104);
    this.eyes = [-0.047, 0.047].map((x) => { const e = mesh(g.eye, this.eyeMat, this.head, x, 0.008, 0.126); e.rotation.z = Math.PI / 2; e.castShadow = false; return e; });
    for (const s of [-1, 1]) { const ear = mesh(g.ear, this.ledMat, this.head, s * 0.128, 0, 0); ear.rotation.z = Math.PI / 2; ear.castShadow = false; }

    const arm = (s) => {
      const sh = grp(this.spine, s * 0.205, 0.42, 0);
      mesh(g.shoulder, this.shell, sh);
      mesh(g.upperArm, this.shell, sh, 0, -0.13, 0);
      const el = grp(sh, 0, -0.27, 0);
      mesh(g.joint, m.joint, el);
      mesh(g.foreArm, this.shell, el, 0, -0.12, 0);
      const hand = grp(el, 0, -0.26, 0);
      mesh(g.hand, m.joint, hand, 0, -0.01, 0);
      return { sh, el, hand };
    };
    this.armL = arm(-1); this.armR = arm(1);
    const leg = (s) => {
      const hip = grp(this.hips, s * 0.085, -0.05, 0);
      mesh(g.joint, m.joint, hip);
      mesh(g.thigh, this.shell, hip, 0, -0.2, 0);
      const knee = grp(hip, 0, -0.39, 0);
      mesh(g.joint, m.joint, knee);
      mesh(g.shin, this.shell, knee, 0, -0.2, 0);
      const ankle = grp(knee, 0, -0.41, 0);
      mesh(g.foot, m.joint, ankle, 0, -0.005, 0.04);
      return { hip, knee, ankle };
    };
    this.legL = leg(-1); this.legR = leg(1);

    this.mug = new THREE.Group();
    const mugBody = mesh(g.mug, m.ceramic, this.mug, 0, 0, 0);
    const handle = mesh(g.mugHandle, m.ceramic, this.mug, 0.035, 0, 0); handle.rotation.z = -Math.PI / 2;
    this.mug.position.set(0, -0.07, 0.05); this.mug.visible = false; this.armR.hand.add(this.mug);
    void mugBody;

    if (hosted) {
      const hb = mesh(g.headband, m.headset, this.head, 0, 0.02, 0); hb.rotation.y = Math.PI / 2;
      for (const s of [-1, 1]) { const c = mesh(g.earcup, m.headset, this.head, s * 0.14, 0, 0); c.rotation.z = Math.PI / 2; }
      const mic = mesh(g.mic, m.headset, this.head, 0.12, -0.06, 0.07); mic.rotation.set(0.9, 0, 0.5);
    }

    this.drones = [];
    this.droneGroup = grp(this.root, 0, 0, 0);
    this.pose = 'stand'; this.mood = 'calm'; this.t = Math.random() * 10; this.blinkT = 2 + Math.random() * 3;
    this.seatY = 0.47; this.highlight = 0; this.speedK = 1; this.pulse = false;
  }

  setStatus(hex, pulse = false) { this.ledMat.color.setHex(hex); this.pulse = pulse; }
  setMood(m) {
    if (this.mood === m) return;
    this.mood = m;
    this.eyeMat.color.setHex(m === 'ask' || m === 'ask-amber' ? 0xffffff : m === 'sleep' ? 0x3a6f86 : m === 'calm' ? 0x8fdcff : 0x64d2ff);
  }
  setDrones(n) {
    const g = geos();
    while (this.drones.length < Math.min(n, 6)) {
      const d = new THREE.Group();
      const ball = new THREE.Mesh(g.drone, this.shell); ball.castShadow = true; d.add(ball);
      const ring = new THREE.Mesh(g.droneRing, new THREE.MeshBasicMaterial({ color: 0x0a84ff, toneMapped: false })); ring.rotation.x = Math.PI / 2; d.add(ring);
      d.userData.phase = this.drones.length * 1.7; this.droneGroup.add(d); this.drones.push(d);
    }
    while (this.drones.length > Math.min(n, 6)) this.droneGroup.remove(this.drones.pop());
  }

  update(dt) {
    this.t += dt;
    const t = this.t, P = this.pose;
    const L = this.legL, R = this.legR, aL = this.armL, aR = this.armR;
    const set = (o, x = 0, y = 0, z = 0) => o.rotation.set(x, y, z);
    this.mug.visible = P === 'lounge';
    this.mug.rotation.x = 2.2;
    let hipsY = 0.88, spineX = 0, headX = 0, headY = 0;
    if (P === 'walk') {
      const w = t * 7.5 * this.speedK, s = Math.sin(w);
      set(L.hip, s * 0.5); set(R.hip, -s * 0.5);
      set(L.knee, Math.max(0, -Math.cos(w)) * 0.7); set(R.knee, Math.max(0, Math.cos(w)) * 0.7);
      set(L.ankle); set(R.ankle);
      set(aL.sh, -s * 0.45, 0, -0.06); set(aR.sh, s * 0.45, 0, 0.06); set(aL.el, -0.35); set(aR.el, -0.35);
      hipsY = 0.88 + Math.abs(Math.cos(w)) * 0.025; spineX = 0.05;
    } else if (P === 'sit-work' || P === 'sit-idle' || P === 'lounge' || P === 'sleep') {
      hipsY = this.seatY + 0.06;
      set(L.hip, -Math.PI / 2 + 0.05, 0, -0.05); set(R.hip, -Math.PI / 2 + 0.05, 0, 0.05);
      set(L.knee, Math.PI / 2 - 0.05); set(R.knee, Math.PI / 2 - 0.05); set(L.ankle); set(R.ankle);
      if (P === 'sit-work') {
        const k = Math.sin(t * 13) * 0.05, k2 = Math.sin(t * 11 + 1) * 0.05;
        set(aL.sh, -0.75 + k, 0, 0.12); set(aR.sh, -0.75 + k2, 0, -0.12);
        set(aL.el, -0.9); set(aR.el, -0.9);
        spineX = 0.1; headX = 0.12 + Math.sin(t * 0.7) * 0.03;
      } else if (P === 'lounge') {
        set(aL.sh, -0.2, 0, -0.12); set(aL.el, -0.5);
        set(aR.sh, -0.6 + Math.sin(t * 0.6) * 0.06, 0, 0.1); set(aR.el, -1.5);
        spineX = -0.12; headX = -0.05; headY = Math.sin(t * 0.4) * 0.25;
      } else if (P === 'sleep') {
        set(aL.sh, -0.25, 0, -0.08); set(aR.sh, -0.25, 0, 0.08); set(aL.el, -0.6); set(aR.el, -0.6);
        spineX = -0.18; headX = 0.42 + Math.sin(t * 1.2) * 0.02; headY = 0.25;
      } else {
        set(aL.sh, -0.35, 0, -0.06); set(aR.sh, -0.35, 0, 0.06); set(aL.el, -0.7); set(aR.el, -0.7);
        spineX = -0.06 + Math.sin(t * 0.9) * 0.015; headY = Math.sin(t * 0.5) * 0.2;
      }
    } else if (P === 'wave') {
      set(L.hip); set(R.hip); set(L.knee); set(R.knee); set(L.ankle); set(R.ankle);
      set(aL.sh, 0, 0, -0.08); set(aL.el, -0.2);
      set(aR.sh, 0, 0, 2.55); set(aR.el, 0, 0, 0.35 + Math.sin(t * 9) * 0.35);
      headX = -0.1;
    } else {
      set(L.hip); set(R.hip); set(L.knee); set(R.knee); set(L.ankle); set(R.ankle);
      set(aL.sh, 0.05, 0, -0.07 - Math.sin(t * 1.6) * 0.01); set(aR.sh, 0.05, 0, 0.07 + Math.sin(t * 1.6) * 0.01);
      set(aL.el, -0.15); set(aR.el, -0.15);
      headY = Math.sin(t * 0.6) * 0.15; hipsY = 0.88 + Math.sin(t * 1.6) * 0.004;
    }
    this.hips.position.y = hipsY;
    this.spine.rotation.x = spineX;
    this.head.rotation.set(headX, headY, 0);

    // глаза: моргание, сон
    this.blinkT -= dt;
    let ey = this.mood === 'sleep' ? 0.18 : this.mood === 'ask' || this.mood === 'ask-amber' ? 1.25 : 1;
    if (this.blinkT < 0) { if (this.blinkT < -0.12) this.blinkT = 2.5 + Math.random() * 3.5; else ey = 0.12; }
    for (const e of this.eyes) e.scale.set(ey, 1, 1);
    const pulse = this.pulse ? 0.55 + 0.45 * Math.sin(t * 6) : 1;
    this.chest.scale.setScalar(this.pulse ? 0.9 + 0.25 * pulse : 1);
    this.shell.emissive.setRGB(0.05 * this.highlight, 0.12 * this.highlight, 0.25 * this.highlight);

    this.drones.forEach((d, i) => {
      const a = t * 1.3 + d.userData.phase;
      const top = (P.startsWith('sit') || P === 'lounge' || P === 'sleep') ? this.seatY + 1.05 : 1.85;
      d.position.set(Math.cos(a) * 0.48, top + Math.sin(t * 2 + i) * 0.06, Math.sin(a) * 0.48);
      d.rotation.y = -a;
    });
  }

  dispose() {
    this.shell.dispose(); this.accentMat.dispose(); this.eyeMat.dispose(); this.ledMat.dispose();
    for (const d of this.drones) d.children[1].material.dispose();
  }
}
