# V2 Media Gateway Contract

## Browser boundary

The browser receives exactly one playback descriptor for a logical channel:

```json
{
  "channelId": "bein-1",
  "manifestUrl": "https://stream-v2.example/hls/bein-1/index.m3u8"
}
```

The public playback shape is:

```text
/hls/{stream}/index.m3u8
```

The **browser never receives, reconstructs, signs, retries, or connects to a provider URL**. Provider credentials, exact upstream URLs, origin selection, and source failover are exclusively server-side concerns.

## Gateway responsibility

The gateway owns the upstream session for an active channel and publishes a KoraZero-owned HLS presentation downstream. The initial implementation target is MistServer because it supports HTTP MPEG-TS input and HLS output.

V2 source configuration is deliberately not copied from MorshLive. A later control-plane subproject will map logical channel IDs to authorized upstream inputs and configure the gateway.

## Player responsibility

The player consumes only the HLS manifest URL. It does not know:

- provider credentials;
- provider stream IDs;
- provider category names;
- exact upstream hosts;
- alternate provider feeds;
- gateway implementation details.

## Security boundary

- MistServer management port `4242` is private/internal only.
- HLS HTTP output is the only media surface intended for browser access in the first gateway prototype.
- No production provider URL or credential is committed to this repository.
- Deployment secrets are injected outside git.

## Future control plane

The next gateway milestone will introduce a server-side API with an interface similar to:

```text
POST /internal/channels/{channelId}/activate
GET  /internal/channels/{channelId}/status
POST /internal/channels/{channelId}/stop
```

Those endpoints will manage source activation and gateway state. They are not browser APIs and are not implemented in milestone 1.
