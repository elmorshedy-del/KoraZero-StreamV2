# KoraZero Stream V2 — Current Handoff
**Date:** 2026-09-18  
**Purpose:** Exact continuation state after real-provider playback, stress testing, two-channel experiments, and the current one-slot/multi-beIN investigation.

---

# 0. Read this first — exact scope

This handoff is for **KoraZero Stream V2**.

The active architecture is:

```text
authorized IPTV service
        ↓
private V2 relay
        ↓
MistServer
        ↓
KoraZero-owned HLS
        ↓
viewers
```

The browser must never receive raw provider credentials or raw provider URLs.

The current user goal is specifically:

> **Serve multiple different beIN channels simultaneously from the same IPTV service/account the user supplied, while engineering around the account's one-connection constraint if there is a legitimate technical way to do so.**

Important scope correction:

- **IPTV Lab / MorshLive is not the thing being built.**
- It is legacy diagnostic/reference material only.
- It may be consulted for historical observations, sanitized metadata, stream IDs, or old experiments.
- Do not turn IPTV Lab into a V2 runtime dependency.
- Do not pivot to YouTube, satellite, alternate broadcasters, or other outside content sources unless the user explicitly asks. The present problem is about the supplied IPTV service.

---

# 1. Repository / branch / deployed HEAD

Repository:

```text
elmorshedy-del/KoraZero-StreamV2
```

Active branch:

```text
feature/gateway-control
```

Current HEAD before this handoff commit:

```text
692b1983f3ae7681f83e9efa8a329c0b31949747
docs: record SPTS multiplex investigation
```

Latest integrated Railway build at that HEAD:

```text
tests: 114
pass: 114
fail: 0
```

Current successful deployments:

```text
v2-control
  service: aa2721d0-b193-4574-8bc4-583607713e12
  deployment: 575c6ec5-732b-4745-89ec-1e3f85ca93b4
  status: SUCCESS
  commit: 692b1983f3ae7681f83e9efa8a329c0b31949747

v2-mist
  service: da1333a1-4ccd-44e9-a4d7-eca43e0c66f5
  deployment: 736691a1-d5a3-4b93-833b-8e426fea689f
  status: SUCCESS

v2-iptv-relay
  service: bab59387-c11f-4e39-bfeb-55b6b116e740
  deployment: dbcb8f76-b778-428d-abd1-e4d49c380c11
  status: SUCCESS
  commit: 692b1983f3ae7681f83e9efa8a329c0b31949747
```

Stress/observer services still exist:

```text
v2-stress-monitor
  59b0aafa-d98e-4f90-ad64-8f648e7859d3

v2-stress-canary
  35c10fd4-47b3-43e1-96d6-9b69f536df90

v2-load-a
  3c8d3e04-0d1f-4369-b32a-4ecae6aa5064

v2-load-b
  15bcc74b-e174-427b-b331-de31d0f38ec1

v2-load-c
  b37a64b7-a7c-4824-8d28-eae13efa6464

v2-load-d
  1cdea224-a607-41f9-bd98-a9537172db85
```

Railway project:

```text
Project ID: 4f2e9448-ae95-4ec7-aa66-65a044e41150
Environment ID: cb6ec070-ddb1-4f7c-b07c-29bb167084d3
```

---

# 2. Real IPTV path — what was solved

The first real provider path used stream:

```text
3974 — ON E [EG]
```

This was intentionally used only as an H.264/AAC control source. It is **not** the ultimate content target. The real future target is multiple beIN channels.

## 2.1 Original Mist failure

MistServer's HTTP input path performs a HEAD request first.

The provider media endpoint/redirect chain did not behave correctly under Mist's HEAD-first logic. Earlier Mist logs showed failures equivalent to:

```text
Error getting URI info
```

Provider diagnostics showed that ordinary GET with redirect following could reach the media origin successfully.

## 2.2 Private relay introduced

