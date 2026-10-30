// Робот-сотрудник: белый глянцевый корпус, лицо-экран с глазами, кольцо цвета проекта,
// антенна-статус. Наёмные (управляемые из офиса) агенты носят гарнитуру — «на линии со столом».
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---------- общие геометрии ----------
const G = {
  leg: (() => { const g = new THREE.CapsuleGeometry(0.068, 0.3, 6, 12); g.translate(0, -0.22, 0); return g; })(),
  arm: (() => { const g = new THREE.CapsuleGeometry(0.052, 0.24, 6, 12); g.translate(0, -0.17, 0); return g; })(),
  body: new THREE.CapsuleGeometry(0.205, 0.24, 8, 24),
  ring: new THREE.TorusGeometry(0.212, 0.026, 10, 40),
  head: new RoundedBoxGeometry(0.47, 0.35, 0.37, 5, 0.11),
  face: (() => { const s = new THREE.Shape(); const w = 0.36, h = 0.22, r = 0.07; s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2); const g = new THREE.ShapeGeometry(s, 8); const uv = g.attributes.uv; const p = g.attributes.position; for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5); return g; })(),
  neck: new THREE.CylinderGeometry(0.07, 0.08, 0.06, 16),
  antenna: new THREE.CylinderGeometry(0.011, 0.011, 0.13, 8),
  ball: new THREE.SphereGeometry(0.036, 16, 12),
  ear: new THREE.CylinderGeometry(0.06, 0.06, 0.05, 20),
  band: new THREE.TorusGeometry(0.26, 0.018, 8, 32, Math.PI),
  mic: new THREE.CapsuleGeometry(0.012, 0.16, 4, 8),
  drone: new THREE.SphereGeometry(0.055, 16, 12),
  droneRing: new THREE.TorusGeometry(0.085, 0.012, 6, 24),
};

// ---------- лица (общие текстуры по настроению) ----------
const faceCache = new Map();
function faceTexture(mood) {
  if (faceCache.has(mood)) return faceCache.get(mood);
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 256, 160);
  const eye = (cx, cy, w, h, col) => { x.fillStyle = col; x.beginPath(); x.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2); x.fill(); };
  const arc = (cx, cy, col, up) => { x.strokeStyle = col; x.lineWidth = 12; x.lineCap = 'round'; x.beginPath(); if (up) x.arc(cx, cy + 10, 22, Math.PI * 1.15, Math.PI * 1.85); else x.arc(cx, cy - 12, 22, Math.PI * 0.15, Math.PI * 0.85); x.stroke(); };
  const CY = '#64d2ff';
  switch (mood) {
    case 'work': eye(88, 92, 34, 26, CY); eye(168, 92, 34, 26, CY); break;
    case 'calm': eye(88, 80, 32, 40, CY); eye(168, 80, 32, 40, CY); break;
    case 'blink': eye(88, 84, 40, 8, CY); eye(168, 84, 40, 8, CY); break;
    case 'sleep': arc(88, 84, '#3f7f96', false); arc(168, 84, '#3f7f96', false); break;
    case 'happy': arc(88, 84, CY, true); arc(168, 84, CY, true); break;
    case 'ask': eye(84, 78, 44, 52, '#ffffff'); eye(172, 78, 44, 52, '#ffffff'); eye(90, 84, 18, 22, '#ff453a'); eye(178, 84, 18, 22, '#ff453a'); break;
    case 'ask-amber': eye(84, 78, 44, 52, '#ffffff'); eye(172, 78, 44, 52, '#ffffff'); eye(90, 84, 18, 22, '#ff9f0a'); eye(178, 84, 18, 22, '#ff9f0a'); break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  faceCache.set(mood, t);
  return t;
}

const accentMats = new Map();
function accentMat(color) {
  if (!accentMats.has(color)) accentMats.set(color, new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, clearcoat: 0.6, emissive: color, emissiveIntensity: 0.15 }));
  return accentMats.get(color);
}

