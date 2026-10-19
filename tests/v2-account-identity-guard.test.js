import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

const accountConfig = [
  { id: 'a', relayBase: 'http://relay-a.railway.internal:8080' },
  { id: 'b', relayBase: 'http://relay-b.railway.internal:8080' },
];

function env() {
  return {
    V2_CHANNELS_JSON: '{}',
    V2_INTERNAL_TOKEN: 'test-token',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.test:4242/api2',
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify(accountConfig),
  };
}

function responder(aFingerprint, bFingerprint) {
  return async (url, options = {}) => {
    const value = String(url);
    if (value === 'http://relay-a.railway.internal:8080/account') {
      return new Response(JSON.stringify({
        auth: 1, status: 'Active', activeConnections: 0, maxConnections: 1,
        allowedOutputFormats: ['ts'], accountFingerprint: aFingerprint,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value === 'http://relay-b.railway.internal:8080/account') {
      return new Response(JSON.stringify({
        auth: 1, status: 'Active', activeConnections: 0, maxConnections: 1,
        allowedOutputFormats: ['ts'], accountFingerprint: bFingerprint,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value === 'http://mist.test:4242/api2') {
      const command = JSON.parse(new URLSearchParams(options.body || '').get('command'));
      if (command.config_backup) {
        return new Response(JSON.stringify({
          config_backup: {
            protocols: [{ connector: 'HTTP', port: 8080 }, { connector: 'HLS' }],
            config: { sessionViewerMode: 10 },
            streams: {},
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error('unexpected URL ' + value);
  };
}

test('distinct account fingerprints keep both configured slots enabled', async () => {
  const app = createApp(env(), { fetchFn: responder('111111111111', '222222222222') });
  const result = await app.bootstrap();
  assert.deepEqual(result.accountGuard, { configured: 2, enabled: 2 });
  assert.equal((await app.gateway.active()).capacity, 2);
});

test('duplicate account fingerprints force single-slot fallback', async () => {
  const app = createApp(env(), { fetchFn: responder('111111111111', '111111111111') });
  const result = await app.bootstrap();
  assert.deepEqual(result.accountGuard, { configured: 2, enabled: 1, fallback: 'a' });
  assert.equal((await app.gateway.active()).capacity, 1);
});

test('missing account fingerprint also fails closed to slot a', async () => {
  const app = createApp(env(), { fetchFn: responder('111111111111', null) });
  const result = await app.bootstrap();
  assert.equal(result.accountGuard.enabled, 1);
  assert.equal(result.accountGuard.fallback, 'a');
});
