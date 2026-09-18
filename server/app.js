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
    for (const entry of runtime.registry.entries()) {
      await runtime.mist.addStream(entry.channelId, entry.source);
    }
    if (activateChannel) await runtime.gateway.activate(activateChannel);
    return {
      httpProtocol,
      hlsProtocol,
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
