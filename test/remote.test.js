const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-')); // remote.json пишется во временный HOME
const { checkRemote } = require('../lib/actions');
const { RemoteManager } = require('../lib/remote');

test('удалённо: запрещены открытие окон, чужие префиксы, лишние операции и не-строки', () => {
  assert.throws(() => checkRemote('agent', { key: 'x:1', action: 'focus' }), /недоступно/);
  assert.throws(() => checkRemote('agent', { key: 'x:1', action: 'prefill', body: { text: 'rm' } }), /недоступно/);
  assert.throws(() => checkRemote('agent', { key: 'm:a:x:1', action: 'mode', body: { mode: 'plan' } }), /недопустимое/);
  assert.throws(() => checkRemote('inbox.resolve', { id: 'm:a:1', decision: { action: 'allow' } }), /недопустимое/);
  assert.throws(() => checkRemote('shell', {}), /недоступно/);
  assert.throws(() => checkRemote('agent', { key: 'h:1', action: 'model', body: { model: 5 } }), /строка/);
  assert.throws(() => checkRemote('inbox.resolve', { id: 'abc', decision: 'allow' }), /объект/);
  assert.throws(() => checkRemote('hire', { cwd: 'x'.repeat(30000) }), /длинно/);
  assert.doesNotThrow(() => checkRemote('agent', { key: 'x:1', action: 'mode', body: { mode: 'plan' } }));
  assert.doesNotThrow(() => checkRemote('inbox.resolve', { id: 'abc', decision: { action: 'answer', answers: { 'Q?': ['a', 'b'] } } }));
});

function mgr(local) {
  const r = new RemoteManager({ actions: null, getLocal: () => local });
  return r;
}
const fakeLink = (state = 'ready') => ({ state, lastError: null, close() {}, send() { return true; } });

test('хаб: агенты другого компьютера вливаются с префиксом, своё «Готово» не пересчитывается', () => {
  const r = mgr();
  r.hubs.set('M1', { m: { id: 'M1', name: 'Mac 2' }, link: fakeLink(), online: true, onlineSince: 1, offset: 0, pending: new Map(),
    snap: { agents: [{ key: 'x:s1', project: 'api', status: 'waiting', attention: { kind: 'permission', inboxId: 'i1' }, report: null, controllable: false },
                     { key: 'h:a1', project: 'api', status: 'idle', report: { at: 5, text: 'ok' }, controllable: true }],
            inbox: [{ id: 'i1', agentKey: 'x:s1', kind: 'permission', createdAt: 3 }], hookInstalled: true, modeHookInstalled: true, models: [] } });
  const out = r.merge({ agents: [{ key: 'x:me', project: 'web' }], inbox: [] });
  const keys = out.agents.map((a) => a.key);
  assert.deepStrictEqual(keys, ['x:me', 'm:M1:x:s1', 'm:M1:h:a1']);
  assert.strictEqual(out.agents[1].project, 'Mac 2 · api');
  assert.strictEqual(out.agents[1].attention.inboxId, 'm:M1:i1');
  assert.deepStrictEqual(out.inbox.map((i) => [i.id, i.agentKey]), [['m:M1:i1', 'm:M1:x:s1']]);
  assert.strictEqual(out.agents[2].report.text, 'ok');
  assert.strictEqual(out.machines[0].online, true);
});

test('хаб: компьютер без связи дольше 15 с — его агенты уходят', () => {
  const r = mgr();
  r.hubs.set('M1', { m: { id: 'M1', name: 'Mac 2' }, link: fakeLink('offline'), online: false, downAt: Date.now() - 20000, offset: 0, pending: new Map(), snap: { agents: [{ key: 'x:s1', project: 'p' }], inbox: [] } });
  const out = r.merge({ agents: [], inbox: [] });
  assert.strictEqual(out.agents.length, 0);
  assert.strictEqual(out.machines[0].online, false);
});

test('узел: отдаёт только своих агентов (без эха) и без pid/tty/version', () => {
  const r = mgr({ agents: [{ key: 'x:1', pid: 5, tty: 't', version: 'v', project: 'p' }, { key: 'm:Z:x:9', project: 'q' }], inbox: [{ id: 'm:Z:1', agentKey: 'm:Z:x:9' }, { id: 'i2', agentKey: 'x:1' }] });
  const s = r.exportSnap();
  assert.deepStrictEqual(s.agents, [{ key: 'x:1', project: 'p' }]);
  assert.deepStrictEqual(s.inbox.map((i) => i.id), ['i2']);
});
