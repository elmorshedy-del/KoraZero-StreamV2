import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRegistry } from '../server/channel-registry.js';
import { createGatewayService } from '../server/gateway-service.js';

function createMistFake() {
  const calls = [];
  return {
    calls,
    async addStream(name, source, options = {}) {
      calls.push(['addStream', name, source, options]);
      return {};
    },
    async deleteStream(name) {
      calls.push(['deleteStream', name]);
      return {};
    },
    async getStream(name) {
      calls.push(['getStream', name]);
      return { streamName: name, active: true, viewers: 2, inputs: 1, outputs: 2, tracks: 2, status: 'online', health: null };
    },
  };
}

function fixture({ sourceSupervisor = null } = {}) {
  const registry = createChannelRegistry({
    'bein-1': { source: 'https://provider.invalid/private-source.ts' },
  });
  const mist = createMistFake();
  const gateway = createGatewayService({
    registry,
    mist,
    publicHlsBase: 'https://stream-v2.example/hls',
    sourceSupervisor,
  });
  return { gateway, mist };
}

test('activate configures MistServer exactly once for the logical channel and returns browser-safe playback', async () => {
  const { gateway, mist } = fixture();
  const result = await gateway.activate('bein-1');
  assert.deepEqual(mist.calls, [['addStream', 'bein-1', 'https://provider.invalid/private-source.ts', { always_on: true }]]);
  assert.deepEqual(result, {
    channelId: 'bein-1',
    manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
  });
  assert.equal(JSON.stringify(result).includes('provider.invalid'), false);
});

test('playback descriptor never activates or exposes the provider source', async () => {
  const { gateway, mist } = fixture();
  const result = await gateway.playback('bein-1');
  assert.deepEqual(mist.calls, []);
  assert.deepEqual(result, {
    channelId: 'bein-1',
    manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
  });
  assert.equal(Object.hasOwn(result, 'source'), false);
});

test('status returns MistServer runtime state without provider source', async () => {
  const { gateway } = fixture();
  const result = await gateway.status('bein-1');
  assert.deepEqual(result, {
    channelId: 'bein-1', active: true, viewers: 2, inputs: 1, outputs: 2, tracks: 2,
    status: 'online', health: null,
    manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
  });
});

test('stop removes only the requested stream', async () => {
  const { gateway, mist } = fixture();
  const result = await gateway.stop('bein-1');
  assert.deepEqual(mist.calls, [['deleteStream', 'bein-1']]);
  assert.deepEqual(result, { channelId: 'bein-1', stopped: true });
});

test('unknown channels fail before touching MistServer', async () => {
  const { gateway, mist } = fixture();
  await assert.rejects(() => gateway.playback('missing'), /unknown channel/i);
  await assert.rejects(() => gateway.activate('missing'), /unknown channel/i);
  await assert.rejects(() => gateway.status('missing'), /unknown channel/i);
  await assert.rejects(() => gateway.stop('missing'), /unknown channel/i);
  assert.deepEqual(mist.calls, []);
});

test('activate arms bounded source recovery and stop disarms it', async () => {
  const events = [];
  const sourceSupervisor = {
    arm(channelId) { events.push(['arm', channelId]); },
    disarm(channelId) { events.push(['disarm', channelId]); },
  };
  const { gateway } = fixture({ sourceSupervisor });

  await gateway.activate('bein-1');
  await gateway.stop('bein-1');

  assert.deepEqual(events, [
    ['arm', 'bein-1'],
    ['disarm', 'bein-1'],
  ]);
});


test('catalog playback switches one provider-backed Mist input at a time', async () => {
  const registry = createChannelRegistry({});
  const mist = createMistFake();
  const events = [];
  const catalogClient = {
    async list() {
      return {
        categories: [{ categoryId: '6', name: 'beIN Sports HD', count: 2 }],
        channels: [
          { streamId: '2449', name: 'beIN Sport 1 HD Q', categoryId: '6', categoryName: 'beIN Sports HD' },
          { streamId: '2454', name: 'beIN Sport 2 HD Q', categoryId: '6', categoryName: 'beIN Sports HD' },
        ],
      };
    },
    async waitForFreeSlot() {
      events.push('slot-free');
      return { activeConnections: 0, maxConnections: 1 };
    },
  };
  const gateway = createGatewayService({
    registry,
    mist,
    publicHlsBase: 'https://stream-v2.example/hls',
    catalogClient,
    relayBase: 'http://relay.internal:8080',
  });

  const first = await gateway.playback('2449');
  const second = await gateway.playback('2454');

  assert.equal(first.channelId, 'iptv-2449');
  assert.equal(second.channelId, 'iptv-2454');
  assert.deepEqual(events, ['slot-free', 'slot-free']);
  assert.deepEqual(mist.calls, [
    ['addStream', 'iptv-2449', 'http://relay.internal:8080/live/2449.ts', { always_on: true }],
    ['deleteStream', 'iptv-2449'],
    ['addStream', 'iptv-2454', 'http://relay.internal:8080/live/2454.ts', { always_on: true }],
  ]);
  assert.equal(JSON.stringify(second).includes('relay.internal'), false);
});
