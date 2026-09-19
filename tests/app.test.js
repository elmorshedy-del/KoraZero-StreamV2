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
      addstream: { 'bein-1': { source: 'https://provider.invalid/private.ts', always_on: true } },
    }]);
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('app bootstrap ensures the MistServer HTTP and HLS outputs before serving viewers', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return { ok: true, status: 200, async json() { return { config_backup: { protocols: [], config: { sessionViewerMode: 10 } } }; } };
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
    { config_backup: true },
    { addprotocol: { connector: 'HLS' } },
    { config_backup: true },
  ]);
});

test('app bootstrap registers configured channels after ensuring media outputs', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return { ok: true, status: 200, async json() { return { config_backup: { protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }], config: { sessionViewerMode: 10 } } }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'test-hls': { source: 'https://test.invalid/master.m3u8' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
  }, { fetchFn });
  await app.bootstrap();
  assert.deepEqual(commands, [
    { config_backup: true },
    { config_backup: true },
    { config_backup: true },
    { addstream: { 'test-hls': { source: 'https://test.invalid/master.m3u8' } } },
  ]);
});

test('app bootstrap enables HLS output after HTTP before registering channels', async () => {
  const commands = [];
  let configReads = 0;
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      configReads += 1;
      const protocols = configReads === 1 ? [] : [{ connector: 'HTTP', port: 8080 }];
      return { ok: true, status: 200, async json() { return { config_backup: { protocols, config: { sessionViewerMode: 10 } } }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'test-hls': { source: 'https://test.invalid/master.m3u8' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
  }, { fetchFn });
  await app.bootstrap();
  assert.deepEqual(commands, [
    { config_backup: true },
    { addprotocol: { connector: 'HTTP', port: 8080 } },
    { config_backup: true },
    { addprotocol: { connector: 'HLS' } },
    { config_backup: true },
    { addstream: { 'test-hls': { source: 'https://test.invalid/master.m3u8' } } },
  ]);
});

test('bootstrap can explicitly warm one smoke channel after lazy registration', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { config_backup: { protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }], config: { sessionViewerMode: 10 } } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'test-ts': { source: 'https-ts://source.example/live.ts' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
  }, { fetchFn });
  await app.bootstrap({ activateChannel: 'test-ts' });
  const addCommands = commands.filter((command) => command.addstream);
  assert.deepEqual(addCommands, [
    { addstream: { 'test-ts': { source: 'https-ts://source.example/live.ts' } } },
    { addstream: { 'test-ts': { source: 'https-ts://source.example/live.ts', always_on: true } } },
  ]);
});


test('app bootstrap enforces stable Mist viewer sessions before registering channels', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            config_backup: {
              protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }],
              config: { sessionViewerMode: 14 },
            },
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'test-hls': { source: 'https://test.invalid/master.m3u8' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
  }, { fetchFn });

  await app.bootstrap();

  const modeIndex = commands.findIndex((command) =>
    command?.config?.sessionViewerMode === 10
  );
  const streamIndex = commands.findIndex((command) => command?.addstream?.['test-hls']);
  assert.notEqual(modeIndex, -1, 'bootstrap must set Mist viewer sessions to stream + token mode');
  assert.notEqual(streamIndex, -1, 'bootstrap must still register configured streams');
  assert.ok(modeIndex < streamIndex, 'viewer session identity must be configured before viewer channels are registered');
});


test('app bootstrap keeps only explicitly flagged channels always on', async () => {
  const commands = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    commands.push(command);
    if (command.config_backup) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            config_backup: {
              protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }],
              config: { sessionViewerMode: 10 },
            },
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };

  const app = createApp({
    V2_CHANNELS_JSON: JSON.stringify({
      'iptv-3645': {
        source: 'http://relay.internal/live/3645.ts',
        alwaysOn: true,
      },
      'bein-2': {
        source: 'http://relay.internal/live/2454.ts',
      },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
  }, { fetchFn });

  await app.bootstrap();

  const addCommands = commands.filter((command) => command.addstream);
  assert.deepEqual(addCommands, [
    {
      addstream: {
        'iptv-3645': {
          source: 'http://relay.internal/live/3645.ts',
          always_on: true,
        },
      },
    },
    {
      addstream: {
        'bein-2': {
          source: 'http://relay.internal/live/2454.ts',
        },
      },
    },
  ]);
});
