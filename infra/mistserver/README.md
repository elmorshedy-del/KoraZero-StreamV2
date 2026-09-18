# MistServer gateway prototype

This directory is intentionally source-agnostic. It boots the official `ddvtech/mistserver` image and exposes:

- `8080/tcp` — browser-facing HTTP/HLS output for local development;
- `4242/tcp` — MistServer management interface, bound to localhost only.

## Start locally

```bash
docker compose up -d
```

Open the management interface locally at `http://127.0.0.1:4242` for initial setup. Do not expose this port publicly.

## Expected V2 playback boundary

When a stream named `bein-1` is configured server-side, the browser-facing manifest is expected at:

```text
http://localhost:8080/hls/bein-1/index.m3u8
```

The exact authorized upstream URL is configured in MistServer/server-side control infrastructure and must never be put into `src/`, a query string used by production viewers, or committed documentation.

## What this skeleton does not do yet

- configure a production provider source;
- import the old Xtream resolver;
- implement source failover;
- transcode HEVC to H.264;
- expose MistServer management to the public internet.

Those are separate, testable gateway milestones.
