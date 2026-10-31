// Другие компьютеры: этот офис (хаб) ведёт агентов офиса на другом компьютере (узел) через свой ретранслятор.
// Всё исходящее (WebSocket к ретранслятору), содержимое зашифровано сквозным ключом (lib/crypto-link.js).
//  • хаб (здесь): «Добавить компьютер» → одноразовое приглашение aw1.… (15 мин, адрес и ключ ретранслятора внутри);
//  • узел (там): вставляет приглашение и разрешает управлять собой → хаб присылает постоянный секрет связи;
//    узел отдаёт снимок своих агентов и выполняет только белый список действий (lib/actions.js, remote: true);
//  • агенты того компьютера вливаются в офис хаба с префиксом «m:<id>:».
// Настройки и секреты — ~/.agentwatch/remote.json (0600), журнал удалённых действий — ~/.agentwatch/remote.log.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const L = require('./crypto-link');

const DIR = path.join(os.homedir(), '.agentwatch');
const CONF = path.join(DIR, 'remote.json');
const LOG = path.join(DIR, 'remote.log');
const PING_MS = 20000, DEAD_MS = 45000, CALL_MS = 15000, GRACE_MS = 15000, SNAP_MS = 400, WAIT_MAX_MS = 10 * 60e3;
const MAX_INVITES = 3;

function loadConf() { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } }
function saveConf(c) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONF}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONF);
}
function audit(line) { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {} }
const brief = (op, a = {}) => op === 'agent' ? `${a.action} ${a.key}` : op === 'inbox.resolve' ? `${a.decision?.action} ${a.id}` : op === 'hire' ? `hire ${a.cwd}` : op === 'report.ack' ? `ack ${a.key}` : op;
const cleanName = (s, def) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || def;

// ---------- одно соединение с ретранслятором ----------
class Link extends EventEmitter {
  constructor({ role, relay, key, secret, label }) {
    super();
    Object.assign(this, { role, relay, key: key || '', secret, label });
    this.room = L.roomOf(secret);
    this.state = 'off'; this.lastError = null; this.backoff = 1000; this.closed = false;
  }
  start() { this.closed = false; this.connect(); return this; }
  connect() {
    if (this.closed) return;
    clearTimeout(this.retryT);
    if (typeof WebSocket !== 'function') { this.setState('error', 'нужен Node 22 или новее'); return; }
    let ws;
    try { ws = new WebSocket(this.relay); } catch (e) { this.lastError = e.message; return this.retry(); }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    this.setState('connecting');
    // Node 22: при отказе в подключении приходит только error, без close — считаем это обрывом; плюс таймаут
    const fail = () => { if (this.ws === ws && ws.readyState !== 1) { try { ws.close(); } catch {} this.onClose(1006); } };
    clearTimeout(this.connT); this.connT = setTimeout(fail, 15000);
    ws.onopen = () => { clearTimeout(this.connT); ws.send(JSON.stringify({ t: 'join', v: 1, key: this.key, room: this.room, role: this.role })); };
    ws.onmessage = (e) => { if (this.ws === ws) this.onFrame(e.data); };
    ws.onclose = (e) => { if (this.ws === ws) this.onClose(e.code); };
    ws.onerror = fail;
  }
  onFrame(data) {
    this.lastRx = Date.now();
    if (typeof data === 'string') {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'joined') {
        this.setState('waiting');
        clearTimeout(this.stableT); this.stableT = setTimeout(() => { this.backoff = 1000; }, 30000);
        clearTimeout(this.waitT); this.waitT = setTimeout(() => { if (this.state === 'waiting') this.drop(); }, WAIT_MAX_MS);
      } else if (m.t === 'peer' && m.up) this.sendHello();
      else if (m.t === 'peer' && !m.up) this.lost('waiting');
      return;
    }
    const buf = Buffer.from(data);
    try {
      if (buf[0] === 0) { // hello собеседника → свежие ключи этой сессии
        if (!this.hello) this.sendHello();
        this.chan = L.deriveChannel(this.secret, this.room, this.hello, buf);
        this.peerFin = false;
        this.ws.send(this.chan.seal({ t: 'fin', role: this.role }));
        return;
      }
      if (!this.chan) throw new Error('кадр до рукопожатия');
      const msg = this.chan.open(buf);
      if (msg.t === 'fin') {
        if (msg.role === this.role) throw new Error('fin: та же роль');
        this.peerFin = true; clearTimeout(this.waitT);
        this.setState('ready'); this.startPing(); this.emit('ready');
        return;
      }
      if (!this.peerFin) throw new Error('сообщение до подтверждения ключей');
      if (msg.t === 'ping') { this.send({ t: 'pong', at: Date.now(), echo: msg.at }); return; }
      this.emit('msg', msg);
    } catch (e) {
      this.lastError = 'сбой защищённого канала: ' + e.message;
      this.drop();
    }
  }
  sendHello() {
    this.hello = L.makeHello(this.role); this.chan = null; this.peerFin = false;
    if (this.ws?.readyState === 1) this.ws.send(this.hello.bytes);
  }
  send(obj) {
    if (this.state !== 'ready' || !this.chan || this.ws?.readyState !== 1) return false;
    this.ws.send(this.chan.seal(obj));
    return true;
  }
  startPing() {
    clearInterval(this.pingT);
    this.pingT = setInterval(() => {
      if (Date.now() - (this.lastRx || 0) > DEAD_MS) return this.drop(); // полуоткрытое соединение (сон ноутбука и т. п.)
      if (this.role === 'hub') this.send({ t: 'ping', at: Date.now() });
    }, PING_MS);
    if (this.role === 'hub') this.send({ t: 'ping', at: Date.now() });
  }
  lost(next) {
    clearInterval(this.pingT);
    const was = this.state;
    this.chan = null; this.hello = null; this.peerFin = false;
    this.setState(next);
    if (was === 'ready') this.emit('down');
  }
  drop() { try { this.ws?.close(); } catch {} }
  onClose(code) {
    clearTimeout(this.stableT); clearTimeout(this.waitT); clearTimeout(this.connT);
    this.ws = null;
    this.lost(this.closed ? 'off' : 'offline');
    if (this.closed) return;
    if (code === 4401) { this.lastError = 'ретранслятор не принял ключ доступа'; this.setState('error'); return this.retry(5 * 60e3); }
    if (code === 4409) { this.lastError = 'это подключение открыто ещё в одном месте'; this.setState('error'); return this.retry(5 * 60e3); }
    if (code === 4429) this.lastError = 'ретранслятор ограничил подключение';
    this.retry();
  }
  retry(ms) {
    if (this.closed) return;
    const d = ms ?? Math.random() * this.backoff;
    this.backoff = Math.min(60000, this.backoff * 2);
    this.retryT = setTimeout(() => this.connect(), d);
  }
  setState(s, err) {
    if (err !== undefined) this.lastError = err;
    if (s === 'ready') this.lastError = null;
    if (this.state === s) return;
    this.state = s; this.emit('state', s);
  }
  close() {
    this.closed = true;
    for (const t of [this.retryT, this.stableT, this.waitT, this.connT]) clearTimeout(t);
    clearInterval(this.pingT);
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000); } catch {}
    this.state = 'off';
  }
}