A private Railway service was added:

```text
v2-iptv-relay
```

Purpose:

- give Mist a stable internal KoraZero-owned URL;
- answer Mist HEAD locally;
- open the provider only with GET;
- follow provider redirect/CDN handoff internally;
- keep credentials out of Mist logs;
- enforce upstream-pull invariants.

Mist therefore sees:

```text
http://v2-iptv-relay.railway.internal:8080/live/<stream>.ts
```

not a credential-bearing provider URL.

## 2.3 Provider required Range for prompt media

A plain GET could reach the final media origin but sometimes produced no media before Mist's short timeout.

The provider was empirically tested with:

```text
Range: bytes=0-13159
```

and then:

```text
Range: bytes=0-
```

Open-ended range produced first media in under a second and continued streaming without a finite Content-Length/Content-Range.

The permanent relay therefore uses:

```text
Range: bytes=0-
```

## 2.4 Remaining 5-second freeze was identified exactly

Safari and Chrome initially played for roughly 5–10 seconds, then froze on the last frame.

The sequence was:

```text
provider media gap
    ↓
Mist Downloader receives insufficient bytes for >5 s
    ↓
Mist input timeout
    ↓
HLS playlist stops advancing
    ↓
Safari/Chrome freezes
```

Mist's downloader resets its timeout only after a substantial amount of new data, not merely a tiny keepalive.

## 2.5 TS null-packet keepalive fix

The relay was changed to:

1. reframe provider data onto exact 188-byte MPEG-TS packet boundaries;
2. during provider silence, inject valid MPEG-TS null packets:
   - PID 0x1FFF
   - no audio/video payload;
   - ignored by decoders;
3. emit enough null-packet bytes to keep Mist's HTTP reader alive.

Commit:

```text
40275a1e18b6a360ba3b27810d64ad2601bb27fa
fix: keep Mist TS input alive across provider gaps
```

The user then tested the real player manually:

- iPhone Safari: smooth
- Chrome: smooth

This validated the full real path:

```text
IPTV provider
→ private relay
→ Mist
→ HLS
→ Safari/Chrome
```

---

# 3. Relay observability and one-upstream proof

The original relay statistics were too ambiguous for serious load experiments.

New precise counters were added:

```text
providerAttempts
successfulProviderOpens
failedProviderOpens
rejectedConcurrentPulls
activePulls
realBytes
keepaliveBursts
keepaliveBytes
```

Commit sequence:

```text
08a7feb03e9577d7dd638bd2c53b131dea3dc5ca
test: require precise provider pull observability

010b371529b0998c502552cda6a857332edc16c4
feat: expose precise provider pull counters
```

The full suite went green.

---

# 4. Scientific stress experiment — one channel

Full experiment record:

```text
docs/experiments/2026-09-18-hls-load-capacity.md
```

Use that document for raw shard-level values and exact timing.

## 4.1 10 viewers

Result: passed.

Representative totals:

```text
segment successes: 442
segment failures: 1
playlist successes: 403
playlist failures: 2
provider successful opens: stayed at 1
active provider pulls: stayed at 1
```

## 4.2 50 viewers

Two independent load shards, 25 each.

Result: strong pass.

Combined:

```text
viewers: 50
segment successes: 2564
segment failures: 0
playlist successes: 2345
playlist failures: 1
provider successful opens: 1
active provider pulls: 1
```

Mist was nowhere near CPU/RAM limits.

## 4.3 First 100-viewer run failed

Four independent load shards, 25 each.

Combined Phase 1 result:

```text
viewers: 100
segment successes: 4716
segment failures: 215
playlist successes: 3795
playlist failures: 306
worst continuity gaps: roughly 20–38 s
```

Provider remained healthy:

```text
successfulProviderOpens: 1
activePulls: 1
```

Railway CPU/RAM were not exhausted.

Mist emitted:

```text
Could not open session semaphore; aborting!
```

