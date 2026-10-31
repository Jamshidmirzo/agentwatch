#!/usr/bin/env node
// Фоновый запуск офиса для плагина: при первом запуске ставит зависимости (npm) и качает текстуры,
// затем поднимает сервер в этом же процессе. Одновременно — только одна загрузка.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(os.homedir(), '.agentwatch');
const LOCK = path.join(DIR, 'boot.lock');
const log = (...a) => console.log(new Date().toISOString(), ...a);

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60e3) fs.unlinkSync(LOCK); } catch {}
try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch { process.exit(0); }
const unlock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// нанятые агенты не должны считать себя вложенными в сессию, которая нас запустила
for (const k of Object.keys(process.env)) if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PLUGIN_|CLAUDE_PROJECT_DIR$|CLAUDE_ENV_FILE$)/.test(k)) delete process.env[k];

const has = (m) => fs.existsSync(path.join(ROOT, 'node_modules', m, 'package.json'));
try {
  if (!has('three') || !has('@anthropic-ai/claude-agent-sdk')) {
    log('ставлю зависимости (npm install)…');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(DIR, 'assets', 'tex'))) {
    log('качаю текстуры и мебель (Poly Haven, CC0)…');
    try { execFileSync(process.execPath, [path.join(ROOT, 'bin', 'assets.js')], { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60e3 }); }
    catch (e) { log('текстуры не скачались — будет простой офис:', e.message); }
  }
} catch (e) {
  log('подготовка не удалась:', e.message);
} finally { unlock(); }

process.env.AGENTWATCH_PLUGIN = '1';
fs.writeFileSync(path.join(DIR, 'server.pid'), String(process.pid));
require(path.join(ROOT, 'server.js'));
