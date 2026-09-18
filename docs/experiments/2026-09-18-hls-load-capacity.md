# Experiment KZV2-HLS-LOAD-001 — Single-upstream HLS fan-out capacity

**Status:** Phase 1 complete; Phase 2 corrective A/B in progress  
**Date:** 2026-09-18  
**Time basis:** UTC unless stated otherwise  
**Repository:** elmorshedy-del/KoraZero-StreamV2  
**Branch:** feature/gateway-control  
**Code baseline:** `010b371529b0998c502552cda6a857332edc16c4`  
**Purpose:** Determine the concurrent HLS viewer capacity of the KoraZero Stream V2 fan-out architecture while proving that viewer load does not multiply the IPTV provider connection count.

---

## 1. Research question

Can KoraZero Stream V2 serve increasing numbers of concurrent HLS viewers from one live IPTV source while maintaining:

1. exactly one successful provider-side upstream connection;
2. uninterrupted media progression for an independent canary viewer;
3. low HLS playlist/segment failure rates;
4. bounded playback continuity gaps; and
5. acceptable MistServer resource utilization?

A secondary question was introduced after the 100-viewer failure:

> Is the observed 100-viewer failure a true compute/network capacity limit, or is it caused by MistServer viewer-session fragmentation behind Railway's reverse-proxy layer?

---

## 2. Architecture under test

```text
IPTV provider
  ↓ exactly one source pull
v2-iptv-relay
  ↓ MPEG-TS
MistServer (v2-mist)
  ↓ KoraZero-owned HLS
Railway public edge
  ↓
synthetic HLS viewers / canary / monitor
```

The browser/viewer path never connects directly to the IPTV provider.

### Services

| Role | Railway service |
|---|---|
| Control plane | `v2-control` |
| Media server | `v2-mist` |
| Provider relay | `v2-iptv-relay` |
| Continuous canary | `v2-stress-canary` |
| Independent monitor | `v2-stress-monitor` |
| Load generator shard A | `v2-load-a` |
| Load generator shard B | `v2-load-b` |
| Load generator shard C | `v2-load-c` |
| Load generator shard D | `v2-load-d` |

No public domains were assigned to the stress harness services.

---

## 3. Instrumentation change made before the experiment

The pre-existing relay statistic `totalPulls` mixed several different events and could not answer the central experimental question reliably.

A test-first instrumentation change was therefore made before interpreting load results.

### RED

Commit:

`08a7feb03e9577d7dd638bd2c53b131dea3dc5ca`  
`test: require precise provider pull observability`

Two new tests were added requiring independent counters for:

- provider connection attempts;
- successful provider opens;
- failed provider opens; and
- concurrent duplicate pull attempts rejected by the relay.

Result:

- existing tests passing: 105;
- new tests failing: 2;
- reason for failure: the new counters were intentionally not yet implemented.

### GREEN

Commit:

`010b371529b0998c502552cda6a857332edc16c4`  
`feat: expose precise provider pull counters`

New relay fields:

- `providerAttempts`
- `successfulProviderOpens`
- `failedProviderOpens`
- `rejectedConcurrentPulls`

Verification:

- **107 tests passed**
- **0 failed**

No streaming behavior was intentionally changed by this instrumentation commit.

---

## 4. Experimental controls and measurements

### Independent variable

Concurrent synthetic HLS viewer count.

### Controlled variables

- same IPTV source;
- same relay process;
- same MistServer service;
- same HLS endpoint;
- same application code;
- same Railway project/environment;
- same canary and monitor processes;
- same provider-side source connection kept alive throughout the load sequence;
- same load-client implementation across shards.

### Primary measurements

#### Provider/relay

- `activePulls`
- `providerAttempts`
- `successfulProviderOpens`
- `failedProviderOpens`
- `rejectedConcurrentPulls`
- `realBytes`
- `keepaliveBursts`

#### HLS client

Per virtual viewer:

- root playlist failures;
- media playlist successes/failures;
- segment successes/failures;
- bytes received;
- time to first segment;
- largest inter-segment gap;
- maximum playlist request duration;
- maximum segment request duration;
- final age of last received segment.

#### Independent canary

A continuously running viewer, independent of the load shards, recorded:

- successful segments;
- failed segments;
- playlist successes/failures;
- root playlist failures;
- received bytes;
- maximum inter-segment gap;
- current last-segment age.

#### Independent monitor

Every approximately 2 seconds:

- latest playlist segment identity;
- age since last playlist advance;
- playlist latency;
- playlist error count;
- relay error count;
- relay provider counters.

#### Resource measurements

Railway service metrics for MistServer and relay:

- CPU usage / limit;
- memory usage / limit;
- network RX;
- network TX.

---

## 5. Baseline before load

The relay had undergone a fresh deployment before the controlled ramp.

Observed baseline:

- `activePulls = 1`
- `providerAttempts = 3`
- `successfulProviderOpens = 1`
- `failedProviderOpens = 2`
- `rejectedConcurrentPulls = 0`

The two failed provider attempts occurred during initial cold start before the single successful provider connection was established. They remained constant throughout the subsequent 10-, 50-, and 100-viewer runs and therefore were not interpreted as load-induced provider reconnects.

At 2026-09-18 14:00:04 UTC, the relay logged one successful upstream open.

Before the first controlled viewer tier, the canary had already streamed continuously for approximately two minutes with:

- 0 segment failures;
- 0 playlist failures;
- 0 root failures.

The independent monitor showed continuous playlist progression and exactly one active provider pull.

---

## 6. Load protocol

### Tier A — 10 viewers

- generator shards: 1
- viewers per shard: 10
- nominal per-viewer duration: 45,000 ms
- join mode: steady
- join spread: 10,000 ms
- run ID: `r10-steady-1`
- load began: 2026-09-18 14:02:27 UTC
- summary emitted: 2026-09-18 14:03:30 UTC

### Tier B — 50 viewers

Two independent shards were used to reduce the possibility that a single load-generator process became the test bottleneck.

Each shard:

- viewers: 25
- nominal per-viewer duration: 60,000 ms
- join mode: steady
- join spread: 15,000 ms

Run IDs:

- `r50-a`
- `r50-b`

Load began approximately 2026-09-18 14:04:20–14:04:24 UTC.  
Summaries emitted approximately 14:05:40–14:05:45 UTC.

### Tier C — 100 viewers

Four independent shards were used.

Each shard:

- viewers: 25
- nominal per-viewer duration: 60,000 ms
- join mode: steady
- join spread: 15,000 ms

Run IDs:

- `r100-a`
- `r100-b`
- `r100-c`
- `r100-d`

Load began approximately 2026-09-18 14:06:49–14:06:54 UTC.  
Summaries emitted approximately 14:08:04–14:08:14 UTC.

---

## 7. Results

## 7.1 Tier A — 10 viewers

Aggregate load-generator summary:

| Metric | Result |
|---|---:|
| viewers | 10 |
| harness `good` classification | 9 / 10 |
| root playlist failures | 0 |
| media playlist successes | 403 |
| media playlist failures | 2 |
| segment successes | 442 |
| segment failures | 1 |
| bytes delivered | 187,019,016 |
| p50 first segment | 67 ms |
| p95 first segment | 125 ms |
| p95 maximum gap | 6,510 ms |
| maximum gap | 6,569 ms |
| p95 maximum playlist request | 41 ms |
| p95 maximum segment request | 5,924 ms |
| maximum last-segment age | 6,367 ms |

Segment error rate:

`1 / (442 + 1) = 0.226%`

Playlist error rate:

`2 / (403 + 2) = 0.494%`

The harness's binary `good` flag was later judged too strict for interpretation because its 8-second gap threshold was close to the source's normal observed segment cadence.

Independent evidence during the tier:

- canary remained continuously active;
- canary segment failures remained 0;
- provider counters did not change;
- `successfulProviderOpens` remained 1;
- `activePulls` remained 1.