export const STATUS_COLORS = { busy: 0x0a84ff, waitRed: 0xff453a, waitAmber: 0xff9f0a, idle: 0x8e8e93 };

export class Robot {
  constructor(mats, accent, { hosted = false } = {}) {
    this.mats = mats;
    this.root = new THREE.Group();
    this.body = new THREE.Group();          // всё, что приседает/качается
    this.root.add(this.body);
    this.pose = 'stand';                     // sit-work | sit-idle | walk | stand | wave
    this.t = Math.random() * 10;
    this.walkPhase = 0;
    this.mood = null;
    this.blinkUntil = 0;
    this.nextBlink = 1 + Math.random() * 4;
    this.highlight = 0;
    this.drones = [];

    const white = mats.robot;
    const add = (geo, mat, parent = this.body) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

    this.hip = new THREE.Group(); this.hip.position.y = 0.5; this.body.add(this.hip);
    this.legL = add(G.leg, white, this.hip); this.legL.position.x = -0.09;
    this.legR = add(G.leg, white, this.hip); this.legR.position.x = 0.09;

    this.torso = new THREE.Group(); this.torso.position.y = 0.5; this.body.add(this.torso);
    this.chest = add(G.body, white, this.torso); this.chest.position.y = 0.32;
    this.ring = add(G.ring, accentMat(accent), this.torso); this.ring.position.y = 0.3; this.ring.rotation.x = Math.PI / 2;

    this.shL = new THREE.Group(); this.shL.position.set(-0.255, 0.5, 0); this.torso.add(this.shL);
    this.shR = new THREE.Group(); this.shR.position.set(0.255, 0.5, 0); this.torso.add(this.shR);
    this.armL = add(G.arm, white, this.shL);
    this.armR = add(G.arm, white, this.shR);

    this.headG = new THREE.Group(); this.headG.position.y = 0.72; this.torso.add(this.headG);
    add(G.neck, mats.metalDark, this.headG).position.y = -0.02;
    this.head = add(G.head, white, this.headG); this.head.position.y = 0.17;
    this.faceMat = new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 0.12, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 1.25, emissiveMap: faceTexture('calm') });
    this.face = new THREE.Mesh(G.face, this.faceMat); this.face.position.set(0, 0.17, 0.187); this.headG.add(this.face);
    const ant = add(G.antenna, mats.metal, this.headG); ant.position.y = 0.4;
    this.ballMat = new THREE.MeshStandardMaterial({ color: STATUS_COLORS.idle, emissive: STATUS_COLORS.idle, emissiveIntensity: 0.6, roughness: 0.3 });
    this.ball = add(G.ball, this.ballMat, this.headG); this.ball.position.y = 0.48;

    if (hosted) { // гарнитура: дуга + наушники в цвет проекта + микрофон
      const band = add(G.band, mats.metalDark, this.headG); band.position.y = 0.2; band.rotation.z = 0; band.scale.set(1, 1.05, 1);
      const eL = add(G.ear, accentMat(accent), this.headG); eL.rotation.z = Math.PI / 2; eL.position.set(-0.255, 0.17, 0);
      const eR = add(G.ear, accentMat(accent), this.headG); eR.rotation.z = Math.PI / 2; eR.position.set(0.255, 0.17, 0);
      const mic = add(G.mic, mats.metalDark, this.headG); mic.rotation.set(Math.PI / 2.4, 0, -0.5); mic.position.set(-0.2, 0.07, 0.1);
    }

    this.root.traverse((o) => { o.userData.robot = this; });
    this.setMood('calm');
  }

  setAccent(color) { this.ring.material = accentMat(color); }

  setMood(mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.faceMat.emissiveMap = faceTexture(mood);
    this.faceMat.needsUpdate = true;
  }

  setStatusColor(hex, blink) { this.statusColor = hex; this.statusBlink = blink; }

  setDrones(n) {
    n = Math.min(n, 6);
    while (this.drones.length < n) {
      const g = new THREE.Group();
      const s = new THREE.Mesh(G.drone, this.mats.robot); s.castShadow = true; g.add(s);
      const r = new THREE.Mesh(G.droneRing, this.ring.material); r.rotation.x = Math.PI / 2; g.add(r);
      this.root.add(g); this.drones.push(g);
    }
    while (this.drones.length > n) { const g = this.drones.pop(); this.root.remove(g); }
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    // сброс поз
    let bodyY = 0, lean = 0, legX = 0, legSwing = 0, armL = 0, armR = 0, armLz = 0.08, armRz = -0.08, headTilt = 0, headYaw = 0;

    switch (this.pose) {
      case 'sit-work': {
        bodyY = -0.02 + Math.sin(t * 2.2) * 0.004;
        legX = -Math.PI / 2;
        armL = -1.25 + Math.sin(t * 13) * 0.09; armR = -1.25 + Math.sin(t * 13 + Math.PI) * 0.09;
        armLz = 0.18; armRz = -0.18;
        headTilt = 0.12 + Math.sin(t * 1.3) * 0.03; headYaw = Math.sin(t * 0.7) * 0.1;
        break;
      }
      case 'sit-idle': {
        bodyY = -0.02; legX = -Math.PI / 2; lean = -0.14 + Math.sin(t * 1.1) * 0.015;
        armL = -0.35; armR = -0.35; headTilt = -0.06 + Math.sin(t * 0.9) * 0.04;
        break;
      }
      case 'walk': {
        this.walkPhase += dt * 9.5 * (this.speedK || 1);
        const s = Math.sin(this.walkPhase);
        legSwing = s * 0.55; armL = -s * 0.5; armR = s * 0.5;
        bodyY = Math.abs(Math.cos(this.walkPhase)) * 0.035; lean = 0.06;
        break;
      }
      case 'wave': {
        const hop = (t % 1.6) < 0.32 ? Math.sin(((t % 1.6) / 0.32) * Math.PI) * 0.06 : 0;
        bodyY = hop;
        armR = -Math.PI * 0.95; armRz = -0.35 + Math.sin(t * 9) * 0.35;
        headTilt = -0.08;
        break;
      }
      default: { // stand
        bodyY = Math.sin(t * 2) * 0.006; armL = Math.sin(t * 1.4) * 0.04; armR = -armL;
      }
    }
    this.body.position.y = bodyY + this.highlight * 0.04;
    this.torso.rotation.x = lean;
    this.legL.rotation.x = legX + legSwing; this.legR.rotation.x = legX - legSwing;
    this.shL.rotation.set(armL, 0, armLz); this.shR.rotation.set(armR, 0, armRz);
    this.headG.rotation.set(headTilt, headYaw, 0);
    const sc = 1 + this.highlight * 0.07; this.root.scale.setScalar(sc);

    // моргание
    if (this.mood !== 'sleep' && !String(this.mood).startsWith('ask')) {
      if (t > this.nextBlink) { this.blinkUntil = t + 0.12; this.nextBlink = t + 2.5 + Math.random() * 4; }
      this.faceMat.emissiveMap = faceTexture(t < this.blinkUntil ? 'blink' : this.mood);
    }
    // антенна
    if (this.statusColor != null) {
      this.ballMat.color.setHex(this.statusColor); this.ballMat.emissive.setHex(this.statusColor);
      this.ballMat.emissiveIntensity = this.statusBlink ? (Math.sin(t * 10) > 0 ? 2.2 : 0.3) : this.pose === 'sit-idle' ? 0.25 : 0.9 + Math.sin(t * 3) * 0.3;
    }
    // дроны-сабагенты
    const n = this.drones.length;
    this.drones.forEach((d, i) => {
      const a = t * 1.6 + (i / n) * Math.PI * 2;
      d.position.set(Math.cos(a) * 0.5, 1.72 + Math.sin(t * 3 + i) * 0.05 + (this.pose.startsWith('sit') ? -0.05 : 0), Math.sin(a) * 0.5);
      d.rotation.y = -a;
    });
  }

  dispose() {
    this.faceMat.dispose(); this.ballMat.dispose();
  }
}
