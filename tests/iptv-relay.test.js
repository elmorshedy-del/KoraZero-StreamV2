import test from 'node:test';
import assert from 'node:assert/strict';
import { createIptvRelay } from '../server/iptv-relay-core.js';

const env = {
  V2_IPTV_PORTAL_URL: 'http://provider.example/player_api.php',
  V2_IPTV_USERNAME: 'user name',
  V2_IPTV_PASSWORD: 'p@ss/word',
  V2_IPTV_TEST_STREAM_ID: '3974',
};

test('IPTV relay answers HEAD locally without opening the provider', async () => {
  let calls = 0;
  const relay = createIptvRelay(env, { fetchFn: async () => { calls += 1; throw new Error('not expected'); } });
  const response = await relay.handle({ method: 'HEAD', pathname: '/live/3974.ts' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.has('accept-ranges'), false);
  assert.equal(calls, 0);
  assert.equal(relay.stats().totalPulls, 0);
});

test('IPTV relay GET follows redirects and streams bytes with one provider pull', async () => {
  let call;
  const relay = createIptvRelay(env, {
    fetchFn: async (url, options) => {
      call = { url, options };
      return new Response(new Uint8Array([0x47, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp2t' },
      });
    },
  });
  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.status, 200);
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'follow');
  assert.equal(call.options.headers['User-Agent'], 'VLC/3.0.18 LibVLC/3.0.18');
  assert.match(call.url, /\/live\/user%20name\/p%40ss%2Fword\/3974\.ts$/);
  assert.equal(relay.stats().activePulls, 1);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes[0], 0x47);
  assert.equal(relay.stats().activePulls, 0);
  assert.equal(relay.stats().totalPulls, 1);
  assert.equal(relay.stats().maxConcurrentPulls, 1);
});

test('IPTV relay fails closed on a second concurrent provider pull', async () => {
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0x47])); },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });
  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const second = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(second.status, 503);
  assert.equal(relay.stats().maxConcurrentPulls, 1);
  assert.equal(relay.stats().rejectedConcurrentPulls, 1);
  await first.body.cancel();
  assert.equal(relay.stats().activePulls, 0);
});

test('IPTV relay exposes only the configured stream id', async () => {
  const relay = createIptvRelay(env, { fetchFn: async () => { throw new Error('not expected'); } });
  assert.equal((await relay.handle({ method: 'GET', pathname: '/live/2449.ts' })).status, 404);
});
