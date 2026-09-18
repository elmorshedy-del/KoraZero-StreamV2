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
