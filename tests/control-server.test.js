import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../server/control-server.js';
import { fileURLToPath } from 'node:url';

const staticRoot = fileURLToPath(new URL('../src/', import.meta.url));

function createGatewayFake() {
  const calls = [];
  return {
    calls,
    async catalog() {
      calls.push(['catalog']);
      return {
        channelCount: 1,
        categories: [{ categoryId: '6', name: 'beIN Sports HD', count: 1 }],
        channels: [{ streamId: '2449', name: 'beIN Sport 1 HD Q', categoryId: '6', categoryName: 'beIN Sports HD' }],
      };
    },
    playback(channelId) {
      calls.push(['playback', channelId]);
      if (channelId === 'missing') throw new Error('Unknown channel: missing');
      return { channelId, manifestUrl: `https://stream-v2.example/hls/${channelId}/index.m3u8` };
    },
    async activate(channelId) {
      calls.push(['activate', channelId]);
      return { channelId, manifestUrl: `https://stream-v2.example/hls/${channelId}/index.m3u8` };
    },
    async status(channelId) {
      calls.push(['status', channelId]);
      return { channelId, active: true, viewers: 2, inputs: 1, outputs: 2, tracks: 2, status: 'online', health: null, manifestUrl: `https://stream-v2.example/hls/${channelId}/index.m3u8` };
    },
    async stop(channelId) {
      calls.push(['stop', channelId]);
      return { channelId, stopped: true };
    },
    async active() {
      calls.push(['active']);
      return { active: { channelId: 'iptv-3645', streamId: '3645', inputs: 1, viewers: 2 }, conflict: false, live: [] };
    },
    async stopDynamic() {
      calls.push(['stopDynamic']);
      return { stopped: true, channels: ['iptv-3645'] };
    },
  };
}

async function withServer(fn) {
  const gateway = createGatewayFake();
  const server = createControlServer({ gateway, internalToken: 'test-secret', operatorPin: 'operator-pin', staticRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, gateway });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('public playback descriptor returns only KoraZero HLS information', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/playback/bein-1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      channelId: 'bein-1',
      manifestUrl: 'https://stream-v2.example/hls/bein-1/index.m3u8',
    });
    assert.equal(JSON.stringify(body).includes('source'), false);
  });
});

test('public numeric catalog playback cannot switch the provider source', async () => {
  await withServer(async ({ base, gateway }) => {
    const response = await fetch(`${base}/api/playback/89778`);
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: 'dynamic_playback_requires_internal_activation' });
    assert.deepEqual(gateway.calls, []);
  });
});

test('unknown public playback channel returns 404', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/playback/missing`);
    assert.equal(response.status, 404);
  });
});

test('internal routes require bearer authentication', async () => {
  await withServer(async ({ base, gateway }) => {
    const response = await fetch(`${base}/internal/channels/bein-1/activate`, { method: 'POST' });
    assert.equal(response.status, 401);
    assert.deepEqual(gateway.calls, []);
  });
});

test('authenticated internal activate/status/stop routes call only the matching gateway operation', async () => {
  await withServer(async ({ base, gateway }) => {
    const headers = { authorization: 'Bearer test-secret' };

    let response = await fetch(`${base}/internal/channels/bein-1/activate`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/internal/channels/bein-1/status`, { headers });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.inputs, 1);
    assert.equal(status.viewers, 2);

    response = await fetch(`${base}/internal/channels/bein-1/stop`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    assert.deepEqual(gateway.calls, [
      ['activate', 'bein-1'],
      ['status', 'bein-1'],
      ['stop', 'bein-1'],
    ]);
  });
});


test('control server serves the disposable V2 shell from the same origin', async () => {
  await withServer(async ({ base }) => {
    let response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /KoraZero Stream V2/);

    response = await fetch(`${base}/player/playback-descriptor.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  });
});

test('static serving rejects paths outside the V2 source root', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/../package.json`);
    assert.equal(response.status, 404);
  });
});


test('public catalog returns sanitized provider channel metadata', async () => {
  await withServer(async ({ base, gateway }) => {
    const response = await fetch(`${base}/api/catalog`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.channelCount, 1);
    assert.equal(body.channels[0].streamId, '2449');
    assert.equal(body.channels[0].name, 'beIN Sport 1 HD Q');
    assert.deepEqual(gateway.calls, [['catalog']]);
    assert.equal(JSON.stringify(body).includes('username'), false);
    assert.equal(JSON.stringify(body).includes('password'), false);
  });
});


test('operator routes require the operator PIN and only allow fixed V2 stream ids', async () => {
  await withServer(async ({ base, gateway }) => {
    let response = await fetch(`${base}/operator/active`);
    assert.equal(response.status, 401);

    const headers = { 'x-operator-pin': 'operator-pin' };
    response = await fetch(`${base}/operator/active`, { headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/operator/switch/3645`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/operator/switch/99999`, { method: 'POST', headers });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/operator/off`, { method: 'POST', headers });
    assert.equal(response.status, 200);

    assert.deepEqual(gateway.calls.slice(-3), [
      ['active'],
      ['activate', '3645'],
      ['stopDynamic'],
    ]);
  });
});

test('operator remote page is served without embedding credentials', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/remote.html`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /V2 Remote/);
    assert.match(html, /operator PIN/i);
    assert.equal(html.includes('operator-pin'), false);
    assert.equal(html.includes('test-secret'), false);
  });
});
