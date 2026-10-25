#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "Missing infra/digitalocean/.env" >&2
  echo "Copy .env.example to .env and fill in the provider credentials/secrets." >&2
  exit 1
fi

chmod 600 .env

docker compose config >/dev/null
docker compose pull mistserver caddy
docker compose build --pull relay control
docker compose up -d

echo
echo "=== KoraZero Stream V2 ==="
docker compose ps

echo
echo "Control: https://v2.korazero.com"
echo "Remote:  https://v2.korazero.com/remote.html"
echo "HLS:     https://mist-v2.korazero.com/hls/<channel>/index.m3u8"