### Interpretation

**Tier A passed.**

The approximately 6.5-second maximum gap was consistent with the canary/source cadence and did not indicate a novel load-induced stall.

---

## 7.2 Tier B — 50 viewers

### Shard A — `r50-a`

| Metric | Result |
|---|---:|
| viewers | 25 |
| good | 25 |
| root failures | 0 |
| playlist successes | 1,175 |
| playlist failures | 1 |
| segment successes | 1,294 |
| segment failures | 0 |
| bytes | 548,372,312 |
| p50 first segment | 91 ms |
| p95 first segment | 188 ms |
| p95 maximum gap | 6,633 ms |
| maximum gap | 6,656 ms |
| p95 playlist request | 82 ms |
| p95 segment request | 5,808 ms |
| maximum last-segment age | 5,487 ms |

### Shard B — `r50-b`

| Metric | Result |
|---|---:|
| viewers | 25 |
| good | 25 |
| root failures | 0 |
| playlist successes | 1,170 |
| playlist failures | 0 |
| segment successes | 1,270 |
| segment failures | 0 |
| bytes | 538,173,688 |
| p50 first segment | 108 ms |
| p95 first segment | 214 ms |
| p95 maximum gap | 6,539 ms |
| maximum gap | 6,652 ms |
| p95 playlist request | 96 ms |
| p95 segment request | 5,810 ms |
| maximum last-segment age | 5,527 ms |

### Combined 50-viewer result

- viewers healthy: **50 / 50**
- segment successes: **2,564**
- segment failures: **0**
- playlist successes: **2,345**
- playlist failures: **1**
- root failures: **0**
- bytes delivered: **1,086,546,000**

Playlist error rate:

`1 / (2345 + 1) = 0.0426%`

During this tier:

- `successfulProviderOpens` remained **1**;
- `activePulls` remained **1**;
- no load-induced provider reconnect occurred;
- canary remained at **0 segment failures** during the tier.

MistServer observed peak values in the sampled one-hour metric window including approximately:

- CPU: **0.249**
- memory: **0.143 GB**

Limits:

- CPU limit: **8**
- memory limit: **8 GB**

### Interpretation

**Tier B passed strongly.**

The 50-viewer tier did not approach MistServer CPU or memory limits and did not multiply provider connections.

---

## 7.3 Tier C — 100 viewers

A common degradation occurred across all four independent generators.

### Shard A — `r100-a`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 1 |
| playlist successes | 999 |
| playlist failures | 67 |
| segment successes | 1,221 |
| segment failures | 50 |
| bytes | 516,037,252 |
| p50 first segment | 89 ms |
| p95 first segment | 180 ms |
| p95 maximum gap | 21,771 ms |
| maximum gap | 30,954 ms |
| p95 playlist request | 301 ms |
| p95 segment request | 5,913 ms |
| maximum last-segment age | 15,904 ms |

### Shard B — `r100-b`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 1 |
| playlist successes | 890 |
| playlist failures | 85 |
| segment successes | 1,189 |
| segment failures | 56 |
| bytes | 502,452,372 |
| p50 first segment | 102 ms |
| p95 first segment | 199 ms |
| p95 maximum gap | 20,704 ms |
| maximum gap | 25,598 ms |
| p95 playlist request | 2,514 ms |
| p95 segment request | 5,838 ms |
| maximum last-segment age | 30,930 ms |

### Shard C — `r100-c`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 3 |
| playlist successes | 1,040 |
| playlist failures | 67 |
| segment successes | 1,174 |
| segment failures | 52 |
| bytes | 497,222,776 |
| p50 first segment | 74 ms |
| p95 first segment | 124 ms |
| p95 maximum gap | 20,942 ms |
| maximum gap | 33,689 ms |
| p95 playlist request | 1,263 ms |
| p95 segment request | 5,891 ms |
| maximum last-segment age | 32,768 ms |

