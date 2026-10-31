#!/usr/bin/env node
// Ретранслятор AgentWatch. Офисы двух компьютеров подключаются сюда исходящим WebSocket и попадают
// в одну «комнату» (id комнаты — хэш их общего секрета). Сервер только пересылает бинарные кадры между
// участниками комнаты: содержимое зашифровано сквозным ключом (lib/crypto-link.js), здесь его не прочитать
// и не подделать. Лимиты — от злоупотреблений.
//   PORT (8080), HOST (127.0.0.1 — наружу смотрит Caddy с TLS), RELAY_KEY — ключ доступа к ретранслятору.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.RELAY_KEY || '';
const L = {
  maxPayload: 4 << 20, rooms: Number(process.env.MAX_ROOMS || 64), perIp: 8,
  framesPerSec: 30, bytesPerSec: 4 << 20, joinMs: 5000, pingMs: Number(process.env.PING_MS || 30000), maxBuffered: 8 << 20,
};
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const other = (role) => (role === 'hub' ? 'node' : 'hub');

const rooms = new Map(); // room -> { hub?: ws, node?: ws }
const perIp = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/aw', maxPayload: L.maxPayload });

function leave(ws) {
  const j = ws.aw;
  if (!j) return;
  const r = rooms.get(j.room);
  if (!r || r[j.role] !== ws) return;
  delete r[j.role];
  const o = r[other(j.role)];
  if (o) o.send(JSON.stringify({ t: 'peer', up: false }));
  if (!r.hub && !r.node) rooms.delete(j.room);
}

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const cnt = (perIp.get(ip) || 0) + 1;
  perIp.set(ip, cnt);
  ws.on('close', () => { const c = (perIp.get(ip) || 1) - 1; if (c <= 0) perIp.delete(ip); else perIp.set(ip, c); leave(ws); });
  if (cnt > L.perIp) return ws.close(4429, 'too many connections');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  const joinTimer = setTimeout(() => ws.close(4408, 'join timeout'), L.joinMs);
  let bucket = { t: Date.now(), frames: 0, bytes: 0 };

  ws.on('message', (data, isBinary) => {
    if (!ws.aw) {
      if (isBinary) return ws.close(4400, 'join first');
      let j; try { j = JSON.parse(data.toString()); } catch { return ws.close(4400, 'bad join'); }
      if (!j || j.t !== 'join' || j.v !== 1 || !/^[0-9a-f]{64}$/.test(j.room || '') || !['hub', 'node'].includes(j.role)) return ws.close(4400, 'bad join');
      if (KEY && !safeEq(String(j.key || ''), KEY)) return ws.close(4401, 'bad key');
      let r = rooms.get(j.room);
      if (!r) { if (rooms.size >= L.rooms) return ws.close(4429, 'too many rooms'); r = {}; rooms.set(j.room, r); }
      const prev = r[j.role];
      r[j.role] = ws; ws.aw = { room: j.room, role: j.role };
      if (prev) { prev.aw = null; prev.close(4409, 'replaced'); }
      clearTimeout(joinTimer);
      ws.send(JSON.stringify({ t: 'joined' }));
      const o = r[other(j.role)];
      if (o) { ws.send(JSON.stringify({ t: 'peer', up: true })); o.send(JSON.stringify({ t: 'peer', up: true })); }
      return;
    }
    if (!isBinary) return ws.close(4400, 'binary only');
    const now = Date.now();
    if (now - bucket.t >= 1000) bucket = { t: now, frames: 0, bytes: 0 };
    bucket.frames++; bucket.bytes += data.length;
    if (bucket.frames > L.framesPerSec || bucket.bytes > L.bytesPerSec) return ws.close(4429, 'rate limit');
    const r = rooms.get(ws.aw.room), o = r && r[other(ws.aw.role)];
    if (o && o.readyState === 1 && o.bufferedAmount < L.maxBuffered) o.send(data, { binary: true });
  });
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, L.pingMs).unref();

server.listen(PORT, HOST, () => console.log(`AgentWatch relay → ws://${HOST}:${PORT}/aw${KEY ? ' (с ключом)' : ' (без ключа!)'}`));
module.exports = { server, wss, rooms };
