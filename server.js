#!/usr/bin/env node
// AgentWatch — офис за всеми сессиями Claude Code на этой машине.
//  • внешние сессии (VS Code / Terminal) — из ~/.claude/sessions + транскриптов (lib/registry);
//  • наёмные агенты офиса — через Agent SDK, полный пульт (lib/hosted);
//  • «мой стол» — очередь вопросов/разрешений/планов (lib/inbox), для внешних — через http-хук (lib/hookbridge).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const registry = require('./lib/registry');
const { Inbox } = require('./lib/inbox');
const { HostedManager, MODES, EFFORTS } = require('./lib/hosted');
const { HookBridge, EXT_MODES } = require('./lib/hookbridge');
const { Reports } = require('./lib/reports');
const { RUN_TOKEN, hookToken, safeEq, hostOk } = require('./lib/security');

const PORT = Number(process.env.AGENTWATCH_PORT || process.env.PORT || 4777);
const SCAN_MS = 2000;
const ROOT = __dirname;
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const inbox = new Inbox();
const hosted = new HostedManager(inbox);
const bridge = new HookBridge({ inbox, hosted, onChange: () => schedule() });
const reports = new Reports();
const HOOK_TOKEN = hookToken();

let external = [];
let hookInstalled = false, modeHookInstalled = false;
// хуки плагина (hooks/hooks.json) в settings.json не видны: офис из плагина или включённый плагин = хуки на месте
const pluginHooks = (s) => process.env.AGENTWATCH_PLUGIN === '1' || Object.entries(s.enabledPlugins || {}).some(([k, v]) => v && k.startsWith('agentwatch@'));

function checkHook() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    hookInstalled = (s.hooks?.PermissionRequest || []).some((m) => (m.hooks || []).some((h) => h.type === 'http' && String(h.url).includes('/hook/permission')));
    modeHookInstalled = (s.hooks?.PreToolUse || []).some((m) => (m.hooks || []).some((h) => h.type === 'command' && String(h.command).includes('pretool.sh')));
    if (pluginHooks(s)) hookInstalled = modeHookInstalled = true;
  } catch { hookInstalled = modeHookInstalled = process.env.AGENTWATCH_PLUGIN === '1'; }
}

function snapshot() {
  const h = hosted.list();
  const regBySession = new Map(external.map((s) => [s.sessionId, s]));
  for (const a of h) { // сабагенты наёмных берём из реестра, если SDK их не прислал
    const r = a.sessionId && regBySession.get(a.sessionId);
    if (r && !a.subagents.length) a.subagents = r.subagents;
  }
  const hostedSessions = new Set(h.map((a) => a.sessionId).filter(Boolean));
  const items = inbox.list();
  const ext = external.filter((s) => !hostedSessions.has(s.sessionId)).map((s) => {
    const it = items.find((i) => i.agentKey === s.key);
    const { pendingTools, ...transcript } = s.transcript || {};
    return {
      ...s, transcript, controllable: false, answerable: !!it,
      attention: s.attention ? { ...s.attention, inboxId: it ? it.id : undefined } : it ? { kind: it.kind, text: it.toolName, inboxId: it.id } : null,
      status: it && s.status !== 'waiting' ? 'waiting' : s.status,
      mode: bridge.modeOf(s), pendingMode: bridge.pendingMode(s.sessionId),
    };
  });
  const agents = [...ext, ...h];
  reports.observe(agents);
  for (const a of agents) a.report = reports.get(a.key);
  return { at: Date.now(), agents, inbox: items, models: hosted.models, modes: MODES, extModes: EXT_MODES, efforts: EFFORTS, hookInstalled, modeHookInstalled };
}

// ---------- SSE ----------
const clients = new Set();
let pushTimer = null;
function schedule() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(payload);
  }, 120);
}
inbox.on('change', schedule);
hosted.on('change', schedule);

function scanLoop() {
  try { external = registry.scan(); } catch (e) { console.error('scan', e); }
  bridge.reconcile(external);
  checkHook();
  schedule();
}

