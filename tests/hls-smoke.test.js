import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfiguredHlsSmokeTest, runHlsSmokeTest } from '../server/hls-smoke.js';

function response({ status = 200, contentType = 'application/vnd.apple.mpegurl', body = '#EXTM3U\n#EXTINF:6.0,\nsegment.ts\n' } = {}) {
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
    response({ body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:6.0,\nsegment.ts\n' }),
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

test('HLS smoke rejects an empty media playlist with no actual segment', async () => {
  let calls = 0;
  await assert.rejects(
    () => runHlsSmokeTest({
      channelId: 'test-hls',
      hlsBase: 'http://mist/hls',
      attempts: 1,
      fetchFn: async () => {
        calls += 1;
        return response({
          body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n',
        });
      },
      sleepFn: async () => {},
    }),
    /HLS smoke failed/i,
  );
  assert.equal(calls, 1);
});

test('HLS smoke gives every media fetch a hard timeout signal', async () => {
  const timeoutSentinel = { aborted: false };
  const timeoutCalls = [];
  const fetchOptions = [];
  const result = await runHlsSmokeTest({
    channelId: 'test-hls',
    hlsBase: 'http://mist/hls',
    attempts: 1,
    timeoutMs: 4321,
    abortSignalFactory: (ms) => {
      timeoutCalls.push(ms);
      return timeoutSentinel;
    },
    fetchFn: async (_url, options) => {
      fetchOptions.push(options);
      return response({ body: '#EXTM3U\n#EXTINF:6.0,\nsegment.ts\n' });
    },
    sleepFn: async () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(timeoutCalls, [4321]);
  assert.equal(fetchOptions[0].signal, timeoutSentinel);
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


test('HLS smoke follows a valid master playlist and validates its child media playlist', async () => {
  const urls = [];
  const replies = [
    response({
      body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.64001f,mp4a.40.2"\nvideo/index.m3u8\n',
    }),
    response({
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment001.ts\n',
    }),
  ];

  const result = await runHlsSmokeTest({
    channelId: 'test-ts',
    hlsBase: 'http://mist/hls',
    attempts: 1,
    fetchFn: async (url) => { urls.push(url); return replies.shift(); },
    sleepFn: async () => {},
  });

  assert.deepEqual(urls, [
    'http://mist/hls/test-ts/index.m3u8',
    'http://mist/hls/test-ts/video/index.m3u8',
  ]);
  assert.equal(result.ok, true);
});
