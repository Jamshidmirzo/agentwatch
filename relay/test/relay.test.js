const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://127.0.0.1:${PORT}/aw`;
const ROOM = 'a'.repeat(64);
let proc;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], { env: { ...process.env, PORT: String(PORT), RELAY_KEY: 'k1', MAX_ROOMS: '3' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => proc.kill());

function client({ role = 'hub', room = ROOM, key = 'k1' } = {}) {
  const ws = new WebSocket(URL); ws.binaryType = 'arraybuffer';
  const msgs = []; let closed = null, waiters = [];
  ws.onmessage = (e) => { msgs.push(typeof e.data === 'string' ? JSON.parse(e.data) : Buffer.from(e.data)); waiters.forEach((w) => w()); };
  ws.onclose = (e) => { closed = e.code; waiters.forEach((w) => w()); };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', v: 1, key, room, role }));
  const until = (fn, ms = 3000) => new Promise((ok, no) => { const t = setTimeout(() => no(new Error('timeout')), ms); const chk = () => { if (fn()) { clearTimeout(t); ok(); } }; waiters.push(chk); chk(); });
  return { ws, msgs, until, get closed() { return closed; } };
}

test('пересылает бинарные кадры между хабом и узлом, сообщает о собеседнике', async () => {
  const h = client({ role: 'hub' }), n = client({ role: 'node' });
  await h.until(() => h.msgs.some((m) => m.t === 'peer' && m.up));
  await n.until(() => n.msgs.some((m) => m.t === 'peer' && m.up));
  h.ws.send(Buffer.from([1, 2, 3]));
  await n.until(() => n.msgs.some((m) => Buffer.isBuffer(m)));
  assert.deepStrictEqual([...n.msgs.find(Buffer.isBuffer)], [1, 2, 3]);
  n.ws.close();
  await h.until(() => h.msgs.some((m) => m.t === 'peer' && m.up === false));
  h.ws.close();
});

test('неверный ключ — 4401', async () => {
  const c = client({ key: 'nope' });
  await c.until(() => c.closed);
  assert.strictEqual(c.closed, 4401);
});

test('второе подключение той же роли вытесняет первое — 4409', async () => {
  const room = 'b'.repeat(64);
  const a = client({ room }); await a.until(() => a.msgs.some((m) => m.t === 'joined'));
  const b = client({ room }); await a.until(() => a.closed);
  assert.strictEqual(a.closed, 4409);
  b.ws.close();
});

test('текст после входа и мусорный вход — закрытие', async () => {
  const c = client({ room: 'c'.repeat(64) }); await c.until(() => c.msgs.some((m) => m.t === 'joined'));
  c.ws.send('hello'); await c.until(() => c.closed);
  assert.strictEqual(c.closed, 4400);
  const d = client({ room: 'not-hex' }); await d.until(() => d.closed);
  assert.strictEqual(d.closed, 4400);
});

test('лимит частоты кадров — 4429', async () => {
  const room = 'd'.repeat(64);
  const h = client({ room }); await h.until(() => h.msgs.some((m) => m.t === 'joined'));
  for (let i = 0; i < 40; i++) h.ws.send(Buffer.from([i]));
  await h.until(() => h.closed);
  assert.strictEqual(h.closed, 4429);
});

test('лимит комнат — 4429', async () => {
  const cs = ['1', '2', '3'].map((x) => client({ room: x.repeat(64) }));
  await Promise.all(cs.map((c) => c.until(() => c.msgs.some((m) => m.t === 'joined'))));
  const extra = client({ room: '4'.repeat(64) }); await extra.until(() => extra.closed);
  assert.strictEqual(extra.closed, 4429);
  cs.forEach((c) => c.ws.close());
});
