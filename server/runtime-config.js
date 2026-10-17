import { createChannelRegistry } from './channel-registry.js';
import { createMistApi } from './mist-api.js';
import { createGatewayService } from './gateway-service.js';
import { createIptvCatalogClient } from './iptv-catalog-client.js';
import { createSourceSupervisor } from './source-supervisor.js';

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

function normalizeRelayBase(raw, label = 'relayBase') {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const railway = url.hostname.endsWith('.railway.internal');
  if ((!local && !railway) || !url.port) {
    throw new Error(`${label} must be a private Railway host with a port, or localhost in tests`);
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function parseAccountConfigs(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('V2_IPTV_ACCOUNTS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2) {
    throw new Error('V2_IPTV_ACCOUNTS_JSON must contain 1 or 2 accounts');
  }

  const ids = new Set();
  const relayBases = new Set();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('V2_IPTV_ACCOUNTS_JSON entries must be objects');
    }
    const id = String(entry.id || '').trim();
    if (!/^[a-z]$/.test(id)) throw new Error('V2 IPTV account ids must be one lowercase letter');
    if (ids.has(id)) throw new Error('V2 IPTV account ids must be unique');
    ids.add(id);
    const relayBase = normalizeRelayBase(entry.relayBase, `V2 IPTV account ${id} relayBase`);
    if (relayBases.has(relayBase)) throw new Error('V2 IPTV account relayBase values must be unique');
    relayBases.add(relayBase);
    return { id, relayBase, index };
  });
}

export function createRuntime(env = process.env, { fetchFn = globalThis.fetch } = {}) {
  const channels = parseChannels(requireEnv(env, 'V2_CHANNELS_JSON'));
  const internalToken = requireEnv(env, 'V2_INTERNAL_TOKEN');
  const operatorPin = String(env.V2_OPERATOR_PIN || '').trim() || null;
  const publicHlsBase = requireEnv(env, 'V2_PUBLIC_HLS_BASE');
  const mistEndpoint = (env.V2_MIST_API_ENDPOINT || 'http://127.0.0.1:4242/api2').trim();
  const mistUsername = (env.V2_MIST_USERNAME || '').trim();
  const mistPassword = env.V2_MIST_PASSWORD || '';
  const mistBootstrapAccount = env.V2_MIST_BOOTSTRAP_ACCOUNT === 'true';
  if (Boolean(mistUsername) !== Boolean(mistPassword)) {
    throw new Error('MistServer credentials require both V2_MIST_USERNAME and V2_MIST_PASSWORD');
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

  const registry = createChannelRegistry(channels);
  const accountConfigs = parseAccountConfigs(env.V2_IPTV_ACCOUNTS_JSON);
  const legacyRelayBase = (env.V2_IPTV_RELAY_BASE || 'http://v2-iptv-relay.railway.internal:8080').trim();
  const accounts = accountConfigs
    ? accountConfigs.map(({ id, relayBase }) => Object.freeze({
      id,
      relayBase,
      catalogClient: createIptvCatalogClient({ baseUrl: relayBase, fetchFn }),
    }))
    : null;
  const relayBase = accounts?.[0]?.relayBase || legacyRelayBase;
  const catalogClient = accounts?.[0]?.catalogClient || createIptvCatalogClient({ baseUrl: relayBase, fetchFn });

  const mist = createMistApi({
    endpoint: mistEndpoint,
    username: mistUsername,
    password: mistPassword,
    bootstrapAccount: mistBootstrapAccount,
    fetchFn,
  });
  const sourceSupervisor = createSourceSupervisor({
    registry,
    mist,
    onError(error) {
      console.error('V2 source supervisor error', error);
    },
    onEvent(event) {
      console.log(`V2 source recovery phase ${JSON.stringify(event)}`);
    },
  });
  const gateway = createGatewayService({
    registry,
    mist,
    publicHlsBase,
    sourceSupervisor,
    catalogClient,
    relayBase,
    accounts,
    fetchFn,
  });

  return Object.freeze({
    port,
    internalToken,
    operatorPin,
    registry,
    mist,
    sourceSupervisor,
    gateway,
    accounts: accounts ? Object.freeze([...accounts]) : null,
  });
}
