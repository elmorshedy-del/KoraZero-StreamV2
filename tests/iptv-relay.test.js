import test from 'node:test';
import assert from 'node:assert/strict';
import { createIptvRelay } from '../server/iptv-relay-core.js';

function tsPacket(pid = 256, cc = 0) {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x10 | (cc & 0x0f);
  packet.fill(0xff, 4);
  return packet;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const env = {
  V2_IPTV_PORTAL_URL: 'http://provider.example/player_api.php',
  V2_IPTV_USERNAME: 'user name',
  V2_IPTV_PASSWORD: 'p@ss/word',
  V2_IPTV_TEST_STREAM_ID: '3974',
};

test('IPTV relay answers HEAD locally without opening the provider', async () => {
  let calls = 0;
  const relay = createIptvRelay(env, { fetchFn: async () => { calls += 1; throw new Error('not expected'); } });
  const response = await relay.handle({ method: 'HEAD', pathname: '/live/3974.ts' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.has('accept-ranges'), false);
  assert.equal(calls, 0);
  assert.equal(relay.stats().totalPulls, 0);
});

test('IPTV relay GET follows redirects and streams bytes with one provider pull', async () => {
  let call;
  const relay = createIptvRelay(env, {
    fetchFn: async (url, options) => {
      call = { url, options };
      return new Response(concat(tsPacket(256, 0), tsPacket(256, 1)), {
        status: 200,
        headers: { 'content-type': 'video/mp2t' },
      });
    },
  });
  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.status, 200);
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'follow');
  assert.equal(call.options.headers['User-Agent'], 'VLC/3.0.18 LibVLC/3.0.18');
  assert.equal(call.options.headers.Range, 'bytes=0-');
  assert.match(call.url, /\/live\/user%20name\/p%40ss%2Fword\/3974\.ts$/);
  assert.equal(relay.stats().activePulls, 1);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 376);
  assert.equal(bytes[0], 0x47);
  assert.equal(bytes[188], 0x47);
  assert.equal(relay.stats().activePulls, 0);
  assert.equal(relay.stats().totalPulls, 1);
  assert.equal(relay.stats().maxConcurrentPulls, 1);
});

test('IPTV relay fails closed on a second concurrent provider pull', async () => {
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0x47])); },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });
  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const second = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(second.status, 503);
  assert.equal(relay.stats().maxConcurrentPulls, 1);
  assert.equal(relay.stats().rejectedConcurrentPulls, 1);
  await first.body.cancel();
  assert.equal(relay.stats().activePulls, 0);
});

test('IPTV relay exposes only the configured stream id', async () => {
  const relay = createIptvRelay(env, { fetchFn: async () => { throw new Error('not expected'); } });
  assert.equal((await relay.handle({ method: 'GET', pathname: '/live/2449.ts' })).status, 404);
});


test('IPTV relay injects packet-aligned TS null bursts during upstream silence', async () => {
  let upstreamController;
  const first = concat(tsPacket(256, 0), tsPacket(256, 1));
  const relay = createIptvRelay(env, {
    idleKeepaliveMs: 10,
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(first.slice(0, 211));
        controller.enqueue(first.slice(211));
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const reader = response.body.getReader();

  const real = await reader.read();
  assert.equal(real.done, false);
  assert.equal(real.value.length, 376);
  assert.equal(real.value[0], 0x47);
  assert.equal(real.value[188], 0x47);

  const heartbeat = await reader.read();
  assert.equal(heartbeat.done, false);
  assert.ok(heartbeat.value.length > 25_600);
  assert.equal(heartbeat.value.length % 188, 0);
  for (let offset = 0; offset < heartbeat.value.length; offset += 188) {
    assert.equal(heartbeat.value[offset], 0x47);
    const pid = ((heartbeat.value[offset + 1] & 0x1f) << 8) | heartbeat.value[offset + 2];
    assert.equal(pid, 0x1fff);
  }

  assert.equal(relay.stats().keepaliveBursts, 1);
  assert.equal(relay.stats().keepaliveBytes, heartbeat.value.length);
  upstreamController.close();
  await reader.cancel();
});

test('IPTV relay keeps split provider chunks aligned to 188-byte TS packets', async () => {
  const bytes = concat(tsPacket(100, 0), tsPacket(100, 1), tsPacket(100, 2));
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 59));
        controller.enqueue(bytes.slice(59, 333));
        controller.enqueue(bytes.slice(333));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const output = new Uint8Array(await response.arrayBuffer());
  assert.equal(output.length, bytes.length);
  assert.deepEqual(output, bytes);
});


