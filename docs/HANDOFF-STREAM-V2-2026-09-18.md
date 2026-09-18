# KoraZero Stream V2 — Exact Handoff
**Date:** 2026-09-18  
**Purpose:** Clean-room streaming-engine rebuild, isolated from legacy MorshLive/KoraZero streaming behavior.

---

## 0. Read this first

This project was intentionally created **separately** from the current KoraZero/MorshLive codebase.

**Hard rule:** the legacy repo is a visual/reference donor only. Do **not** copy old streaming JavaScript, proxy logic, mpegts.js lifecycle, child-player continuity, reconnect timers, provider resolver behavior, or old Lab behavior into V2.

The current priority is **streaming reliability first**. Do not spend time building the final SEO/frontend architecture yet. The old SEO plan exists separately and should be applied after the streaming path is proven.

The actual goal of V2 is:

```text
provider/synthetic MPEG-TS
        ↓
one server-side pull
        ↓
MistServer
        ↓
KoraZero-owned HLS
        ↓
native HLS on Safari / hls.js elsewhere
        ↓
many viewers
```

The browser must never talk directly to the IPTV provider.

---

# 1. Repository / branch

Repository:

```text
elmorshedy-del/KoraZero-StreamV2
```

GitHub:

```text
https://github.com/elmorshedy-del/KoraZero-StreamV2
```

Active development/deployment branch:

```text
feature/gateway-control
```

Current branch HEAD at handoff:

```text
d7babbf401cfa7d13b2b14fae70252398f4ab26d
```

Commit message:

```text
test: isolate legacy backoff from post-rearm grace
```

This is the commit currently deployed successfully on Railway `v2-control`.

---

# 2. Railway project

Railway project:

```text
Name: KoraZero Stream V2
Project ID: 4f2e9448-ae95-4ec7-aa66-65a044e41150
Workspace: deltasqueeze-dev's Projects
```

Environment:

```text
Name: production
Environment ID: cb6ec070-ddb1-4f7c-b07c-29bb167084d3
```

There are three services.

## 2.1 v2-control

```text
Service name: v2-control
Service ID: aa2721d0-b193-4574-8bc4-583607713e12
Source repo: elmorshedy-del/KoraZero-StreamV2
Branch: feature/gateway-control
Public domain: https://v2-control-production.up.railway.app
Builder: RAILPACK
Build command: npm test && npm run build
Runtime: Railway V2
Region: sfo
```

Current latest deployment:

```text
Deployment ID: 4bb32c76-bc3c-4987-95f3-8abe8449486f
Status: SUCCESS
Commit: d7babbf401cfa7d13b2b14fae70252398f4ab26d
```

Configured variable NAMES only — values are secrets / Railway config and must not be copied into git:

```text
V2_CHANNELS_JSON
V2_FANOUT_SOURCE_STATS_URL
V2_FANOUT_VIEWERS
V2_INTERNAL_TOKEN
V2_MIST_API_ENDPOINT
V2_MIST_BOOTSTRAP_ACCOUNT
V2_MIST_HLS_INTERNAL_BASE
V2_MIST_PASSWORD
V2_MIST_USERNAME
V2_PUBLIC_HLS_BASE
V2_RECOVERY_ATTEMPTS
V2_RECOVERY_DELAY_MS
V2_RECOVERY_SOURCE_CONTROL_TOKEN
V2_RECOVERY_SOURCE_CONTROL_URL
V2_SMOKE_TEST_CHANNEL
```

## 2.2 v2-mist

```text
Service name: v2-mist
Service ID: da1333a1-4ccd-44e9-a4d7-eca43e0c66f5
Image: ddvtech/mistserver:latest
Public domain: https://v2-mist-production.up.railway.app
Public target port: 8080
Mist API port: 4242 — private-network use only
Start command: MistController
Runtime: Railway V2
Region: sfo
```

Latest deployment:

```text
Deployment ID: 736691a1-d5a3-4b93-833b-8e426fea689f
Status: SUCCESS
```

Variable names:

```text
MIST_ADMIN_USER
MIST_ADMIN_PASSWORD
```

Do not expose the Mist API port 4242 publicly.

### Important Mist limitation seen on Railway

Mist logs warn that Railway exposes only about **60 MiB /dev/shm** to the container by default.

