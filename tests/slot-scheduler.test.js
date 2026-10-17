import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlotScheduler } from '../server/slot-scheduler.js';

function iso(ms) { return new Date(ms).toISOString(); }

function schedule(entries) {
  return { version: 1, capacity: 2, slots: ['a', 'b'], entries, unassigned: [] };
}

function entry({ slot='a', matchId, streamId, start, end }) {
  return {
    slot,
    matchId,
    streamId: String(streamId),
    channelId: 'iptv-' + streamId,
    startAt: iso(start),
    endAt: iso(end),
    score: 50,
    reasons: [],
    pinned: false,
  };
}

function gatewayFake(initialSlots = [
  { slot: 'a', channelId: null, streamId: null, mode: 'auto', manualUntil: null },
  { slot: 'b', channelId: null, streamId: null, mode: 'auto', manualUntil: null },
]) {
  const slots = initialSlots.map((slot) => ({ ...slot }));
  const calls = [];
  function slotById(id) { return slots.find((slot) => slot.slot === id); }
  return {
    calls,
    slots,
    async active() {
      calls.push(['active']);
      const live = slots.filter((slot) => slot.channelId).map((slot) => ({
        channelId: slot.channelId,
        streamId: slot.streamId,
        slot: slot.slot,
        inputs: 1,
        viewers: 0,
      }));
      return {
        capacity: slots.length,
        slots: slots.map((slot) => ({ ...slot })),
        active: live[0] || null,
        live,
        conflict: false,
      };
    },
    async activate(streamId, { slot }) {
      calls.push(['activate', String(streamId), slot]);
      const target = slotById(slot);
      target.streamId = String(streamId);
      target.channelId = 'iptv-' + streamId;
      return { streamId: String(streamId), slot, channelId: target.channelId, verified: true };
    },
    async stopDynamic({ slot }) {
      calls.push(['stopDynamic', slot]);
      const target = slotById(slot);
      target.streamId = null;
      target.channelId = null;
      return { stopped: true, slot };
    },
    async resumeAuto(slot) {
      calls.push(['resumeAuto', slot]);
      const target = slotById(slot);
      target.mode = 'auto';
      target.manualUntil = null;
      return { slot, mode: 'auto', manualUntil: null };
    },
    setManualUntil(slot, until) {
      calls.push(['setManualUntil', slot, until]);
      const target = slotById(slot);
      target.mode = 'manual';
      target.manualUntil = until;
      return { slot, mode: 'manual', manualUntil: until };
    },
  };
}

function fetcher(getSchedule, getToday = () => ({ matches: [] })) {
  return async (url) => {
    if (String(url).includes('schedule')) {
      const value = getSchedule();
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('today')) {
      const value = getToday();
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected URL ' + url);
  };
}

test('scheduler activates at startAt and stops after endAt', async () => {
  let now = Date.parse('2026-10-18T10:00:00Z');
  const start = now - 1_000;
  const end = now + 60_000;
  const g = gatewayFake();
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    todayUrl: 'https://example.test/today.json',
    nowFn: () => now,
    fetchFn: fetcher(() => schedule([
      entry({ matchId: 'm1', streamId: '3645', start, end }),
    ])),
  });

  await s.tick();
  assert.ok(g.calls.some((call) => call[0] === 'activate' && call[1] === '3645' && call[2] === 'a'));

  now = end + 1;
  await s.tick();
  assert.ok(g.calls.some((call) => call[0] === 'stopDynamic' && call[1] === 'a'));
});

test('schedule fetch failure changes no slot state', async () => {
  const g = gatewayFake([
    { slot: 'a', channelId: 'iptv-3645', streamId: '3645', mode: 'auto', manualUntil: null },
    { slot: 'b', channelId: null, streamId: null, mode: 'auto', manualUntil: null },
  ]);
  const before = JSON.stringify(g.slots);
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    fetchFn: fetcher(() => new Error('offline')),
  });

  const result = await s.tick();
  assert.equal(result.reason, 'schedule-unavailable');
  assert.equal(JSON.stringify(g.slots), before);
  assert.equal(g.calls.length, 0);
});