So the failure was downstream of the provider.

---

# 5. 100-viewer failure root cause and fix

MistServer source inspection showed default viewer-session mode:

```text
14 decimal = 0b1110
= stream + viewer IP + client token
```

Railway places Mist behind internal proxy hops.

Mist logs showed untrusted forwarded-address behavior and changing internal proxy addresses.

This made viewer IP a bad component of session identity.

## 5.1 Fix

Viewer session mode changed to:

```text
10 decimal = 0b1010
= stream + client token
```

Viewer IP is excluded.

TDD/implementation commits:

```text
815585df44ef8c9f04caa21ec807b5a09496d64a
test: require stable Mist viewer session identity

555aa17b430e5a32e1979810df6bb80ebffc4e74
feat: support stable Mist viewer session mode

277198535374d3e64ec1c81f5c18f53bbbba0783
test: require stable viewer mode at bootstrap

ea2a24c1fe1001a422db63d7d75de3a1b7de984c
fix: stabilize Mist viewer identity behind proxy

66d9255df107d7e6957378aa9b17806723ee384c
test: account for viewer session bootstrap
```

Bootstrap now enforces mode 10 persistently before channel registration.

## 5.2 Replicated 100-viewer A/B

Same load shape:

```text
4 shards
25 viewers/shard
100 total
60 s/viewer
15 s steady join spread
```

Phase 2 combined result:

```text
segment successes: 5322
segment failures: 0
playlist successes: 3735
playlist failures: 0
root failures: 0
bytes delivered: 2,255,915,400
provider active pulls: 1
provider successful opens: 1
Mist semaphore failures: 0
Mist FAIL-level events: 0
```

Worst load-shard continuity gap:

```text
6.939 s
```

The original 100-viewer serving failure is therefore fixed.

---

# 6. Remaining viewer-token hardening

After the successful 100-viewer run, Mist access logs still occasionally coalesced more than one synthetic User-Agent into one internal statistical session.

Therefore one follow-up remains:

- generate an explicit stable random non-secret `tkn` for each browser/player session;
- append it to the root HLS request;
- preserve it through player recovery;
- give every synthetic stress viewer a unique explicit token;
- rerun 100 viewers;
- verify both playback health and one-logical-viewer/one-session identity.

This was approved by the user, but **was intentionally postponed when the user asked to investigate multiple channels first**.

Do not claim it is completed.

---

# 7. Multi-channel relay work

User then asked to run two different channels simultaneously.

Initial test channels:

```text
3974 — ON E [EG]               (control only)
2454 — beIN Sport 2 HD Q       (real beIN target family)
```

The existing relay originally had one global active-pull lock, so it could not even test two distinct channels correctly.

## 7.1 Per-stream relay locks/counters

TDD:

```text
7247c18bfbf52d0cb8f58fc64dd3800ee994fef8
test: require independent multi-channel relay pulls

2a10dbf97c85a3b8557fa313aeedfef40eda2bac
feat: isolate relay pulls per IPTV channel
```

Relay now:

- accepts an allowlist of stream IDs;
- permits one active upstream pull **per stream**;
- rejects duplicate pulls of the same stream;
- exposes aggregate + per-stream counters.

The current experimental relay allowlist includes:

```text
3974
2454
```

The current control-plane experiment also registers a second logical V2 channel:

```text
bein-1 → stream 3974
bein-2 → stream 2454
```

Note: logical id `bein-1` is a stale test alias and currently maps to ON E 3974. Do not infer content name from that logical id.

---

# 8. Two-channel 5+5 experiment

Experiment:

```text
5 HLS viewers on 3974
5 HLS viewers on 2454
60 seconds
steady joins
```

The relay successfully demonstrated, momentarily:

```text
global activePulls = 2

3974.activePulls = 1
2454.activePulls = 1
```

Therefore **the V2 relay itself can hold two distinct provider streams at the same time**.

However, the IPTV account reports:

