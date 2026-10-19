import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRegistry } from '../server/channel-registry.js';
import { createGatewayService } from '../server/gateway-service.js';

function createMistFake(initial = {}, inactive = []) {
  const sources = new Map(Object.entries(initial));
  const inactiveNames = new Set(inactive);
  const calls = [];
  return {
    calls,
    sources,
    async listConfiguredStreamSources() {
      calls.push(['listConfiguredStreamSources']);
      return Object.fromEntries(sources);
    },
    async listConfiguredStreams() {
      calls.push(['listConfiguredStreams']);
      return [...sources.keys()].sort();
    },
    async getStreamSource(name) {
      calls.push(['getStreamSource', name]);
      return sources.get(name) || null;
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
    async getStream(name) {
      calls.push(['getStream', name]);
      const active = sources.has(name) && !inactiveNames.has(name);
      return {
        streamName: name,
        active,
        viewers: active ? 3 : 0,
        inputs: active ? 1 : 0,
        outputs: active ? 2 : 0,
        tracks: active ? 2 : 0,
        status: active ? 'online' : 'inactive',
        health: null,
      };
    },
  };
}

function catalogClient() {
  const channels = [
    { streamId: '3645', name: 'beIN Sports 1', categoryId: '1', categoryName: 'beIN' },
    { streamId: '3653', name: 'beIN Sports 3', categoryId: '1', categoryName: 'beIN' },
    { streamId: '3652', name: 'beIN Sports 4', categoryId: '1', categoryName: 'beIN' },
  ];
  return {
    async list() { return { categories: [], channels }; },
    async waitForFreeSlot() { return { activeConnections: 0, maxConnections: 1 }; },
    async stats() { return { streams: {} }; },
    async account() {
      return {
        auth: 1,
        status: 'Active',
        activeConnections: 0,
        maxConnections: 1,
        accountFingerprint: '111111111111',
      };
    },
  };
}

function fixture(initial = {}, inactive = []) {
  const mist = createMistFake(initial, inactive);
  const registry = createChannelRegistry({});
  const accounts = [
    { id: 'a', relayBase: 'http://relay-a.railway.internal:8080', catalogClient: catalogClient() },
    { id: 'b', relayBase: 'http://relay-b.railway.internal:8080', catalogClient: catalogClient() },
  ];
  const gateway = createGatewayService({
    registry,
    mist,
    accounts,
    publicHlsBase: 'https://stream-v2.example/hls',
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 376, totalMs: 5 }),
    sleepFn: async () => {},
  });
  return { gateway, mist, accounts };
}

test('two healthy Mist inputs map to two slots without conflict', async () => {
  const { gateway } = fixture({
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-b.railway.internal:8080/live/3653.ts',
  });

  const state = await gateway.active();
  assert.equal(state.capacity, 2);
  assert.equal(state.conflict, false);
  assert.deepEqual(state.live.map((item) => [item.channelId, item.slot]).sort(), [
    ['iptv-3645', 'a'],
    ['iptv-3653', 'b'],
  ]);
  assert.equal(state.active.channelId, 'iptv-3645');
  assert.equal(state.slots.find((slot) => slot.slot === 'a').channelId, 'iptv-3645');
  assert.equal(state.slots.find((slot) => slot.slot === 'b').channelId, 'iptv-3653');
});

test('controller restart derives slot ownership from Mist stream source hosts', async () => {
  const initial = {
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-b.railway.internal:8080/live/3653.ts',
  };
  const first = fixture(initial);
  const state1 = await first.gateway.active();

  const registry = createChannelRegistry({});
  const restarted = createGatewayService({
    registry,
    mist: first.mist,
    accounts: first.accounts,
    publicHlsBase: 'https://stream-v2.example/hls',
    playbackProbeFn: async () => ({ ok: true, segmentBytes: 376, totalMs: 5 }),
    sleepFn: async () => {},
  });
  const state2 = await restarted.active();

  assert.deepEqual(
    state2.slots.map((slot) => [slot.slot, slot.channelId]),
    state1.slots.map((slot) => [slot.slot, slot.channelId]),
  );
  assert.equal(state2.conflict, false);
});

test('unknown ownership and two live inputs on one account fail closed as conflict', async () => {
  const unknown = fixture({
    'iptv-3645': 'http://unknown.railway.internal:8080/live/3645.ts',
  });
  assert.equal((await unknown.gateway.active()).conflict, true);

  const duplicate = fixture({
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-a.railway.internal:8080/live/3653.ts',
  });
  assert.equal((await duplicate.gateway.active()).conflict, true);
});

test('different slots switch concurrently without deleting each other', async () => {
  const { gateway, mist } = fixture();
  const [a, b] = await Promise.all([
    gateway.activate('3645', { slot: 'a' }),
    gateway.activate('3653', { slot: 'b' }),
  ]);

  assert.equal(a.slot, 'a');
  assert.equal(b.slot, 'b');
  assert.equal(mist.sources.get('iptv-3645'), 'http://relay-a.railway.internal:8080/live/3645.ts');
  assert.equal(mist.sources.get('iptv-3653'), 'http://relay-b.railway.internal:8080/live/3653.ts');
  assert.equal(mist.calls.filter((call) => call[0] === 'addStream').length, 2);
  assert.equal((await gateway.active()).conflict, false);
});

