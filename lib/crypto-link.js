// Сквозное шифрование связи «этот офис ↔ офис на другом компьютере» через ретранслятор.
// Ретранслятор видит только номер комнаты и шифротекст: не может ни прочитать, ни подделать, ни повторить кадр.
//  • комната = HKDF(секрет, "aw1 room") — секрет не покидает два компьютера;
//  • рукопожатие на каждое соединение: свежие X25519-ключи + общий секрет (PSK) →
//    отдельные ключи AES-256-GCM на каждое направление (повтор кадров из старой сессии и отражение невозможны);
//  • кадр: 0x01 | seq u64 | шифротекст | тег; nonce = seq, строго seq == ожидаемый (TCP сохраняет порядок).
const crypto = require('crypto');
const zlib = require('zlib');

const V = 1;
const ROLES = { hub: 0, node: 1 };
const HELLO_LEN = 1 + 1 + 1 + 16 + 32;
const MAX_PLAIN = 16 << 20;
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hkdf = (ikm, salt, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

function roomOf(secret) { return hkdf(secret, Buffer.alloc(0), Buffer.from('aw1 room')).toString('hex'); }
function newSecret(bytes = 32) { return crypto.randomBytes(bytes); }

// hello: 0x00 | v | role | n(16) | e(32)
function makeHello(role) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const bytes = Buffer.concat([Buffer.from([0, V, ROLES[role]]), crypto.randomBytes(16), pub]);
  return { role, bytes, privateKey };
}
function parseHello(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== HELLO_LEN || buf[0] !== 0) throw new Error('hello: неверный кадр');
  if (buf[1] !== V) throw new Error('hello: другая версия протокола');
  const role = buf[2] === 0 ? 'hub' : buf[2] === 1 ? 'node' : null;
  if (!role) throw new Error('hello: неверная роль');
  return { role, pub: buf.subarray(19, 51) };
}

class Channel {
  constructor(role, kSend, kRecv) {
    this.role = role;
    this.kSend = kSend; this.kRecv = kRecv;
    this.dSend = role === 'hub' ? 1 : 2; this.dRecv = role === 'hub' ? 2 : 1;
    this.sendSeq = 0n; this.recvSeq = 0n;
  }
  static iv(seq) { const b = Buffer.alloc(12); b.writeBigUInt64BE(seq, 4); return b; }
  static aad(dir, seqBuf) { return Buffer.concat([Buffer.from('aw1'), Buffer.from([dir]), seqBuf]); }
  seal(obj) {
    const seq = this.sendSeq++;
    const seqBuf = Buffer.alloc(8); seqBuf.writeBigUInt64BE(seq);
    const c = crypto.createCipheriv('aes-256-gcm', this.kSend, Channel.iv(seq));
    c.setAAD(Channel.aad(this.dSend, seqBuf));
    const ct = Buffer.concat([c.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
    return Buffer.concat([Buffer.from([1]), seqBuf, ct, c.getAuthTag()]);
  }
  open(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 1 + 8 + 16 || buf[0] !== 1) throw new Error('кадр: неверный формат');
    const seqBuf = buf.subarray(1, 9), seq = seqBuf.readBigUInt64BE();
    if (seq !== this.recvSeq) throw new Error('кадр: нарушен порядок (повтор или пропуск)');
    const d = crypto.createDecipheriv('aes-256-gcm', this.kRecv, Channel.iv(seq));
    d.setAAD(Channel.aad(this.dRecv, seqBuf));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(9, buf.length - 16)), d.final()]); // бросит при подделке
    this.recvSeq++;
    return JSON.parse(zlib.inflateRawSync(pt, { maxOutputLength: MAX_PLAIN }).toString('utf8'));
  }
}

// mine — результат makeHello(role); peerBytes — hello второй стороны; psk — общий секрет (Buffer)
function deriveChannel(psk, room, mine, peerBytes) {
  const peer = parseHello(peerBytes);
  if (peer.role === mine.role) throw new Error('hello: та же роль у обеих сторон');
  const pubKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, peer.pub]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: pubKey });
  const [hHub, hNode] = mine.role === 'hub' ? [mine.bytes, peerBytes] : [peerBytes, mine.bytes];
  const th = crypto.createHash('sha256').update(hHub).update(hNode).digest();
  const info = (dir) => Buffer.concat([Buffer.from(`aw1 ${dir}`), Buffer.from(room), th]);
  const h2n = hkdf(shared, psk, info('h2n')), n2h = hkdf(shared, psk, info('n2h'));
  return mine.role === 'hub' ? new Channel('hub', h2n, n2h) : new Channel('node', n2h, h2n);
}

// приглашение: aw1.<base64url(JSON)>; inv — одноразовый секрет (16 байт)
function makeInvite({ relay, key, mid, name, ttlMs = 15 * 60e3 }) {
  const inv = newSecret(16);
  const body = { v: V, relay, key, mid, name, inv: b64u(inv), exp: Date.now() + ttlMs };
  return { invite: 'aw1.' + b64u(JSON.stringify(body)), inv, exp: body.exp };
}
function parseInvite(s) {
  const m = String(s || '').trim().match(/^aw1\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('это не строка подключения AgentWatch (должна начинаться с aw1.)');
  let b; try { b = JSON.parse(unb64u(m[1]).toString('utf8')); } catch { throw new Error('строка подключения повреждена'); }
  if (b.v !== V || !/^wss?:\/\//.test(b.relay || '') || !b.mid || !b.inv) throw new Error('строка подключения повреждена');
  if (b.exp < Date.now()) throw new Error('приглашение истекло — создайте новое на том компьютере');
  return { relay: b.relay, key: String(b.key || ''), mid: String(b.mid), name: String(b.name || 'Компьютер'), inv: unb64u(b.inv), exp: b.exp };
}

module.exports = { roomOf, newSecret, makeHello, parseHello, deriveChannel, Channel, makeInvite, parseInvite, b64u, unb64u };