Mist says it relies heavily on shared memory and prefers much more. This has not prevented the current synthetic tests from working, but it is a real production-capacity concern and must be revisited before scaling many channels/viewers.

## 2.3 v2-test-source

```text
Service name: v2-test-source
Service ID: 2585f1fa-be75-4fa4-b784-f785e13b01c9
Source repo: elmorshedy-del/KoraZero-StreamV2
Branch: feature/gateway-control
Dockerfile: infra/test-source/Dockerfile
Public domain: https://v2-test-source-production.up.railway.app
Public target port: 8080
Runtime: Railway V2
Region: sfo
```

Latest deployment:

```text
Deployment ID: 3fcee888-ebf2-4d61-b312-7a78c9354b06
Status: SUCCESS
```

Variables:

```text
PORT
TEST_SOURCE_CONTROL_TOKEN
```

### Railway staged-change warning

At handoff, Railway reports **one staged change** associated with `v2-test-source`:

```text
Patch ID: 80746dad-7067-42e8-a167-05d5156ce7ce
Status: STAGED
changeCount: 1
```

The staged config shown by Railway contained:

```text
source.commitSha: null
```

Before making unrelated Railway changes, inspect this staged patch and either intentionally apply it or discard it. Do not blindly deploy staged configuration.

---

# 3. Current verified state — this is important

The most recent successful `v2-control` deployment is **green**.

Railway build gate:

```text
tests: 98
pass: 98
fail: 0
```

The build command is:

```bash
npm test && npm run build
```

Therefore both test suite and static build passed for the deployed commit.

## 3.1 HLS smoke is passing

Latest runtime startup log:

```text
V2 HLS smoke passed channel=test-ts status=200 bytes=1430
```

This proves the deployed control service can obtain a playable HLS playlist from Mist for the synthetic channel.

## 3.2 Fan-out is proven for 5 synthetic viewers

Latest runtime startup log:

```text
V2 fanout smoke passed channel=test-ts viewers=5 upstreamPulls=1 totalPulls=28
```

This is a major architecture proof.

Five concurrent simulated HLS consumers used:

```text
1 upstream pull
```

not five.

The smoke explicitly checks that `totalPulls` does not increase while the five viewers consume HLS segments.

## 3.3 Forced disconnect recovery is also passing

Latest successful recovery smoke:

```text
V2 recovery smoke passed
channel=test-ts
reconnectPulls=1
upstreamPulls=1
totalPulls=29
```

Measured timing:

```json
{
  "disconnectRequestMs": 3,
  "faultToZeroPullMs": 255,
  "faultToReconnectMs": 6356,
  "reconnectToPlayableMs": 12876,
  "faultToPlayableMs": 19232,
  "totalMs": 19239
}
```

Interpretation:

- source connection was killed intentionally;
- upstream count reached zero in ~255 ms;
- exactly **one** new upstream connection was created;
- no reconnect storm occurred;
- HLS became playable again;
- total synthetic recovery to playable media was ~19.2 seconds.

This is functional, but **19.2 seconds is not yet an acceptable final production target**. The next work should improve/understand this recovery time without recreating aggressive reconnect churn.

---

# 4. Why the current recovery code looks the way it does

Earlier recovery attempts were too aggressive.

A previous runtime showed repeated cycles such as:

```text
recovery-start
nuke-complete
Mist input did not exit after nuke
recovery-start
nuke-complete
...
```

Mist's `nuke_stream` uses MistUtilNuke asynchronously and may take several seconds to fully clean up a source.

The source supervisor therefore now has layered recovery timing.

Current defaults in `server/source-supervisor.js`:

```text
unhealthyThreshold = 2
nativeRecoveryGraceMs = 5000
postRearmGraceMs = 8000
baseBackoffMs = 2000
maxBackoffMs = 8000
intervalMs = 1000
inputExitPollMs = 100
inputExitTimeoutMs = 7000
```

## Current intended recovery philosophy

```text
source disturbance
      ↓
let Mist try native recovery
      ↓
5 second native recovery grace
      ↓
still unhealthy?
      ↓
fallback recovery
      ↓
nuke old Mist input
      ↓
wait for old input to actually exit
      ↓
re-arm source exactly once
      ↓
8 second post-rearm grace
      ↓
only then consider another destructive recovery
```

