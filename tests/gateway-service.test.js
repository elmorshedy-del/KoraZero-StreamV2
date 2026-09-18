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

test('playback descriptor never activates or exposes the provider source', () => {
  const { gateway, mist } = fixture();
  const result = gateway.playback('bein-1');
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
  assert.throws(() => gateway.playback('missing'), /unknown channel/i);
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
