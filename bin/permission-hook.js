#!/usr/bin/env node
// Хук PermissionRequest плагина: передаёт запрос в офис AgentWatch и ждёт ответа со «стола» (long-poll).
// Офис не запущен или нет токена — молча выходим, Claude Code спрашивает как обычно.
// Если ответили в самой сессии, Claude Code закрывает хук — соединение рвётся, и запрос пропадает со стола.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.AGENTWATCH_PORT || 4777);
let token;
try { token = fs.readFileSync(path.join(os.homedir(), '.agentwatch', 'token'), 'utf8').trim(); } catch { process.exit(0); }

let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/hook/permission?t=' + encodeURIComponent(token),
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let out = '';
    res.on('data', (c) => { out += c; });
    res.on('end', () => { if (res.statusCode === 200 && out.trim()) process.stdout.write(out); process.exit(0); });
  });
  req.on('error', () => process.exit(0));
  req.end(body);
});