// ---------- helpers ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('битый JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.hdr': 'image/vnd.radiance' };
function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}
function within(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p.startsWith(base + path.sep) ? p : null;
}
const findExternal = (key) => external.find((s) => s.key === key);

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/state') return json(res, 200, snapshot());
  // ключ меняется при каждом запуске; открытая вкладка забирает новый (читать может только своя страница — Host и same-origin)
  if (req.method === 'GET' && p === '/api/token') return json(res, 200, { token: RUN_TOKEN });
  if (req.method === 'GET' && p === '/api/projects') {
    const live = [...external.map((s) => s.cwd), ...hosted.list().map((a) => a.cwd)];
    return json(res, 200, { projects: registry.recentProjects(live), archive: hosted.archiveList() });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  if (!safeEq(req.headers['x-aw-token'], RUN_TOKEN)) return json(res, 403, { error: 'token' });
  const body = await readBody(req);

  if (p === '/api/hire') {
    const a = await hosted.hire(body);
    return json(res, 200, { ok: true, key: a.key });
  }
  let m = p.match(/^\/api\/resume\/([0-9a-f]+)$/);
  if (m) { const a = await hosted.resume(m[1], body.prompt); return json(res, 200, { ok: true, key: a.key }); }

  m = p.match(/^\/api\/inbox\/([0-9a-f]+)$/);
  if (m) {
    inbox.resolve(m[1], body);
    return json(res, 200, { ok: true });
  }

  m = p.match(/^\/api\/reports\/([^/]+)\/ack$/);
  if (m) { reports.ack(decodeURIComponent(m[1])); schedule(); return json(res, 200, { ok: true }); }

  m = p.match(/^\/api\/agents\/([^/]+)\/([a-z]+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]), action = m[2];
    if (key.startsWith('h:')) {
      const a = hosted.get(key);
      if (!a) return json(res, 404, { error: 'агент не найден' });
      if (action === 'message') { if (!body.text?.trim()) throw new Error('пустое сообщение'); a.send(body.text.trim()); }
      else if (action === 'model') await a.setModel(body.model);
      else if (action === 'effort') await a.setEffort(body.effort);
      else if (action === 'mode') await a.setMode(body.mode);
      else if (action === 'interrupt') await a.interrupt();
      else if (action === 'stop') a.stop();
      else return json(res, 400, { error: 'неизвестное действие' });
      schedule();
      return json(res, 200, { ok: true });
    }
    const s = findExternal(key);
    if (!s) return json(res, 404, { error: 'сессия не найдена' });
    if (action === 'focus') return registry.focus(s, (err, info) => json(res, err ? 500 : 200, err ? { error: err.message } : { ok: true, ...info }));
    if (action === 'mode') { if (!modeHookInstalled) throw new Error('нужен хук смены режима: npm run hook:install'); const r = body.mode ? bridge.setMode(s, body.mode) : (bridge.clearMode(s.sessionId), { cancelled: true }); return json(res, 200, { ok: true, ...r }); }
    if (action === 'prefill') return registry.openWithPrompt(s, String(body.text || ''), (err, info) => json(res, err ? 500 : 200, err ? { error: err.message } : { ok: true, ...info }));
    return json(res, 400, { error: 'внешней сессии модель и effort меняются только в ней самой' });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- server ----------
const INDEX = path.join(ROOT, 'index.html');
const OFFICE = path.join(ROOT, 'office');
// текстуры и мебель — в данных пользователя (переживают обновления плагина); для разработки — office/assets
const ASSETS = [process.env.AGENTWATCH_ASSETS, path.join(os.homedir(), '.agentwatch', 'assets'), path.join(OFFICE, 'assets')].find((d) => d && fs.existsSync(path.join(d, 'tex'))) || path.join(os.homedir(), '.agentwatch', 'assets');
const THREE = path.join(ROOT, 'node_modules', 'three');

const server = http.createServer(async (req, res) => {
  if (!hostOk(req, PORT)) { res.writeHead(421); return res.end('bad host'); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/hook/permission' && req.method === 'POST') {
      if (!safeEq(url.searchParams.get('t'), HOOK_TOKEN)) return json(res, 403, { error: 'token' });
      const payload = await readBody(req, 4 << 20);
      return bridge.handle(payload, req, res);
    }
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(INDEX, 'utf8').replace('__AW_TOKEN__', RUN_TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (p.startsWith('/office/assets/')) { const f = within(ASSETS, p.slice('/office/assets/'.length)); return f ? sendFile(res, f) : json(res, 404, {}); }
    if (p.startsWith('/office/')) { const f = within(OFFICE, p.slice(8)); return f ? sendFile(res, f) : json(res, 404, {}); }
    if (p.startsWith('/vendor/three/')) {
      const rel = p.slice('/vendor/three/'.length);
      if (!/^(build\/three\.module\.js|examples\/jsm\/[\w/.-]+\.js)$/.test(rel)) return json(res, 404, {});
      const f = within(THREE, rel); return f ? sendFile(res, f) : json(res, 404, {});
    }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }
    if (p.startsWith('/api/')) return await api(req, res, url);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AgentWatch → http://localhost:${PORT}`);
  registry.refreshTtyMap();
  scanLoop();
  setInterval(scanLoop, SCAN_MS);
});

function shutdown() {
  bridge.releaseAll();
  hosted.stopAll();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
