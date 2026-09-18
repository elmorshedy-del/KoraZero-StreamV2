import { createHash } from 'node:crypto';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4242/api2';
const STATUS_FIELDS = ['viewers', 'inputs', 'outputs', 'lastms', 'health', 'tracks', 'status'];

export function createMistApi({ endpoint = DEFAULT_ENDPOINT, username = '', password = '', bootstrapAccount = false, fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Mist API requires fetch');

  function md5(value) {
    return createHash('md5').update(value).digest('hex');
  }

  async function post(payload) {
    const body = new URLSearchParams({ command: JSON.stringify(payload) }).toString();
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response?.ok) {
      throw new Error(`MistServer API request failed with HTTP ${response?.status ?? 'unknown'}`);
    }
    return response.json();
  }

  function assertAuthorized(response) {
    const status = response?.authorize?.status;
    if (status === 'NOACC') throw new Error('MistServer has no account configured');
    if (status === 'CHALL') throw new Error('MistServer authentication failed');
    return response;
  }

  async function command(payload) {
    if (!username && !password) {
      return assertAuthorized(await post(payload));
    }

    const first = await post({
      ...payload,
      authorize: { username, password: '' },
      minimal: 1,
    });
    const status = first?.authorize?.status;
    if (status === 'OK') return first;
    if (status === 'NOACC') {
      if (!bootstrapAccount) throw new Error('MistServer has no account configured');
      const created = await post({
        authorize: { new_username: username, new_password: password },
        minimal: 1,
      });
      if (created?.authorize?.status !== 'ACC_MADE') {
        throw new Error('MistServer first account creation failed');
      }
      return command(payload);
    }
    if (status !== 'CHALL' || !first.authorize.challenge) {
      throw new Error(`Unexpected MistServer authorization status: ${status ?? 'missing'}`);
    }

    const response = await post({
      ...payload,
      authorize: {
        username,
        password: md5(md5(password) + first.authorize.challenge),
      },
      minimal: 1,
    });
    if (response?.authorize?.status !== 'OK') {
      throw new Error('MistServer authentication failed');
    }
    return response;
  }

  async function ensureHttpProtocol({ port = 8080 } = {}) {
    const backup = await command({ config_backup: true });
    const protocols = Array.isArray(backup?.config_backup?.protocols)
      ? backup.config_backup.protocols
      : [];
    const existing = protocols.find((protocol) =>
      protocol?.connector === 'HTTP' && Number(protocol?.port ?? 8080) === Number(port)
    );
    if (existing) return { changed: false, port: Number(port) };
    await command({ addprotocol: { connector: 'HTTP', port: Number(port) } });
    return { changed: true, port: Number(port) };
  }

  async function ensureHlsProtocol() {
    const backup = await command({ config_backup: true });
    const protocols = Array.isArray(backup?.config_backup?.protocols)
      ? backup.config_backup.protocols
      : [];
    const existing = protocols.find((protocol) => protocol?.connector === 'HLS');
    if (existing) return { changed: false };
    await command({ addprotocol: { connector: 'HLS' } });
    return { changed: true };
  }

  async function ensureViewerSessionMode({ mode = 10 } = {}) {
    const normalizedMode = Number(mode);
    if (!Number.isInteger(normalizedMode) || normalizedMode < 0 || normalizedMode > 15) {
      throw new Error('MistServer viewer session mode must be an integer from 0 through 15');
    }
    const backup = await command({ config_backup: true });
    const rawPreviousMode = backup?.config_backup?.config?.sessionViewerMode;
    const previousMode = rawPreviousMode === null || rawPreviousMode === undefined
      ? null
      : Number(rawPreviousMode);
    if (previousMode === normalizedMode) {
      return { changed: false, previousMode, mode: normalizedMode };
    }
    await command({ config: { sessionViewerMode: normalizedMode } });
    return { changed: true, previousMode, mode: normalizedMode };
  }

  function normalizedLastMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return Object.freeze({
    ensureHttpProtocol,
    ensureHlsProtocol,
    ensureViewerSessionMode,

    async addStream(name, source, options = {}) {
      return command({ addstream: { [name]: { ...options, source } } });
    },

    async deleteStream(name) {
      return command({ deletestream: name });
    },

    async nukeStream(name) {
      return command({ nuke_stream: name });
    },

    async getStream(name) {
      const response = await command({
        active_streams: {
          stream: name,
          fields: STATUS_FIELDS,
          longform: true,
        },
      });
      const active = response?.active_streams?.[name] ?? null;
      if (!active) {
        return {
          streamName: name,
          active: false,
          viewers: 0,
          inputs: 0,
          outputs: 0,
          lastms: null,
          tracks: 0,
          status: 'inactive',
          health: null,
        };
      }
      return {
        streamName: name,
        active: true,
        viewers: Number(active.viewers ?? 0),
        inputs: Number(active.inputs ?? 0),
        outputs: Number(active.outputs ?? 0),
        lastms: normalizedLastMs(active.lastms),
        tracks: Number(active.tracks ?? 0),
        status: active.status ?? 'active',
        health: active.health ?? null,
      };
    },
  });
}
