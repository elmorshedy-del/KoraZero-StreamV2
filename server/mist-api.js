const DEFAULT_ENDPOINT = 'http://127.0.0.1:4242/api2';
const STATUS_FIELDS = ['viewers', 'inputs', 'outputs', 'health', 'tracks', 'status'];

export function createMistApi({ endpoint = DEFAULT_ENDPOINT, fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Mist API requires fetch');

  async function command(payload) {
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

  return Object.freeze({
    async addStream(name, source) {
      return command({ addstream: { [name]: { source } } });
    },

    async deleteStream(name) {
      return command({ deletestream: name });
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
        tracks: Number(active.tracks ?? 0),
        status: active.status ?? 'active',
        health: active.health ?? null,
      };
    },
  });
}
