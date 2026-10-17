# V2 Media Gateway Contract

## Browser boundary

The public V2 media URL remains:

```text
/hls/iptv-<digits>/index.m3u8
```

A slot/account identifier is never added to that URL. The account that supplies a channel is a server-side implementation detail.

The browser never receives, reconstructs, signs, retries, or connects to a provider URL. Provider credentials, exact upstream URLs, origin selection, and account ownership stay server-side.

## Active-state contract

`GET /api/active` is public and read-only. In multi-slot mode it returns an additive shape:

```json
{
  "capacity": 2,
  "slots": [
    {
      "slot": "a",
      "channelId": "iptv-3645",
      "streamId": "3645",
      "inputs": 1,
      "viewers": 40,
      "mode": "auto",
      "manualUntil": null
    },
    {
      "slot": "b",
      "channelId": null,
      "mode": "auto",
      "manualUntil": null
    }
  ],
  "live": [
    {
      "channelId": "iptv-3645",
      "streamId": "3645",
      "slot": "a",
      "inputs": 1,
      "viewers": 40
    }
  ],
  "active": {
    "channelId": "iptv-3645",
    "streamId": "3645",
    "slot": "a"
  },
  "conflict": false
}
```

Legacy readers may continue to use `active`. Two healthy slots are **not** a conflict.

`conflict:true` means an invariant is broken, for example:

- more live `iptv-*` inputs than configured capacity;
- more than one live input owned by one relay/account;
- a live `iptv-*` input whose Mist source does not belong to any configured relay.

Slot ownership is derived from the Mist stream source host so it survives controller restarts.

## Account configuration

Multi-slot mode is opt-in with:

```text
V2_IPTV_ACCOUNTS_JSON=[
  {"id":"a","relayBase":"http://v2-iptv-relay.railway.internal:8080"},
  {"id":"b","relayBase":"http://v2-iptv-relay-b.railway.internal:8080"}
]
```

When this variable is unset, the existing `V2_IPTV_RELAY_BASE` single-slot behavior remains authoritative.

Each relay `/account` response exposes only a 12-hex `accountFingerprint` derived from the normalized portal plus username. It does not expose the portal, username, password, or provider media URL. If two configured relays have the same fingerprint, or identity cannot be verified, bootstrap falls back to slot A only.

## Operator API

All `/operator/*` routes require the existing operator PIN.

```text
GET  /operator/active
GET  /operator/catalog?account=a|b
POST /operator/switch/<streamId>?slot=a|b
POST /operator/off?slot=a|b
POST /operator/auto?slot=a|b
```

Rules:

- A switch with an explicit slot replaces only that slot.
- A switch without a slot uses a free slot; if all slots are busy it returns HTTP 409 `all_slots_busy` and never evicts automatically.
- If the requested channel is already live on any slot, it is reused and no second provider pull is opened.
- With two accounts configured, `/operator/off` requires `?slot=`; stopping every slot is never an implicit operator action.
- Manual switch/off puts only that slot into manual mode. `/operator/auto?slot=` resumes schedule control.
- Provider-slot waits and superseding queues are per slot, so work on slot A does not abort work on slot B.

## Automatic scheduler

Automation is disabled unless:

```text
V2_AUTO_SCHEDULE=true
```

The scheduler reads `V2_SLOT_SCHEDULE_URL` (default `https://korazero.com/assets/data/v2-slot-schedule.json`) every 60 seconds.

Fail-closed behavior:

- schedule fetch/parse failure changes nothing;
- controller conflict changes nothing;
- a started schedule entry is frozen until its original `endAt`, even if a newer schedule drops it;
- manual slots are skipped until their hold expires;
- handover waits for the previous match to stop being live, but never later than the next match kickoff.

Unset `V2_AUTO_SCHEDULE` to return to remote-only control.

## Security boundary

- MistServer management port `4242` stays private/internal only.
- Relay bases in multi-slot config must be private Railway hosts with explicit ports (localhost is accepted only for tests).
- No production provider URL or credential belongs in git, logs, schedule files, public API responses, or browser code.
- The existing IPTV Lab/Xtream path is outside this contract and is unchanged.
