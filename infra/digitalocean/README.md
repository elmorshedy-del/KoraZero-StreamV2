# KoraZero Stream V2 — DigitalOcean

This deployment moves the existing V2 architecture from Railway onto one DigitalOcean VPS without changing the proven media logic.

## Target

- Droplet: `korazero-stream-v2`
- Public IPv4: `134.209.36.189`
- Region: `nyc3`
- Size: 2 vCPU / 4 GB RAM
- Control: `https://v2.korazero.com`
- Mist HLS: `https://mist-v2.korazero.com`

Cloudflare DNS for both hostnames is DNS-only and points directly at the VPS so Caddy terminates TLS and Cloudflare does not proxy the media path.

## Architecture

```text
authorized IPTV provider
        |
        v
relay (private Docker network)
        |
        v
MistServer (private 4242 management API)
        |
        v
Caddy HTTPS
        |
        v
KoraZero viewers
```

The relay has the Docker network alias:

```text
v2-iptv-relay.railway.internal
```

This intentionally preserves the existing V2 runtime assumptions and the emergency 3645 path without rewriting proven application code.

## First boot on Ubuntu 24.04

Run as root or through sudo:

```bash
apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-v2
systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

git clone --branch deploy/digitalocean-v2-20261025 \
  https://github.com/elmorshedy-del/KoraZero-StreamV2.git \
  /opt/korazero-stream-v2

cd /opt/korazero-stream-v2/infra/digitalocean
cp .env.example .env
chmod 600 .env
```

Fill only the real values in `.env`:

- `V2_IPTV_PORTAL_URL`
- `V2_IPTV_USERNAME`
- `V2_IPTV_PASSWORD`
- `V2_INTERNAL_TOKEN`
- `V2_OPERATOR_PIN`
- `V2_MIST_PASSWORD`

Do not commit the real `.env`.

Generate secrets on the VPS with, for example:

```bash
openssl rand -hex 32
```

Then launch:

```bash
cd /opt/korazero-stream-v2/infra/digitalocean
bash deploy.sh
```

## Verification before touching MorshLive

Container health:

```bash
docker compose ps
docker compose logs --tail=100 relay
docker compose logs --tail=100 mistserver
docker compose logs --tail=100 control
docker compose logs --tail=100 caddy
```

Public control:

```bash
curl -fsS https://v2.korazero.com/api/active
```

Open the operator remote:

```text
https://v2.korazero.com/remote.html
```

Use the configured operator PIN and switch **one** known channel first.

Suggested current remote IDs include:

- 3645 — beIN Sports 1
- 3644 — beIN Sports 2
- 3653 — beIN Sports 3
- 3652 — beIN Sports 4
- 3651 — beIN Sports 5
- 241362 — Thamanya 1
- 241363 — Thamanya 2
- 241364 — Thamanya 3
- 89778 — Al Kass 1
- 89779 — Al Kass 2
- 677 — ON Sport HD
- 244603 — Shasha Sport 2

The relay is deliberately configured with:

```text
V2_IPTV_CATALOG_MODE=true
V2_IPTV_MAX_ACTIVE_PULLS=1
```

so numeric channels can be chosen dynamically while the relay still enforces one active provider media pull globally.

After a successful switch, verify that the returned HLS manifest is under:

```text
https://mist-v2.korazero.com/hls/iptv-<stream-id>/index.m3u8
```

and that its media sequence continues advancing.

## Security invariants

- Provider credentials never leave the relay container environment.
- Relay port 8080 is not bound to the public host.
- Mist management port 4242 is not bound to the public host.
- Only Caddy exposes ports 80/443.
- The browser receives KoraZero-owned HTTPS HLS URLs, never provider URLs.
- Do not proxy Mist HLS through Cloudflare unless intentionally tested later.

## Cutover

Do not change MorshLive until the standalone remote and a real HLS stream pass.

Once verified, replace the old Railway control/Mist host assumptions in MorshLive with:

```text
https://v2.korazero.com
https://mist-v2.korazero.com
```

Run its V2 tests before merging that cutover.

## Rollback

The existing V2 application branch remains untouched:

```text
feature/gateway-control
```

All DigitalOcean deployment work is isolated on:

```text
deploy/digitalocean-v2-20261025
```

If the DigitalOcean cutover fails, do not merge the MorshLive endpoint changes. The application code on `feature/gateway-control` remains the known baseline.