// ---------- менеджер ----------
class RemoteManager extends EventEmitter {
  constructor({ actions, getLocal }) {
    super();
    this.actions = actions; this.getLocal = getLocal;
    this.hubs = new Map();    // id компьютера → { m, link, snap, offset, online, onlineSince, downAt, pending }
    this.nodes = new Map();   // id связи → { a, link, online, lastHash, sendT, lastActionAt }
    this.invites = new Map(); // inv → { link, exp, expT }
    this.callSeq = 0;
    const c = loadConf();
    c.mid ??= crypto.randomBytes(4).toString('hex');
    c.name ??= cleanName(os.hostname().replace(/\.local$/, ''), 'Компьютер');
    c.relay ??= { url: process.env.AGENTWATCH_RELAY_URL || '', key: process.env.AGENTWATCH_RELAY_KEY || '' };
    c.node ??= { enabled: false, accept: [] };
    c.node.accept ??= [];
    c.machines ??= [];
    this.conf = c;
    saveConf(c);
  }
  changed() { this.emit('change'); }
  start() {
    for (const m of this.conf.machines) this.startHub(m);
    if (this.conf.node.enabled) for (const a of this.conf.node.accept) this.startNode(a);
    return this;
  }
  stopAll() {
    for (const h of this.hubs.values()) h.link.close();
    for (const n of this.nodes.values()) n.link.close();
    for (const i of this.invites.values()) { clearTimeout(i.expT); i.link.close(); }
  }

