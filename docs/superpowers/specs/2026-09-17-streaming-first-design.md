# KoraZero Stream V2 — Streaming-First Design

## Goal
Prove a clean streaming architecture before building the final KoraZero product/SEO frontend.

## Scope now
Build only the server-only source registry, MistServer control adapter, gateway service, internal activate/status/stop endpoints, browser playback descriptor, one shared HLS player, diagnostics, then fault/multi-viewer tests.

## Explicitly out of scope
Permanent SEO entity pages, match/team/competition architecture, production homepage/navigation, animations, legacy streaming code, direct provider URLs/credentials in browser code, and browser-owned provider reconnects.

## Streaming boundaries
Browser -> GET /api/playback/:channelId -> KoraZero HLS only. Internal control -> server registry -> private MistServer API. MistServer -> one provider pull per active logical stream -> shared buffer -> many HLS readers.

## Ownership rules
MistServer/gateway owns provider connectivity. Browser owns only KoraZero HLS playback. hls.js owns non-fatal HLS recovery. V2 controller owns bounded fatal recovery. Lab is telemetry only.

## First success criterion
One authorized H.264/AAC provider stream plays continuously through provider -> MistServer -> KoraZero HLS -> iPhone Safari, followed by proving multiple viewers share one upstream provider stream.
