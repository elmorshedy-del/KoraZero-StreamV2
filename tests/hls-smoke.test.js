import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfiguredHlsSmokeTest, runHlsSmokeTest } from '../server/hls-smoke.js';

function response({ status = 200, contentType = 'application/vnd.apple.mpegurl', body = '#EXTM3U\n' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    async text() { return body; },
  };
}

test('HLS smoke retries Mist error playlists and succeeds on a real playlist', async () => {
  const calls = [];
  const replies = [
    response({ body: '#EXTM3U\n#EXT-X-ERROR: Stream open failed\n#EXT-X-ENDLIST\n' }),
    response({ body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\nsegment.ts\n' }),
  ];
  const delays = [];
  const result = await runHlsSmokeTest({
    channelId: 'test-hls',
    hlsBase: 'http://v2-mist.railway.internal:8080/hls/',
    attempts: 3,
    delayMs: 25,
    fetchFn: async (url) => { calls.push(url); return replies.shift(); },
    sleepFn: async (ms) => { delays.push(ms); },
  });

  assert.deepEqual(calls, [
    'http://v2-mist.railway.internal:8080/hls/test-hls/index.m3u8',
    'http://v2-mist.railway.internal:8080/hls/test-hls/index.m3u8',
  ]);
  assert.deepEqual(delays, [25]);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.channelId, 'test-hls');
  assert.match(result.contentType, /mpegurl/);
  assert.ok(result.bytes > 0);
});

test('HLS smoke fails after bounded attempts when no playable playlist appears', async () => {
  let calls = 0;
  await assert.rejects(
    () => runHlsSmokeTest({
      channelId: 'test-hls',
      hlsBase: 'http://mist/hls',
      attempts: 2,
      delayMs: 0,
      fetchFn: async () => {
        calls += 1;
        return response({ status: 404, contentType: 'text/plain', body: 'missing' });
      },
      sleepFn: async () => {},
    }),
    /HLS smoke failed/i,
  );
  assert.equal(calls, 2);
});

test('configured HLS smoke is disabled unless both test variables are present', async () => {
  const fetchFn = async () => { throw new Error('must not fetch'); };
  assert.equal(await runConfiguredHlsSmokeTest({}, { fetchFn }), null);
  await assert.rejects(
    () => runConfiguredHlsSmokeTest({ V2_SMOKE_TEST_CHANNEL: 'test-hls' }, { fetchFn }),
    /V2_MIST_HLS_INTERNAL_BASE/i,
  );
});

test('configured HLS smoke uses private base and logical test channel', async () => {
  const urls = [];
  const result = await runConfiguredHlsSmokeTest({
    V2_SMOKE_TEST_CHANNEL: 'test-hls',
    V2_MIST_HLS_INTERNAL_BASE: 'http://v2-mist.railway.internal:8080/hls',
  }, {
    fetchFn: async (url) => { urls.push(url); return response(); },
    sleepFn: async () => {},
  });
  assert.deepEqual(urls, ['http://v2-mist.railway.internal:8080/hls/test-hls/index.m3u8']);
  assert.equal(result.ok, true);
});
