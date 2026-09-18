import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaybackDescriptor } from '../src/player/playback-descriptor.js';

test('fetchPlaybackDescriptor requests a logical channel descriptor', async () => {
  const calls = [];
  const fetchFn = async (url) => ({ ok: true, status: 200, async json() { calls.push(url); return { channelId: 'bein-1', manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8' }; } });
  const result = await fetchPlaybackDescriptor('bein-1', { fetchFn });
  assert.deepEqual(calls, ['/api/playback/bein-1']);
  assert.deepEqual(result, { channelId: 'bein-1', manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8' });
});

test('fetchPlaybackDescriptor rejects malformed descriptors', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return { source: 'https://provider.invalid/direct.ts' }; } });
  await assert.rejects(() => fetchPlaybackDescriptor('bein-1', { fetchFn }), /invalid playback descriptor/i);
});

test('fetchPlaybackDescriptor reports non-success responses', async () => {
  const fetchFn = async () => ({ ok: false, status: 404, async json() { return {}; } });
  await assert.rejects(() => fetchPlaybackDescriptor('missing', { fetchFn }), /404/);
});
