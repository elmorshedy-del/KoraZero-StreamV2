import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlotScheduler } from '../server/slot-scheduler.js';

function schedule(entries) {
  return { version: 1, capacity: 2, slots: ['a', 'b'], entries, unassigned: [] };
}

function entry({
  slot = 'a',
  matchId = 'm1',
  streamId = '111',
  startAt,
  endAt,
} = {}) {
  return { slot, matchId, streamId, channelId: `iptv-${streamId}`, startAt, endAt, score: 1, reasons: [] };
}

function gatewayFake(initialSlots = [
  { slot: 'a', channelId: null, mode: 'auto', manualUntil: null },
  { slot: 'b', channelId: null, mode: 'auto', manualUntil: null },
]) {
  const slots = initialSlots.map((value) => ({ ...value }));
  const calls = [];
  let resolver = null;
  return {
    calls,
    slots,
    setManualUntilResolver(fn) { resolver = fn; },
    manualUntil(slot, now) { return resolver?.(slot, now); },
    async active() { return { capacity: slots.length, slots: slots.map((value) => ({ ...value })), live: [], conflict: false }; },
    async activate(streamId, { slot } = {}) {
      calls.push(['activate', String(streamId), slot]);
      const target = slots.find((value) => value.slot === slot);
      target.channelId = `iptv-${streamId}`;
      target.streamId = String(streamId);
      return { channelId: target.channelId, streamId: target.streamId, slot };
    },
    async stopDynamic({ slot } = {}) {
      calls.push(['stop', slot]);
      const target = slots.find((value) => value.slot === slot);
      target.channelId = null;
      delete target.streamId;
      return { stopped: true, slot };
    },
    async resumeAuto(slot) {
      calls.push(['resumeAuto', slot]);
      const target = slots.find((value) => value.slot === slot);
      target.mode = 'auto';
      target.manualUntil = null;
      return { slot, mode: 'auto' };
    },
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('scheduler starts an entry at startAt and stops it after endAt', async () => {
  let now = Date.parse('2026-10-18T18:45:00Z');
  const startAt = '2026-10-18T18:45:00.000Z';
  const endAt = '2026-10-18T21:00:00.000Z';
  const gateway = gatewayFake();
  const value = schedule([entry({ startAt, endAt })]);

  const scheduler = createSlotScheduler({
    gateway,
    nowFn: () => now,
    fetchFn: async () => response(value),
  });

  await scheduler.tick();
  assert.deepEqual(gateway.calls, [['activate', '111', 'a']]);

  now = Date.parse('2026-10-18T21:00:01Z');
  await scheduler.tick();
  assert.deepEqual(gateway.calls, [['activate', '111', 'a'], ['stop', 'a']]);
});

test('schedule fetch failure changes no slot', async () => {
  const gateway = gatewayFake();
  const scheduler = createSlotScheduler({
    gateway,
    fetchFn: async () => response({ error: true }, 503),
  });
  const result = await scheduler.tick();
  assert.equal(result.changed, false);
  assert.deepEqual(gateway.calls, []);
});

test('manual mode wins until manualUntil, then auto resumes', async () => {
  let now = Date.parse('2026-10-18T18:45:00Z');
  const gateway = gatewayFake([
    { slot: 'a', channelId: 'iptv-999', streamId: '999', mode: 'manual', manualUntil: '2026-10-18T19:00:00.000Z' },
    { slot: 'b', channelId: null, mode: 'auto', manualUntil: null },
  ]);
  const value = schedule([entry({
    startAt: '2026-10-18T18:45:00.000Z',
    endAt: '2026-10-18T21:00:00.000Z',
  })]);
  const scheduler = createSlotScheduler({ gateway, nowFn: () => now, fetchFn: async () => response(value) });

  await scheduler.tick();
  assert.deepEqual(gateway.calls, []);

  now = Date.parse('2026-10-18T19:00:01Z');
  await scheduler.tick();
  assert.deepEqual(gateway.calls, [
    ['resumeAuto', 'a'],
    ['activate', '111', 'a'],
  ]);
});

test('a started entry dropped by a newer schedule is not stopped early', async () => {
  let now = Date.parse('2026-10-18T19:00:00Z');
  const gateway = gatewayFake([
    { slot: 'a', channelId: 'iptv-111', streamId: '111', mode: 'auto', manualUntil: null },
    { slot: 'b', channelId: null, mode: 'auto', manualUntil: null },
  ]);
  let value = schedule([entry({
    matchId: 'old',
    startAt: '2026-10-18T18:45:00.000Z',
    endAt: '2026-10-18T21:00:00.000Z',
  })]);
  const scheduler = createSlotScheduler({ gateway, nowFn: () => now, fetchFn: async () => response(value) });

  await scheduler.tick();
  value = schedule([]);
  now = Date.parse('2026-10-18T19:30:00Z');
  await scheduler.tick();

  assert.equal(gateway.slots[0].channelId, 'iptv-111');
  assert.deepEqual(gateway.calls, []);
});

test('busy-slot handover waits for the old live match but never beyond the next kickoff', async () => {
  let now = Date.parse('2026-10-18T18:55:00Z');
  const gateway = gatewayFake([
    { slot: 'a', channelId: 'iptv-111', streamId: '111', mode: 'auto', manualUntil: null },
    { slot: 'b', channelId: null, mode: 'auto', manualUntil: null },
  ]);
  let value = schedule([entry({
    matchId: 'old',
    streamId: '111',
    startAt: '2026-10-18T16:30:00.000Z',
    endAt: '2026-10-18T18:45:00.000Z',
  })]);
  const fetchFn = async (url) => {
    if (String(url).includes('today.json')) return response([{ id: 'old', status: 'live' }]);
    return response(value);
  };
  const scheduler = createSlotScheduler({ gateway, nowFn: () => now, fetchFn });

  await scheduler.tick();
  value = schedule([entry({
    matchId: 'next',
    streamId: '222',
    startAt: '2026-10-18T18:45:00.000Z',
    endAt: '2026-10-18T21:00:00.000Z',
  })]);
  await scheduler.tick();
  assert.deepEqual(gateway.calls, []);

  now = Date.parse('2026-10-18T19:00:00Z');
  await scheduler.tick();
  assert.deepEqual(gateway.calls, [['activate', '222', 'a']]);
});

test('invalid entries are ignored and cannot switch a slot', async () => {
  const gateway = gatewayFake();
  const scheduler = createSlotScheduler({
    gateway,
    nowFn: () => Date.parse('2026-10-18T19:00:00Z'),
    fetchFn: async () => response(schedule([
      { slot: 'x', matchId: 'bad-slot', streamId: '111', channelId: 'iptv-111', startAt: '2026-10-18T18:45:00Z', endAt: '2026-10-18T21:00:00Z' },
      { slot: 'a', matchId: 'bad-channel', streamId: 'abc', channelId: 'iptv-abc', startAt: '2026-10-18T18:45:00Z', endAt: '2026-10-18T21:00:00Z' },
    ])),
  });
  await scheduler.tick();
  assert.deepEqual(gateway.calls, []);
});

test('manual hold uses the scheduled window end when one covers now', () => {
  const gateway = gatewayFake();
  let now = Date.parse('2026-10-18T19:00:00Z');
  const value = schedule([entry({
    startAt: '2026-10-18T18:45:00.000Z',
    endAt: '2026-10-18T21:00:00.000Z',
  })]);
  const scheduler = createSlotScheduler({
    gateway,
    nowFn: () => now,
    fetchFn: async () => response(value),
  });

  assert.match(gateway.manualUntil('a', now), /^2026-10-18T22:00:00/);
  return scheduler.tick().then(() => {
    assert.equal(gateway.manualUntil('a', now), '2026-10-18T21:00:00.000Z');
  });
});

test('scheduler start is idempotent and disabled code can simply never call start', () => {
  const gateway = gatewayFake();
  const timers = [];
  const scheduler = createSlotScheduler({
    gateway,
    fetchFn: async () => response(schedule([])),
    setIntervalFn(fn, ms) { timers.push({ fn, ms }); return { fn, ms }; },
    clearIntervalFn() {},
  });
  assert.equal(scheduler.running, false);
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.running, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
});
