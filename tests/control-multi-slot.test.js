import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../server/control-server.js';

async function withServer(gateway, fn) {
  const server = createControlServer({ gateway, internalToken: 'internal', operatorPin: 'pin' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fakeGateway() {
  const calls = [];
  return {
    calls,
    async catalog(account) { calls.push(['catalog', account]); return { channels: [], categories: [] }; },
    async active() { return { capacity: 2, slots: [{ slot: 'a', channelId: null }, { slot: 'b', channelId: null }], live: [], active: null, conflict: false }; },
    async activate(streamId, options) { calls.push(['activate', streamId, options]); return { channelId: `iptv-${streamId}`, streamId, slot: options?.slot || 'a' }; },
    async stopDynamic(options) { calls.push(['stopDynamic', options]); return { stopped: true, slot: options?.slot || null, channels: [] }; },
    async resumeAuto(slot) { calls.push(['resumeAuto', slot]); return { slot, mode: 'auto' }; },
    diagnostic() { return null; },
    playback() { throw new Error('not used'); },
    status() { throw new Error('not used'); },
    stop() { throw new Error('not used'); },
  };
}

test('operator routes scope switches, catalog and off actions to the requested slot/account', async () => {
  const gateway = fakeGateway();
  await withServer(gateway, async (base) => {
    const headers = { 'x-operator-pin': 'pin' };

    let response = await fetch(`${base}/operator/catalog?account=b`, { headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/operator/switch/3645?slot=b`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/operator/off?slot=b`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/operator/resume-auto?slot=b`, { method: 'POST', headers });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(gateway.calls, [
    ['catalog', 'b'],
    ['activate', '3645', { slot: 'b', manual: true }],
    ['stopDynamic', { slot: 'b', manual: true }],
    ['resumeAuto', 'b'],
  ]);
});

test('operator slot routes stay PIN gated', async () => {
  const gateway = fakeGateway();
  await withServer(gateway, async (base) => {
    const response = await fetch(`${base}/operator/switch/3645?slot=b`, { method: 'POST' });
    assert.equal(response.status, 401);
  });
  assert.deepEqual(gateway.calls, []);
});

test('all_slots_busy maps to 409 and missing multi-slot off maps to 400', async () => {
  const gateway = fakeGateway();
  gateway.activate = async () => {
    const error = new Error('All V2 slots are busy');
    error.code = 'all_slots_busy';
    throw error;
  };
  gateway.stopDynamic = async ({ slot } = {}) => {
    assert.equal(slot, null);
    const error = new Error('slot is required when multiple V2 accounts are configured');
    error.code = 'slot_required';
    throw error;
  };

  await withServer(gateway, async (base) => {
    const headers = { 'x-operator-pin': 'pin' };
    let response = await fetch(`${base}/operator/switch/3645`, { method: 'POST', headers });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'all_slots_busy');

    response = await fetch(`${base}/operator/off`, { method: 'POST', headers });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'slot_required');
  });
});

test('public active response can expose two slots without credentials or relay URLs', async () => {
  const gateway = fakeGateway();
  await withServer(gateway, async (base) => {
    const response = await fetch(`${base}/api/active`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.capacity, 2);
    assert.equal(body.conflict, false);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('pin'), false);
    assert.equal(serialized.includes('railway.internal'), false);
    assert.equal(serialized.includes('username'), false);
    assert.equal(serialized.includes('password'), false);
  });
});
