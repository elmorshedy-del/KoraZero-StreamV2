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
        if (channelId === 'bein-1' || channelId.startsWith('iptv-')) {
          try { await runtime.mist.nukeStream(channelId); } catch {}
          try { await runtime.mist.deleteStream(channelId); } catch {}
        }
      }
    }
    for (const entry of runtime.registry.entries()) {
      if (emergency3645Only && entry.channelId === 'bein-1') continue;
      await runtime.mist.addStream(
        entry.channelId,
        entry.source,
        entry.alwaysOn ? { always_on: true } : {},
      );
    }
    if (activateChannel) await runtime.gateway.activate(activateChannel);
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
