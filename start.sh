#!/usr/bin/env bash
# Запуск AgentWatch в фоне (идемпотентно). Лог: ~/.agentwatch.log
cd "$(dirname "$0")"
PORT="${PORT:-4777}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "AgentWatch уже слушает http://localhost:$PORT"; exit 0
fi
nohup node server.js > "$HOME/.agentwatch.log" 2>&1 &
sleep 1
echo "AgentWatch → http://localhost:$PORT  (pid $!)"