### Shard D — `r100-d`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 1 |
| playlist successes | 866 |
| playlist failures | 87 |
| segment successes | 1,132 |
| segment failures | 57 |
| bytes | 478,829,232 |
| p50 first segment | 163 ms |
| p95 first segment | 253 ms |
| p95 maximum gap | 31,054 ms |
| maximum gap | 37,803 ms |
| p95 playlist request | 170 ms |
| p95 segment request | 12,530 ms |
| maximum last-segment age | 43,257 ms |

### Combined 100-viewer result

- viewers represented: **100**
- segment successes: **4,716**
- segment failures: **215**
- playlist successes: **3,795**
- playlist failures: **306**
- bytes delivered: **1,994,541,632**

Segment error rate:

`215 / (4716 + 215) = 4.36%`

Playlist error rate:

`306 / (3795 + 306) = 7.46%`

Observed continuity changed qualitatively:

- 50-viewer worst gaps: approximately **6.65 s**
- 100-viewer p95/worst gaps: approximately **20–38 s**

This was therefore considered a real failure, not a marginal threshold effect.

---

## 8. Failure localization at 100 viewers

### Provider/relay remained healthy

During the failure:

- `activePulls = 1`
- `successfulProviderOpens = 1`
- `providerAttempts = 3`
- `failedProviderOpens = 2`
- no load-induced successful provider reopen occurred.

Therefore, the 100-viewer failure occurred **downstream of the IPTV provider connection**.

### Compute resources were not exhausted

At one degraded 100-viewer snapshot:

MistServer:

- CPU usage: approximately **1.576**
- CPU limit: **8**
- memory usage: approximately **0.626 GB**
- memory limit: **8 GB**
- network TX sample: approximately **1.302 GB** in the Railway metric's sampled interval representation.

Relay:

- CPU usage: approximately **0.005**
- memory usage: approximately **0.044 GB**

Thus the observed failure did not coincide with CPU or RAM exhaustion.

### Independent canary also degraded

Before the 100-viewer tier the canary had remained clean.

During 100 viewers, the independent canary changed from:

- 0 segment failures
- 0 playlist failures

to observable failures, including by approximately 14:07:15 UTC:

- segment successes: 220
- segment failures: 1
- playlist successes: 342
- playlist failures: 2

and later:

- segment successes: 221
- segment failures: 2.

This confirms the failure was not confined to the synthetic load clients' own accounting.

### MistServer emitted a concrete internal error

During the degraded period MistServer logged:

```text
FAIL: Could not open session semaphore; aborting!
FAIL: Logging unclean exit reason: could not connect to session ...
```

This is the first direct server-side failure signature associated with the 100-viewer boundary.

---

## 9. Session-identity confounder discovered after failure

MistServer source inspection showed that the default viewer session mode is:

```text
SESS_BUNDLE_DEFAULT_VIEWER = 14
```

Bit interpretation in MistServer's `Connections::generateSession`:

- `0x08` — include stream name
- `0x04` — include viewer IP
- `0x02` — include client-side session token
- `0x01` — include protocol

Therefore mode 14 (`0b1110`) derives viewer session identity from:

```text
stream name + viewer IP + session token
```

MistServer's HTTP code also shows:

- it reads `tkn`, `sid`, or `sessId` from the request URL;
- it can read a token from cookies;
- when no token exists and token propagation is enabled, Mist generates one;
- HLS propagates the token into generated child URLs.

Therefore ordinary HLS playback is intended to have a stable client token.

### Proxy observation

MistServer repeatedly logged warnings such as:

```text
Host 100.64.x.x is attempting to act as a proxy for <client address>, but not trusted
```

Mist access logs also showed one session accumulating multiple different synthetic viewer User-Agent tags.

This creates a plausible confounder:

1. Railway terminates public HTTP and forwards requests internally.
2. Mist currently rejects the forwarded real-client address as untrusted.
3. Mist therefore sees an internal Railway proxy address as the viewer IP.
4. Consecutive requests belonging to one HLS token can traverse different internal proxy hops.
5. Because default session identity includes IP, one logical viewer may fragment into multiple Mist sessions.
6. Under load, this can cause excess MistSession process/semaphore churn.
7. The observed `Could not open session semaphore` failure is consistent with this mechanism.

