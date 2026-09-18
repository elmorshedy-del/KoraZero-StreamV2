import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRegistry } from '../server/channel-registry.js';
import { createGatewayService } from '../server/gateway-service.js';

function createMistFake() {
  const calls = [];
  const configured = new Set();
  return {
    calls,
    configured,
    async addStream(name, source, options = {}) {
      calls.push(['addStream', name, source, options]);
      configured.add(name);
      return {};
    },
    async deleteStream(name) {
      calls.push(['deleteStream', name]);
      configured.delete(name);
      return {};
    },
    async nukeStream(name) {
      calls.push(['nukeStream', name]);
      return {};
    },
    async getStream(name) {
      calls.push(['getStream', name]);
      if (name.startsWith('iptv-') && !configured.has(name)) {
        return { streamName: name, active: false, viewers: 0, inputs: 0, outputs: 0, tracks: 0, status: 'inactive', health: null };
      }
      return { streamName: name, active: true, viewers: 2, inputs: 1, outputs: 2, tracks: 2, status: 'online', health: null };
    },
    async listConfiguredStreams() {
      calls.push(['listConfiguredStreams']);
      return [...configured];
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
    catalogClient: {
      ...catalogClient,
      async stats() { return { streams: {} }; },
    },
    relayBase: 'http://relay.internal:8080',
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 376, totalMs: 5 }),
  });

  const first = await gateway.playback('2449');
  const second = await gateway.playback('2454');

  assert.equal(first.channelId, 'iptv-2449');
  assert.equal(second.channelId, 'iptv-2454');
  assert.deepEqual(events, ['slot-free', 'slot-free']);
  assert.deepEqual(mist.calls, [
    ['listConfiguredStreams'],
    ['addStream', 'iptv-2449', 'http://relay.internal:8080/live/2449.ts', { always_on: true }],
    ['listConfiguredStreams'],
    ['nukeStream', 'iptv-2449'],
    ['deleteStream', 'iptv-2449'],
    ['getStream', 'iptv-2449'],
    ['addStream', 'iptv-2454', 'http://relay.internal:8080/live/2454.ts', { always_on: true }],
  ]);
  assert.equal(first.verified, true);
  assert.equal(first.diagnostics.segmentBytes, 376);
  assert.equal(second.verified, true);
  assert.equal(JSON.stringify(second).includes('relay.internal'), false);
});


test('catalog playback cleans stale dynamic Mist streams without arming the static supervisor', async () => {
  const registry = createChannelRegistry({});
  const mist = createMistFake();
  mist.listConfiguredStreams = async () => {
    mist.calls.push(['listConfiguredStreams']);
    return ['bein-1', 'iptv-111', 'iptv-222'];
  };
  const supervisorEvents = [];
  const sourceSupervisor = {
    arm(id) { supervisorEvents.push(['arm', id]); },
    disarm(id) { supervisorEvents.push(['disarm', id]); },
  };
  const catalogClient = {
    async list() {
      return { categories: [], channels: [{ streamId: '333', name: 'Three', categoryId: '', categoryName: 'Other' }] };
    },
    async waitForFreeSlot() { return { activeConnections: 0, maxConnections: 1 }; },
  };
  const gateway = createGatewayService({
    registry, mist, sourceSupervisor,
    catalogClient: {
      ...catalogClient,
      async stats() { return { streams: {} }; },
    },
    publicHlsBase: 'https://stream-v2.example/hls',
    relayBase: 'http://relay.internal:8080',
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 564, totalMs: 7 }),
  });

  const result = await gateway.playback('333');
  assert.equal(result.channelId, 'iptv-333');
  assert.deepEqual(mist.calls, [
    ['listConfiguredStreams'],
    ['nukeStream', 'iptv-111'],
    ['deleteStream', 'iptv-111'],
    ['getStream', 'iptv-111'],
    ['nukeStream', 'iptv-222'],
    ['deleteStream', 'iptv-222'],
    ['getStream', 'iptv-222'],
    ['addStream', 'iptv-333', 'http://relay.internal:8080/live/333.ts', { always_on: true }],
  ]);
  assert.equal(result.verified, true);
  assert.deepEqual(supervisorEvents, []);
});


