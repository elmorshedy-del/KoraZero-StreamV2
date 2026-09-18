import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

function createMistTransport() {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const params = new URLSearchParams(options.body);
    const command = JSON.parse(params.get('command'));
    commands.push(command);
    if (command.active_streams) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { active_streams: { 'bein-1': { viewers: 1, inputs: 1, outputs: 1, tracks: 2, status: 'online' } } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  return { commands, fetchFn };
}

test('createApp composes the disposable site, public descriptor and authenticated Mist control', async () => {
  const transport = createMistTransport();
  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'bein-1': { source: 'https://provider.invalid/private.ts' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
    PORT: '8787',
  }, { fetchFn: transport.fetchFn });

  assert.equal(app.port, 8787);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    let response = await fetch(`${base}/`);
    assert.equal(response.status, 200);

    response = await fetch(`${base}/api/playback/bein-1`);
    assert.deepEqual(await response.json(), {
      channelId: 'bein-1',
      manifestUrl: 'https://media.example/hls/bein-1/index.m3u8',
    });
    assert.deepEqual(transport.commands, []);

    response = await fetch(`${base}/internal/channels/bein-1/activate`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(transport.commands, [{
      addstream: { 'bein-1': { source: 'https://provider.invalid/private.ts' } },
    }]);
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('app bootstrap ensures the MistServer HTTP output before serving viewers', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return { ok: true, status: 200, async json() { return { config_backup: { protocols: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const app = createApp({
    V2_CHANNELS_JSON: '{}',
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
  }, { fetchFn });

  await app.bootstrap();

  assert.deepEqual(commands, [
    { config_backup: true },
    { addprotocol: { connector: 'HTTP', port: 8080 } },
  ]);
});
