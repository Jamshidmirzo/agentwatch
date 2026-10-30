#!/usr/bin/env node
// Установка / удаление глобального http-хука PermissionRequest для AgentWatch.
//   node bin/hook.js install    — добавить (бэкап ~/.claude/settings.json.agentwatch-bak)
//   node bin/hook.js uninstall  — убрать только наш хук
//   node bin/hook.js status
// Если AgentWatch не запущен, хук сразу получает «connection refused» → Claude Code
// продолжает как обычно (http-хук non-blocking).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { hookToken } = require('../lib/security');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const PORT = Number(process.env.PORT || 4777);
const MARK = '/hook/permission';

function load() { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
function save(obj) {
  const tmp = SETTINGS + '.agentwatch-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}
const isOurs = (h) => h && h.type === 'http' && typeof h.url === 'string' && h.url.includes(MARK);

function strip(settings) {
  const list = settings.hooks?.PermissionRequest;
  if (!Array.isArray(list)) return 0;
  let removed = 0;
  settings.hooks.PermissionRequest = list
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => (isOurs(h) ? (removed++, false) : true)) }))
    .filter((m) => m.hooks.length);
  if (!settings.hooks.PermissionRequest.length) delete settings.hooks.PermissionRequest;
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

const cmd = process.argv[2] || 'status';
const s = load();
if (cmd === 'install') {
  const bak = SETTINGS + '.agentwatch-bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(SETTINGS, bak);
  strip(s);
  s.hooks ??= {};
  s.hooks.PermissionRequest ??= [];
  s.hooks.PermissionRequest.push({
    matcher: '*',
    hooks: [{ type: 'http', url: `http://127.0.0.1:${PORT}${MARK}?t=${hookToken()}`, timeout: 1800 }],
  });
  save(s);
  console.log('Хук установлен →', SETTINGS, '(бэкап:', bak + ')');
} else if (cmd === 'uninstall') {
  const n = strip(s);
  save(s);
  console.log(n ? 'Хук удалён' : 'Хука не было');
} else {
  const on = (s.hooks?.PermissionRequest || []).some((m) => (m.hooks || []).some(isOurs));
  console.log(on ? 'Хук установлен' : 'Хук не установлен');
}
