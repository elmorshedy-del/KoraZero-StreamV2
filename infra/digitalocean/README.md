# V2 DigitalOcean migration

Target only droplet **612468340**, `korazero-stream-v2`, **134.209.36.189**.
Source is `feature/gateway-control` at `f869e2f1e5cf52385d411a9360d585cb7052c6d0`.
This directory adds deployment configuration only. It does not change the runtime.

## Current checkpoint (2026-10-25)

Prepared locally, not deployed. Application suite before/after: 192 passed.
Local Docker validation with non-provider fixtures: relay, Mist and control healthy;
Caddy served `/api/active` and `/remote.html` with HTTP 200. `/api2`, `/stats`, and
`/internal/*` returned 404. Private authenticated Mist access and relay alias/health
worked, with zero provider attempts. Compose and Caddy validation passed. Non-root
image file ownership and Mist/control startup ordering were verified by startup.
Fixture environment files were removed after validation. No live playback tested.
Railway connection requires reauthentication. No coldtrader private key is available
in this workspace. Initial SSH attempt returned connection refused.
A new key lives outside git at `/workspace/shared/ssh/korazero_v2` (private) and
`/workspace/shared/ssh/korazero_v2.pub` (public). Do not commit or publish the private key.
No MorshLive URLs have been changed. No remote infrastructure has been modified.

## Configuration recovery

Read Railway production project `4f2e9448-ae95-4ec7-aa66-65a044e41150`, environment
`cb6ec070-ddb1-4f7c-b07c-29bb167084d3`:

- relay: `bab59387-c11f-4e39-bfeb-55b6b116e740`
- control: `aa2721d0-b193-4574-8bc4-583607713e12`
- Mist: `da1333a1-4ccd-44e9-a4d7-eca43e0c66f5`
- discover second relay if control's account JSON names one.

Retrieve values into mode-600 files without printing them. OAuth may expose only
variable names; in that case use an authorized Railway CLI session or the owner's
existing password manager/config export. Never invent provider credentials.

Required unrecovered provider values: `V2_IPTV_PORTAL_URL`, `V2_IPTV_USERNAME`,
`V2_IPTV_PASSWORD` (each account). Also recover allowed IDs/catalog mode,
max-active-pulls, audio delay, channel registry, account JSON, emergency and
scheduler flags. Do not infer current configuration from the September handoff.
October companion handoff names `3645` as beIN 1; verify using recovered catalog.

Recover `V2_INTERNAL_TOKEN`, `V2_OPERATOR_PIN`, `V2_MIST_USERNAME` and
`V2_MIST_PASSWORD`, or explicitly create fresh random local management secrets for
this fresh instance and update authorized integrations. Provider secrets cannot
be regenerated locally. Environment templates deliberately leave values blank.

Compose requires >= 2.30 for raw environment files. Copy `relay.env.example` to
`relay.env`, `control.env.example` to `control.env`, fill recovered values, chmod
600 both. Values are literal (no wrapping quotes, shell expansion or sourcing).
The Docker build copies only package.json, server and src; .dockerignore also
excludes environment files. Only relay receives provider credentials.
`V2_PUBLIC_HLS_BASE` includes `/hls`. `V2_MIST_API_ENDPOINT` is forced internally.
`V2_CHANNELS_JSON` sources must point to relay aliases, never raw provider URLs.

For two recovered accounts, copy account B values into `relay-b.env`, preserve
control's account JSON and start with `--profile second-account`. The optional
second relay has its own environment and private alias. Never reuse account A's
credentials as B. Wait for B's health before control startup/account verification.
This preserves existing concurrency and fingerprint guards.

## Host setup and start (after access is restored)

1. SSH to this droplet only. Verify `/etc/os-release`, hostname, existing containers
   and listeners before installing anything. Do not replace an existing deployment.
2. Install Docker Engine + Compose plugin from the official Docker Ubuntu apt repo
   if absent; enable Docker. Allow inbound TCP 22,80,443 and optional UDP 443 in the
   host/cloud firewall. Do not open 4242,8080,8787 or relay ports.
3. Clone this repository's migration branch under `/opt/korazero-stream-v2`; verify
   its ancestor is the production commit above. Do not deploy main. Do not place a
   GitHub token in a remote URL; alternatively transfer a clean git archive.
4. Populate the private environment files above using secure transfer.
5. From `infra/digitalocean`, run `docker compose config --quiet` (never print the
   rendered config, which contains secrets). Build: `docker compose build`.
6. `docker compose up -d v2-iptv-relay v2-mist`. If account B was recovered, run
   `docker compose --profile second-account up -d v2-iptv-relay-b` and wait healthy.
7. `docker compose up -d v2-control caddy` (add the profile for subsequent full-stack
   operations if using B). `docker compose ps` must show healthy app/Mist/relay.

