import test from 'node:test';
import assert from 'node:assert/strict';
import * as smoke from '../server/hls-smoke.js';

function response(body, { status = 200, contentType = 'application/json' } = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

test('recovery smoke restores playable HLS after one forced upstream disconnect and one reconnect pull', async () => {
  assert.equal(typeof smoke.runRecoverySmokeTest, 'function');

  const statsUrl = 'http://source.internal/stats';
  const controlUrl = 'http://source.internal/control/disconnect';
  const root = 'http://mist.internal/hls/test-ts/index.m3u8';
  const segment = 'http://mist.internal/hls/test-ts/1000_3000.ts';
  const stats = [
    { activePulls: 1, totalPulls: 7, maxConcurrentPulls: 1, headRequests: 2 },
    { activePulls: 0, totalPulls: 7, maxConcurrentPulls: 1, headRequests: 2 },
    { activePulls: 1, totalPulls: 8, maxConcurrentPulls: 1, headRequests: 3 },
  ];
  const calls = [];

  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === statsUrl) return response(stats.shift());
    if (url === controlUrl) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer fault-secret');
      return response({ disconnected: 1 });
    }
    if (url === root) {
      return response('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n1000_3000.ts\n', {
        contentType: 'application/vnd.apple.mpegurl',
      });
    }
    if (url === segment) {
      return response('media-after-recovery', { contentType: 'video/mp2t' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const delays = [];
  const result = await smoke.runRecoverySmokeTest({
    channelId: 'test-ts',
    hlsBase: 'http://mist.internal/hls',
    sourceStatsUrl: statsUrl,
    sourceControlUrl: controlUrl,
    sourceControlToken: 'fault-secret',
    attempts: 3,
    delayMs: 25,
    fetchFn,
    sleepFn: async (ms) => { delays.push(ms); },
  });

  assert.deepEqual(result, {
    ok: true,
    channelId: 'test-ts',
    reconnectPulls: 1,
    upstreamPulls: 1,
    totalPulls: 8,
  });
  assert.deepEqual(delays, [25, 25]);
});


test('configured recovery smoke uses the deployed source control settings', async () => {
  assert.equal(typeof smoke.runConfiguredRecoverySmokeTest, 'function');

  const statsUrl = 'http://source.internal/stats';
  const controlUrl = 'http://source.internal/control/disconnect';
  const root = 'http://mist.internal/hls/test-ts/index.m3u8';
  const segment = 'http://mist.internal/hls/test-ts/1000_3000.ts';
  const stats = [
    { activePulls: 1, totalPulls: 10, maxConcurrentPulls: 1, headRequests: 2 },
    { activePulls: 1, totalPulls: 11, maxConcurrentPulls: 1, headRequests: 3 },
  ];

  const fetchFn = async (url, options = {}) => {
    if (url === statsUrl) return response(stats.shift());
    if (url === controlUrl) {
      assert.equal(options.headers.authorization, 'Bearer fault-secret');
      return response({ disconnected: 1 });
    }
    if (url === root) {
      return response('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n1000_3000.ts\n', {
        contentType: 'application/vnd.apple.mpegurl',
      });
    }
    if (url === segment) return response('media-after-recovery', { contentType: 'video/mp2t' });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await smoke.runConfiguredRecoverySmokeTest({
    V2_SMOKE_TEST_CHANNEL: 'test-ts',
    V2_MIST_HLS_INTERNAL_BASE: 'http://mist.internal/hls',
    V2_FANOUT_SOURCE_STATS_URL: statsUrl,
    V2_RECOVERY_SOURCE_CONTROL_URL: controlUrl,
    V2_RECOVERY_SOURCE_CONTROL_TOKEN: 'fault-secret',
    V2_RECOVERY_ATTEMPTS: '4',
    V2_RECOVERY_DELAY_MS: '0',
  }, {
    fetchFn,
    sleepFn: async () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    channelId: 'test-ts',
    reconnectPulls: 1,
    upstreamPulls: 1,
    totalPulls: 11,
  });
});
