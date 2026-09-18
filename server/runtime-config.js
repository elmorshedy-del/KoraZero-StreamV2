import { createChannelRegistry } from './channel-registry.js';
import { createMistApi } from './mist-api.js';
import { createGatewayService } from './gateway-service.js';

function requireEnv(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function parseChannels(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new Error('V2_CHANNELS_JSON must be valid JSON object');
  }
}

export function createRuntime(env = process.env, { fetchFn = globalThis.fetch } = {}) {
  const channels = parseChannels(requireEnv(env, 'V2_CHANNELS_JSON'));
  const internalToken = requireEnv(env, 'V2_INTERNAL_TOKEN');
  const publicHlsBase = requireEnv(env, 'V2_PUBLIC_HLS_BASE');
  const mistEndpoint = (env.V2_MIST_API_ENDPOINT || 'http://127.0.0.1:4242/api2').trim();
  const mistUsername = (env.V2_MIST_USERNAME || '').trim();
  const mistPassword = env.V2_MIST_PASSWORD || '';
  if (Boolean(mistUsername) !== Boolean(mistPassword)) {
    throw new Error('MistServer credentials require both V2_MIST_USERNAME and V2_MIST_PASSWORD');
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

  const registry = createChannelRegistry(channels);
  const mist = createMistApi({
    endpoint: mistEndpoint,
    username: mistUsername,
    password: mistPassword,
    fetchFn,
  });
  const gateway = createGatewayService({ registry, mist, publicHlsBase });

  return Object.freeze({ port, internalToken, registry, mist, gateway });
}
