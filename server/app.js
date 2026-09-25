import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime-config.js';
import { createControlServer } from './control-server.js';

const defaultStaticRoot = fileURLToPath(new URL('../src/', import.meta.url));

export function createApp(env = process.env, { fetchFn = globalThis.fetch, staticRoot = defaultStaticRoot } = {}) {
  const runtime = createRuntime(env, { fetchFn });
  const server = createControlServer({
    gateway: runtime.gateway,
    internalToken: runtime.internalToken,
    staticRoot,
  });
  async function bootstrap({ activateChannel = null } = {}) {
    const httpProtocol = await runtime.mist.ensureHttpProtocol({ port: 8080 });
    const hlsProtocol = await runtime.mist.ensureHlsProtocol();
    // 10 = stream + client token. Exclude reverse-proxy hop IP from viewer identity.
    const viewerSessionMode = await runtime.mist.ensureViewerSessionMode({ mode: 10 });
    const emergency3645Only = env.V2_EMERGENCY_3645_ONLY === 'true';
    if (emergency3645Only) {
      const configured = await runtime.mist.listConfiguredStreams();
      for (const channelId of configured) {
        try { await runtime.mist.nukeStream(channelId); } catch {}
        try { await runtime.mist.deleteStream(channelId); } catch {}
      }
      await runtime.mist.addStream(
        'iptv-3645',
        'http://v2-iptv-relay.railway.internal:8080/live/3645.ts',
        { always_on: true },
      );
    }
    for (const entry of runtime.registry.entries()) {
      if (emergency3645Only) continue;
      await runtime.mist.addStream(
        entry.channelId,
        entry.source,
        entry.alwaysOn ? { always_on: true } : {},
      );
    }
    if (activateChannel && !emergency3645Only) await runtime.gateway.activate(activateChannel);
    return {
      httpProtocol,
      hlsProtocol,
      viewerSessionMode,
      channels: runtime.registry.entries().map((entry) => entry.channelId),
      activateChannel,
    };
  }

  return Object.freeze({
    port: runtime.port,
    bootstrap,
    server,
    gateway: runtime.gateway,
    sourceSupervisor: runtime.sourceSupervisor,
  });
}
