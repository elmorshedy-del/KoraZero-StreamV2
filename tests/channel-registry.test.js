import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRegistry } from '../server/channel-registry.js';

test('channel registry returns server-only source for a known logical channel', () => {
  const registry = createChannelRegistry({
    'bein-1': { source: 'https://provider.invalid/live/source.ts' },
  });

  assert.deepEqual(registry.get('bein-1'), {
    channelId: 'bein-1',
    source: 'https://provider.invalid/live/source.ts',
  });
  assert.equal(registry.has('bein-1'), true);
});

test('channel registry returns null for an unknown channel', () => {
  const registry = createChannelRegistry({});
  assert.equal(registry.get('missing'), null);
  assert.equal(registry.has('missing'), false);
});

test('channel registry rejects invalid channel ids', () => {
  assert.throws(
    () => createChannelRegistry({ 'BEIN 1': { source: 'https://provider.invalid/source.ts' } }),
    /invalid channel id/i,
  );
});

test('channel registry rejects missing or empty sources', () => {
  assert.throws(
    () => createChannelRegistry({ 'bein-1': { source: '   ' } }),
    /source/i,
  );
});

test('channel registry exposes a server-only snapshot for startup registration', () => {
  const registry = createChannelRegistry({
    'bein-1': { source: 'https://provider.invalid/one.ts' },
    'bein-2': { source: 'https://provider.invalid/two.ts' },
  });

  assert.deepEqual(registry.entries(), [
    { channelId: 'bein-1', source: 'https://provider.invalid/one.ts' },
    { channelId: 'bein-2', source: 'https://provider.invalid/two.ts' },
  ]);
});
