import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaybackDescriptor } from '../src/player/playback-descriptor.js';

test('fetchPlaybackDescriptor requests a logical channel descriptor', async () => {
  const calls = [];
  const fetchFn = async (url) => ({ ok: true, status: 200, async json() { calls.push(url); return { channelId: 'bein-1', manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8' }; } });
  const result = await fetchPlaybackDescriptor('bein-1', { fetchFn });
  assert.deepEqual(calls, ['/api/playback/bein-1']);
  assert.deepEqual(result, {
    channelId: 'bein-1',
    manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
    verified: false,
    diagnostics: null,
  });
});

test('fetchPlaybackDescriptor rejects malformed descriptors', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return { source: 'https://provider.invalid/direct.ts' }; } });
  await assert.rejects(() => fetchPlaybackDescriptor('bein-1', { fetchFn }), /invalid playback descriptor/i);
});

test('fetchPlaybackDescriptor reports non-success responses', async () => {
  const fetchFn = async () => ({ ok: false, status: 404, async json() { return {}; } });
  await assert.rejects(() => fetchPlaybackDescriptor('missing', { fetchFn }), /404/);
});


test('fetchPlaybackDescriptor surfaces phase-aware playback failure details', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 502,
    async json() {
      return {
        error: 'playback_verification_failed',
        detail: 'Playback verification failed at hls-verify-start: segment HTTP 404',
      };
    },
  });
  await assert.rejects(
    () => fetchPlaybackDescriptor('3645', { fetchFn }),
    /hls-verify-start: segment HTTP 404/i,
  );
});


test('fetchPlaybackDescriptor forwards the caller abort signal', async () => {
  const controller = new AbortController();
  let seenSignal = null;
  const fetchFn = async (_url, options = {}) => {
    seenSignal = options.signal;
    return {
      ok: true,
      status: 200,
      async json() {
        return { channelId: 'iptv-3645', manifestUrl: 'https://stream-v2.example/hls/iptv-3645/index.m3u8' };
      },
    };
  };

  await fetchPlaybackDescriptor('3645', { fetchFn, signal: controller.signal });
  assert.equal(seenSignal, controller.signal);
});
