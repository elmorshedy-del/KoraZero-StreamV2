import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSyntheticTsServer } from '../infra/test-source/server.mjs';

function fakeSpawnRecorder() {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args });
    return {
      stdout: Readable.from([Buffer.from([0x47, 0x40, 0x00, 0x10])]),
      kill() {},
      on() {},
    };
  };
  return { calls, spawnFn };
}

async function withServer(spawnFn, fn) {
  const server = createSyntheticTsServer({ spawnFn });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('HEAD /live.ts is safe and does not start ffmpeg', async () => {
  const fake = fakeSpawnRecorder();
  await withServer(fake.spawnFn, async (base) => {
    const response = await fetch(`${base}/live.ts`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /video\/mp2t/);
  });
  assert.equal(fake.calls.length, 0);
});

test('GET /live.ts starts an H264 AAC MPEG-TS generator and streams bytes', async () => {
  const fake = fakeSpawnRecorder();
  await withServer(fake.spawnFn, async (base) => {
    const response = await fetch(`${base}/live.ts`);
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.deepEqual([...body], [0x47, 0x40, 0x00, 0x10]);
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, 'ffmpeg');
  const joined = fake.calls[0].args.join(' ');
  assert.match(joined, /libx264/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /-f mpegts/);
  assert.match(joined, /pipe:1/);
});

test('GET /live.ts flushes HTTP headers before ffmpeg emits its first media byte', async () => {
  const { PassThrough } = await import('node:stream');
  const stdout = new PassThrough();
  const spawnFn = () => ({
    stdout,
    kill() {},
    on() {},
  });

  await withServer(spawnFn, async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      const response = await fetch(`${base}/live.ts`, { signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /video\/mp2t/);
    } finally {
      clearTimeout(timer);
      controller.abort();
      stdout.destroy();
    }
  });
});


test('GET /stats reports source pull counters without starting ffmpeg', async () => {
  const fake = fakeSpawnRecorder();
  await withServer(fake.spawnFn, async (base) => {
    const response = await fetch(`${base}/stats`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), {
      activePulls: 0,
      totalPulls: 0,
      maxConcurrentPulls: 0,
      headRequests: 0,
    });
  });
  assert.equal(fake.calls.length, 0);
});


test('authorized disconnect control terminates the active source pull', async () => {
  const { PassThrough } = await import('node:stream');
  const stdout = new PassThrough();
  let kills = 0;
  const spawnFn = () => ({
    stdout,
    kill() { kills += 1; },
    on() {},
  });

  const server = createSyntheticTsServer({ spawnFn, controlToken: 'fault-secret' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let liveResponse;
  try {
    liveResponse = await fetch(`${base}/live.ts`);
    let stats = await (await fetch(`${base}/stats`)).json();
    assert.equal(stats.activePulls, 1);
    assert.equal(stats.totalPulls, 1);

    const response = await fetch(`${base}/control/disconnect`, {
      method: 'POST',
      headers: { authorization: 'Bearer fault-secret' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { disconnected: 1 });

    stats = await (await fetch(`${base}/stats`)).json();
    assert.equal(stats.activePulls, 0);
    assert.equal(stats.totalPulls, 1);
    assert.equal(kills, 1);
  } finally {
    await liveResponse?.body?.cancel().catch(() => {});
    stdout.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
