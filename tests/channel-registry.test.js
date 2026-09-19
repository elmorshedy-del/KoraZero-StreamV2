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
    alwaysOn: false,
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
    { channelId: 'bein-1', source: 'https://provider.invalid/one.ts', alwaysOn: false },
    { channelId: 'bein-2', source: 'https://provider.invalid/two.ts', alwaysOn: false },
  ]);
});


test('channel registry preserves explicit always-on intent without making it the default', () => {
  const registry = createChannelRegistry({
    'iptv-3645': { source: 'http://relay.internal/live/3645.ts', alwaysOn: true },
    'bein-2': { source: 'http://relay.internal/live/2454.ts' },
  });

  assert.equal(registry.get('iptv-3645').alwaysOn, true);
  assert.equal(registry.get('bein-2').alwaysOn, false);
});