test('relay observability separates provider attempts, successful opens, failures, and blocked duplicates', async () => {
  let upstreamController;
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(concat(tsPacket(256, 0), tsPacket(256, 1)));
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const blocked = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });

  assert.equal(blocked.status, 503);
  assert.equal(relay.stats().providerAttempts, 1);
  assert.equal(relay.stats().successfulProviderOpens, 1);
  assert.equal(relay.stats().failedProviderOpens, 0);
  assert.equal(relay.stats().rejectedConcurrentPulls, 1);

  upstreamController.close();
  await first.body.cancel();
});

test('relay counts upstream HTTP failure as a failed provider open', async () => {
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response('bad gateway', { status: 502 }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.status, 502);
  assert.equal(relay.stats().providerAttempts, 1);
  assert.equal(relay.stats().successfulProviderOpens, 0);
  assert.equal(relay.stats().failedProviderOpens, 1);
});


test('relay permits one simultaneous provider pull per configured stream and reports per-stream counters', async () => {
  const envTwo = {
    ...env,
    V2_IPTV_ALLOWED_STREAM_IDS: '3974,2454',
  };
  const controllers = new Map();
  const relay = createIptvRelay(envTwo, {
    fetchFn: async (url) => {
      const streamId = /\/(\d+)\.ts$/.exec(url)?.[1];
      return new Response(new ReadableStream({
        start(controller) {
          controllers.set(streamId, controller);
          controller.enqueue(concat(tsPacket(256, 0), tsPacket(256, 1)));
        },
      }), { status: 200, headers: { 'content-type': 'video/mp2t' } });
    },
  });

  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const second = await relay.handle({ method: 'GET', pathname: '/live/2454.ts' });
  const duplicate = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(duplicate.status, 503);

  const stats = relay.stats();
  assert.equal(stats.activePulls, 2);
  assert.equal(stats.maxConcurrentPulls, 2);
  assert.equal(stats.successfulProviderOpens, 2);
  assert.equal(stats.rejectedConcurrentPulls, 1);
  assert.deepEqual(
    {
      activePulls: stats.streams['3974'].activePulls,
      totalPulls: stats.streams['3974'].totalPulls,
      providerAttempts: stats.streams['3974'].providerAttempts,
      successfulProviderOpens: stats.streams['3974'].successfulProviderOpens,
      failedProviderOpens: stats.streams['3974'].failedProviderOpens,
      rejectedConcurrentPulls: stats.streams['3974'].rejectedConcurrentPulls,
      keepaliveBursts: stats.streams['3974'].keepaliveBursts,
      keepaliveBytes: stats.streams['3974'].keepaliveBytes,
    },
    {
      activePulls: 1,
      totalPulls: 1,
      providerAttempts: 1,
      successfulProviderOpens: 1,
      failedProviderOpens: 0,
      rejectedConcurrentPulls: 1,
      keepaliveBursts: 0,
      keepaliveBytes: 0,
    },
  );
  assert.deepEqual(
    {
      activePulls: stats.streams['2454'].activePulls,
      totalPulls: stats.streams['2454'].totalPulls,
      providerAttempts: stats.streams['2454'].providerAttempts,
      successfulProviderOpens: stats.streams['2454'].successfulProviderOpens,
      failedProviderOpens: stats.streams['2454'].failedProviderOpens,
      rejectedConcurrentPulls: stats.streams['2454'].rejectedConcurrentPulls,
      keepaliveBursts: stats.streams['2454'].keepaliveBursts,
      keepaliveBytes: stats.streams['2454'].keepaliveBytes,
    },
    {
      activePulls: 1,
      totalPulls: 1,
      providerAttempts: 1,
      successfulProviderOpens: 1,
      failedProviderOpens: 0,
      rejectedConcurrentPulls: 0,
      keepaliveBursts: 0,
      keepaliveBytes: 0,
    },
  );
  assert.ok(stats.streams['3974'].realBytes >= 0);
  assert.ok(stats.streams['2454'].realBytes >= 0);

  await first.body.cancel();
  await second.body.cancel();
  assert.equal(relay.stats().activePulls, 0);
});

