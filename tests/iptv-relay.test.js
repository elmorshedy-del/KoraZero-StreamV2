import test from 'node:test';
import assert from 'node:assert/strict';
import { createIptvRelay } from '../server/iptv-relay-core.js';

function tsPacket(pid = 256, cc = 0) {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x10 | (cc & 0x0f);
  packet.fill(0xff, 4);
  return packet;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

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
      return new Response(concat(tsPacket(256, 0), tsPacket(256, 1)), {
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
  assert.equal(call.options.headers.Range, 'bytes=0-');
  assert.match(call.url, /\/live\/user%20name\/p%40ss%2Fword\/3974\.ts$/);
  assert.equal(relay.stats().activePulls, 1);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 376);
  assert.equal(bytes[0], 0x47);
  assert.equal(bytes[188], 0x47);
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


test('IPTV relay injects packet-aligned TS null bursts during upstream silence', async () => {
  let upstreamController;
  const first = concat(tsPacket(256, 0), tsPacket(256, 1));
  const relay = createIptvRelay(env, {
    idleKeepaliveMs: 10,
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(first.slice(0, 211));
        controller.enqueue(first.slice(211));
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const reader = response.body.getReader();

  const real = await reader.read();
  assert.equal(real.done, false);
  assert.equal(real.value.length, 376);
  assert.equal(real.value[0], 0x47);
  assert.equal(real.value[188], 0x47);

  const heartbeat = await reader.read();
  assert.equal(heartbeat.done, false);
  assert.ok(heartbeat.value.length > 25_600);
  assert.equal(heartbeat.value.length % 188, 0);
  for (let offset = 0; offset < heartbeat.value.length; offset += 188) {
    assert.equal(heartbeat.value[offset], 0x47);
    const pid = ((heartbeat.value[offset + 1] & 0x1f) << 8) | heartbeat.value[offset + 2];
    assert.equal(pid, 0x1fff);
  }

  assert.equal(relay.stats().keepaliveBursts, 1);
  assert.equal(relay.stats().keepaliveBytes, heartbeat.value.length);
  upstreamController.close();
  await reader.cancel();
});

test('IPTV relay keeps split provider chunks aligned to 188-byte TS packets', async () => {
  const bytes = concat(tsPacket(100, 0), tsPacket(100, 1), tsPacket(100, 2));
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 59));
        controller.enqueue(bytes.slice(59, 333));
        controller.enqueue(bytes.slice(333));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const output = new Uint8Array(await response.arrayBuffer());
  assert.equal(output.length, bytes.length);
  assert.deepEqual(output, bytes);
});


test('relay observability separates provider attempts, successful opens, failures, and blocked duplicates', async () => {
  let upstreamController;
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(concat(tsPacket(256, 0), tsPacket(256, 1)));
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const blocked = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });

  assert.equal(blocked.status, 503);
  assert.equal(relay.stats().providerAttempts, 1);
  assert.equal(relay.stats().successfulProviderOpens, 1);
  assert.equal(relay.stats().failedProviderOpens, 0);
  assert.equal(relay.stats().rejectedConcurrentPulls, 1);

  upstreamController.close();
  await first.body.cancel();
});

test('relay counts upstream HTTP failure as a failed provider open', async () => {
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response('bad gateway', { status: 502 }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.status, 502);
  assert.equal(relay.stats().providerAttempts, 1);
  assert.equal(relay.stats().successfulProviderOpens, 0);
  assert.equal(relay.stats().failedProviderOpens, 1);
});
