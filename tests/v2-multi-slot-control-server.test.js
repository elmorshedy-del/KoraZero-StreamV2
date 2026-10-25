import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../server/control-server.js';

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gatewayFake() {
  const calls = [];
  return {
    calls,
    async catalog(account = null) {
      calls.push(['catalog', account]);
      return { channelCount: 0, categories: [], channels: [] };
    },
    async active() {
      calls.push(['active']);
      return { capacity: 2, slots: [], live: [], conflict: false, active: null };
    },
    async activate(streamId, options = {}) {
      calls.push(['activate', streamId, options]);
      if (streamId === '999') throw coded('all_slots_busy', 'All V2 slots are busy');
      return { channelId: 'iptv-' + streamId, streamId, slot: options.slot || 'a', verified: true };
    },
    async stopDynamic(options = {}) {
      calls.push(['stopDynamic', options]);
      if (!options.slot) throw coded('slot_required', 'slot is required');
      return { stopped: true, slot: options.slot, channels: [] };
    },
    async resumeAuto(slot) {
      calls.push(['resumeAuto', slot]);
      return { slot, mode: 'auto', manualUntil: null };
    },
    playback() { throw new Error('not used'); },
    diagnostic() { return null; },
    status() { throw new Error('not used'); },
    stop() { throw new Error('not used'); },
  };
}

async function withServer(fn) {
  const gateway = gatewayFake();
  const server = createControlServer({
    gateway,
    internalToken: 'internal-secret',
    operatorPin: 'operator-pin',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ base: 'http://127.0.0.1:' + port, gateway });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const headers = { 'x-operator-pin': 'operator-pin' };


const REMOTE_STREAM_IDS = [
  '3645', '3644', '3653', '3652', '3651',
  '241362', '241363', '241364',
  '89778', '89779', '677', '244603',
];

test('every V2 Remote channel ID reaches the authenticated operator switch route', async () => {
  await withServer(async ({ base, gateway }) => {
    for (const streamId of REMOTE_STREAM_IDS) {
      const response = await fetch(base + '/operator/switch/' + streamId + '?slot=a', {
        method: 'POST',
        headers,
      });
      assert.equal(response.status, 200, streamId);
      const body = await response.json();
      assert.equal(body.streamId, streamId);
      assert.equal(body.verified, true);
    }

    const activations = gateway.calls.filter((call) => call[0] === 'activate');
    assert.deepEqual(
      activations.map((call) => call[1]),
      REMOTE_STREAM_IDS,
    );
    assert.ok(activations.every((call) => call[2].slot === 'a' && call[2].manual === true));
  });
});

test('operator switch passes explicit slot and manual override to gateway', async () => {
  await withServer(async ({ base, gateway }) => {
    const response = await fetch(base + '/operator/switch/3653?slot=b', { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.deepEqual(gateway.calls, [
      ['activate', '3653', { slot: 'b', manual: true }],
    ]);
  });
});

test('operator Off is slot scoped and missing slot is a 400 in multi-slot mode', async () => {
  await withServer(async ({ base, gateway }) => {
    let response = await fetch(base + '/operator/off?slot=a', { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.deepEqual(gateway.calls[0], ['stopDynamic', { slot: 'a', manual: true }]);

    response = await fetch(base + '/operator/off', { method: 'POST', headers });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, 'slot_required');
  });
});

test('all_slots_busy maps to HTTP 409 and never silently replaces a slot', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(base + '/operator/switch/999', { method: 'POST', headers });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error, 'all_slots_busy');
  });
});

test('operator can read a specific account catalog and Resume Auto for one slot', async () => {
  await withServer(async ({ base, gateway }) => {
    let response = await fetch(base + '/operator/catalog?account=b', { headers });
    assert.equal(response.status, 200);

    response = await fetch(base + '/operator/auto?slot=b', { method: 'POST', headers });
    assert.equal(response.status, 200);

    assert.deepEqual(gateway.calls, [
      ['catalog', 'b'],
      ['resumeAuto', 'b'],
    ]);
  });
});

test('operator Auto requires an explicit slot', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(base + '/operator/auto', { method: 'POST', headers });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'slot_required' });
  });
});