  // ----- хаб: управляем другим компьютером -----
  startHub(m) {
    this.hubs.get(m.id)?.link.close();
    const h = { m, snap: null, offset: 0, online: false, onlineSince: 0, downAt: 0, pending: new Map() };
    h.link = new Link({ role: 'hub', relay: m.relay, key: m.key, secret: L.unb64u(m.secret), label: m.name });
    h.link.on('ready', () => { h.online = true; h.onlineSince = Date.now(); h.downAt = 0; this.changed(); });
    h.link.on('down', () => {
      h.online = false; h.downAt = Date.now();
      for (const p of h.pending.values()) { clearTimeout(p.t); p.reject(new Error(`связь с «${m.name}» прервалась — выполнено ли действие, неизвестно`)); }
      h.pending.clear();
      this.changed();
      setTimeout(() => this.changed(), GRACE_MS + 200); // через 15 с его агенты уходят из офиса
    });
    h.link.on('state', () => this.changed());
    h.link.on('msg', (msg) => {
      if (msg.t === 'snap') { h.snap = msg; this.changed(); }
      else if (msg.t === 'res') {
        const p = h.pending.get(msg.id);
        if (!p) return;
        h.pending.delete(msg.id); clearTimeout(p.t);
        if (msg.ok) p.resolve(msg.data || {}); else p.reject(new Error(msg.error || `ошибка на «${m.name}»`));
      } else if (msg.t === 'pong' && typeof msg.at === 'number' && typeof msg.echo === 'number') {
        h.offset = msg.at - (msg.echo + Date.now()) / 2; // поправка часов того компьютера
      }
    });
    this.hubs.set(m.id, h);
    h.link.start();
  }
  call(mid, op, args) {
    const h = this.hubs.get(mid);
    if (!h) return Promise.reject(new Error('компьютер не найден'));
    if (!h.online) return Promise.reject(new Error(`«${h.m.name}» не на связи`));
    const id = ++this.callSeq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { h.pending.delete(id); reject(new Error(`«${h.m.name}» не ответил за 15 с — выполнено ли действие, неизвестно`)); }, CALL_MS);
      h.pending.set(id, { resolve, reject, t });
      if (!h.link.send({ t: 'call', id, op, args })) { clearTimeout(t); h.pending.delete(id); reject(new Error(`«${h.m.name}» не на связи`)); }
    });
  }
  invite() {
    const r = this.conf.relay;
    if (!r?.url) throw new Error('сначала укажите адрес ретранслятора');
    for (const [k, i] of this.invites) if (this.invites.size >= MAX_INVITES) { clearTimeout(i.expT); i.link.close(); this.invites.delete(k); }
    const { invite, inv, exp } = L.makeInvite({ relay: r.url, key: r.key, mid: this.conf.mid, name: this.conf.name });
    const k = L.b64u(inv);
    const link = new Link({ role: 'hub', relay: r.url, key: r.key, secret: inv, label: 'приглашение' });
    const rec = { link, exp };
    const done = () => { clearTimeout(rec.expT); this.invites.delete(k); setTimeout(() => link.close(), 1000); this.changed(); };
    rec.expT = setTimeout(done, exp - Date.now());
    let secret = null, node = null;
    link.on('msg', (msg) => {
      if (!this.invites.has(k)) return;
      if (msg.t === 'join2' && !secret) { // узел вставил приглашение и согласился
        node = { mid: String(msg.mid || '').slice(0, 16), name: cleanName(msg.name, 'Компьютер') };
        if (!node.mid || node.mid === this.conf.mid) return link.drop();
        secret = L.newSecret(32);
        link.send({ t: 'rekey', linkSecret: L.b64u(secret), hubName: this.conf.name, hubMid: this.conf.mid });
      } else if (msg.t === 'rekeyed' && secret) {
        const m = { id: node.mid, name: node.name, relay: r.url, key: r.key, secret: L.b64u(secret), createdAt: Date.now() };
        this.conf.machines = this.conf.machines.filter((x) => x.id !== m.id);
        this.conf.machines.push(m); saveConf(this.conf);
        done(); this.startHub(m);
      }
    });
    this.invites.set(k, rec);
    link.start();
    this.changed();
    return { invite, exp };
  }

  // ----- узел: этим компьютером управляют -----
  startNode(a) {
    this.nodes.get(a.id)?.link.close();
    const n = { a, online: false, lastHash: '', sendT: null, lastActionAt: 0 };
    n.link = new Link({ role: 'node', relay: a.relay, key: a.key, secret: L.unb64u(a.secret), label: a.hubName });
    n.link.on('ready', () => { n.online = true; n.lastHash = ''; this.sendSnap(n); audit(`на связи «${a.hubName}»`); this.changed(); });
    n.link.on('down', () => { n.online = false; this.changed(); });
    n.link.on('state', () => this.changed());
    n.link.on('msg', (msg) => this.onCall(n, msg));
    this.nodes.set(a.id, n);
    n.link.start();
  }
  async onCall(n, msg) {
    if (msg.t !== 'call' || !this.conf.node.enabled) return;
    const { id, op, args } = msg;
    let res;
    try {
      const data = await this.actions.perform(op, args, { remote: true });
      audit(`«${n.a.hubName}»: ${brief(op, args)} → ок`);
      n.lastActionAt = Date.now();
      if (op === 'hire' || op === 'resume') this.sendSnap(n); // сначала новый агент в снимке, потом ответ
      res = { t: 'res', id, ok: true, data };
    } catch (e) {
      audit(`«${n.a.hubName}»: ${brief(op, args)} → ошибка: ${e.message}`);
      res = { t: 'res', id, ok: false, error: String(e.message || e) };
    }
    n.link.send(res);
    this.changed();
  }
  exportSnap() {
    const s = this.getLocal();
    const own = (k) => typeof k === 'string' && !k.startsWith('m:'); // только свои — без эха, если компы подключили друг друга
    return {
      at: Date.now(), host: this.conf.name,
      agents: s.agents.filter((a) => own(a.key)).map(({ pid, tty, terminal, version, ...a }) => a),
      inbox: s.inbox.filter((i) => own(i.id) && own(i.agentKey)),
      models: s.models, modes: s.modes, extModes: s.extModes, efforts: s.efforts,
      hookInstalled: s.hookInstalled, modeHookInstalled: s.modeHookInstalled,
    };
  }
  sendSnap(n) {
    if (!n.online) return;
    const s = this.exportSnap();
    const hash = crypto.createHash('sha256').update(JSON.stringify({ ...s, at: 0 })).digest('hex');
    if (hash === n.lastHash) return;
    if (n.link.send({ t: 'snap', ...s })) n.lastHash = hash;
  }
  localChanged() {
    for (const n of this.nodes.values()) {
      if (!n.online || n.sendT) continue;
      n.sendT = setTimeout(() => { n.sendT = null; this.sendSnap(n); }, SNAP_MS);
    }
  }
  accept({ invite }) {
    const p = L.parseInvite(invite);
    if (p.mid === this.conf.mid) throw new Error('это приглашение этого же компьютера');
    return new Promise((resolve, reject) => {
      const link = new Link({ role: 'node', relay: p.relay, key: p.key, secret: p.inv, label: 'приглашение' });
      const fail = (msg) => { clearTimeout(t); link.close(); reject(new Error(msg)); };
      const t = setTimeout(() => fail('не дождался компьютера, который приглашал: проверьте, что его офис запущен и приглашение свежее'), 25000);
      link.on('state', (st) => { if (st === 'error') fail(link.lastError || 'ошибка ретранслятора'); });
      link.on('ready', () => link.send({ t: 'join2', mid: this.conf.mid, name: this.conf.name }));
      link.on('msg', (msg) => {
        if (msg.t !== 'rekey') return;
        const secret = L.unb64u(msg.linkSecret);
        if (secret.length !== 32) return fail('неверный ответ при сопряжении');
        const a = { id: crypto.randomBytes(4).toString('hex'), hubName: cleanName(msg.hubName, p.name), hubMid: String(msg.hubMid || p.mid).slice(0, 16), relay: p.relay, key: p.key, secret: L.b64u(secret), createdAt: Date.now() };
        this.conf.node.accept = this.conf.node.accept.filter((x) => x.hubMid !== a.hubMid);
        this.conf.node.accept.push(a);
        this.conf.node.enabled = true; saveConf(this.conf);
        audit(`сопряжение: управлять этим компьютером может «${a.hubName}»`);
        link.send({ t: 'rekeyed' });
        clearTimeout(t); setTimeout(() => link.close(), 1000);
        this.startNode(a); this.changed();
        resolve({ id: a.id, name: a.hubName });
      });
      link.start();
    });
  }
  setNode(enabled) {
    this.conf.node.enabled = !!enabled; saveConf(this.conf);
    if (enabled) { for (const a of this.conf.node.accept) if (!this.nodes.has(a.id)) this.startNode(a); }
    else {
      for (const n of this.nodes.values()) n.link.close();
      this.nodes.clear();
      audit('доступ извне выключен');
    }
    this.changed();
  }

  // ----- для server.js -----
  merge(local) {
    const now = Date.now();
    const agents = [...local.agents], inbox = [...local.inbox], machines = [];
    for (const h of this.hubs.values()) {
      const s = h.snap, m = h.m;
      machines.push({
        id: m.id, name: m.name, online: h.online, onlineSince: h.onlineSince, state: h.link.state, error: h.link.lastError,
        agents: s ? s.agents.length : 0, hookInstalled: !!s?.hookInstalled, modeHookInstalled: !!s?.modeHookInstalled,
        models: s?.models || null, modes: s?.modes || null, extModes: s?.extModes || null, efforts: s?.efforts || null,
      });
      const alive = h.online || (h.downAt && now - h.downAt < GRACE_MS);
      if (!s || !alive) continue;
      const P = `m:${m.id}:`, off = h.offset || 0;
      const fix = (t) => (typeof t === 'number' && t > 0 ? Math.round(t - off) : t);
      for (const a of s.agents || []) {
        agents.push({
          ...a, key: P + a.key, project: `${m.name} · ${a.project}`, machine: m.id, machineName: m.name,
          startedAt: fix(a.startedAt), updatedAt: fix(a.updatedAt), statusUpdatedAt: fix(a.statusUpdatedAt),
          report: a.report ? { ...a.report, at: fix(a.report.at) } : null,
          attention: a.attention ? { ...a.attention, inboxId: a.attention.inboxId ? P + a.attention.inboxId : undefined } : null,
          controllable: !!a.controllable && h.online, answerable: !!a.answerable && h.online,
        });
      }
      for (const i of s.inbox || []) inbox.push({ ...i, id: P + i.id, agentKey: P + i.agentKey, createdAt: fix(i.createdAt), machine: m.id });
    }
    const remoteIn = [...this.nodes.values()].map((n) => ({ id: n.a.id, name: n.a.hubName, online: n.online, lastActionAt: n.lastActionAt }));
    return { ...local, agents, inbox, machines, remoteIn, me: { mid: this.conf.mid, name: this.conf.name } };
  }
  async manage(cmd, b = {}) {
    if (cmd === 'state') {
      return {
        me: { mid: this.conf.mid, name: this.conf.name },
        relay: { url: this.conf.relay.url, hasKey: !!this.conf.relay.key }, invites: this.invites.size,
        node: { enabled: this.conf.node.enabled,
          accept: this.conf.node.accept.map((a) => ({ id: a.id, name: a.hubName, online: !!this.nodes.get(a.id)?.online, lastActionAt: this.nodes.get(a.id)?.lastActionAt || 0, createdAt: a.createdAt })) },
        machines: [...this.hubs.values()].map((h) => ({ id: h.m.id, name: h.m.name, online: h.online, state: h.link.state, error: h.link.lastError, agents: h.snap ? h.snap.agents.length : 0 })),
        node22: typeof WebSocket === 'function',
      };
    }
    if (cmd === 'relay') {
      let url = String(b.url || '').trim(), key = b.key != null ? String(b.key).trim() : this.conf.relay.key;
      const hash = url.indexOf('#'); // можно вставить одной строкой: wss://…/aw#ключ
      if (hash > 0) { key = url.slice(hash + 1); url = url.slice(0, hash); }
      if (url && !/^wss?:\/\/[^\s#]+$/.test(url)) throw new Error('адрес ретранслятора: wss://…');
      this.conf.relay = { url, key };
      saveConf(this.conf); this.changed();
      return {};
    }
    if (cmd === 'name') { this.conf.name = cleanName(b.name, this.conf.name); saveConf(this.conf); this.changed(); return {}; }
    if (cmd === 'node') { this.setNode(!!b.enabled); return {}; }
    if (cmd === 'invite') return this.invite();
    if (cmd === 'revoke') {
      this.nodes.get(b.id)?.link.close(); this.nodes.delete(b.id);
      this.conf.node.accept = this.conf.node.accept.filter((a) => a.id !== b.id); saveConf(this.conf);
      audit(`доступ отозван у связи ${b.id}`); this.changed();
      return {};
    }
    if (cmd === 'accept') return this.accept({ invite: b.invite });
    if (cmd === 'rename') {
      const m = this.conf.machines.find((x) => x.id === b.id);
      if (!m) throw new Error('компьютер не найден');
      m.name = cleanName(b.name, m.name); saveConf(this.conf);
      const h = this.hubs.get(m.id); if (h) h.m = m;
      this.changed(); return {};
    }
    if (cmd === 'remove') {
      this.hubs.get(b.id)?.link.close(); this.hubs.delete(b.id);
      this.conf.machines = this.conf.machines.filter((m) => m.id !== b.id); saveConf(this.conf);
      this.changed(); return {};
    }
    throw new Error('неизвестная команда');
  }
}

module.exports = { RemoteManager, Link };