test('catalog playback fails closed, cleans Mist, and preserves a phase trace when HLS verification fails', async () => {
  const registry = createChannelRegistry({});
  const mist = createMistFake();
  const catalogClient = {
    async list() {
      return { categories: [], channels: [{ streamId: '444', name: 'Broken', categoryId: '9', categoryName: 'Test' }] };
    },
    async waitForFreeSlot() { return { activeConnections: 0, maxConnections: 1 }; },
    async stats() { return { streams: {} }; },
  };
  const gateway = createGatewayService({
    registry,
    mist,
    publicHlsBase: 'https://stream-v2.example/hls',
    catalogClient,
    relayBase: 'http://relay.internal:8080',
    playbackProbeFn: async () => { throw new Error('segment HTTP 404'); },
  });

  await assert.rejects(() => gateway.playback('444'), /playback verification failed/i);
  const diagnostic = gateway.diagnostic('444');
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.phase, 'failed');
  assert.match(diagnostic.error, /segment HTTP 404/);
  assert.ok(diagnostic.events.some((event) => event.phase === 'hls-verify-start'));
  assert.ok(diagnostic.events.some((event) => event.phase === 'failed'));
  assert.deepEqual(mist.calls, [
    ['listConfiguredStreams'],
    ['addStream', 'iptv-444', 'http://relay.internal:8080/live/444.ts', { always_on: true }],
    ['nukeStream', 'iptv-444'],
    ['deleteStream', 'iptv-444'],
    ['getStream', 'iptv-444'],
  ]);
});


test('stale Mist input bookkeeping never blocks a verified channel switch when provider slot is free', async () => {
  const registry = createChannelRegistry({});
  const calls = [];
  const mist = {
    async listConfiguredStreams() {
      calls.push(['listConfiguredStreams']);
      return ['iptv-2463'];
    },
    async nukeStream(name) {
      calls.push(['nukeStream', name]);
      return {};
    },
    async deleteStream(name) {
      calls.push(['deleteStream', name]);
      return {};
    },
    async getStream(name) {
      calls.push(['getStream', name]);
      return {
        streamName: name,
        active: true,
        viewers: 0,
        inputs: 1,
        outputs: 0,
        tracks: 0,
        status: 'stale',
        health: null,
      };
    },
    async addStream(name, source, options = {}) {
      calls.push(['addStream', name, source, options]);
      return {};
    },
  };
  const catalogClient = {
    async list() {
      return {
        categories: [],
        channels: [{ streamId: '3645', name: 'beIN Sport 1 Vega', categoryId: '1', categoryName: 'beIN Sports Vega' }],
      };
    },
    async waitForFreeSlot() {
      calls.push(['provider-slot-free']);
      return { activeConnections: 0, maxConnections: 1 };
    },
    async stats() {
      return { streams: { '3645': { transportMode: 'hls-to-ts', playlistFetches: 1, segmentFetches: 3 } } };
    },
  };
  const gateway = createGatewayService({
    registry,
    mist,
    publicHlsBase: 'https://stream-v2.example/hls',
    catalogClient,
    relayBase: 'http://relay.internal:8080',
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 123456, totalMs: 10 }),
    sleepFn: async () => {},
  });

  const started = Date.now();
  const result = await gateway.playback('3645');
  assert.equal(result.verified, true);
  assert.equal(result.channelId, 'iptv-3645');
  assert.ok(Date.now() - started < 3_000);
  assert.ok(calls.some((call) => call[0] === 'provider-slot-free'));
  assert.ok(calls.some((call) => call[0] === 'addStream' && call[1] === 'iptv-3645'));
  const diagnostic = gateway.diagnostic('3645');
  assert.equal(diagnostic.ok, true);
  assert.ok(diagnostic.events.some((event) => event.phase === 'mist-stop-stale'));
  assert.equal(diagnostic.phase, 'verified');
});