```text
maxConnections = 1
```

Under the 5+5 experiment, provider sessions began contending/reopening.

Representative post-run totals:

```text
provider attempts: 36
successful opens: 11
failed opens: 25
active pulls: 1
```

Channel 3974:

```text
5 viewers
150 segment successes
0 segment failures
16 playlist failures
worst gap ~15.5 s
not healthy
```

Channel 2454:

```text
5 viewers
30 root failures
0 playlist successes
0 segment successes
0 bytes
```

Mist logged repeated inability to keep the second stream connected.

Conclusion:

- the V2 multi-stream relay works;
- the supplied IPTV account's normal per-channel media path does not sustain two simultaneous live stream sessions under its one-connection account limit.

Do **not** scale this normal two-live-request method to 50+50 or 100+100.

---

# 9. MPTS/SPTS investigation

The user correctly pushed back that there may still be an engineering solution under one provider connection.

The first legitimate possibility investigated was:

```text
one upstream MPEG-TS connection
containing several programs
→ local PAT/PMT demux
→ multiple channels
```

That requires the provider feed to be MPTS.

## 9.1 Passive PAT parser added

The relay was instrumented to inspect the PAT from bytes it already receives.

It exposes:

```text
transportPrograms
transportProgramCount
transportKind = spts | mpts
```

No second provider request is needed.

Commits:

```text
94b0f0b2836b3a29feba2baaedacd0760617f312
test: detect SPTS vs MPTS from live transport PAT

2287fbc065d96ccf3d8d66eb50fbad1bf490bcdb
feat: inspect live TS program map passively
```

Tests:

```text
114 pass
0 fail
```

## 9.2 Live result for 3974

Observed:

```json
{
  "transportPrograms": [
    {
      "programNumber": 1,
      "pmtPid": 4096
    }
  ],
  "transportProgramCount": 1,
  "transportKind": "spts"
}
```

Therefore the normal 3974 media URL carries **one program only**.

It does not contain hidden additional channels that can be locally demultiplexed.

The provider catalog was also searched for obvious aggregate naming:

```text
MPTS
mux
bouquet
multi
```

No actual aggregate/multiplex source was found in the visible catalog.

---

# 10. Other one-slot engineering routes considered

These were explored conceptually because the user wants a genuine engineering solution, not an immediate “buy another slot” answer.

## 10.1 Catch-up/archive time division

Idea:

- keep only one provider session at a time;
- alternate between channels;
- fetch slightly-behind-live archived chunks;
- maintain local buffers for each channel.

Blocked for the tested channels because provider metadata reports:

```text
tvArchive = 0
```

for the relevant streams.

No rewindable source is exposed.

## 10.2 True HLS segment time division

Potentially promising idea:

If the provider's `.m3u8` output for beIN is **real segmented HLS**, a scheduler might be able to:

```text
fetch short A segment(s)
close/reuse slot
fetch short B segment(s)
close/reuse slot
repeat
```

while local buffers feed Mist continuously.

This would preserve one active provider media session at a time and trade latency/buffer depth for multiple channels.

This is the exact investigation that was in progress when work stopped.

Important facts:

- account reports allowed output formats:
  - `m3u8`
  - `ts`
- MorshLive adapter code explicitly tries real HLS first and falls back to TS only when HLS is not a genuine playable `#EXTM3U` manifest/segment path;
- earlier probe for stream 3974 resolved to protocol `ts`, meaning its HLS path was not usable as genuine HLS;
- **beIN streams 2449/2454 still need this exact HLS-shape test**.

## 10.3 Socket-sharing tricks

Do not confuse HTTP/TCP connection reuse with an authorized media-session multiplex.

The old IPTV Lab code contains a measured historical observation for this same one-slot line:

> starting a second real `/live/...` request closes the player's stream roughly 3 seconds later and can leave a ghost session.