test('relay still rejects stream ids outside the configured allowlist', async () => {
  const relay = createIptvRelay({
    ...env,
    V2_IPTV_ALLOWED_STREAM_IDS: '3974,2454',
  }, { fetchFn: async () => { throw new Error('not expected'); } });

  assert.equal((await relay.handle({ method: 'GET', pathname: '/live/2449.ts' })).status, 404);
});


function patPacket(programs) {
  const packet = new Uint8Array(188);
  packet.fill(0xff);
  packet[0] = 0x47;
  packet[1] = 0x40; // PUSI + PID 0
  packet[2] = 0x00;
  packet[3] = 0x10; // payload only
  packet[4] = 0x00; // pointer_field
  const sectionLength = 9 + (programs.length * 4);
  packet[5] = 0x00; // PAT table_id
  packet[6] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  packet[7] = sectionLength & 0xff;
  packet[8] = 0x00;
  packet[9] = 0x01; // transport_stream_id
  packet[10] = 0xc1; // version 0, current_next=1
  packet[11] = 0x00;
  packet[12] = 0x00;
  let offset = 13;
  for (const { programNumber, pmtPid } of programs) {
    packet[offset] = (programNumber >> 8) & 0xff;
    packet[offset + 1] = programNumber & 0xff;
    packet[offset + 2] = 0xe0 | ((pmtPid >> 8) & 0x1f);
    packet[offset + 3] = pmtPid & 0xff;
    offset += 4;
  }
  // CRC bytes may be zero for parser tests; parser does not validate CRC.
  packet.fill(0x00, offset, offset + 4);
  return packet;
}

test('relay passively detects multiple MPEG-TS programs from PAT without another provider request', async () => {
  const bytes = concat(
    patPacket([
      { programNumber: 101, pmtPid: 1001 },
      { programNumber: 202, pmtPid: 1002 },
    ]),
    tsPacket(256, 0),
  );
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/mp2t' },
    }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  await response.arrayBuffer();

  assert.deepEqual(relay.stats().streams['3974'].transportPrograms, [
    { programNumber: 101, pmtPid: 1001 },
    { programNumber: 202, pmtPid: 1002 },
  ]);
  assert.equal(relay.stats().streams['3974'].transportProgramCount, 2);
  assert.equal(relay.stats().streams['3974'].transportKind, 'mpts');
});

test('relay labels a one-program PAT as SPTS', async () => {
  const bytes = concat(
    patPacket([{ programNumber: 7, pmtPid: 4096 }]),
    tsPacket(257, 0),
  );
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/mp2t' },
    }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  await response.arrayBuffer();

  const stats = relay.stats().streams['3974'];
  assert.deepEqual(stats.transportPrograms, [{ programNumber: 7, pmtPid: 4096 }]);
  assert.equal(stats.transportProgramCount, 1);
  assert.equal(stats.transportKind, 'spts');
});


