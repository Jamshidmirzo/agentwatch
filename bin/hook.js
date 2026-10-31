#!/usr/bin/env node
// Установка / удаление глобальных хуков AgentWatch:
//   • PermissionRequest (http) — ответы со «стола» внешним сессиям;
//   • PreToolUse (command, bin/pretool.sh) — смена режима внешней сессии из офиса (без сети, только файл-флаг).
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
const PORT = Number(process.env.AGENTWATCH_PORT || process.env.PORT || 4777);
const MARK = '/hook/permission';

function load() { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
function save(obj) {
  const tmp = SETTINGS + '.agentwatch-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}
const PRETOOL = path.join(__dirname, 'pretool.sh');
const isOurs = (h) => h && ((h.type === 'http' && typeof h.url === 'string' && h.url.includes(MARK)) || (h.type === 'command' && typeof h.command === 'string' && h.command.endsWith('/pretool.sh') && h.command.includes('agentwatch')));

function strip(settings) {
  let removed = 0;
  for (const ev of ['PermissionRequest', 'PreToolUse']) {
    const list = settings.hooks?.[ev];
    if (!Array.isArray(list)) continue;
    settings.hooks[ev] = list
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => (isOurs(h) ? (removed++, false) : true)) }))
      .filter((m) => m.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
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
  s.hooks.PreToolUse ??= [];
  s.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: PRETOOL, timeout: 5 }] });
  save(s);
  console.log('Хуки установлены (ответы со стола + смена режима) →', SETTINGS, '(бэкап:', bak + ')');
} else if (cmd === 'uninstall') {
  const n = strip(s);
  save(s);
  console.log(n ? `Хуки AgentWatch удалены: ${n}` : 'Хуков не было');
} else {
  const on = (ev) => (s.hooks?.[ev] || []).some((m) => (m.hooks || []).some(isOurs));
  console.log(`Ответы со стола: ${on('PermissionRequest') ? 'да' : 'нет'} · смена режима: ${on('PreToolUse') ? 'да' : 'нет'}`);
}
