import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRegistry } from '../server/channel-registry.js';
import { createGatewayService } from '../server/gateway-service.js';

function createMistFake(initial = {}) {
  const sources = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    sources,
    async listConfiguredStreamSources() {
      calls.push(['listConfiguredStreamSources']);
      return Object.fromEntries(sources);
    },
    async listConfiguredStreams() {
      return [...sources.keys()];
    },
    async getStreamSource(name) {
      return sources.get(name) || null;
    },
    async getStream(name) {
      const active = sources.has(name);
      return {
        streamName: name,
        active,
        viewers: active ? 2 : 0,
        inputs: active ? 1 : 0,
        outputs: active ? 1 : 0,
        tracks: active ? 2 : 0,
        status: active ? 'online' : 'inactive',
        health: null,
      };
    },
    async addStream(name, source, options = {}) {
      calls.push(['addStream', name, source, options]);
      sources.set(name, source);
      return {};
    },
    async nukeStream(name) {
      calls.push(['nukeStream', name]);
      return {};
    },
    async deleteStream(name) {
      calls.push(['deleteStream', name]);
      sources.delete(name);
      return {};
    },
  };
}

function account(id, relayBase, events) {
  return {
    id,
    relayBase,
    catalogClient: {
      async list() {
        return {
          categories: [],
          channels: [
            { streamId: '111', name: 'One', categoryId: '1', categoryName: 'Test' },
            { streamId: '222', name: 'Two', categoryId: '1', categoryName: 'Test' },
            { streamId: '333', name: 'Three', categoryId: '1', categoryName: 'Test' },
          ],
        };
      },
      async waitForFreeSlot() {
        events.push(['wait', id]);
        return { activeConnections: 0, maxConnections: 1, accountFingerprint: id.repeat(12) };
      },
      async stats() {
        return { streams: {} };
      },
    },
  };
}

function fixture(initial = {}) {
  const events = [];
  const mist = createMistFake(initial);
  const accounts = [
    account('a', 'http://relay-a.railway.internal:8080', events),
    account('b', 'http://relay-b.railway.internal:8080', events),
  ];
  const gateway = createGatewayService({
    registry: createChannelRegistry({}),
    mist,
    publicHlsBase: 'https://stream-v2.example/hls',
    accounts,
    catalogClient: accounts[0].catalogClient,
    relayBase: accounts[0].relayBase,
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 376, totalMs: 5 }),
  });
  return { gateway, mist, events };
}

test('two V2 slots can carry different channels without one switch deleting the other', async () => {
  const { gateway, mist, events } = fixture();

  const first = await gateway.activate('111', { slot: 'a' });
  const second = await gateway.activate('222', { slot: 'b' });

  assert.equal(first.slot, 'a');
  assert.equal(second.slot, 'b');
  assert.equal(mist.sources.get('iptv-111'), 'http://relay-a.railway.internal:8080/live/111.ts');
  assert.equal(mist.sources.get('iptv-222'), 'http://relay-b.railway.internal:8080/live/222.ts');
  assert.equal(mist.calls.some((call) => call[0] === 'deleteStream' && call[1] === 'iptv-111'), false);
  assert.deepEqual(events, [['wait', 'a'], ['wait', 'b']]);

  const state = await gateway.active();
  assert.equal(state.capacity, 2);
  assert.equal(state.conflict, false);
  assert.deepEqual(state.live.map((item) => item.channelId).sort(), ['iptv-111', 'iptv-222']);
});

test('concurrent requests for the same channel create only one provider pull', async () => {
  const { gateway, mist, events } = fixture();

  const [one, two] = await Promise.all([
    gateway.activate('111'),
    gateway.activate('111'),
  ]);

  assert.equal(one.channelId, 'iptv-111');
  assert.equal(two.channelId, 'iptv-111');
  assert.equal(events.filter((event) => event[0] === 'wait').length, 1);
  assert.equal(mist.calls.filter((call) => call[0] === 'addStream' && call[1] === 'iptv-111').length, 1);
});

test('automatic slot selection never evicts when all slots are busy', async () => {
  const { gateway } = fixture({
    'iptv-111': 'http://relay-a.railway.internal:8080/live/111.ts',
    'iptv-222': 'http://relay-b.railway.internal:8080/live/222.ts',
  });

  await assert.rejects(
    () => gateway.activate('333'),
    (error) => error?.code === 'all_slots_busy',
  );
});

test('explicit slot replacement only stops the selected slot', async () => {
  const { gateway, mist } = fixture({
    'iptv-111': 'http://relay-a.railway.internal:8080/live/111.ts',
    'iptv-222': 'http://relay-b.railway.internal:8080/live/222.ts',
  });

  await gateway.activate('333', { slot: 'b' });

  assert.equal(mist.sources.has('iptv-111'), true);
  assert.equal(mist.sources.has('iptv-222'), false);
  assert.equal(mist.sources.get('iptv-333'), 'http://relay-b.railway.internal:8080/live/333.ts');
  assert.equal(mist.calls.some((call) => call[0] === 'deleteStream' && call[1] === 'iptv-111'), false);
  assert.equal(mist.calls.some((call) => call[0] === 'deleteStream' && call[1] === 'iptv-222'), true);
});

test('controller restart reconstructs slot ownership from Mist source hosts', async () => {
  const { gateway } = fixture({
    'iptv-111': 'http://relay-a.railway.internal:8080/live/111.ts',
    'iptv-222': 'http://relay-b.railway.internal:8080/live/222.ts',
  });

  const state = await gateway.active();
  assert.equal(state.conflict, false);
  assert.deepEqual(
    state.slots.map((slot) => ({ slot: slot.slot, channelId: slot.channelId })),
    [
      { slot: 'a', channelId: 'iptv-111' },
      { slot: 'b', channelId: 'iptv-222' },
    ],
  );
});

test('unknown Mist ownership fails closed instead of assigning it to a slot', async () => {
  const { gateway } = fixture({
    'iptv-111': 'http://unknown-relay.railway.internal:8080/live/111.ts',
  });

  const state = await gateway.active();
  assert.equal(state.conflict, true);
  assert.equal(state.live[0].slot, null);
});

test('operator-style off can stop one slot without touching the other', async () => {
  const { gateway, mist } = fixture({
    'iptv-111': 'http://relay-a.railway.internal:8080/live/111.ts',
    'iptv-222': 'http://relay-b.railway.internal:8080/live/222.ts',
  });

  const result = await gateway.stopDynamic({ slot: 'b', manual: true });
  assert.deepEqual(result.channels, ['iptv-222']);
  assert.equal(mist.sources.has('iptv-111'), true);
  assert.equal(mist.sources.has('iptv-222'), false);

  const state = await gateway.active();
  assert.equal(state.slots.find((slot) => slot.slot === 'b').mode, 'manual');
});

test('missing slot for multi-account off fails closed', async () => {
  const { gateway } = fixture();
  await assert.rejects(
    () => gateway.stopDynamic({ manual: true }),
    (error) => error?.code === 'slot_required',
  );
});
