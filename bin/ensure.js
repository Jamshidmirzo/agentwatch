#!/usr/bin/env node
// Хук SessionStart плагина: если офис AgentWatch не запущен — поднимаем его в фоне и сразу выходим.
// Ничего не печатаем (вывод SessionStart попал бы в контекст модели). --status / --stop — для команд /agentwatch.
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(os.homedir(), '.agentwatch');
const PORT = Number(process.env.AGENTWATCH_PORT || 4777);
const LOG = path.join(DIR, 'server.log');
const PID = path.join(DIR, 'server.pid');
const arg = process.argv[2];

function up(cb) {
  const s = net.connect(PORT, '127.0.0.1');
  const done = (v) => { s.destroy(); cb(v); };
  s.on('connect', () => done(true)); s.on('error', () => done(false)); s.setTimeout(600, () => done(false));
}

up((running) => {
  const url = `http://localhost:${PORT}`;
  if (arg === '--stop') {
    let pid = 0; try { pid = Number(fs.readFileSync(PID, 'utf8')); } catch {}
    if (!running) return console.log('Офис AgentWatch не запущен.');
    try { process.kill(pid, 'SIGTERM'); console.log('Офис AgentWatch остановлен. Поднимется снова при следующей сессии Claude Code или по /agentwatch.'); }
    catch { console.log(`Офис работает, но запущен не плагином (нет ${PID}) — остановите его там, где запускали.`); }
    return;
  }
  if (running) { if (arg === '--status') console.log(`Офис AgentWatch работает: ${url}`); return; }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'boot.js')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, AGENTWATCH_PORT: String(PORT) } });
  child.unref();
  if (arg === '--status') console.log(`Офис AgentWatch запускается: ${url} (первый запуск ставит зависимости и качает текстуры ~1–2 мин; лог ${LOG})`);
});
