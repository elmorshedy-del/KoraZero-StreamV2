import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../server/runtime-config.js';

const baseEnv = {
  V2_CHANNELS_JSON: '{}',
  V2_INTERNAL_TOKEN: 'internal-secret',
  V2_PUBLIC_HLS_BASE: 'https://stream-v2.example/hls',
};

test('explicit V2 account config creates two private relay slots', () => {
  const runtime = createRuntime({
    ...baseEnv,
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify([
      { id: 'a', relayBase: 'http://relay-a.railway.internal:8080' },
      { id: 'b', relayBase: 'http://relay-b.railway.internal:8080' },
    ]),
  }, { fetchFn: async () => { throw new Error('not called'); } });

  assert.equal(runtime.accounts.length, 2);
  assert.deepEqual(runtime.accounts.map((account) => [account.id, account.relayBase]), [
    ['a', 'http://relay-a.railway.internal:8080'],
    ['b', 'http://relay-b.railway.internal:8080'],
  ]);
  assert.equal(typeof runtime.accounts[0].catalogClient.account, 'function');
});

test('unset V2_IPTV_ACCOUNTS_JSON exposes legacy account a while preserving the legacy gateway path', () => {
  const runtime = createRuntime(baseEnv, { fetchFn: async () => { throw new Error('not called'); } });
  assert.equal(runtime.accounts.length, 1);
  assert.equal(runtime.accounts[0].id, 'a');
  assert.equal(runtime.accounts[0].relayBase, 'http://v2-iptv-relay.railway.internal:8080');
});

test('multi-account runtime rejects duplicate ids, duplicate relay bases, public hosts, and more than two slots', () => {
  const make = (accounts) => () => createRuntime({
    ...baseEnv,
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify(accounts),
  }, { fetchFn: async () => { throw new Error('not called'); } });

  assert.throws(make([
    { id: 'a', relayBase: 'http://relay-a.railway.internal:8080' },
    { id: 'a', relayBase: 'http://relay-b.railway.internal:8080' },
  ]), /ids must be unique/i);

  assert.throws(make([
    { id: 'a', relayBase: 'http://relay-a.railway.internal:8080' },
    { id: 'b', relayBase: 'http://relay-a.railway.internal:8080' },
  ]), /relayBase values must be unique/i);

  assert.throws(make([
    { id: 'a', relayBase: 'https://example.com:8080' },
  ]), /private Railway host/i);

  assert.throws(make([
    { id: 'a', relayBase: 'http://relay-a.railway.internal:8080' },
    { id: 'b', relayBase: 'http://relay-b.railway.internal:8080' },
    { id: 'c', relayBase: 'http://relay-c.railway.internal:8080' },
  ]), /1 or 2 accounts/i);
});

test('localhost relay bases remain available for tests but still require explicit ports', () => {
  const runtime = createRuntime({
    ...baseEnv,
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify([
      { id: 'a', relayBase: 'http://127.0.0.1:18080' },
      { id: 'b', relayBase: 'http://localhost:28080' },
    ]),
  }, { fetchFn: async () => { throw new Error('not called'); } });
  assert.equal(runtime.accounts.length, 2);

  assert.throws(() => createRuntime({
    ...baseEnv,
    V2_IPTV_ACCOUNTS_JSON: JSON.stringify([{ id: 'a', relayBase: 'http://localhost' }]),
  }, { fetchFn: async () => { throw new Error('not called'); } }), /with a port/i);
});