This mechanism has **not yet been proven**. It is the leading hypothesis for the next controlled A/B.

---

## 10. Hypothesis for Phase 2

### H1 — proxy-induced session fragmentation

The 100-viewer failure is caused primarily by unstable proxy-hop IPs participating in Mist viewer-session identity.

### Prediction

If viewer sessions are bundled by:

```text
stream + stable HLS token
```

while excluding the proxy-hop IP, then the identical 100-viewer load should show:

- materially fewer or zero session-semaphore failures;
- materially fewer playlist/segment failures;
- continuity gaps near the source's normal approximately 6–7 second envelope;
- one successful provider open;
- one active provider pull;
- no major CPU/RAM increase sufficient to explain the prior failure.

### Proposed Mist viewer session mode

```text
10 decimal = 0b1010
```

which includes:

- stream name (`0x08`)
- client token (`0x02`)

and excludes:

- viewer IP (`0x04`)
- protocol (`0x01`)

Input and output session modes are not to be changed by this experiment.

---

## 11. Phase 2 protocol

1. Add an explicit, version-controlled V2 Mist bootstrap setting for viewer-session mode 10.
2. Add unit tests before implementation.
3. Verify the entire repository test suite.
4. Deploy control configuration.
5. Confirm the stream is healthy at baseline.
6. Confirm provider counters before load.
7. Run the **same 100-viewer protocol**:
   - four shards;
   - 25 viewers per shard;
   - 60,000 ms;
   - steady joins;
   - 15,000 ms join spread.
8. Maintain the independent canary and monitor.
9. Collect MistServer logs for:
   - session semaphore failure;
   - session cleanup;
   - HLS errors.
10. Compare Phase 2 directly against Phase 1 100-viewer results.
11. Only if 100 viewers passes cleanly, proceed to:
   - 200 viewers;
   - 400 viewers;
   - higher if still healthy;
   - thundering-herd/burst join test;
   - sustained soak.

---

## 12. Acceptance criteria for declaring 100 viewers fixed

The corrective change will not be accepted merely because most requests succeed.

A Phase 2 100-viewer run should satisfy all of the following:

1. `successfulProviderOpens` does not increase from its pre-run value.
2. `activePulls` remains 1.
3. Independent canary continues media progression.
4. No sustained multi-tens-of-seconds continuity gaps comparable with Phase 1.
5. Segment failure rate is returned near the 50-viewer baseline and is not materially elevated.
6. Playlist failure rate is returned near the 50-viewer baseline and is not materially elevated.
7. MistServer emits no recurring session-semaphore failure pattern attributable to the load.
8. CPU and memory remain below service limits.
9. All four load shards agree sufficiently that the result cannot reasonably be explained by one generator process.

---

## 13. Conclusions from Phase 1

What is established:

- The architecture successfully fans one provider pull out to multiple HLS viewers.
- 50 concurrent viewers were served cleanly with one provider connection.
- 100 concurrent viewers caused a reproducible HLS-layer failure.
- The provider connection remained healthy during the 100-viewer failure.
- CPU and RAM were not exhausted.
- MistServer emitted a session semaphore failure during degradation.
- Railway proxy/session identity is a concrete confounder that must be eliminated before treating 100 as a true capacity ceiling.

What is **not** established:

- 100 viewers is not yet the true capacity limit.
- Network bandwidth has not yet been proven to be the limiting resource.
- MistServer itself has not yet been proven incapable of serving 100 viewers.
- The session-identity hypothesis has not yet been proven.

The next experiment is therefore an A/B correction of viewer-session identity, followed by an identical 100-viewer replay.

---

## 14. Reproducibility notes

The stress harness intentionally uses multiple independent load-generator services so that a single synthetic-client process is less likely to become the hidden bottleneck.

The continuous canary and independent monitor are deliberately separate from the load shards.

