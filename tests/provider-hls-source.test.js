import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHlsTsStream } from '../server/provider-hls-source.js';

function tsBytes(pid = 256) {
  const out = new Uint8Array(188 * 2);
  for (let packet = 0; packet < 2; packet += 1) {
    const offset = packet * 188;
    out[offset] = 0x47;
    out[offset + 1] = (pid >> 8) & 0x1f;
    out[offset + 2] = pid & 0xff;
    out[offset + 3] = 0x10 | packet;
    out.fill(0xff, offset + 4, offset + 188);
  }
  return out;
}

function mediaPlaylist(segments, { target = 2, sequence = 1, end = false } = {}) {
  const rows = ['#EXTM3U', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${sequence}`];
  for (const segment of segments) rows.push('#EXTINF:2.0,', segment);
  if (end) rows.push('#EXT-X-ENDLIST');
  rows.push('');
  return rows.join('\n');
}

function initialResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

test('segment 404 is skipped and the next segment is delivered', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['gone.ts', 'good.ts'], { end: true });
  const good = tsBytes(301);
  const recovery = [];
  const calls = [];

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/gone.ts')) return new Response('', { status: 404 });
      if (String(url) === base) return new Response(playlist, { status: 200 });
      if (String(url).endsWith('/good.ts')) return new Response(good, { status: 200, headers: { 'content-type': 'video/mp2t' } });
      throw new Error(`unexpected URL ${url}`);
    },
    onRecovery: (event) => recovery.push(event),
  });

  const chunks = await readAll(stream);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], good);
  assert.equal(calls.filter((url) => url.endsWith('/gone.ts')).length, 1);
  assert.ok(recovery.some((event) => event.kind === 'segment-skip' && event.status === 404));
});

test('segment 522 retries the same URL and delivers bytes once', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['one.ts'], { end: true });
  const good = tsBytes(302);
  const calls = [];
  const recovery = [];

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response('', { status: 522 });
      return new Response(good, { status: 200, headers: { 'content-type': 'video/mp2t' } });
    },
    onRecovery: (event) => recovery.push(event),
  });

  const chunks = await readAll(stream);
  assert.equal(calls.length, 2);
  assert.deepEqual(chunks, [good]);
  assert.equal(recovery.filter((event) => event.kind === 'segment-retry').length, 1);
});

test('network failures back off 500 then 1000 ms before recovering', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['one.ts'], { end: true });
  const good = tsBytes(303);
  const sleeps = [];
  let attempts = 0;

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    sleepFn: async (ms) => { sleeps.push(ms); },
    fetchFn: async () => {
      attempts += 1;
      if (attempts <= 2) throw new TypeError('fetch failed');
      return new Response(good, { status: 200, headers: { 'content-type': 'video/mp2t' } });
    },
  });

  assert.deepEqual(await readAll(stream), [good]);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('arrayBuffer terminated error is retried', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['one.ts'], { end: true });
  const good = tsBytes(304);
  let attempts = 0;

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'video/mp2t' }),
          arrayBuffer: async () => { throw new TypeError('terminated'); },
        };
      }
      return new Response(good, { status: 200, headers: { 'content-type': 'video/mp2t' } });
    },
  });

  assert.deepEqual(await readAll(stream), [good]);
  assert.equal(attempts, 2);
});

test('playlist 503 is retried and streaming continues', async () => {
  const base = 'https://provider.example/live.m3u8';
  const firstPlaylist = mediaPlaylist(['one.ts']);
  const secondPlaylist = mediaPlaylist(['two.ts'], { sequence: 2, end: true });
  const one = tsBytes(305);
  const two = tsBytes(306);
  let playlistReads = 0;
  const recovery = [];

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(firstPlaylist),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      const value = String(url);
      if (value.endsWith('/one.ts')) return new Response(one, { status: 200, headers: { 'content-type': 'video/mp2t' } });
      if (value === base) {
        playlistReads += 1;
        if (playlistReads === 1) return new Response('', { status: 503 });
        return new Response(secondPlaylist, { status: 200 });
      }
      if (value.endsWith('/two.ts')) return new Response(two, { status: 200, headers: { 'content-type': 'video/mp2t' } });
      throw new Error(`unexpected URL ${value}`);
    },
    onRecovery: (event) => recovery.push(event),
  });

  assert.deepEqual(await readAll(stream), [one, two]);
  assert.equal(playlistReads, 2);
  assert.ok(recovery.some((event) => event.kind === 'playlist-retry' && event.status === 503));
});

test('persistent failures past maxGapMs throw the original error', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['one.ts'], { end: true });
  let now = 0;

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    maxGapMs: 600,
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    fetchFn: async () => new Response('', { status: 522 }),
  });

  await assert.rejects(() => readAll(stream), /Provider HLS segment failed with HTTP 522/);
});

test('abort during retry backoff stops without another fetch', async () => {
  const base = 'https://provider.example/live.m3u8';
  const playlist = mediaPlaylist(['one.ts'], { end: true });
  const controller = new AbortController();
  let calls = 0;

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(playlist),
    initialUrl: base,
    signal: controller.signal,
    fetchFn: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
    sleepFn: async () => { controller.abort(); },
  });

  await assert.rejects(() => readAll(stream), (error) => error?.name === 'AbortError');
  assert.equal(calls, 1);
});

test('catch-up after a gap keeps only the newest two unseen segments', async () => {
  const base = 'https://provider.example/live.m3u8';
  const initial = mediaPlaylist(['gone.ts']);
  const refreshed = mediaPlaylist(['s1.ts', 's2.ts', 's3.ts', 's4.ts', 's5.ts', 's6.ts'], { sequence: 2, end: true });
  const recovery = [];
  const fetchedSegments = [];

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(initial),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      const value = String(url);
      if (value.endsWith('/gone.ts')) return new Response('', { status: 404 });
      if (value === base) return new Response(refreshed, { status: 200 });
      const match = /\/s(\d+)\.ts$/.exec(value);
      if (match) {
        fetchedSegments.push(Number(match[1]));
        return new Response(tsBytes(310 + Number(match[1])), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      }
      throw new Error(`unexpected URL ${value}`);
    },
    onRecovery: (event) => recovery.push(event),
  });

  const chunks = await readAll(stream);
  assert.equal(chunks.length, 2);
  assert.deepEqual(fetchedSegments, [5, 6]);
  assert.ok(recovery.some((event) => event.kind === 'catch-up' && event.dropped === 4));
});

test('provider adapter never has more than one fetch in flight', async () => {
  const base = 'https://provider.example/live.m3u8';
  const initial = mediaPlaylist(['one.ts'], { end: true });
  const good = tsBytes(320);
  let active = 0;
  let maxActive = 0;
  let attempts = 0;

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(initial),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        attempts += 1;
        if (attempts < 3) return new Response('', { status: 522 });
        return new Response(good, { status: 200, headers: { 'content-type': 'video/mp2t' } });
      } finally {
        active -= 1;
      }
    },
  });

  assert.deepEqual(await readAll(stream), [good]);
  assert.equal(maxActive, 1);
});

test('clean run preserves fetch order and emits no recovery events', async () => {
  const base = 'https://provider.example/live.m3u8';
  const firstPlaylist = mediaPlaylist(['one.ts']);
  const secondPlaylist = mediaPlaylist(['two.ts'], { sequence: 2, end: true });
  const calls = [];
  const recovery = [];

  const stream = await createProviderHlsTsStream({
    initialResponse: initialResponse(firstPlaylist),
    initialUrl: base,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith('/one.ts')) return new Response(tsBytes(330), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      if (value === base) return new Response(secondPlaylist, { status: 200 });
      if (value.endsWith('/two.ts')) return new Response(tsBytes(331), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      throw new Error(`unexpected URL ${value}`);
    },
    onRecovery: (event) => recovery.push(event),
  });

  const chunks = await readAll(stream);
  assert.equal(chunks.length, 2);
  assert.deepEqual(calls, [
    'https://provider.example/one.ts',
    base,
    'https://provider.example/two.ts',
  ]);
  assert.deepEqual(recovery, []);
});