Public candidate base initially `http://134.209.36.189/hls`, control
`http://134.209.36.189`. These are planned addresses, not verified live endpoints.
Caddy forwards only `/hls/*` to Mist's HTTP output; all management and relay
routes are blocked. `/internal/*` control operations remain available only from
inside the network. Operator endpoints retain existing PIN authentication.
No Caddy access logs are enabled. Mist config persists in the named volume;
management is explicitly bound inside the container and has no published port.
The 1 GB shared-memory cap avoids the old 4 GB setting on this 4 GB machine.

## Verification before integration

- `docker compose ps`; inspect health statuses and sanitized logs locally. Do not
  paste raw environment, config backup, credential-bearing errors or logs into chat.
- `docker compose exec -T v2-control node -e "fetch('http://v2-iptv-relay.railway.internal:8080/health').then(async r=>console.log(r.status,await r.text()))"`
- From the control container, use existing `createMistApi` and its environment to
  read configured stream names; success proves authenticated private API access.
- From outside VPS verify ports 4242,8080,8787 are closed; HTTP `/api2`, `/internal/`,
  `/stats`, `/account` return 404; `/api/active` returns sanitized JSON.
- Before media activation inspect private relay `/account` and identify existing
  account usage. Do not create a competing test pull or stop unrelated streams.
- Use PIN-authenticated `/operator/switch/3645` only after catalog confirms beIN 1;
  for explicit account slots supply `?slot=a`. Use existing operator UI or a secret
  header from a protected file; do not put PINs in URLs/history. No direct-provider
  ffprobe: probe Mist's HLS output only.
- Fetch `/hls/iptv-3645/index.m3u8`; follow its variant to a media playlist. Record
  sequence, fetch segments, repeat after at least two target durations and prove
  sequence advances. `ffprobe` must find video + audio; `ffmpeg` must decode a
  sample. Open the control player and a real Safari/iPhone for device verification.
- Observe private `/stats` before/after several HLS viewers: intended stream has
  `activePulls=1`, no extra provider opens caused by viewers. Look for real byte
  growth and keepalive/recovery counters during a naturally occurring gap. Do not
  disrupt today's stream to inject a provider failure. Existing automated tests
  cover reframing, null keepalive and HLS recovery; live behavior remains a
  separate check.
- Inspect public descriptors/manifests and protected local logs against actual
  credentials without printing matches; verify no provider URL/secret leaks.
- `npm test` before and after any runtime changes; current migration has none.

## HTTPS then coherent KoraZero cutover

HTTP suffices for isolated VPS tests. Production korazero.com requires HTTPS
because its fail-closed validators and browsers reject HTTP/mixed-content HLS.
Point a chosen domain's A record at 134.209.36.189, set `V2_PUBLIC_ADDRESS` in the
untracked Compose `.env` to that hostname, update control's HLS base to
`https://<hostname>/hls`, then recreate control and Caddy. Verify TLS and HLS first.
Do not broaden the website's validators to arbitrary hosts to avoid this step.

Before modifying MorshLive, record its HEAD as an immutable rollback checkpoint.
Read its root/backend AGENTS.md and stream-lock requirements. Change the exact
trusted host coherently in `backend/services/stream-plan.js`, `assets/js/watch.js`,
`assets/js/data.js`, `assets/data/v2-bein-vega.json`, binding generator and generated
plans/bindings where present, operator links, relevant tests and versioned HTML
asset references. Search both literal hosts and escaped regexes; retain
`/hls/iptv-<digits>/index.m3u8`. Set `V2_CONTROL_ACTIVE_URL` if overriding the
Worker default. Run existing tests before/after and required lint/lock checks.
Verify live match plan, actual player request, playlist, segments and device HLS.
Do not switch KoraZero to an unverified VPS.

## Rollback

No production cutover has happened at this checkpoint, so nothing needs reverting.
After deployment, from this directory on **this droplet only**:

```
docker compose --profile second-account stop caddy v2-control v2-mist v2-iptv-relay v2-iptv-relay-b
```

This releases V2's new provider pulls and preserves config volumes. Do not use
`down -v`. To undo only a later website cutover, revert its dedicated MorshLive
cutover commit (do not reset the entire tree), restore any changed Worker
`V2_CONTROL_ACTIVE_URL` to its recorded old value, deploy using its normal process,
and verify live asset URLs. Railway resources remain untouched, but restoring
Railway URLs is useful only if Railway is operational. Verify the VPS pull has
closed before reactivating Railway; avoid duplicate provider sessions.

Local harness note: Docker injects a proxy here. Local validation added internal
service names to NO_PROXY in a scratch-only Compose override; the VPS does not
need this unless it also configures an outbound HTTP proxy.
