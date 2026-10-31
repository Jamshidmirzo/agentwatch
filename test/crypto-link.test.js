const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const L = require('../lib/crypto-link');

const pair = (psk = L.newSecret(), room = L.roomOf(psk)) => {
  const h = L.makeHello('hub'), n = L.makeHello('node');
  return { hub: L.deriveChannel(psk, room, h, n.bytes), node: L.deriveChannel(psk, room, n, h.bytes), psk, room };
};

test('обе стороны получают одинаковые ключи, сообщения ходят в обе стороны', () => {
  const { hub, node } = pair();
  assert.deepStrictEqual(node.open(hub.seal({ t: 'call', id: 1, op: 'x' })), { t: 'call', id: 1, op: 'x' });
  assert.deepStrictEqual(hub.open(node.seal({ t: 'res', id: 1, ok: true })), { t: 'res', id: 1, ok: true });
  assert.deepStrictEqual(node.open(hub.seal({ n: 2 })), { n: 2 });
});

test('подмена любого байта шифротекста — отказ', () => {
  const { hub, node } = pair();
  const f = hub.seal({ secret: 'rm -rf /' });
  for (const i of [10, f.length - 20, f.length - 1]) {
    const bad = Buffer.from(f); bad[i] ^= 1;
    assert.throws(() => pair().node.open(bad));
  }
  const bad = Buffer.from(f); bad[12] ^= 1;
  assert.throws(() => node.open(bad));
});

test('повтор и пропуск кадра — отказ', () => {
  const { hub, node } = pair();
  const f1 = hub.seal({ a: 1 }), f2 = hub.seal({ a: 2 });
  assert.throws(() => node.open(f2), /порядок/);
  node.open(f1);
  assert.throws(() => node.open(f1), /порядок/);
  node.open(f2);
});

test('кадр, отражённый обратно отправителю, — отказ', () => {
  const { hub } = pair();
  assert.throws(() => hub.open(hub.seal({ a: 1 })));
});

test('кадр из старой сессии с тем же секретом — отказ', () => {
  const psk = L.newSecret(), room = L.roomOf(psk);
  const old = pair(psk, room), fresh = pair(psk, room);
  assert.throws(() => fresh.node.open(old.hub.seal({ op: 'allow' })));
});

test('неверный общий секрет — ключи не сходятся', () => {
  const room = 'r';
  const h = L.makeHello('hub'), n = L.makeHello('node');
  const hub = L.deriveChannel(L.newSecret(), room, h, n.bytes), node = L.deriveChannel(L.newSecret(), room, n, h.bytes);
  assert.throws(() => node.open(hub.seal({ a: 1 })));
});

test('одна и та же роль у обеих сторон — отказ', () => {
  const a = L.makeHello('hub'), b = L.makeHello('hub');
  assert.throws(() => L.deriveChannel(L.newSecret(), 'r', a, b.bytes), /роль/);
});

test('сжатая «бомба» больше 16 МБ не распаковывается', () => {
  const { hub, node } = pair();
  const huge = { x: 'a'.repeat(17 << 20) };
  const f = hub.seal(huge);
  assert.ok(f.length < 200000);
  assert.throws(() => node.open(f));
});

test('приглашение: туда-обратно, истечение, мусор', () => {
  const { invite, inv } = L.makeInvite({ relay: 'wss://r.example', key: 'k', mid: 'm1', name: 'Mac' });
  const p = L.parseInvite(invite);
  assert.strictEqual(p.mid, 'm1'); assert.ok(p.inv.equals(inv));
  assert.throws(() => L.parseInvite(L.makeInvite({ relay: 'wss://r', key: '', mid: 'm', name: 'x', ttlMs: -1 }).invite), /истекло/);
  assert.throws(() => L.parseInvite('hello'), /aw1/);
  assert.throws(() => L.parseInvite('aw1.' + Buffer.from('{"v":1}').toString('base64url')), /повреждена/);
});

test('комната не раскрывает секрет и разная для разных секретов', () => {
  const a = L.newSecret(), b = L.newSecret();
  assert.notStrictEqual(L.roomOf(a), L.roomOf(b));
  assert.ok(!L.roomOf(a).includes(a.toString('hex')));
  void zlib;
});
