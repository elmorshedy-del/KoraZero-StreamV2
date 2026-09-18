import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../server/runtime-config.js';

test('runtime config composes registry, Mist endpoint and public HLS base from environment', () => {
  const runtime = createRuntime({
    V2_CHANNELS_JSON: JSON.stringify({
      'bein-1': { source: 'https://provider.invalid/private.ts' },
    }),
    V2_INTERNAL_TOKEN: 'secret',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
    PORT: '8787',
  }, { fetchFn: async () => { throw new Error('not called'); } });

  assert.equal(runtime.port, 8787);
  assert.equal(runtime.internalToken, 'secret');
  assert.equal(typeof runtime.sourceSupervisor.start, 'function');
  assert.deepEqual(runtime.gateway.playback('bein-1'), {
    channelId: 'bein-1',
    manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
  });
});

test('runtime config rejects missing secrets and source registry', () => {
  assert.throws(() => createRuntime({}), /V2_CHANNELS_JSON/i);
  assert.throws(() => createRuntime({ V2_CHANNELS_JSON: '{}' }), /V2_INTERNAL_TOKEN/i);
  assert.throws(() => createRuntime({ V2_CHANNELS_JSON: '{}', V2_INTERNAL_TOKEN: 'x' }), /V2_PUBLIC_HLS_BASE/i);
});

test('runtime config rejects malformed channel JSON', () => {
  assert.throws(() => createRuntime({
    V2_CHANNELS_JSON: '{bad-json',
    V2_INTERNAL_TOKEN: 'x',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
  }), /V2_CHANNELS_JSON/i);
});

test('runtime config accepts private MistServer API credentials without exposing them in playback descriptors', () => {
  const runtime = createRuntime({
    V2_CHANNELS_JSON: JSON.stringify({ 'bein-1': { source: 'https://provider.invalid/private.ts' } }),
    V2_INTERNAL_TOKEN: 'internal-secret',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
    V2_MIST_USERNAME: 'v2control',
    V2_MIST_PASSWORD: 'mist-secret',
  }, { fetchFn: async () => { throw new Error('not called'); } });

  const descriptor = runtime.gateway.playback('bein-1');
  assert.equal(JSON.stringify(descriptor).includes('mist-secret'), false);
  assert.equal(JSON.stringify(descriptor).includes('v2control'), false);
});

test('runtime config rejects half-configured MistServer credentials', () => {
  const base = {
    V2_CHANNELS_JSON: '{}',
    V2_INTERNAL_TOKEN: 'internal-secret',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
  };
  assert.throws(() => createRuntime({ ...base, V2_MIST_USERNAME: 'v2control' }), /MistServer credentials/i);
  assert.throws(() => createRuntime({ ...base, V2_MIST_PASSWORD: 'secret' }), /MistServer credentials/i);
});

test('runtime config enables first-account bootstrap only when explicitly requested', async () => {
  const calls = [];
  const responses = [
    { authorize: { status: 'NOACC' } },
    { authorize: { status: 'ACC_MADE' } },
    { authorize: { status: 'CHALL', challenge: 'abc123' } },
    { authorize: { status: 'OK' }, config_backup: { protocols: [{ connector: 'HTTP', port: 8080 }] } },
  ];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    calls.push(command);
    const body = responses.shift();
    return { ok: true, status: 200, async json() { return body; } };
  };
  const runtime = createRuntime({
    V2_CHANNELS_JSON: '{}',
    V2_INTERNAL_TOKEN: 'internal-secret',
    V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
    V2_MIST_API_ENDPOINT: 'http://mist.internal:4242/api2',
    V2_MIST_USERNAME: 'v2control',
    V2_MIST_PASSWORD: 'mist-secret',
    V2_MIST_BOOTSTRAP_ACCOUNT: 'true',
  }, { fetchFn });

  await runtime.mist.ensureHttpProtocol({ port: 8080 });
  assert.equal(calls.some((call) => call.authorize?.new_username === 'v2control'), true);
});
