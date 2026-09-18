import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSupervisor } from '../server/source-supervisor.js';
import { createChannelRegistry } from '../server/channel-registry.js';

function fixture(statuses, { now = 0 } = {}) {
  const calls = [];
  let clock = now;
  const registry = createChannelRegistry({
    'test-ts': { source: 'http://source.internal/live.ts' },
  });
  const mist = {
    async getStream(channelId) {
      calls.push(['getStream', channelId]);
      return statuses.length ? statuses.shift() : { active: false, inputs: 0 };
    },
    async nukeStream(channelId) {
      calls.push(['nukeStream', channelId]);
    },
    async addStream(channelId, source, options) {
      calls.push(['addStream', channelId, source, options]);
    },
  };
  const supervisor = createSourceSupervisor({
    registry,
    mist,
    unhealthyThreshold: 2,
    baseBackoffMs: 2000,
    maxBackoffMs: 8000,
    nowFn: () => clock,
  });
  return {
    supervisor,
    calls,
    advance(ms) { clock += ms; },
  };
}

test('supervisor requires two consecutive missing-input observations before one reset/re-arm', async () => {
  const f = fixture([
    { active: true, inputs: 0 },
    { active: true, inputs: 0 },
  ]);

  let state = await f.supervisor.check('test-ts');
  assert.equal(state.consecutiveUnhealthy, 1);
  assert.deepEqual(f.calls, [['getStream', 'test-ts']]);

  state = await f.supervisor.check('test-ts');
  assert.equal(state.recoveryAttempts, 1);
  assert.deepEqual(f.calls, [
    ['getStream', 'test-ts'],
    ['getStream', 'test-ts'],
    ['nukeStream', 'test-ts'],
    ['addStream', 'test-ts', 'http://source.internal/live.ts', { always_on: true }],
  ]);
});

test('supervisor backs off repeated resets while the input remains unhealthy', async () => {
  const f = fixture([
    { active: true, inputs: 0 },
    { active: true, inputs: 0 },
    { active: false, inputs: 0 },
    { active: false, inputs: 0 },
    { active: false, inputs: 0 },
  ]);

  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');

  assert.equal(f.calls.filter(([name]) => name === 'nukeStream').length, 1);

  f.advance(2000);
  const state = await f.supervisor.check('test-ts');
  assert.equal(state.recoveryAttempts, 2);
  assert.equal(f.calls.filter(([name]) => name === 'nukeStream').length, 2);
});

test('one healthy input observation clears failure and backoff state', async () => {
  const f = fixture([
    { active: true, inputs: 0 },
    { active: true, inputs: 0 },
    { active: true, inputs: 1 },
  ]);

  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');
  const state = await f.supervisor.check('test-ts');

  assert.equal(state.healthy, true);
  assert.equal(state.consecutiveUnhealthy, 0);
  assert.equal(state.recoveryAttempts, 0);
  assert.equal(state.nextRecoveryAt, 0);
});

test('background supervision checks only armed channels and disarm removes them', async () => {
  const calls = [];
  const intervals = [];
  const registry = createChannelRegistry({
    one: { source: 'http://source.internal/one.ts' },
    two: { source: 'http://source.internal/two.ts' },
  });
  const mist = {
    async getStream(channelId) {
      calls.push(['getStream', channelId]);
      return { active: true, inputs: 1 };
    },
    async nukeStream(channelId) {
      calls.push(['nukeStream', channelId]);
    },
    async addStream(channelId, source, options) {
      calls.push(['addStream', channelId, source, options]);
    },
  };
  const supervisor = createSourceSupervisor({
    registry,
    mist,
    intervalMs: 1000,
    setIntervalFn(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearIntervalFn() {},
  });

  supervisor.arm('one');
  supervisor.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 1000);

  await intervals[0].fn();
  assert.deepEqual(calls, [['getStream', 'one']]);

  calls.length = 0;
  supervisor.disarm('one');
  supervisor.arm('two');
  await intervals[0].fn();
  assert.deepEqual(calls, [['getStream', 'two']]);
  assert.deepEqual(supervisor.armedChannels(), ['two']);
});


test('frozen media clock becomes unhealthy even while Mist still reports one input', async () => {
  const f = fixture([
    { active: true, inputs: 1, lastms: 10000 },
    { active: true, inputs: 1, lastms: 10000 },
    { active: true, inputs: 1, lastms: 10000 },
  ]);

  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');
  const state = await f.supervisor.check('test-ts');

  assert.equal(state.recoveryAttempts, 1);
  assert.equal(f.calls.filter(([name]) => name === 'nukeStream').length, 1);
});

test('advancing media clock remains healthy and never resets the source', async () => {
  const f = fixture([
    { active: true, inputs: 1, lastms: 10000 },
    { active: true, inputs: 1, lastms: 11000 },
    { active: true, inputs: 1, lastms: 12000 },
  ]);

  await f.supervisor.check('test-ts');
  await f.supervisor.check('test-ts');
  const state = await f.supervisor.check('test-ts');

  assert.equal(state.healthy, true);
  assert.equal(state.recoveryAttempts, 0);
  assert.equal(f.calls.some(([name]) => name === 'nukeStream'), false);
});
