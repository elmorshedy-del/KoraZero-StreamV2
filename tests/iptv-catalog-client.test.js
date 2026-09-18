import test from 'node:test';
import assert from 'node:assert/strict';
import { createIptvCatalogClient } from '../server/iptv-catalog-client.js';

test('IPTV catalog client reads relay catalog and account status', async () => {
  const calls = [];
  const client = createIptvCatalogClient({
    baseUrl: 'http://relay.internal:8080/',
    fetchFn: async (url) => {
      calls.push(url);
      if (url.endsWith('/catalog')) {
        return new Response(JSON.stringify({ categories: [], channels: [], channelCount: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ auth: 1, status: 'Active', activeConnections: 0, maxConnections: 1, allowedOutputFormats: ['ts'] }), { status: 200 });
    },
  });
  assert.equal((await client.list()).channelCount, 0);
  assert.equal((await client.account()).maxConnections, 1);
  assert.deepEqual(calls, ['http://relay.internal:8080/catalog', 'http://relay.internal:8080/account']);
});

test('IPTV catalog client waits until the provider slot is free', async () => {
  let accountReads = 0;
  const client = createIptvCatalogClient({
    baseUrl: 'http://relay.internal:8080',
    sleepFn: async () => {},
    fetchFn: async (url) => {
      if (!url.endsWith('/account')) throw new Error('unexpected route');
      accountReads += 1;
      return new Response(JSON.stringify({ activeConnections: accountReads < 3 ? 1 : 0, maxConnections: 1 }), { status: 200 });
    },
  });
  const status = await client.waitForFreeSlot({ timeoutMs: 1000, pollMs: 0 });
  assert.equal(status.activeConnections, 0);
  assert.equal(accountReads, 3);
});


test('IPTV catalog client aborts provider-slot polling immediately', async () => {
  const controller = new AbortController();
  let accountReads = 0;
  const client = createIptvCatalogClient({
    baseUrl: 'http://relay.internal:8080',
    fetchFn: async (url) => {
      assert.ok(url.endsWith('/account'));
      accountReads += 1;
      controller.abort(Object.assign(new Error('client-left'), { name: 'AbortError' }));
      return new Response(JSON.stringify({ activeConnections: 1, maxConnections: 1 }), { status: 200 });
    },
  });

  await assert.rejects(
    () => client.waitForFreeSlot({ timeoutMs: 30_000, pollMs: 5_000, signal: controller.signal }),
    /client-left/i,
  );
  assert.equal(accountReads, 1);
});