This is intentionally designed to stop the fallback supervisor from fighting Mist's own recovery.

---

# 5. Current source-supervisor health logic

File:

```text
server/source-supervisor.js
```

It tracks per channel:

```text
healthy
consecutiveUnhealthy
unhealthySince
recoveryAttempts
nextRecoveryAt
recoveryGraceUntil
lastMediaMs
```

Health uses:

1. whether Mist reports an active input;
2. whether Mist's media clock `lastms` progresses.

A source is not considered truly healthy merely because an input object exists if media time has stopped progressing.

---

# 6. Current startup order

File:

```text
server/index.js
```

Current order:

```text
createApp()
   ↓
bootstrap({ activateChannel: smokeChannel })
   ↓
HLS smoke
   ↓
fanout smoke
   ↓
sourceSupervisor.start()
   ↓
forced recovery smoke
   ↓
open public control/player listener on :8080
```

This is deliberate for the prototype: if the media path fails its startup gates, the public control/player service does not claim to be healthy.

---

# 7. Synthetic test source

Files:

```text
infra/test-source/server.mjs
infra/test-source/Dockerfile
```

It generates a real H.264/AAC MPEG-TS stream with ffmpeg:

```text
video: H.264
1280x720
25 fps
~1.8 Mbps

audio: AAC
48 kHz
stereo
128 kbps

container: MPEG-TS
```

Endpoints:

```text
GET  /health
GET  /stats
GET  /live.ts
HEAD /live.ts
POST /control/disconnect   [Bearer token required]
```

`/stats` reports:

```text
activePulls
totalPulls
maxConcurrentPulls
headRequests
```

Keep this fixture. It is the main regression/fault-injection tool.

---

# 8. MistServer API/authentication

Files:

```text
server/mist-api.js
server/runtime-config.js
```

Mist API is private.

The adapter implements Mist's challenge-response:

```text
MD5( MD5(password) + challenge )
```

Fresh Mist instances can return `NOACC`. V2 supports first-account creation only when explicitly enabled:

```text
V2_MIST_BOOTSTRAP_ACCOUNT=true
```

After account creation, normal challenge-response is used.

Do not make port 4242 public.

---

# 9. Browser/player architecture

Files:

```text
src/player/player-controller.js
src/player/hls-adapter.js
src/player/playback-descriptor.js
src/player/watch-entry.js
src/player/lab-entry.js
src/player/session-telemetry.js
```

Rules:

- Safari/native-HLS capable browser → native HLS.
- Other supported browsers → hls.js.
- No mpegts.js.
- No old KoraZero child-player wrapper.
- No separate Lab player.
- Watch and Lab import the same player controller.
- Lab adds diagnostics only.

The browser receives only KoraZero-owned HLS, never raw provider URLs.

---

# 10. Public URLs

Control/player shell:

```text
https://v2-control-production.up.railway.app
```

Mist public media base:

```text
https://v2-mist-production.up.railway.app
```

Synthetic source:

```text
https://v2-test-source-production.up.railway.app
```

Expected test HLS:

```text
https://v2-mist-production.up.railway.app/hls/test-ts/index.m3u8
```

Manual player test:

```text
https://v2-control-production.up.railway.app/watch.html?channel=test-ts
```

---

# 11. Important recent commits

```text
8131876458e3f597e3db082cb7f16f7d9773bba9
feat: bootstrap first private Mist account safely
```

```text
4537c730542bd20ca42cae3d79579e3b846e502b
feat: add synthetic source readiness endpoint
```

```text
793deb4fb05b343d755b8da5cc7962f4af37a616
test: tolerate transient zero upstream before fanout
```

```text
4c789bc27c512400ff9fce375c66dfb629c6fa33
fix: wait for upstream readiness before fanout smoke
```

```text
ebd63af06b2e12023c4385aa7356d16f69c40ca9
test: define layered Mist recovery grace
```

```text
90fd5a8d85ffc9f29b1c7b85a827fc9ea9c70c21
fix: layer fallback recovery behind Mist grace
```

At `90fd5a8...`, one legacy backoff test failed because it still expected a second destructive reset before the new post-rearm grace expired:

```text
tests 98
pass 97
fail 1
```

