// Действия офиса — общие для локального интерфейса (HTTP /api в server.js) и для команд
// с другого компьютера (lib/remote.js). Для удалённых (remote: true) — только белый список,
// строгая проверка аргументов, без открытия окон на этой машине и без чужих префиксов «m:».

const REMOTE_OPS = new Set(['projects', 'hire', 'resume', 'inbox.resolve', 'report.ack', 'agent']);
const REMOTE_AGENT_ACTIONS = new Set(['message', 'model', 'effort', 'mode', 'interrupt', 'stop', 'send']);
const MAX = 20000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function str(v, name, max = MAX) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new Error(`${name}: ожидалась строка`);
  if (v.length > max) throw new Error(`${name}: слишком длинно`);
  return v;
}
function localKey(v, name) {
  const s = str(v, name, 200);
  if (!s || s.startsWith('m:')) throw new Error(`${name}: недопустимое значение`);
  return s;
}

function checkRemote(op, args) {
  if (!REMOTE_OPS.has(op)) throw new Error('это действие удалённо недоступно');
  if (!isObj(args)) throw new Error('аргументы: ожидался объект');
  if (op === 'hire') for (const k of ['cwd', 'name', 'prompt', 'model', 'effort', 'mode']) str(args[k], k);
  if (op === 'resume') { localKey(args.id, 'id'); str(args.prompt, 'prompt'); }
  if (op === 'report.ack') localKey(args.key, 'key');
  if (op === 'inbox.resolve') {
    localKey(args.id, 'id');
    const d = args.decision;
    if (!isObj(d)) throw new Error('decision: ожидался объект');
    for (const k of ['action', 'mode', 'message', 'feedback']) str(d[k], k);
    if (d.answers != null) {
      if (!isObj(d.answers)) throw new Error('answers: ожидался объект');
      for (const [q, a] of Object.entries(d.answers)) {
        str(q, 'вопрос', 2000);
        if (Array.isArray(a)) a.forEach((x) => str(x, 'ответ')); else str(a, 'ответ');
      }
    }
  }
  if (op === 'agent') {
    localKey(args.key, 'key');
    if (!REMOTE_AGENT_ACTIONS.has(args.action)) throw new Error('это действие удалённо недоступно');
    if (args.body != null && !isObj(args.body)) throw new Error('body: ожидался объект');
    for (const [k, v] of Object.entries(args.body || {})) str(v, k);
  }
}

function createActions({ inbox, hosted, bridge, reports, registry, getExternal, getModeHook, schedule }) {
  const findExternal = (key) => getExternal().find((s) => s.key === key);
  const cb = (fn) => new Promise((ok, no) => fn((err, info) => (err ? no(err) : ok(info || {}))));

  const ops = {
    projects() {
      const live = [...getExternal().map((s) => s.cwd), ...hosted.list().map((a) => a.cwd)];
      return { projects: registry.recentProjects(live), archive: hosted.archiveList() };
    },
    async hire(args) { const a = await hosted.hire(args); return { key: a.key }; },
    async resume({ id, prompt }) { const a = await hosted.resume(id, prompt); return { key: a.key }; },
    'inbox.resolve'({ id, decision }) { inbox.resolve(id, decision || {}); return {}; },
    'report.ack'({ key }) { reports.ack(key); schedule(); return {}; },
    async agent({ key, action, body = {} }) {
      if (key.startsWith('h:')) {
        const a = hosted.get(key);
        if (!a) throw new Error('агент не найден');
        if (action === 'message') { const t = String(body.text || '').trim(); if (!t) throw new Error('пустое сообщение'); a.send(t); }
        else if (action === 'model') await a.setModel(body.model);
        else if (action === 'effort') await a.setEffort(body.effort);
        else if (action === 'mode') await a.setMode(body.mode);
        else if (action === 'interrupt') await a.interrupt();
        else if (action === 'stop') a.stop();
        else throw new Error('неизвестное действие');
        schedule();
        return {};
      }
      const s = findExternal(key);
      if (!s) throw new Error('сессия не найдена');
      if (action === 'mode') {
        if (!getModeHook()) throw new Error('нужен хук смены режима: npm run hook:install');
        return body.mode ? bridge.setMode(s, body.mode) : (bridge.clearMode(s.sessionId), { cancelled: true });
      }
      if (action === 'send') return registry.sendPrompt(s, body.text);
      if (action === 'focus') return cb((done) => registry.focus(s, done));
      if (action === 'prefill') return cb((done) => registry.openWithPrompt(s, String(body.text || ''), done));
      throw new Error('внешней сессии модель и effort меняются только в ней самой');
    },
  };

  async function perform(op, args = {}, { remote = false } = {}) {
    if (remote) checkRemote(op, args);
    const fn = ops[op];
    if (!fn) throw new Error('неизвестное действие');
    return (await fn(args)) || {};
  }
  return { perform };
}

module.exports = { createActions, checkRemote };
