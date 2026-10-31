#!/usr/bin/env bash
# Запуск AgentWatch в фоне (идемпотентно). Лог: ~/.agentwatch.log
cd "$(dirname "$0")"
PORT="${PORT:-4777}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "AgentWatch уже слушает http://localhost:$PORT"; exit 0
fi
if [ ! -d "$HOME/.agentwatch/assets/tex" ] && [ ! -d office/assets/tex ]; then
  echo "Скачиваю текстуры и мебель для реалистичного офиса (один раз)…"
  node bin/assets.js || echo "Не скачалось — будет простой офис. Повторить: npm run assets"
fi
nohup node server.js > "$HOME/.agentwatch.log" 2>&1 &
sleep 1
echo "AgentWatch → http://localhost:$PORT  (pid $!)"