No IPTV credentials, provider authorization tokens, MistServer credentials, or signed source URLs are recorded in this document.


---

# Phase 2 — Viewer-session identity A/B

## 15. Corrective change

### Rationale

Phase 1 failed at 100 viewers while:

- the provider remained on one successful upstream connection;
- relay input continued;
- Mist CPU and memory were below limits; and
- Mist emitted `Could not open session semaphore; aborting!`.

Source inspection showed the default Mist viewer-session mode was 14:

```text
14 decimal = 0b1110 = stream + viewer IP + client token
```

Railway's public edge forwards requests to Mist through internal proxy hops, and Mist logged that those proxy addresses were not trusted. The A/B intervention therefore removed viewer IP from Mist's session-key material while preserving stream name and client token:

```text
10 decimal = 0b1010 = stream + client token
```

No changes were made to:

- provider selection;
- relay single-pull enforcement;
- MPEG-TS ingest;
- HLS format;
- source recovery behavior;
- input/output session modes;
- Mist CPU/memory limits.

### TDD implementation record

1. RED — `815585df44ef8c9f04caa21ec807b5a09496d64a`  
   `test: require stable Mist viewer session identity`

   Result: **107 pass / 2 fail**, both because `ensureViewerSessionMode` did not yet exist.

2. GREEN — `555aa17b430e5a32e1979810df6bb80ebffc4e74`  
   `feat: support stable Mist viewer session mode`

   Added an idempotent Mist API operation which:
   - reads `config_backup`;
   - compares current `sessionViewerMode`;
   - sends only `{ config: { sessionViewerMode: 10 } }` when needed.

   Result: **109 pass / 0 fail**.

3. RED — `277198535374d3e64ec1c81f5c18f53bbbba0783`  
   `test: require stable viewer mode at bootstrap`

   The new bootstrap test failed as expected because startup had not yet applied the mode.

4. GREEN implementation — `ea2a24c1fe1001a422db63d7d75de3a1b7de984c`  
   `fix: stabilize Mist viewer identity behind proxy`

5. Test-fixture/order update — `66d9255df107d7e6957378aa9b17806723ee384c`  
   `test: account for viewer session bootstrap`

   Final verification: **110 pass / 0 fail**.

Bootstrap now enforces viewer mode 10 before channel registration.

---

## 16. Phase 2 pre-run baseline

Fresh canary deployment:

`9efcc626-e10b-4462-9e8d-4ea826196905`

Fresh monitor deployment:

`aa00cc5f-d8b8-49e5-8257-9da9118f79b9`

Fresh relay deployment:

`9bf697a3-106f-471f-8871-f8e79953bf14`

Before starting the 100-viewer load:

- `activePulls = 1`
- `providerAttempts = 3`
- `successfulProviderOpens = 1`
- `failedProviderOpens = 2`
- `rejectedConcurrentPulls = 0`
- canary segment failures = 0
- canary playlist failures = 0
- monitor playlist errors = 0
- monitor relay errors = 0

The two failed provider attempts were cold-start attempts preceding the one successful provider connection and were fixed at baseline.

---

## 17. Phase 2 100-viewer replay protocol

The Phase 1 100-viewer test was repeated without changing the load shape:

- total viewers: **100**
- shards: **4**
- viewers per shard: **25**
- per-viewer duration: **60,000 ms**
- join mode: **steady**
- join spread: **15,000 ms**
- start delay: **3,000 ms**

Run IDs:

- `r100p2-a`
- `r100p2-b`
- `r100p2-c`
- `r100p2-d`

Load begins:

- A: 2026-09-18 14:40:38 UTC
- B: 2026-09-18 14:40:40 UTC
- C: 2026-09-18 14:40:43 UTC
- D: 2026-09-18 14:40:45 UTC

Load summaries:

- A: 14:41:57 UTC
- B: 14:42:00 UTC
- C: 14:42:03 UTC
- D: 14:42:05 UTC

---

## 18. Phase 2 raw results