Therefore merely tunneling two stream IDs through one local socket/proxy is not a sound solution if the provider accounts them as separate live media sessions.

The goal must remain a real one-session media strategy, not disguising two sessions.

---

# 11. Exact point where work stopped

The active research question was:

> **Do beIN streams 2449 and/or 2454 expose genuine segmented HLS through this same IPTV account, such that a one-slot sequential segment scheduler could alternate channels while local buffers make both outputs continuous?**

Relevant channels:

```text
2449 — beIN Sport 1 HD Q
2454 — beIN Sport 2 HD Q
```

A direct HLS-shape probe was intentionally guarded by the provider's account status.

At the last check:

```text
maxConnections = 1
activeConnections = 1
```

The V2 relay had just been freshly deployed and its logs showed **zero upstream-open events**, so that active connection was not opened by the current relay process.

Therefore the diagnostic correctly refused to open another provider media session.

### Do not blindly kill that connection

First determine whether:

- it is a stale/ghost provider session from the earlier tests;
- some older KoraZero/MorshLive process still holds it;
- the user is actively using the IPTV account elsewhere.

Only run the HLS-shape probe once the slot is genuinely free or the holder is known.

---

# 12. Exact next experiment

Once:

```text
activeConnections = 0
```

test **one beIN stream at a time**, sequentially.

Recommended order:

```text
2449 — beIN Sport 1 HD Q
2454 — beIN Sport 2 HD Q
```

For each:

1. obtain the exact playlist-resolved `.m3u8` source using the provider's own playlist mapping;
2. GET the manifest only;
3. inspect:
   - HTTP status;
   - Content-Type;
   - does body begin `#EXTM3U`?
   - `#EXT-X-TARGETDURATION`
   - `#EXTINF`
   - segment count/window;
   - media sequence;
4. fetch **one segment only**;
5. close everything;
6. wait for provider `activeConnections` to return to 0;
7. repeat for the second beIN.

Do not run both simultaneously for this diagnostic.

### If genuine HLS exists

Build a test-only one-slot scheduler:

```text
single provider slot

A manifest/segment window
        ↓
local A buffer
        ↓
Mist A

switch slot

B manifest/segment window
        ↓
local B buffer
        ↓
Mist B

repeat
```

Measure:

- provider activeConnections must never exceed 1;
- no overlapping provider requests;
- segment window duration;
- minimum required local latency/buffer;
- whether switching invalidates prior segment URLs/session state;
- whether provider session accounting releases quickly enough;
- whether both local outputs remain continuous.

Start with only:

```text
beIN 1 + beIN 2
```

and 1 local viewer each.

### If beIN m3u8 is not genuine segmented HLS

Then this route is closed for this account.

The next same-provider questions should be:

- any non-catalogued aggregate/restream endpoint exposed by the provider;
- any server/API metadata indicating restreamer/reseller capability;
- any exact playlist-resolved source behavior that permits sequential channel switching without ghost-session overlap.

Do not jump to unrelated outside sources.

---

# 13. Current provider facts

Sanitized status currently observed:

```text
auth = 1
status = Active
maxConnections = 1
allowedOutputFormats = [m3u8, ts]
serverProtocol = http
serverPort = 80
timezone = Africa/Cairo
```

Relevant stream metadata:

```text
2449 — beIN Sport 1 HD Q
category 6 — beIN Sports HD
tvArchive = 0

2454 — beIN Sport 2 HD Q
category 6 — beIN Sports HD
tvArchive = 0

3974 — ON E [EG]
category 21
tvArchive = 0
```

Do not write provider username/password/raw credential URLs into git.

---

# 14. Current experimental runtime configuration

The current deployment was left in the **two-channel experimental configuration**.

Relay allowlist includes:

```text
3974
2454
```

Control registers:

```text
bein-1 → relay /live/3974.ts
bein-2 → relay /live/2454.ts
```

This is not intended to mean both should be pulled simultaneously on the one-slot account.

