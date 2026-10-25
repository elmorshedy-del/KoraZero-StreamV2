# DigitalOcean V2 migration implementation plan

Goal: move feature/gateway-control to existing droplet 612468340 (134.209.36.189).
Architecture: preserve relay → official Mist → HLS and control; use Docker aliases for Railway private names and Caddy for public access. No application logic changes.
Spec: user's migration request, docs/HANDOFF-STREAM-V2-2026-09-18.md and MorshLive/docs/HANDOFF-V2-SECOND-ACCOUNT.md.

- [x] Clone production branch and inspect runtime, relay, recovery, gateway, control, Mist and companion handoffs.
- [x] Run baseline suite: 192/192 passed.
- [x] Add infra/digitalocean Compose, Caddy, environment templates, runbook. Validate Compose and Caddy, run unchanged application suite.
- [x] Checkpoint migration files before any MorshLive integration change.
- [ ] Obtain SSH access and recovered provider configuration, install Docker on existing droplet only, deploy.
- [ ] Verify internal health, port isolation, one beIN pull, advancing HLS and decodable audio/video; inspect sanitized counters and browser playback.
- [ ] Update MorshLive URL validators, data, generated bindings and tests together only after independent V2 success and HTTPS. Run companion tests before/after and retain rollback checkpoint.

Constraints: no credentials in git; no public 4242 or relay; no changes to concurrency or unrelated infrastructure; no Railway deletion; do not deploy main.
Review focus: preserve optional second-account topology; do not turn on emergency or automatic schedule flags without recovered settings; no broad Mist proxy exposing management; HTTPS needed for live HTTPS website; recovered channels must reference private relay URLs.

Status: Railway app requires reauthentication. Workspace has no coldtrader private key or agent. New migration key generated outside repo. SSH attempt returned connection refused. No remote changes performed.
Ruling: prepare configuration locally while access is blocked; retain runtime Railway aliases, application code, and MorshLive unchanged until real stream verification.

Validation: Compose config and Caddy validate passed; local stack healthy, public active/UI HTTP 200, protected paths 404, private API and relay DNS verified, provider attempts 0. Full suite 192/192 before and after. No live playback.
