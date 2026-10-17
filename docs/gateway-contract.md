# V2 Media Gateway Contract

## Browser boundary

The browser-facing V2 URL remains unchanged:

```text
https://v2-mist-production.up.railway.app/hls/iptv-<streamId>/index.m3u8
```

The browser never receives provider credentials, provider URLs, relay account identity, or slot identity. Account selection is a private controller detail.

## Public active state

`GET /api/active` is public and read-only.

Single-account mode remains backward compatible. With the optional multi-account controller enabled, the response is additive:

```json
{
  "capacity": 2,
  "slots": [
    {"slot":"a","channelId":"iptv-3645","streamId":"3645","inputs":1,"viewers":20,"mode":"auto"},
    {"slot":"b","channelId":null,"mode":"auto"}
  ],
  "live": [
    {"channelId":"iptv-3645","streamId":"3645","slot":"a"}
  ],
  "active": {"channelId":"iptv-3645","streamId":"3645","slot":"a"},
  "conflict": false
}
```

`active` remains the first live item for legacy readers. Two healthy slots are not a conflict. `conflict:true` means an invariant failed: live inputs exceed capacity, more than one live input belongs to one relay account, or a live `iptv-*` source cannot be mapped to a configured relay.

## Operator API

All `/operator/*` routes require the operator PIN using `x-operator-pin` or bearer authentication.

- `GET /operator/active` — current slot state.
- `GET /operator/catalog?account=a|b` — sanitized catalog for one relay account.
- `POST /operator/switch/<streamId>?slot=a|b` — switch a specific slot. If `slot` is omitted, a free slot is chosen. A busy slot is never evicted automatically.
- `POST /operator/off?slot=a|b` — stop only that slot. With two configured accounts, omitting `slot` returns 400.
- `POST /operator/resume-auto?slot=a|b` — clear a manual hold and return that slot to scheduler control.

A request for a channel already live on either slot is idempotent and opens no second provider pull. If no slot was requested and every slot is busy, the controller returns `409 all_slots_busy`.

## Internal channel API

Static channel control remains server-only:

```text
POST /internal/channels/{channelId}/activate
GET  /internal/channels/{channelId}/status
POST /internal/channels/{channelId}/stop
```

These routes require `V2_INTERNAL_TOKEN` and are not browser APIs.

## Multi-account configuration

`V2_IPTV_ACCOUNTS_JSON` is optional. When unset, the legacy `V2_IPTV_RELAY_BASE` single-account path is used.

Example private Railway configuration:

```json
[
  {"id":"a","relayBase":"http://v2-iptv-relay.railway.internal:8080"},
  {"id":"b","relayBase":"http://v2-iptv-relay-b.railway.internal:8080"}
]
```

Only private `.railway.internal:<port>` relay bases are accepted in production. Provider credentials stay on each relay service and never appear in this JSON, API responses, schedules, or logs.

Each relay exposes a non-secret 12-hex `accountFingerprint` on `/account`, derived from SHA-256 of normalized portal + username. At bootstrap, duplicate or missing fingerprints fail safely to account A only rather than crashing V2.

## Ownership and isolation

Mist source URLs are the durable ownership record. A source beginning with relay A's private base belongs to slot A; relay B owns slot B. A controller restart reconstructs ownership from Mist instead of trusting process memory.

Switching or stopping one slot nukes/deletes only the stream owned by that slot. One channel may not occupy two slots simultaneously.

## Automatic scheduling

Automation is opt-in only:

```text
V2_AUTO_SCHEDULE=true
```

When the flag is absent or not exactly `true`, no scheduler starts. The default schedule URL is:

```text
https://korazero.com/assets/data/v2-slot-schedule.json
```

Schedule fetch/parse failure leaves all current slots untouched. Manual choices override automation until the scheduled window covering the action ends, or for three hours if there is no covering window. A started scheduled match is never cut merely because a newer schedule dropped it.

## Security boundary

- MistServer management port `4242` stays private/internal.
- Public playback keeps the frozen `/hls/iptv-<digits>/index.m3u8` contract.
- Provider credentials and exact upstream URLs never enter git or browser responses.
- Unsetting `V2_IPTV_ACCOUNTS_JSON` returns the controller to the legacy single-slot path.
- Leaving `V2_AUTO_SCHEDULE` off disables automatic switching independently of the multi-slot controller.