test('concurrent requests for the same channel create only one Mist/provider assignment', async () => {
  const { gateway, mist } = fixture();
  const [first, second] = await Promise.all([
    gateway.activate('3645', { slot: 'a' }),
    gateway.activate('3645', { slot: 'b' }),
  ]);

  assert.equal(first.slot, 'a');
  assert.equal(second.slot, 'a');
  assert.equal(mist.calls.filter((call) => call[0] === 'addStream' && call[1] === 'iptv-3645').length, 1);
  assert.equal(mist.sources.size, 1);
});

test('auto-pick never evicts when all slots are busy', async () => {
  const { gateway } = fixture({
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-b.railway.internal:8080/live/3653.ts',
  });

  await assert.rejects(
    () => gateway.activate('3652'),
    (error) => error?.code === 'all_slots_busy',
  );
});

test('explicit replacement stops only the requested slot', async () => {
  const { gateway, mist } = fixture({
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-b.railway.internal:8080/live/3653.ts',
  });

  const result = await gateway.activate('3652', { slot: 'b' });
  assert.equal(result.slot, 'b');
  assert.equal(mist.sources.has('iptv-3645'), true);
  assert.equal(mist.sources.has('iptv-3653'), false);
  assert.equal(mist.sources.get('iptv-3652'), 'http://relay-b.railway.internal:8080/live/3652.ts');
  assert.equal(mist.calls.some((call) => call[0] === 'deleteStream' && call[1] === 'iptv-3645'), false);
});

test('slot-scoped off never stops the other live slot', async () => {
  const { gateway, mist } = fixture({
    'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    'iptv-3653': 'http://relay-b.railway.internal:8080/live/3653.ts',
  });

  const result = await gateway.stopDynamic({ slot: 'a', manual: true });
  assert.deepEqual(result.channels, ['iptv-3645']);
  assert.equal(mist.sources.has('iptv-3645'), false);
  assert.equal(mist.sources.has('iptv-3653'), true);
  const state = await gateway.active();
  assert.equal(state.slots.find((slot) => slot.slot === 'a').mode, 'manual');
  assert.equal(state.slots.find((slot) => slot.slot === 'b').channelId, 'iptv-3653');
});

test('slot replacement deletes an owned configured stream even when Mist reports it inactive', async () => {
  const { gateway, mist } = fixture(
    {
      'iptv-3645': 'http://relay-a.railway.internal:8080/live/3645.ts',
    },
    ['iptv-3645'],
  );

  const result = await gateway.activate('3653', { slot: 'a' });
  assert.equal(result.slot, 'a');
  assert.equal(mist.sources.has('iptv-3645'), false);
  assert.equal(mist.sources.get('iptv-3653'), 'http://relay-a.railway.internal:8080/live/3653.ts');
  assert.ok(mist.calls.some((call) => call[0] === 'deleteStream' && call[1] === 'iptv-3645'));
});

test('multi-account Off requires an explicit slot unless all is explicitly requested', async () => {
  const { gateway } = fixture();
  await assert.rejects(
    () => gateway.stopDynamic(),
    (error) => error?.code === 'slot_required',
  );
});

test('manual switch marks only that slot manual and Resume Auto clears it', async () => {
  const { gateway } = fixture();
  await gateway.activate('3645', { slot: 'a', manual: true });
  let state = await gateway.active();
  assert.equal(state.slots.find((slot) => slot.slot === 'a').mode, 'manual');
  assert.equal(state.slots.find((slot) => slot.slot === 'b').mode, 'auto');

  await gateway.resumeAuto('a');
  state = await gateway.active();
  assert.equal(state.slots.find((slot) => slot.slot === 'a').mode, 'auto');
  assert.equal(state.slots.find((slot) => slot.slot === 'a').manualUntil, null);
});

test('automation cannot replace an actively held manual slot', async () => {
  const { gateway, mist } = fixture();
  await gateway.activate('3645', { slot: 'a', manual: true });

  await assert.rejects(
    () => gateway.activate('3653', { slot: 'a' }),
    (error) => error?.code === 'slot_manual_hold',
  );

  assert.equal(mist.sources.get('iptv-3645'), 'http://relay-a.railway.internal:8080/live/3645.ts');
  assert.equal(mist.sources.has('iptv-3653'), false);
});

test('automatic free-slot selection skips a manually held empty slot', async () => {
  const { gateway } = fixture();
  await gateway.stopDynamic({ slot: 'a', manual: true });
  const result = await gateway.activate('3653');
  assert.equal(result.slot, 'b');
});

test('enabled-account fallback reduces advertised capacity without touching Mist', async () => {
  const { gateway, mist } = fixture();
  gateway.setEnabledAccounts(['a']);
  const state = await gateway.active();
  assert.equal(state.capacity, 1);
  assert.deepEqual(state.slots.map((slot) => slot.slot), ['a']);
  assert.equal(mist.calls.some((call) => call[0] === 'deleteStream'), false);
});
