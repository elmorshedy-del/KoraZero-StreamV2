import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

function env() {
  return {
    V2_CHANNELS_JSON: '{}',
    V2_INTERNAL_TOKEN: 'secret',
    V2_OPERATOR_PIN: 'operator-pin',
    V2_PUBLIC_HLS_BASE: 'https://media.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify([
      { id: 'a', relayBase: 'http://127.0.0.1:18081' },
      { id: 'b', relayBase: 'http://127.0.0.1:18082' },
    ]),
  };
}

function createFetch({ fingerprintA, fingerprintB }) {
  return async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('http://mist.internal:4242/api2')) {
      const command = JSON.parse(new URLSearchParams(options.body).get('command'));
      if (command.config_backup) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              config_backup: {
                protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }],
                config: { sessionViewerMode: 10 },
                streams: {},
              },
            };
          },
        };
      }
      return { ok: true, status: 200, async json() { return {}; } };
    }

    if (value.endsWith('/account')) {
      const fingerprint = value.includes(':18081') ? fingerprintA : fingerprintB;
      return new Response(JSON.stringify({
        auth: 1,
        status: 'Active',
        activeConnections: 0,
        maxConnections: 1,
        allowedOutputFormats: ['ts'],
        accountFingerprint: fingerprint,
      }), { status: 200 });
    }

    throw new Error(`unexpected fetch ${value}`);
  };
}

test('bootstrap keeps two configured accounts only when fingerprints are distinct', async () => {
  const app = createApp(env(), {
    fetchFn: createFetch({ fingerprintA: 'aaaaaaaaaaaa', fingerprintB: 'bbbbbbbbbbbb' }),
  });
  await app.bootstrap();
  const state = await app.gateway.active();
  assert.equal(state.capacity, 2);
  assert.equal(state.conflict, false);
});

test('bootstrap fails safely to account a when fingerprints are duplicate', async () => {
  const app = createApp(env(), {
    fetchFn: createFetch({ fingerprintA: 'aaaaaaaaaaaa', fingerprintB: 'aaaaaaaaaaaa' }),
  });
  await app.bootstrap();
  const state = await app.gateway.active();
  assert.equal(state.capacity, 1);
  assert.equal(state.slots[0].slot, 'a');
});

test('bootstrap fails safely to account a when one fingerprint is missing', async () => {
  const app = createApp(env(), {
    fetchFn: createFetch({ fingerprintA: 'aaaaaaaaaaaa', fingerprintB: null }),
  });
  await app.bootstrap();
  const state = await app.gateway.active();
  assert.equal(state.capacity, 1);
});