test('catalog mode exposes the provider live catalog without credentials and permits discovered stream ids', async () => {
  const envCatalog = { ...env, V2_IPTV_CATALOG_MODE: 'true' };
  const calls = [];
  const relay = createIptvRelay(envCatalog, {
    fetchFn: async (url) => {
      calls.push(url);
      if (url.includes('action=get_live_streams')) {
        return new Response(JSON.stringify([{ stream_id: 2449, name: 'beIN Sport 1 HD Q', category_id: '6', tv_archive: 0 }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('action=get_live_categories')) {
        return new Response(JSON.stringify([{ category_id: '6', category_name: 'beIN Sports HD' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/2449.ts')) {
        return new Response(concat(tsPacket(256, 0), tsPacket(256, 1)), { status: 200, headers: { 'content-type': 'video/mp2t' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const catalogResponse = await relay.handle({ method: 'GET', pathname: '/catalog' });
  const catalog = await catalogResponse.json();
  assert.equal(catalog.channelCount, 1);
  assert.deepEqual(catalog.channels[0], {
    streamId: '2449',
    name: 'beIN Sport 1 HD Q',
    categoryId: '6',
    categoryName: 'beIN Sports HD',
    tvArchive: false,
    isAdult: false,
  });
  assert.equal(JSON.stringify(catalog).includes('user name'), false);
  assert.equal(JSON.stringify(catalog).includes('p@ss/word'), false);

  const media = await relay.handle({ method: 'GET', pathname: '/live/2449.ts' });
  assert.equal(media.status, 200);
  await media.arrayBuffer();
  assert.equal(calls.filter((url) => url.includes('action=get_live_streams')).length, 1);
});

test('relay account endpoint returns only sanitized connection status', async () => {
  const relay = createIptvRelay(env, {
    fetchFn: async (url) => {
      assert.equal(url.includes('action='), false);
      return new Response(JSON.stringify({
        user_info: {
          auth: 1,
          status: 'Active',
          active_cons: '0',
          max_connections: '1',
          allowed_output_formats: ['m3u8', 'ts'],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const response = await relay.handle({ method: 'GET', pathname: '/account' });
  assert.deepEqual(await response.json(), {
    auth: 1,
    status: 'Active',
    activeConnections: 0,
    maxConnections: 1,
    allowedOutputFormats: ['m3u8', 'ts'],
  });
});

test('relay can enforce one total provider pull while catalog testing', async () => {
  const relay = createIptvRelay({
    ...env,
    V2_IPTV_ALLOWED_STREAM_IDS: '3974,2454',
    V2_IPTV_MAX_ACTIVE_PULLS: '1',
  }, {
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(concat(tsPacket(256, 0), tsPacket(256, 1)));
      },
    }), { status: 200, headers: { 'content-type': 'video/mp2t' } }),
  });

  const first = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  const second = await relay.handle({ method: 'GET', pathname: '/live/2454.ts' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 503);
  assert.equal(relay.stats().maxConcurrentPulls, 1);
  await first.body.cancel();
});


test('relay normalizes an HLS-backed provider stream into MPEG-TS for Mist', async () => {
  const calls = [];
  const segmentBytes = concat(tsPacket(300, 0), tsPacket(300, 1));
  const playlist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:42',
    '#EXTINF:2.0,',
    'segment-42.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  const relay = createIptvRelay(env, {
    fetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/player_api.php')) {
        return new Response(JSON.stringify({
          user_info: {
            auth: 1,
            status: 'Active',
            active_cons: '0',
            max_connections: '1',
            allowed_output_formats: ['m3u8', 'ts'],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/3974.ts') && options.headers?.Range === 'bytes=0-') {
        return new Response(playlist, {
          status: 206,
          headers: {
            'content-type': 'application/vnd.apple.mpegurl',
            'content-range': 'bytes 0-266/267',
          },
        });
      }
      if (String(url).endsWith('/segment-42.ts')) {
        return new Response(segmentBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp2t' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.get('x-kz-transport'), 'hls-to-ts');

  const output = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(output, segmentBytes);

  const stats = relay.stats().streams['3974'];
  assert.equal(stats.transportMode, 'hls-to-ts');
  assert.equal(stats.upstreamContentType, 'application/vnd.apple.mpegurl');
  assert.equal(stats.playlistFetches, 1);
  assert.equal(stats.segmentFetches, 1);
  assert.equal(stats.segmentBytes, segmentBytes.length);
  assert.equal(stats.lastSegmentStatus, 200);
  assert.equal(stats.lastSegmentContentType, 'video/mp2t');
  assert.ok(Number.isFinite(stats.firstMediaByteMs));
  assert.ok(stats.lastMediaAt);
  assert.equal(stats.lastError, null);

  assert.equal(calls.filter((call) => call.url.endsWith('/3974.ts')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/segment-42.ts')).length, 1);
});

test('raw MPEG-TS channels keep raw-ts transport observability', async () => {
  const bytes = concat(tsPacket(301, 0), tsPacket(301, 1));
  const relay = createIptvRelay(env, {
    fetchFn: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'video/mp2t' },
    }),
  });

  const response = await relay.handle({ method: 'GET', pathname: '/live/3974.ts' });
  assert.equal(response.headers.get('x-kz-transport'), 'raw-ts');
  await response.arrayBuffer();

  const stats = relay.stats().streams['3974'];
  assert.equal(stats.transportMode, 'raw-ts');
  assert.equal(stats.segmentFetches, 0);
  assert.equal(stats.playlistFetches, 0);
  assert.ok(Number.isFinite(stats.firstMediaByteMs));
});
