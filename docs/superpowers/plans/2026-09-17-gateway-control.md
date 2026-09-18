# Gateway Control Implementation Plan

**Goal:** Build the minimum server-side control plane mapping a logical V2 channel to an authorized upstream source, configure MistServer, and expose only KoraZero-owned HLS to the browser.

**Constraints:** no legacy streaming code, no provider URL/credential in src, Mist API private, browser receives only KoraZero HLS, no frontend overbuild, test-first changes.

Implemented tasks: server-only registry, Mist API adapter, gateway service, authenticated control routes, logical-channel playback descriptor, shared Watch/Lab player, verification. Next: deploy media service, activate one authorized H.264 source, prove provider -> MistServer -> HLS -> Safari, then multi-viewer/fault tests.