test('manual slot is skipped until its hold expires, then resumes auto', async () => {
  let now = Date.parse('2026-10-18T10:05:00Z');
  const start = Date.parse('2026-10-18T10:00:00Z');
  const end = Date.parse('2026-10-18T12:00:00Z');
  const g = gatewayFake([
    { slot: 'a', channelId: 'iptv-3653', streamId: '3653', mode: 'manual', manualUntil: iso(now + 3 * 60 * 60 * 1000) },
    { slot: 'b', channelId: null, streamId: null, mode: 'auto', manualUntil: null },
  ]);
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    nowFn: () => now,
    fetchFn: fetcher(() => schedule([
      entry({ matchId: 'm1', streamId: '3645', start, end }),
    ])),
  });

  await s.tick();
  assert.equal(g.slots[0].channelId, 'iptv-3653');
  assert.equal(g.slots[0].manualUntil, iso(end));
  assert.equal(g.calls.some((call) => call[0] === 'activate'), false);

  now = end + 1;
  await s.tick();
  assert.ok(g.calls.some((call) => call[0] === 'resumeAuto' && call[1] === 'a'));
});

test('a started entry dropped from a newer schedule is not stopped before its original endAt', async () => {
  let now = Date.parse('2026-10-18T10:00:00Z');
  const start = now - 1_000;
  const end = now + 60 * 60 * 1000;
  let currentSchedule = schedule([
    entry({ matchId: 'started', streamId: '3645', start, end }),
  ]);
  const g = gatewayFake();
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    nowFn: () => now,
    fetchFn: fetcher(() => currentSchedule),
  });

  await s.tick();
  currentSchedule = schedule([]);
  now += 10 * 60 * 1000;
  const stopCount = g.calls.filter((call) => call[0] === 'stopDynamic').length;
  await s.tick();
  assert.equal(g.calls.filter((call) => call[0] === 'stopDynamic').length, stopCount);
  assert.equal(g.slots[0].channelId, 'iptv-3645');

  now = end + 1;
  await s.tick();
  assert.equal(g.slots[0].channelId, null);
});

test('handover waits for a live previous match until the next kickoff, then switches', async () => {
  let now = Date.parse('2026-10-18T09:00:00Z');
  const firstStart = now - 1_000;
  const firstEnd = Date.parse('2026-10-18T10:00:00Z');
  const nextStart = firstEnd;
  const nextEnd = Date.parse('2026-10-18T12:00:00Z');
  const g = gatewayFake();
  const all = schedule([
    entry({ matchId: 'old', streamId: '3645', start: firstStart, end: firstEnd }),
    entry({ matchId: 'next', streamId: '3653', start: nextStart, end: nextEnd }),
  ]);
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    todayUrl: 'https://example.test/today.json',
    nowFn: () => now,
    fetchFn: fetcher(
      () => all,
      () => ({ matches: [{ id: 'old', status: 'live' }] }),
    ),
  });

  await s.tick();
  assert.equal(g.slots[0].channelId, 'iptv-3645');

  now = Date.parse('2026-10-18T10:05:00Z');
  await s.tick();
  assert.equal(g.slots[0].channelId, 'iptv-3645');

  now = Date.parse('2026-10-18T10:15:00Z');
  await s.tick();
  assert.equal(g.slots[0].channelId, 'iptv-3653');
});

test('invalid schedule entries are ignored without touching slots', async () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const g = gatewayFake();
  const s = createSlotScheduler({
    gateway: g,
    scheduleUrl: 'https://example.test/schedule.json',
    nowFn: () => now,
    fetchFn: fetcher(() => schedule([
      { slot: 'a', matchId: 'bad', streamId: 'abc', channelId: 'iptv-abc', startAt: iso(now - 1), endAt: iso(now + 1_000) },
      { slot: '', matchId: 'bad2', streamId: '3645', channelId: 'iptv-3645', startAt: iso(now - 1), endAt: iso(now + 1_000) },
    ])),
  });

  const result = await s.tick();
  assert.equal(result.changed, false);
  assert.equal(g.calls.some((call) => call[0] === 'activate'), false);
  assert.equal(g.calls.some((call) => call[0] === 'stopDynamic'), false);
});