### Shard A — `r100p2-a`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 25 |
| good % | 100% |
| root failures | 0 |
| playlist successes | 960 |
| playlist failures | 0 |
| segment successes | 1,346 |
| segment failures | 0 |
| bytes | 570,393,128 |
| p50 first segment | 60 ms |
| p95 first segment | 98 ms |
| p95 maximum gap | 6,510 ms |
| maximum gap | 6,544 ms |
| p95 playlist request | 157 ms |
| p95 segment request | 5,683 ms |
| maximum final last-segment age | 5,465 ms |

### Shard B — `r100p2-b`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 25 |
| good % | 100% |
| root failures | 0 |
| playlist successes | 946 |
| playlist failures | 0 |
| segment successes | 1,337 |
| segment failures | 0 |
| bytes | 566,664,148 |
| p50 first segment | 61 ms |
| p95 first segment | 151 ms |
| p95 maximum gap | 6,426 ms |
| maximum gap | 6,465 ms |
| p95 playlist request | 111 ms |
| p95 segment request | 5,637 ms |
| maximum final last-segment age | 5,464 ms |

### Shard C — `r100p2-c`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 25 |
| good % | 100% |
| root failures | 0 |
| playlist successes | 929 |
| playlist failures | 0 |
| segment successes | 1,325 |
| segment failures | 0 |
| bytes | 561,718,244 |
| p50 first segment | 112 ms |
| p95 first segment | 233 ms |
| p95 maximum gap | 6,515 ms |
| maximum gap | 6,708 ms |
| p95 playlist request | 318 ms |
| p95 segment request | 5,773 ms |
| maximum final last-segment age | 6,382 ms |

### Shard D — `r100p2-d`

| Metric | Result |
|---|---:|
| viewers | 25 |
| harness good | 24 |
| good % | 96% |
| root failures | 0 |
| playlist successes | 900 |
| playlist failures | 0 |
| segment successes | 1,314 |
| segment failures | 0 |
| bytes | 557,139,880 |
| p50 first segment | 169 ms |
| p95 first segment | 343 ms |
| p95 maximum gap | 6,627 ms |
| maximum gap | 6,939 ms |
| p95 playlist request | 262 ms |
| p95 segment request | 5,613 ms |
| maximum final last-segment age | 8,357 ms |

The single viewer not classified as `good` in shard D failed only the harness's strict final-age criterion of <8,000 ms. There were **zero playlist failures and zero segment failures** in that shard, and its maximum measured inter-segment gap was 6.939 s. It is therefore not interpreted as a playback failure.

### Combined Phase 2 100-viewer result

- synthetic viewers: **100**
- harness good: **99 / 100**
- segment successes: **5,322**
- segment failures: **0**
- playlist successes: **3,735**
- playlist failures: **0**
- root failures: **0**
- bytes delivered: **2,255,915,400**

Observed request failure rates:

- segment failure rate: **0 / 5,322 = 0%**
- playlist failure rate: **0 / 3,735 = 0%**

---

## 19. Independent Phase 2 controls

### Provider invariant

Before, during, and after the run:

- `activePulls = 1`
- `providerAttempts = 3`
- `successfulProviderOpens = 1`
- `failedProviderOpens = 2`
- `rejectedConcurrentPulls = 0`

Therefore the 100-viewer test caused:

- **0 additional successful provider opens**
- **0 additional failed provider attempts**
- **0 duplicate provider pulls**

### Canary

The independent canary accumulated no request failures throughout the Phase 2 run:

- segment failures: **0**
- playlist failures: **0**
- root failures: **0**

Its maximum recorded inter-segment gap eventually reached **8,453 ms**. This was transient; segment delivery continued without an HTTP failure and did not develop into the multi-tens-of-seconds failure pattern seen in Phase 1.

### Independent monitor

Throughout and after the load:

- playlist errors: **0**
- relay errors: **0**
- `activePulls = 1`
- `successfulProviderOpens = 1`

The largest sampled playlist-advance age during the end of the run reached approximately **8,143 ms** before the next segment appeared. No playlist request failed.