Current known-good:

```text
d7babbf401cfa7d13b2b14fae70252398f4ab26d
test: isolate legacy backoff from post-rearm grace
```

Current Railway build:

```text
tests 98
pass 98
fail 0
deployment SUCCESS
```

---

# 12. What is NOT done yet

## A. Long-run synthetic soak

Run V2 with no induced faults.

Verify:

```text
activePulls == 1
maxConcurrentPulls == 1
```

and ensure:

- no spontaneous fallback nukes;
- no unexplained totalPulls growth;
- HLS remains playable;
- media clock progresses;
- no supervisor error loop.

## B. Improve recovery latency carefully

Current forced hard-disconnect recovery is ~19.2 seconds.

Break the delay into:

```text
native recovery grace
Mist input cleanup
source reconnect
HLS segment availability
browser visibility
```

Do not simply lower everything aggressively.

Preserve:

```text
reconnectPulls == 1
maxConcurrentPulls == 1
no storm
```

## C. Real browser validation

First:

```text
iPhone Safari
```

Open:

```text
https://v2-control-production.up.railway.app/watch.html?channel=test-ts
```

Then branded Chrome/Edge if available.

Confirm real playback, not merely playlist fetching.

## D. Browser fault test

While a real browser is playing `test-ts`, induce one synthetic disconnect and measure:

- visible freeze duration;
- buffer before failure;
- whether the video element stays attached;
- native-HLS/hls.js behavior;
- time until playback resumes.

Do not add new recovery logic before observing this.

## E. Only after synthetic/browser proof: one real provider H264/AAC channel

Keep `test-ts`.

Add a separate real provider H264/AAC source server-side.

Test:

```text
1 viewer
2 viewers
5 viewers
```

Confirm same-channel viewers still create only one provider pull.

Do not test while the existing provider line is actively being used if connection limits may matter.

## F. HEVC later

Only after H264 works, test:

```text
7053 — beIN_Sport_1_H265 — H265 / 8M
```

---

# 13. Things NOT to do

Do not:

- copy old MorshLive streaming code;
- bring back mpegts.js as primary player;
- bring back child-player continuity;
- create a separate Lab player;
- expose provider URLs/credentials to browser;
- expose Mist 4242 publicly;
- return to infinite 700 ms reconnect loops;
- build final SEO/team/league frontend now;
- merge V2 into production yet;
- remove synthetic fault fixture;
- nuke a newly rearmed source before grace ends.

---

# 14. Files to inspect first in the next chat

```text
server/source-supervisor.js
server/hls-smoke.js
server/index.js
server/app.js
server/mist-api.js
server/gateway-service.js
server/runtime-config.js

infra/test-source/server.mjs
infra/test-source/Dockerfile

src/player/player-controller.js
src/player/hls-adapter.js
src/player/playback-descriptor.js
src/player/watch-entry.js
src/player/lab-entry.js

tests/source-supervisor.test.js
tests/fanout-smoke.test.js
tests/mist-api.test.js
tests/player-recovery.test.js
```

Also inspect Railway deployment:

```text
4bb32c76-bc3c-4987-95f3-8abe8449486f
```

It is the current known-good integrated synthetic run.

---

# 15. Immediate next action

```text
1. Inspect/resolve Railway staged patch 80746dad-7067-42e8-a167-05d5156ce7ce.
2. Check current logs for all three services.
3. Run a no-fault synthetic soak.
4. Confirm activePulls=1 / maxConcurrentPulls=1 / totalPulls stable.
5. Open test-ts on real iPhone Safari.
6. Run one controlled synthetic disconnect while Safari is playing.
7. Measure visible interruption against gateway timings.
8. Only then add one real H264/AAC provider channel.
```

---

# 16. Bottom line

Already demonstrated:

```text
Synthetic MPEG-TS
      ↓
MistServer
      ↓
KoraZero HLS
      ↓
5 viewers
      ↓
exactly 1 upstream pull
```

Forced source disconnect:

```text
exactly 1 reconnect
```

Current main unresolved engineering questions:

```text
Can it stay stable for long periods?
Can recovery be faster without becoming aggressive?
How does it behave in real iPhone Safari?
Then: does the same architecture work with one real provider H264 feed?
```

Continue there.