The relay now safely enforces one active pull per configured stream, but the provider line itself is still one media connection total.

If returning to normal single-channel testing, do not assume the experimental second-channel registration has already been removed.

---

# 15. Key commits from the real-provider phase

```text
32c98d63c268424b58d9ba07e3f1c58d586965b1
feat: add private GET-only IPTV relay for Mist

4c81b9360e0aa599c288feb8dc8def02273cf6a9
fix: stream IPTV relay with open-ended range

40275a1e18b6a360ba3b27810d64ad2601bb27fa
fix: keep Mist TS input alive across provider gaps

08a7feb03e9577d7dd638bd2c53b131dea3dc5ca
test: require precise provider pull observability

010b371529b0998c502552cda6a857332edc16c4
feat: expose precise provider pull counters

815585df44ef8c9f04caa21ec807b5a09496d64a
test: require stable Mist viewer session identity

555aa17b430e5a32e1979810df6bb80ebffc4e74
feat: support stable Mist viewer session mode

277198535374d3e64ec1c81f5c18f53bbbba0783
test: require stable viewer mode at bootstrap

ea2a24c1fe1001a422db63d7d75de3a1b7de984c
fix: stabilize Mist viewer identity behind proxy

66d9255df107d7e6957378aa9b17806723ee384c
test: account for viewer session bootstrap

7247c18bfbf52d0cb8f58fc64dd3800ee994fef8
test: require independent multi-channel relay pulls

2a10dbf97c85a3b8557fa313aeedfef40eda2bac
feat: isolate relay pulls per IPTV channel

94b0f0b2836b3a29feba2baaedacd0760617f312
test: detect SPTS vs MPTS from live transport PAT

2287fbc065d96ccf3d8d66eb50fbad1bf490bcdb
feat: inspect live TS program map passively

692b1983f3ae7681f83e9efa8a329c0b31949747
docs: record SPTS multiplex investigation
```

---

# 16. Experiment documentation

The detailed scientific record is:

```text
docs/experiments/2026-09-18-hls-load-capacity.md
```

It contains:

- single-channel load protocol;
- 10/50/100 results;
- original 100-viewer failure;
- mode-10 A/B fix;
- replicated successful 100-viewer run;
- two-channel 5+5 experiment;
- provider one-slot result;
- SPTS/MPTS investigation.

Use that file for raw experiment tables rather than reconstructing results from memory.

---

# 17. Things not to do

Do not:

- expose provider credentials;
- expose credential-bearing raw provider URLs;
- send provider URLs to the browser;
- bring old MorshLive streaming architecture into V2;
- treat IPTV Lab as the target architecture;
- use ON E as though it were the actual content goal;
- pivot to YouTube/satellite/other providers without user request;
- call the multiple-beIN problem solved;
- claim the explicit per-viewer `tkn` hardening is complete;
- run another two-channel simultaneous normal TS test and expect a different result;
- kill an unknown active provider session without identifying it;
- use connection-obfuscation tricks whose purpose is only to defeat provider accounting.

---

# 18. Bottom line

Already proven:

```text
ONE real IPTV source
        ↓
ONE provider pull
        ↓
private relay
        ↓
Mist
        ↓
100 concurrent HLS viewers
        ↓
0 segment failures
0 playlist failures
```

Also proven:

```text
normal two-stream acquisition
3974 + 2454
        ↓
provider one-slot contention
        ↓
not stable
```

Also proven for normal stream 3974:

```text
SPTS
1 MPEG-TS program
not an MPTS containing hidden extra channels
```

Current unresolved objective:

```text
Multiple beIN channels
from the SAME supplied IPTV service
while keeping provider media concurrency at 1
```

Exact next hypothesis to test:

```text
Does beIN 2449 / 2454 expose genuine segmented HLS
that can be time-divided sequentially through one slot
and buffered locally into continuous outputs?
```

That is where work stopped.