### MistServer failure log

For the complete Phase 2 load window, filtered MistServer logs contained:

- **0** `Could not open session semaphore` events
- **0** FAIL-level events

This directly contrasts with Phase 1, where semaphore failures occurred during the 100-viewer degradation.

### Resource observation

The post-run Railway one-hour rolling metric window reported:

- CPU limit: 8
- maximum CPU value in that rolling window: approximately 1.673
- memory limit: 8 GB
- maximum memory value in that rolling window: approximately 0.626 GB

Because the one-hour window contains both Phase 1 and Phase 2 activity, these maxima are not treated as pure Phase 2 maxima. They nevertheless show no CPU or memory limit exhaustion during the experiment.

---

## 20. Phase 1 versus Phase 2 A/B comparison

| Metric | Phase 1: mode 14 | Phase 2: mode 10 |
|---|---:|---:|
| viewers | 100 | 100 |
| provider successful opens during baseline/run | 1 | 1 |
| additional provider opens caused by load | 0 | 0 |
| segment successes | 4,716 | 5,322 |
| segment failures | 215 | **0** |
| segment failure rate | 4.36% | **0%** |
| playlist successes | 3,795 | 3,735 |
| playlist failures | 306 | **0** |
| playlist failure rate | 7.46% | **0%** |
| worst load-shard gap | 37.803 s | **6.939 s** |
| Mist semaphore failures | observed | **0 observed** |
| canary request failures | observed | **0 observed** |

The only intended serving-path intervention between the two 100-viewer experiments was the viewer-session identity mode.

---

## 21. Phase 2 inference

The Phase 2 intervention **eliminated the reproducible Phase 1 100-viewer failure under the same four-shard load shape**.

The observations are consistent with the hypothesis that inclusion of reverse-proxy-hop IP in Mist viewer-session identity was causing harmful session churn or fragmentation under Railway's proxy topology.

The evidence supports the narrower causal statement:

> Removing proxy-hop IP from Mist viewer-session identity was sufficient to change the same 100-viewer experiment from a high-error/semaphore-failure state to a zero-request-failure state.

The experiment does **not** establish that session identity is now perfectly one-viewer-to-one-Mist-session.

---

## 22. Secondary session-coalescence observation

After Phase 2, Mist access logs were inspected using the unique synthetic viewer User-Agent labels.

Many sessions contained a single synthetic viewer label, but some sessions still accumulated multiple labels. Examples included sessions containing two, three, or more distinct `KZ-Load/r100p2-*/N` tags.

Therefore:

- the mode-10 intervention solved the observed serving failure;
- it did not guarantee a unique Mist statistical session for every synthetic viewer;
- Mist's automatic client-token generation/propagation remains a possible source of session coalescence in this synthetic environment.

This is important because the load test generated **100 independent HTTP/HLS consumers**, but Mist's internal session accounting did not always represent those consumers one-for-one.

### Consequence

A further hardening/validation experiment is warranted:

1. assign each real browser a stable, random, non-secret viewer token explicitly;
2. append that token as Mist's `tkn` parameter to the root HLS manifest;
3. keep the token stable across player recovery within the page session;
4. make each synthetic load viewer send a distinct explicit token;
5. repeat the 100-viewer experiment;
6. verify both serving health **and** improved viewer/session identity separation.

This next experiment is intended to validate 100 distinct viewer identities, not merely 100 independent HLS request loops.

---

## 23. Phase 2 conclusion

**The original 100-viewer serving failure is fixed under the replicated load protocol.**

At 100 concurrent synthetic HLS consumers after the mode-10 correction:

- provider fan-out remained one upstream connection;
- 5,322 segment requests succeeded with 0 failures;
- 3,735 playlist requests succeeded with 0 failures;
- no Mist semaphore failure occurred;
- the canary remained error-free;
- worst load-shard continuity remained below 7 seconds.

Because internal Mist session coalescence was still observed, Phase 2 is considered a successful serving-capacity fix but not the final viewer-identity validation.
