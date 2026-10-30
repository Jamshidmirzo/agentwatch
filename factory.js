// factory.js — пиксельный цех: каждая сессия Claude Code = робот у своего станка.
// Участки цеха = проекты. Ждущий ответа робот бежит к стойке «ВЫ» и машет.
// Снапшот приходит из index.html через Factory.update(snap); клик по роботу → window.awFocus(pid).
(() => {
  'use strict';
  const canvas = document.getElementById('factory');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const tip = document.getElementById('ftip');
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BODY = ['#ff7a59', '#ffc145', '#5ad1a0', '#4cc3ff', '#9b8cff', '#ff6fb1', '#c4e86b', '#e4e6ee'];
  const ZONE = ['#4cc3ff', '#ffc145', '#5ad1a0', '#ff6fb1', '#9b8cff', '#ff7a59', '#c4e86b'];
  const C = {
    ceil: '#0d0f14', wall: '#161920', seam: '#1d2129', pillar: '#232833', rivet: '#3a404e',
    floorA: '#22252e', floorB: '#1e2129', dash: '#4d4527',
    metal: '#3a3f4c', metalHi: '#565c6c', metalLo: '#2a2e38', screen: '#0b0f16',
    red: '#ff453a', amber: '#ffb340', blue: '#3f8cff', green: '#30d158', dim: '#6b7080',
    box: '#a77b4a', boxHi: '#c2955f', boxLo: '#8a6238',
  };
  const G = { // пиксельные глифы
    q: ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'],
    ex: ['..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
    plan: ['#.###', '.....', '#.###', '.....', '#.##.', '.....'],
    qs: ['##.', '..#', '.#.', '...', '.#.'],
    z: ['###', '..#', '.#.', '#..', '###'],
  };

  const DESK_W = 56, EXIT_W = 18, PILLAR = 3, PAD = 4;

  let S = 3, dpr = 1, wrapW = 0, cssW = 0, cssH = 0, Wl = 0, Hl = 0;
  const L = { zones: [], floorTop: 0, beltY: 0, stationY: 0, laneY: 0, zonesEnd: 0 };
  let sessions = [];
  const robots = new Map(); // pid -> robot
  const parts = [];
  let first = true, t = 0, last = 0, nWaiting = 0, doorOpen = 0;
  let hoverPid = null, extHover = null;

  // ---------- utils ----------
  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), k = f < 0 ? 0 : 255, a = Math.abs(f);
    const m = (v) => Math.round(v + (k - v) * a);
    return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`;
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let OV = null; // цвет-заливка для силуэта (обводка при наведении)
  const R = (x, y, w, h, c) => { ctx.fillStyle = OV || c; ctx.fillRect(x, y, w, h); };
  function glyph(g, x, y, c) {
    for (let j = 0; j < g.length; j++) for (let i = 0; i < g[j].length; i++) if (g[j][i] === '#') R(x + i, y + j, 1, 1, c);
  }
  const isAttnAmber = (s) => s.attention && (s.attention.kind === 'permission' || s.attention.kind === 'plan');
  function ledColor(s) {
    if (s.status === 'waiting') return isAttnAmber(s) ? C.amber : C.red;
    if (s.status === 'busy') return C.blue;
    return C.dim;
  }
  function ago(ts) {
    const s = Math.max(0, (Date.now() - (ts || Date.now())) / 1000);
    return s < 60 ? Math.floor(s) + 'с' : s < 3600 ? Math.floor(s / 60) + 'м' : Math.floor(s / 3600) + 'ч';
  }

  // ---------- layout ----------
  function groups() {
    const m = new Map();
    for (const s of sessions) { if (!m.has(s.project)) m.set(s.project, []); m.get(s.project).push(s); }
    for (const a of m.values()) a.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0) || x.pid - y.pid);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  // Масштаб подбирается под число агентов (3× → 2.5× → 2×), высота сцены — под масштаб,
  // чтобы стена не раздувалась. Если и при 2× не влезает (телефон) — канвас шире, скролл внутри .scene.
  const HL = 104, MIN_SLOT = 24;
  function layout() {
    if (!wrapW) return;
    const gs = groups();
    const n = sessions.length, z = gs.length;
    const fixed = DESK_W + EXIT_W + z * (PAD * 2 + PILLAR) + PILLAR;
    const cands = dpr >= 2 ? [3, 2.5, 2] : [3, 2];
    S = cands.find((k) => wrapW / k - fixed >= n * MIN_SLOT) || 2;
    cssW = Math.max(wrapW, Math.ceil((fixed + n * MIN_SLOT) * S));
    cssH = Math.round(HL * S);
    if (wrap.style.height !== cssH + 'px') wrap.style.height = cssH + 'px';
    canvas.style.width = cssW > wrapW ? cssW + 'px' : '100%';
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    Wl = Math.floor(cssW / S); Hl = Math.floor(cssH / S);
    L.floorTop = Hl - 44; L.beltY = L.floorTop - 7; L.stationY = Hl - 20; L.laneY = Hl - 5;
    const avail = Wl - fixed;
    const slot = n ? Math.max(16, Math.min(42, Math.floor(avail / n))) : 32;
    const used = n * slot + z * (PAD * 2 + PILLAR);
    let x = DESK_W + Math.max(0, Math.floor((Wl - EXIT_W - DESK_W - used) / 2));
    L.zones = [];
    for (const [proj, arr] of gs) {
      const x0 = x; x += PILLAR + PAD;
      for (const s of arr) {
        const cw = Math.min(slot, 32), off = x + Math.floor((slot - cw) / 2);
        const r = robots.get(s.pid);
        if (r) { r.machineX = off + 1; r.homeX = off + cw - 9; r.slotX = x; r.slotW = slot; }
        x += slot;
      }
      x += PAD;
      L.zones.push({ proj, x0, x1: x, n: arr.length, color: ZONE[hash(proj) % ZONE.length] });
    }
    L.zonesEnd = x;
  }

  function resize() {
    const w = Math.round(wrap.clientWidth), d = window.devicePixelRatio || 1;
    if (w === wrapW && d === dpr && Wl) return; // наша же смена высоты — игнор
    wrapW = w; dpr = d;
    layout();
    for (const rb of robots.values()) { // без прогулок через весь цех после ресайза
      const [tx, ty] = target(rb);
      rb.x = tx; rb.y = ty; rb.path = []; rb.tx = tx; rb.ty = ty;
    }
  }

  // ---------- robots: state ----------
  const doorX = () => Wl - Math.round(EXIT_W / 2);
  const queueX = (i) => DESK_W + 3 + i * 13;

  function target(r) {
    if (r.leaving) return [doorX(), L.floorTop + 2];
    if (r.s.status === 'waiting') return [queueX(r.qi || 0), L.laneY];
    if (r.stroll) return r.stroll;
    return [r.homeX, L.stationY];
  }
  function route(r, tx, ty) {
    if (Math.abs(tx - r.x) < 3) return [[tx, ty]];
    const pts = [];
    if (Math.abs(r.y - L.laneY) > 0.5) pts.push([r.x, L.laneY]); // по цеху ходим только по передней дорожке
    pts.push([tx, L.laneY]);
    if (Math.abs(ty - L.laneY) > 0.5) pts.push([tx, ty]);
    return pts;
  }
  const atHome = (r) => Math.abs(r.x - r.homeX) < 0.5 && Math.abs(r.y - L.stationY) < 0.5;

  function update(snap) {
    if (!wrapW) resize();
    sessions = (snap && snap.sessions) || [];
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.pid);
      let r = robots.get(s.pid);
      if (!r) {
        const h = hash(s.sessionId || s.pid), base = BODY[h % BODY.length];
        r = {
          pid: s.pid, s, c: { base, light: shade(base, 0.3), dark: shade(base, -0.38) },
          x: 0, y: 0, path: [], tx: null, ty: null, facing: -1, walkT: 0, walking: false,
          phase: (h % 997) / 97, nextStroll: t + rnd(4, 16), stroll: null, carry: false,
          alpha: 1, leaving: false, gone: false, flash: 0, lastHit: 0, nextZ: t + rnd(0, 3),
          fresh: !first, placed: false,
        };
        robots.set(s.pid, r);
      }
      if (s.status === 'waiting' && r.s.status !== 'waiting') { r.stroll = null; r.carry = false; }
      r.s = s;
      if (r.leaving) { r.leaving = false; r.gone = false; r.alpha = 1; }
    }
    for (const r of robots.values()) if (!seen.has(r.pid) && !r.leaving) { r.leaving = true; r.stroll = null; r.carry = false; }
    layout();
    for (const r of robots.values()) {
      if (r.placed || r.homeX == null) continue;
      r.placed = true;
      if (r.fresh && !reduce) { r.x = doorX(); r.y = L.floorTop + 2; } // новенький выходит из двери
      else { const [tx, ty] = target(r); r.x = tx; r.y = ty; }
    }
    const w = [...robots.values()].filter((r) => !r.leaving && r.s.status === 'waiting')
      .sort((a, b) => (a.s.statusUpdatedAt || 0) - (b.s.statusUpdatedAt || 0));
    w.forEach((r, i) => { r.qi = i; });
    nWaiting = w.length;
    first = false;
    if (hoverPid != null) showTip(hoverPid);
  }

  function spawn(p) { if (!reduce && parts.length < 500) parts.push(p); }

  function step(r, dt) {
    const [tx, ty] = target(r);
    if (r.tx !== tx || r.ty !== ty) { r.tx = tx; r.ty = ty; r.path = route(r, tx, ty); }
    if (reduce && r.path.length) { r.x = tx; r.y = ty; r.path = []; }
    const urgent = r.s.status === 'waiting' && !r.leaving;
    const spd = urgent ? 64 : 40;
    r.walking = r.path.length > 0;
    if (r.walking) {
      const [px, py] = r.path[0];
      const dx = px - r.x, dy = py - r.y, d = Math.hypot(dx, dy), st = spd * dt;
      if (Math.abs(dx) > 0.2) r.facing = dx < 0 ? -1 : 1;
      if (d <= st) { r.x = px; r.y = py; r.path.shift(); } else { r.x += (dx / d) * st; r.y += (dy / d) * st; }
      r.walkT += dt * (urgent ? 1.8 : 1);
      if (!r.path.length) arrived(r);
    } else if (!r.stroll) r.facing = -1;
    if (r.flash > 0) r.flash -= dt;
    if (r.gone) { r.alpha -= dt * 2.5; return; }

    const tt = t + r.phase;
    const s = r.s;
    if (!r.walking && !r.leaving && s.status === 'busy' && r.homeX != null && atHome(r)) {
      if (!r.stroll && !r.carry && t > r.nextStroll && !reduce) {
        r.stroll = [Math.max(DESK_W + 4, Math.min(Wl - EXIT_W - 4, r.homeX + rnd(-16, 16))), L.laneY];
        r.nextStroll = t + rnd(12, 26);
      }
      const hit = Math.floor(tt * 5);
      if (hit !== r.lastHit) { // удар молотком → искры
        r.lastHit = hit;
        if (hit % 2 === 0) for (let k = 0; k < 3; k++) spawn({
          x: r.machineX + 11, y: L.stationY - 11, vx: rnd(6, 30), vy: rnd(-34, -10), g: 90,
          life: rnd(0.25, 0.5), max: 0.5, color: ['#ffe27a', '#ffb340', '#ffffff'][k % 3],
        });
      }
    }
    if (!r.walking && !r.leaving && s.status === 'idle' && atHome(r) && t > r.nextZ) {
      r.nextZ = t + rnd(1.8, 3.2);
      spawn({ kind: 'z', x: r.x + 3, y: L.stationY - 26, vx: rnd(2, 5), vy: -5, life: 2.2, max: 2.2, color: '#8a90a0' });
    }
  }

  function arrived(r) {
    if (r.leaving) { r.gone = true; return; }
    if (r.stroll && Math.abs(r.x - r.stroll[0]) < 0.5 && Math.abs(r.y - r.stroll[1]) < 0.5) { r.stroll = null; r.carry = true; return; }
    if (r.carry && atHome(r)) {
      r.carry = false;
      for (let k = 0; k < 5; k++) spawn({ x: r.machineX + 6, y: L.stationY - 19, vx: rnd(-12, 12), vy: rnd(-22, -8), g: 40, life: 0.6, max: 0.6, color: '#7dffb0' });
    }
  }

  function stepParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.vy += (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }

  // ---------- drawing: scene ----------
  function sky() {
    const h = new Date().getHours();
    if (h < 6 || h >= 20) return { top: '#0b1230', bot: '#18224a', night: true };
    if (h < 8 || h >= 18) return { top: '#2f2a5a', bot: '#d07a52', night: false };
    return { top: '#3f7fc4', bot: '#8cc3ea', night: false };
  }

  function drawWindow(x, y, w, h, sk) {
    R(x - 1, y - 1, w + 2, h + 2, '#2a2f3b');
    const hb = Math.ceil(h / 2);
    R(x, y, w, hb, sk.top); R(x, y + hb, w, h - hb, sk.bot);
    if (sk.night) for (let k = 0; k < 4; k++) {
      const sx = x + ((hash(x * 7 + k) >> 3) % w), sy = y + ((hash(x * 13 + k) >> 5) % Math.max(1, hb));
      if (Math.sin(t * 2 + k + x) > -0.4) R(sx, sy, 1, 1, '#e8eeff');
    } else {
      const cx = x + Math.floor(((t * 2 + hash(x) % 40) % (w + 8)) - 6);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      R(cx, y + 2, 6, 2, 'rgba(255,255,255,.75)'); R(cx + 1, y + 1, 3, 1, 'rgba(255,255,255,.75)');
      ctx.restore();
    }
    for (let k = 0; k < w; k += 3) { // силуэт города
      const bh = 2 + (hash(x + k) % Math.max(2, Math.floor(h / 2)));
      R(x + k, y + h - bh, 2, bh, '#0c0f1c');
      if (sk.night && hash(x * k + 3) % 3 === 0) R(x + k, y + h - bh + 1, 1, 1, '#ffd36b');
    }
    R(x + (w >> 1), y, 1, h, '#2a2f3b');
  }

  function drawBg() {
    const sk = sky();
    R(0, 0, Wl, L.floorTop, C.wall);
    for (let x = 12; x < Wl; x += 24) R(x, 9, 1, L.floorTop - 9, C.seam);
    R(0, L.beltY - 5, Wl, 1, C.seam);
    // окна по участкам
    const wy = 26, wh = L.beltY - 9 - wy;
    if (wh >= 8) for (const z of L.zones) {
      for (let wx = z.x0 + PILLAR + 4; wx + 16 <= z.x1 - 3; wx += 24) drawWindow(wx, wy, 16, wh, sk);
    }
    // потолок и трубы
    R(0, 0, Wl, 6, C.ceil);
    R(0, 6, Wl, 2, '#2b303c'); R(0, 6, Wl, 1, '#3a404e');
    for (let x = 20; x < Wl; x += 48) R(x, 5, 2, 4, '#4a5262');
    if (!reduce && Math.random() < 0.02) {
      const jx = 20 + 48 * Math.floor(Math.random() * Math.max(1, Wl / 48));
      spawn({ x: jx + 1, y: 9, vx: rnd(-3, 3), vy: rnd(2, 5), size: 2, life: 1.4, max: 1.4, color: 'rgba(190,200,220,.45)' });
    }
    // пол
    R(0, L.floorTop, Wl, Hl - L.floorTop, C.floorA);
    for (let y = L.floorTop, j = 0; y < Hl; y += 8, j++) for (let x = 0, i = 0; x < Wl; x += 8, i++) if ((i + j) & 1) R(x, y, 8, 8, C.floorB);
    R(0, L.floorTop, Wl, 1, '#2e323d');
    for (let x = DESK_W; x < Wl - EXIT_W; x += 8) R(x, L.laneY - 16, 4, 1, C.dash);
    // участки: колонны, подсветка пола, таблички
    for (const z of L.zones) {
      drawPillar(z.x0);
      ctx.globalAlpha = 0.45; R(z.x0 + PILLAR, L.stationY + 1, z.x1 - z.x0 - PILLAR, 1, z.color); ctx.globalAlpha = 1;
      const px = z.x0 + PILLAR + 2, pw = z.x1 - z.x0 - PILLAR - 4;
      R(px + 3, 8, 1, 5, '#3a404e'); R(px + pw - 4, 8, 1, 5, '#3a404e');
      R(px, 13, pw, 9, '#0e1117'); R(px, 13, pw, 1, z.color);
    }
    if (L.zones.length) drawPillar(L.zonesEnd);
    drawBelt();
    drawLamps();
  }

  function drawPillar(x) {
    R(x, 8, PILLAR, L.floorTop - 8, C.pillar);
    R(x, 8, 1, L.floorTop - 8, '#2b3140');
    for (let y = 14; y < L.floorTop - 4; y += 10) R(x + 1, y, 1, 1, C.rivet);
  }

  function drawBelt() {
    const x0 = DESK_W, x1 = Wl - EXIT_W, by = L.beltY;
    R(x0, by, x1 - x0, 7, '#252830'); R(x0, by, x1 - x0, 2, '#3a3e4a');
    const off = Math.floor((t * 10) % 6);
    for (let x = x0 + off; x < x1; x += 6) { R(x, by, 2, 1, '#50566a'); R(x, by + 4, 2, 2, '#16181e'); }
    for (let x = x0 + 4; x < x1; x += 30) R(x, by + 2, 1, 5, '#30343f');
    const len = x1 - x0 - 6;
    for (let k = 0; k < Math.floor(len / 40); k++) {
      const bx = x0 + Math.floor((t * 10 + k * 40) % len);
      R(bx, by - 4, 5, 4, C.box); R(bx, by - 4, 5, 1, C.boxHi); R(bx + 2, by - 4, 1, 4, C.boxLo);
    }
  }

  function drawLamps() {
    for (let x = 34, k = 0; x < Wl; x += 58, k++) {
      R(x, 8, 1, 4, '#3b404c'); R(x - 3, 12, 7, 2, '#555b6a');
      const flicker = k === 2 && Math.sin(t * 13) > 0.92 ? 0 : 1; // одна лампа вечно моргает
      R(x - 1, 14, 3, 1, flicker ? '#ffe7a8' : '#6b6450');
      if (!flicker) continue;
      const g = ctx.createLinearGradient(0, 14, 0, L.floorTop + 26);
      g.addColorStop(0, 'rgba(255,224,160,.10)'); g.addColorStop(1, 'rgba(255,224,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x - 2, 14); ctx.lineTo(x + 3, 14); ctx.lineTo(x + 26, L.floorTop + 26); ctx.lineTo(x - 25, L.floorTop + 26); ctx.fill();
    }
  }

  function drawDesk() {
    const bx = 4, bw = DESK_W - 10;
    // табло
    R(bx - 1, 13, bw + 2, 16, '#2e3340'); R(bx, 14, bw, 14, '#07080b');
    // маячок
    const cx = bx + (bw >> 1);
    R(cx - 2, 9, 5, 4, nWaiting ? C.red : '#3a3f4c'); R(cx - 1, 9, 3, 1, nWaiting ? '#ff9a92' : '#4a505e');
    if (nWaiting && !reduce) {
      const a = t * 5, reach = Math.cos(a) * 70;
      ctx.fillStyle = `rgba(255,69,58,${0.22 * Math.abs(Math.cos(a))})`;
      ctx.beginPath(); ctx.moveTo(cx, 11); ctx.lineTo(cx + reach, 2); ctx.lineTo(cx + reach, 22); ctx.fill();
    }
    // стойка «ВЫ»
    const ly = L.laneY;
    const you = DESK_W - 20;
    R(you - 4, ly - 20, 9, 8, '#3f8cff'); R(you - 4, ly - 20, 9, 1, '#6aa7ff');
    const bob = nWaiting && Math.floor(t * 3) % 2 ? -1 : 0;
    R(you - 2, ly - 26 + bob, 5, 5, '#f1c27d'); R(you - 2, ly - 27 + bob, 5, 2, '#2a1b10');
    R(you + 1, ly - 24 + bob, 1, 1, '#2a1b10');
    R(2, ly - 13, DESK_W - 9, 2, '#7a5f43'); R(3, ly - 11, DESK_W - 11, 11, '#5a4632');
    for (let x = 6; x < DESK_W - 10; x += 8) R(x, ly - 9, 1, 8, '#4a3a29');
    // монитор
    R(7, ly - 22, 12, 9, '#1d222c');
    const scr = nWaiting ? (Math.floor(t * 3) % 2 ? C.red : '#5a1a16') : '#1f6f4a';
    R(8, ly - 21, 10, 6, scr); R(12, ly - 13, 2, 1, '#1d222c');
    if (nWaiting) R(9, ly - 20, 1 + (Math.floor(t * 6) % 7), 1, '#ffd0cc');
  }

  function drawDoor() {
    const x0 = Wl - EXIT_W + 3, w = EXIT_W - 6, y1 = L.floorTop, h = 24;
    R(x0 - 2, y1 - h - 2, w + 4, h + 2, '#2c313d');
    R(x0, y1 - h, w, h, '#050608');
    const pw = Math.round((w / 2) * (1 - doorOpen));
    R(x0, y1 - h, pw, h, '#3d4352'); R(x0 + w - pw, y1 - h, pw, h, '#3d4352');
    if (pw > 1) { R(x0 + pw - 1, y1 - h, 1, h, '#2a2e38'); R(x0 + w - pw, y1 - h, 1, h, '#2a2e38'); }
    R(x0 + 1, y1 - h - 6, w - 2, 3, '#0f3d22'); R(x0 + 2, y1 - h - 5, w - 4, 1, '#30d158');
  }

  function drawMachine(r) {
    const mx = r.machineX, y = L.stationY, s = r.s, tt = t + r.phase;
    const waiting = s.status === 'waiting', busy = s.status === 'busy';
    R(mx, y - 18, 12, 18, C.metal); R(mx, y - 18, 12, 1, C.metalHi); R(mx + 11, y - 18, 1, 18, C.metalLo); R(mx, y - 1, 12, 1, '#1c1f27');
    R(mx + 2, y - 16, 8, 6, C.screen);
    if (waiting) {
      if ((tt * 3) % 1 < 0.6) glyph(G.qs, mx + 4, y - 15, isAttnAmber(s) ? C.amber : C.red);
    } else if (busy) {
      for (let k = 0; k < 3; k++) R(mx + 3, y - 15 + k * 2, 1 + ((Math.floor(tt * 4) + k * 7 + r.pid) * 37) % 6, 1, '#30d158');
    } else if ((tt % 1.2) < 0.6) R(mx + 3, y - 12, 2, 1, '#2a8a52');
    R(mx + 2, y - 8, 2, 2, waiting ? C.red : '#4a2a2a');
    R(mx + 5, y - 8, 2, 2, busy ? '#ffc145' : '#4a4128');
    R(mx + 8, y - 8, 2, 2, busy ? C.green : '#24402e');
    R(mx + 2, y - 5, 8, 1, C.metalLo); R(mx + 2, y - 3, 8, 1, C.metalLo);
    const lampOn = waiting ? (tt * 4) % 1 < 0.5 : busy;
    R(mx + 5, y - 20, 2, 2, lampOn ? ledColor(s) : '#3a3f4c');
    if (busy && !reduce) { const p = Math.floor(tt * 5) % 2; R(mx + 1, y - 21 - p, 2, 3 + p, C.metalHi); }
  }

  // ---------- drawing: robot ----------
  function drawDrones(r, base, front) {
    const subs = r.s.subagents || [];
    const n = Math.min(subs.length, 8);
    const tt = t + r.phase;
    for (let i = 0; i < n; i++) {
      const a = tt * 1.7 + (i * Math.PI * 2) / n;
      if ((Math.sin(a) >= 0) !== front) continue;
      const x = Math.round(r.x + Math.cos(a) * 12), y = Math.round(base - 24 + Math.sin(a) * 3 + Math.sin(tt * 3 + i));
      R(x - 2, y, 5, 2, r.c.light); R(x - 1, y + 2, 3, 1, r.c.dark); R(x, y + 1, 1, 1, '#7ff7ff');
      const rw = Math.floor(tt * 24 + i) % 2 ? 7 : 3;
      R(x - (rw >> 1), y - 1, rw, 1, '#c8ccd6');
    }
  }

  function drawRobot(r) {
    const s = r.s, ix = Math.round(r.x), iy = Math.round(r.y), tt = t + r.phase, c = r.c;
    const home = r.homeX != null && atHome(r);
    const waiting = s.status === 'waiting' && !r.leaving;
    const sitting = s.status === 'idle' && home && !r.walking;
    const working = s.status === 'busy' && home && !r.walking;
    const atDesk = waiting && !r.walking;
    const step = r.walking ? Math.floor(r.walkT * 8) % 2 : 0;
    let base = iy;
    if (sitting) base = iy - 3;
    if (r.walking && step) base -= 1;
    if (atDesk && !reduce) { const j = tt % 1.4; if (j < 0.3) base -= Math.round(Math.sin((j / 0.3) * Math.PI) * 3); }
    const f = r.facing;

    if (!OV) {
      ctx.fillStyle = waiting ? 'rgba(255,69,58,.22)' : 'rgba(0,0,0,.35)';
      ctx.fillRect(ix - 7, iy - 1, 14, 2);
    }
    if (sitting) { R(ix - 5, iy - 4, 10, 4, C.box); R(ix - 5, iy - 4, 10, 1, C.boxHi); R(ix - 1, iy - 4, 1, 4, C.boxLo); }
    drawDrones(r, base, false);
    // ноги
    if (!sitting) {
      R(ix - 4, base - 4, 3, step === 1 ? 3 : 4, c.dark); R(ix + 1, base - 4, 3, step === 0 && r.walking ? 3 : 4, c.dark);
      R(ix - 4 + (f > 0 ? 1 : -1), base - 1, 3, 1, '#20232b'); R(ix + 1 + (f > 0 ? 1 : -1), base - 1, 3, 1, '#20232b');
    }
    // корпус
    R(ix - 6, base - 11, 12, 7, c.base); R(ix - 6, base - 11, 12, 1, c.light); R(ix - 6, base - 5, 12, 1, c.dark);
    R(ix - 3, base - 9, 6, 3, '#151922');
    const led = ledColor(s);
    const ledOn = waiting ? (tt * 6) % 1 < 0.6 : s.status === 'busy' ? (tt * 1.5) % 1 < 0.7 : (tt * 0.5) % 1 < 0.5;
    R(ix - 2, base - 8, 1, 1, ledOn ? led : '#2a2e38'); R(ix, base - 8, 2, 1, s.status === 'busy' ? '#30d158' : '#2a2e38');
    R(ix - 2, base - 12, 4, 1, '#2b2f3a');
    // голова
    R(ix - 5, base - 19, 10, 7, c.light); R(ix - 5, base - 13, 10, 1, c.base);
    R(ix - 6, base - 17, 1, 3, '#8a90a0'); R(ix + 5, base - 17, 1, 3, '#8a90a0');
    R(ix - 4, base - 18, 8, 4, C.screen);
    const ef = f < 0 ? 0 : 1;
    const blink = (tt % 3.7) < 0.12;
    if (sitting) { R(ix - 3 + ef, base - 16, 2, 1, '#3d6a78'); R(ix + ef, base - 16, 2, 1, '#3d6a78'); }
    else if (waiting && !blink) { const e = isAttnAmber(s) ? '#ffe2a8' : '#ffffff'; R(ix - 3 + ef, base - 17, 2, 2, e); R(ix + ef, base - 17, 2, 2, e); }
    else { const e = blink ? '#2a4a55' : '#7ff7ff'; R(ix - 3 + ef - (working ? 1 : 0), base - 16, 2, 1, e); R(ix + ef - (working ? 1 : 0), base - 16, 2, 1, e); }
    // антенна
    R(ix, base - 22, 1, 3, '#8a90a0'); R(ix - 1, base - 24, 3, 2, ledOn ? led : '#3a3f4c');
    // руки
    if (r.carry) {
      const bx = f < 0 ? ix - 11 : ix + 5;
      R(ix - 8, base - 10, 2, 3, c.base); R(ix + 6, base - 10, 2, 3, c.base);
      R(bx, base - 13, 6, 5, C.box); R(bx, base - 13, 6, 1, C.boxHi); R(bx + 2, base - 13, 1, 5, C.boxLo);
    } else if (working && !reduce) {
      const up = Math.floor(tt * 5) % 2;
      if (up) { R(ix - 9, base - 16, 2, 6, c.base); R(ix - 9, base - 17, 2, 1, '#8a90a0'); }
      else { R(ix - 11, base - 10, 5, 2, c.base); R(ix - 12, base - 10, 1, 2, '#8a90a0'); }
      R(ix + 6, base - 11, 2, 6, c.base);
    } else if (atDesk && !reduce) {
      const w = Math.floor(tt * 5) % 2;
      R(ix - 8 - w, base - 18, 2, 7, c.base); R(ix - 8 - w, base - 19, 2, 1, '#8a90a0');
      R(ix + 6, base - 11, 2, 6, c.base);
    } else {
      const sw = r.walking ? (step ? 1 : -1) : 0;
      R(ix - 8, base - 11 + sw, 2, 6, c.base); R(ix + 6, base - 11 - sw, 2, 6, c.base);
      R(ix - 8, base - 5 + sw, 2, 1, '#8a90a0'); R(ix + 6, base - 5 - sw, 2, 1, '#8a90a0');
    }
    drawDrones(r, base, true);
    // пузырь с вопросом
    if (waiting) {
      const by = base - 38 + (reduce ? 0 : Math.round(Math.sin(tt * 4)));
      const kind = s.attention && s.attention.kind;
      const col = isAttnAmber(s) ? C.amber : C.red;
      R(ix - 5, by, 11, 10, '#0b0c0f'); R(ix - 4, by + 1, 9, 8, '#ffffff');
      R(ix - 1, by + 9, 3, 1, '#ffffff'); R(ix, by + 10, 1, 1, '#ffffff');
      glyph(kind === 'permission' ? G.ex : kind === 'plan' ? G.plan : G.q, ix - 2, by + 2, col);
    }
  }

  function drawRobotFull(r) {
    if (r.homeX == null) return;
    ctx.globalAlpha = Math.max(0, r.alpha);
    const hl = r.pid === hoverPid || r.pid === extHover || r.flash > 0;
    if (hl) {
      OV = r.flash > 0 && Math.floor(r.flash * 10) % 2 ? '#ffd36b' : '#ffffff';
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.save(); ctx.translate(dx, dy); drawRobot(r); ctx.restore(); }
      OV = null;
    }
    drawRobot(r);
    ctx.globalAlpha = 1;
  }

  function drawParts() {
    for (const p of parts) {
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.6);
      if (p.kind === 'z') glyph(G.z, Math.round(p.x), Math.round(p.y), p.color);
      else R(Math.round(p.x), Math.round(p.y), p.size || 1, p.size || 1, p.color);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- text (в CSS-пикселях, чётко) ----------
  const fitCache = new Map();
  function fit(str, maxW, font) {
    const key = font + '|' + maxW + '|' + str;
    let v = fitCache.get(key);
    if (v !== undefined) return v;
    v = str;
    if (ctx.measureText(v).width > maxW) {
      while (v.length > 1 && ctx.measureText(v + '…').width > maxW) v = v.slice(0, -1);
      v += '…';
    }
    if (fitCache.size > 2000) fitCache.clear();
    fitCache.set(key, v);
    return v;
  }
  function txt(str, lx, ly, color, size = 10, weight = 600, maxW = 0, align = 'center') {
    const font = `${weight} ${size}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillStyle = color;
    ctx.fillText(maxW ? fit(String(str), maxW, font) : String(str), Math.round(lx * S), Math.round(ly * S));
  }

  function textStation() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const r of robots.values()) {
      if (r.leaving || r.homeX == null) continue;
      const s = r.s;
      const col = s.status === 'waiting' ? (isAttnAmber(s) ? '#ffcf85' : '#ff8a80') : s.status === 'busy' ? '#c3cde6' : '#6b7080';
      txt(s.title || s.name || '', r.slotX + r.slotW / 2, L.stationY + 2.5, col, 10, 500, r.slotW * S - 6);
    }
  }

  function textOverlay() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const z of L.zones) {
      const w = (z.x1 - z.x0 - PILLAR - 6) * S;
      txt(z.proj.toUpperCase(), z.x0 + PILLAR + 2 + (z.x1 - z.x0 - PILLAR - 4) / 2, 14.6, z.color, 10, 700, w);
    }
    const bx = 4, bw = DESK_W - 10;
    txt(nWaiting ? `ЖДУТ: ${nWaiting}` : 'ВСЁ ОК', bx + bw / 2, 16.5, nWaiting ? '#ff6b61' : '#5be08a', 13, 800, bw * S - 6);
    txt('ВЫ', (DESK_W - 9) / 2 + 2, L.laneY - 8.5, '#e8d2b4', 10, 800);
    for (const r of robots.values()) { // таймер ожидания под роботом в очереди
      if (r.leaving || r.s.status !== 'waiting' || r.walking) continue;
      txt(ago(r.s.statusUpdatedAt), r.x, L.laneY + 0.6, isAttnAmber(r.s) ? '#ffcf85' : '#ff8a80', 9, 700);
    }
  }

  // ---------- loop ----------
  function render() {
    const k = S * dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, Wl + 1, Hl + 1);
    drawBg(); drawDoor(); drawDesk();
    for (const r of robots.values()) if (!r.leaving && r.machineX != null) drawMachine(r);
    textStation();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const list = [...robots.values()].sort((a, b) => a.y - b.y);
    for (const r of list) drawRobotFull(r);
    drawParts();
    if (nWaiting && !reduce) { ctx.fillStyle = `rgba(255,40,30,${0.025 + 0.02 * Math.sin(t * 4)})`; ctx.fillRect(0, 0, Wl, Hl); }
    textOverlay();
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now; t += dt;
    if (Wl) {
      for (const r of robots.values()) step(r, dt);
      for (const [pid, r] of robots) if (r.gone && r.alpha <= 0) robots.delete(pid);
      stepParts(dt);
      const near = [...robots.values()].some((r) => (r.leaving || r.fresh) && Math.abs(r.x - doorX()) < 14 && r.y < L.floorTop + 14);
      doorOpen += ((near ? 1 : 0) - doorOpen) * Math.min(1, dt * 8);
      render();
    }
    requestAnimationFrame(frame);
  }

  // ---------- interaction ----------
  function hit(lx, ly) {
    let best = null, by = -Infinity;
    for (const r of robots.values()) {
      if (r.leaving || r.homeX == null) continue;
      const top = r.s.status === 'waiting' ? 40 : 26;
      const inRobot = lx >= r.x - 8 && lx <= r.x + 8 && ly >= r.y - top && ly <= r.y + 2;
      const inSlot = lx >= r.slotX && lx <= r.slotX + r.slotW && ly >= L.stationY - 22 && ly <= L.stationY + 7;
      if ((inRobot || inSlot) && r.y > by) { best = r.pid; by = inRobot ? r.y + 1000 : r.y; }
    }
    return best;
  }

  function tipHTML(s) {
    const env = s.entrypoint === 'claude-vscode' ? 'VS Code' : s.entrypoint === 'cli' ? 'Terminal' : s.entrypoint;
    const tr = s.transcript || {};
    let st = '';
    if (s.status === 'waiting') {
      const label = { question: 'Вопрос', permission: 'Разрешение', plan: 'Одобрить план', input: 'Ждёт ответа' }[s.attention && s.attention.kind] || 'Ждёт';
      st = `<div class="st w${isAttnAmber(s) ? ' a' : ''}">● ${label} · ${ago(s.statusUpdatedAt)}</div>`;
      const q = tr.question ? tr.question.map((x) => x.question).join(' · ') : (s.attention && s.attention.kind === 'input' ? tr.lastAssistantText : s.attention && s.attention.text);
      if (q) st += `<div class="q">${esc(String(q).slice(0, 260))}</div>`;
    } else if (s.status === 'busy') {
      st = `<div class="st b">● Работает</div>`;
      if (tr.pendingTool) st += `<div class="q"><code>${esc(tr.pendingTool.name)}</code> ${esc(tr.pendingTool.summary)}</div>`;
    } else st = `<div class="st">○ Свободен</div>`;
    const subs = s.subagents || [];
    const sb = subs.length ? `<div class="subs">🛸 ${subs.length} сабагент${subs.length === 1 ? '' : subs.length < 5 ? 'а' : 'ов'}: ${subs.slice(0, 4).map((x) => esc(x.description || x.type)).join(', ')}${subs.length > 4 ? '…' : ''}</div>` : '';
    return `<b>${esc(s.title || s.name)}</b><div class="m">${esc(s.project)} · ${esc(env)}</div>${st}${sb}<div class="hint">клик — перейти</div>`;
  }

  function showTip(pid) {
    const r = robots.get(pid);
    if (!r || !tip) { if (tip) tip.classList.remove('show'); return; }
    tip.innerHTML = tipHTML(r.s);
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.x * S + 34, top = (r.y - 30) * S - th / 2;
    if (left + tw > cssW - 8) left = r.x * S - 34 - tw;
    left = Math.max(8, left); top = Math.max(8, Math.min(cssH - th - 8, top));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    tip.classList.add('show');
  }

  function setHover(pid) {
    if (pid === hoverPid) return;
    hoverPid = pid;
    canvas.style.cursor = pid != null ? 'pointer' : '';
    document.querySelectorAll('.card.hl').forEach((c) => c.classList.remove('hl'));
    if (pid != null) {
      const card = document.querySelector(`.card[data-pid="${pid}"]`);
      if (card) card.classList.add('hl');
      showTip(pid);
    } else if (tip) tip.classList.remove('show');
  }

  canvas.addEventListener('pointermove', (e) => setHover(hit(e.offsetX / S, e.offsetY / S)));
  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener('click', (e) => {
    const pid = hit(e.offsetX / S, e.offsetY / S);
    if (pid == null) return;
    ping(pid);
    if (window.awFocus) window.awFocus(pid);
  });

  function ping(pid) { const r = robots.get(pid); if (r) r.flash = 1; }

  new ResizeObserver(resize).observe(wrap);
  resize();
  requestAnimationFrame(frame);
  window.Factory = { update, ping, highlight(pid) { extHover = pid; }, _debug: () => ({ S, Wl, Hl, L: { ...L, zones: L.zones.length }, robots: [...robots.values()].map((r) => ({ pid: r.pid, st: r.s.status, x: Math.round(r.x), y: Math.round(r.y), homeX: r.homeX, path: r.path.length, tx: r.tx, ty: r.ty, stroll: r.stroll, carry: r.carry, qi: r.qi })) }) };
})();
