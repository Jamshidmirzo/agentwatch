#!/usr/bin/env bash
# Ставит ретранслятор AgentWatch на чистую Ubuntu 24.04: Node 22, Caddy (автоматический TLS), systemd.
# Запуск на сервере из папки relay/:  sudo bash setup.sh <домен>   (например 1-2-3-4.sslip.io)
# Ключ доступа создаётся один раз в /etc/agentwatch-relay.env и печатается в конце.
set -euo pipefail
DOMAIN="${1:?укажите домен, например 1-2-3-4.sslip.io}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR=/opt/agentwatch-relay
export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

mkdir -p "$DIR"
cp "$SRC/relay.js" "$SRC/package.json" "$SRC/package-lock.json" "$DIR/"
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
if [ ! -f /etc/agentwatch-relay.env ]; then
  umask 077
  echo "RELAY_KEY=$(openssl rand -hex 24)" > /etc/agentwatch-relay.env
fi
cp "$SRC/relay.service" /etc/systemd/system/agentwatch-relay.service
printf '%s {\n\treverse_proxy 127.0.0.1:8080\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now agentwatch-relay
systemctl restart agentwatch-relay caddy
sleep 2
systemctl is-active agentwatch-relay caddy
echo "Ретранслятор: wss://$DOMAIN/aw#$(sed -n 's/^RELAY_KEY=//p' /etc/agentwatch-relay.env)"
