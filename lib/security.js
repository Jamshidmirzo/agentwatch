// Защита локального пульта: сервер может одобрять действия агентов, поэтому
//  • слушаем только 127.0.0.1 и проверяем Host (против DNS-rebinding);
//  • все мутации /api/* требуют заголовок X-AW-Token (токен на запуск вшит в index.html;
//    кастомный заголовок кросс-доменно без CORS не отправить → CSRF невозможен);
//  • хук ходит со стабильным токеном из ~/.agentwatch/token (он же в settings.json).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TOKEN_FILE = path.join(os.homedir(), '.agentwatch', 'token');
const RUN_TOKEN = crypto.randomBytes(16).toString('hex');

function hookToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(t)) return t; } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}

const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hostOk(req, port) {
  const h = String(req.headers.host || '');
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

module.exports = { RUN_TOKEN, hookToken, safeEq, hostOk };
