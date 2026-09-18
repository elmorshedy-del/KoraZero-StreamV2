import test from 'node:test';
import assert from 'node:assert/strict';
import * as smoke from '../server/hls-smoke.js';

function textResponse(body, { status = 200, contentType = 'application/vnd.apple.mpegurl' } = {}) {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    async text() { return body; },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { return JSON.parse(body); },
  };
}

test('fanout smoke gives five HLS readers media without creating a second upstream pull', async () => {
  assert.equal(typeof smoke.runFanoutSmokeTest, 'function');

  const statsUrl = 'http://source.internal/stats';
  const root = 'http://mist.internal:8080/hls/test-ts/index.m3u8';
  const child = 'http://mist.internal:8080/hls/test-ts/1_0/index.m3u8';
  const segment = 'http://mist.internal:8080/hls/test-ts/1_0/1000_3000.ts';

  let statsReads = 0;
  let segmentReads = 0;
  const fetchFn = async (url) => {
    if (url === statsUrl) {
      statsReads += 1;
      return textResponse(JSON.stringify({
        activePulls: 1,
        totalPulls: 7,
        maxConcurrentPulls: 1,
        headRequests: 3,
      }), { contentType: 'application/json' });
    }
    if (url === root) {
      return textResponse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n1_0/index.m3u8\n');
    }
    if (url === child) {
      return textResponse('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n1000_3000.ts\n');
    }
    if (url === segment) {
      segmentReads += 1;
      return textResponse('media-bytes', { contentType: 'video/mp2t' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await smoke.runFanoutSmokeTest({
    channelId: 'test-ts',
    hlsBase: 'http://mist.internal:8080/hls',
    sourceStatsUrl: statsUrl,
    viewers: 5,
    fetchFn,
  });

  assert.equal(statsReads, 2);
  assert.equal(segmentReads, 5);
  assert.deepEqual(result, {
    ok: true,
    channelId: 'test-ts',
    viewers: 5,
    upstreamPulls: 1,
    totalPulls: 7,
  });
});


test('configured fanout smoke uses the deployed smoke channel and source stats endpoint', async () => {
  assert.equal(typeof smoke.runConfiguredFanoutSmokeTest, 'function');

  const statsUrl = 'http://source.internal:8080/stats';
  const root = 'http://mist.internal:8080/hls/test-ts/index.m3u8';
  const segment = 'http://mist.internal:8080/hls/test-ts/1000_3000.ts';
  let segmentReads = 0;

  const fetchFn = async (url) => {
    if (url === statsUrl) {
      return textResponse(JSON.stringify({
        activePulls: 1,
        totalPulls: 4,
        maxConcurrentPulls: 1,
        headRequests: 2,
      }), { contentType: 'application/json' });
    }
    if (url === root) {
      return textResponse('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n1000_3000.ts\n');
    }
    if (url === segment) {
      segmentReads += 1;
      return textResponse('media-bytes', { contentType: 'video/mp2t' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await smoke.runConfiguredFanoutSmokeTest({
    V2_SMOKE_TEST_CHANNEL: 'test-ts',
    V2_MIST_HLS_INTERNAL_BASE: 'http://mist.internal:8080/hls',
    V2_FANOUT_SOURCE_STATS_URL: statsUrl,
    V2_FANOUT_VIEWERS: '3',
  }, { fetchFn });

  assert.equal(segmentReads, 3);
  assert.deepEqual(result, {
    ok: true,
    channelId: 'test-ts',
    viewers: 3,
    upstreamPulls: 1,
    totalPulls: 4,
  });
});


test('fanout smoke waits boundedly for one upstream pull after a source restart', async () => {
  const statsUrl = 'http://source.internal/stats';
  const root = 'http://mist.internal:8080/hls/test-ts/index.m3u8';
  const segment = 'http://mist.internal:8080/hls/test-ts/1000_3000.ts';
  const stats = [
    { activePulls: 0, totalPulls: 8, maxConcurrentPulls: 1, headRequests: 2 },
    { activePulls: 1, totalPulls: 9, maxConcurrentPulls: 1, headRequests: 3 },
    { activePulls: 1, totalPulls: 9, maxConcurrentPulls: 1, headRequests: 3 },
  ];
  const delays = [];
  const fetchFn = async (url) => {
    if (url === statsUrl) return textResponse(JSON.stringify(stats.shift()), { contentType: 'application/json' });
    if (url === root) return textResponse('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n1000_3000.ts\n');
    if (url === segment) return textResponse('media-bytes', { contentType: 'video/mp2t' });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await smoke.runFanoutSmokeTest({
    channelId: 'test-ts',
    hlsBase: 'http://mist.internal:8080/hls',
    sourceStatsUrl: statsUrl,
    viewers: 2,
    readyAttempts: 3,
    readyDelayMs: 25,
    fetchFn,
    sleepFn: async (ms) => { delays.push(ms); },
  });

  assert.deepEqual(delays, [25]);
  assert.equal(result.upstreamPulls, 1);
  assert.equal(result.totalPulls, 9);
});
