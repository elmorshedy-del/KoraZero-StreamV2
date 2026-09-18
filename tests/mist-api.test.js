import test from 'node:test';
import assert from 'node:assert/strict';
import { createMistApi } from '../server/mist-api.js';

function createFetchRecorder(responseBody = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() { return responseBody; },
    };
  };
  return { calls, fetchFn };
}

function commandFrom(call) {
  const params = new URLSearchParams(call.options.body);
  return JSON.parse(params.get('command'));
}

test('Mist API addStream sends an incremental addstream command', async () => {
  const transport = createFetchRecorder({ streams: { 'bein-1': { name: 'bein-1', online: 2 } } });
  const mist = createMistApi({ endpoint: 'http://127.0.0.1:4242/api2', fetchFn: transport.fetchFn });
  await mist.addStream('bein-1', 'https://provider.invalid/source.ts');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, 'http://127.0.0.1:4242/api2');
  assert.equal(transport.calls[0].options.method, 'POST');
  assert.deepEqual(commandFrom(transport.calls[0]), {
    addstream: { 'bein-1': { source: 'https://provider.invalid/source.ts' } },
  });
});

test('Mist API deleteStream sends deletestream without touching other streams', async () => {
  const transport = createFetchRecorder({ streams: { 'incomplete list': 1 } });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  await mist.deleteStream('bein-1');
  assert.deepEqual(commandFrom(transport.calls[0]), { deletestream: 'bein-1' });
});

test('Mist API getStream uses active_streams and never sends the destructive streams setter', async () => {
  const transport = createFetchRecorder({
    active_streams: {
      'bein-1': { viewers: 2, inputs: 1, outputs: 2, lastms: 12345, tracks: 2, status: 'online' },
    },
  });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  const status = await mist.getStream('bein-1');
  const command = commandFrom(transport.calls[0]);
  assert.equal(Object.hasOwn(command, 'streams'), false);
  assert.deepEqual(command, {
    active_streams: {
      stream: 'bein-1',
      fields: ['viewers', 'inputs', 'outputs', 'lastms', 'health', 'tracks', 'status'],
      longform: true,
    },
  });
  assert.deepEqual(status, {
    streamName: 'bein-1', active: true, viewers: 2, inputs: 1, outputs: 2,
    lastms: 12345, tracks: 2, status: 'online', health: null,
  });
});

test('Mist API getStream returns inactive when stream is not in active_streams', async () => {
  const transport = createFetchRecorder({ active_streams: {} });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  assert.deepEqual(await mist.getStream('bein-1'), {
    streamName: 'bein-1', active: false, viewers: 0, inputs: 0,
    outputs: 0, lastms: null, tracks: 0, status: 'inactive', health: null,
  });
});

test('Mist API rejects non-success HTTP responses', async () => {
  const fetchFn = async () => ({ ok: false, status: 503, async json() { return {}; } });
  const mist = createMistApi({ fetchFn });
  await assert.rejects(() => mist.getStream('bein-1'), /503/);
});

test('Mist API ensureHttpProtocol adds HTTP only when it is missing', async () => {
  const calls = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    calls.push(command);
    if (command.config_backup) {
      return { ok: true, status: 200, async json() { return { config_backup: { protocols: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const mist = createMistApi({ fetchFn });
  const result = await mist.ensureHttpProtocol({ port: 8080 });
  assert.deepEqual(calls, [
    { config_backup: true },
    { addprotocol: { connector: 'HTTP', port: 8080 } },
  ]);
  assert.deepEqual(result, { changed: true, port: 8080 });
});

test('Mist API ensureHttpProtocol is idempotent when HTTP already exists', async () => {
  const transport = createFetchRecorder({
    config_backup: { protocols: [{ connector: 'HTTP', port: 8080 }] },
  });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  const result = await mist.ensureHttpProtocol({ port: 8080 });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(commandFrom(transport.calls[0]), { config_backup: true });
  assert.deepEqual(result, { changed: false, port: 8080 });
});

test('Mist API authenticates remote commands with challenge-response without sending plaintext password', async () => {
  const calls = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    calls.push(command);
    if (calls.length === 1) {
      return { ok: true, status: 200, async json() { return { authorize: { status: 'CHALL', challenge: 'abc123' } }; } };
    }
    return { ok: true, status: 200, async json() { return { authorize: { status: 'OK' }, config_backup: { protocols: [] } }; } };
  };
  const mist = createMistApi({ username: 'v2control', password: 'secret', fetchFn });
  await mist.ensureHttpProtocol({ port: 8080 });
  assert.deepEqual(calls[0].authorize, { username: 'v2control', password: '' });
  assert.equal(calls[0].minimal, 1);
  assert.equal(calls[1].authorize.username, 'v2control');
  assert.equal(calls[1].authorize.password, '7840a038e45863d5ef110af0145f1b06');
  assert.notEqual(calls[1].authorize.password, 'secret');
});

test('Mist API fails closed when remote MistServer has no configured account', async () => {
  const fetchFn = async () => ({
    ok: true, status: 200,
    async json() { return { authorize: { status: 'NOACC' } }; },
  });
  const mist = createMistApi({ username: 'v2control', password: 'secret', fetchFn });
  await assert.rejects(() => mist.getStream('bein-1'), /no account/i);
});

test('Mist API can create the first private account once, then retries with challenge-response', async () => {
  const calls = [];
  const responses = [
    { authorize: { status: 'NOACC' } },
    { authorize: { status: 'ACC_MADE' } },
    { authorize: { status: 'CHALL', challenge: 'abc123' } },
    { authorize: { status: 'OK' }, config_backup: { protocols: [] } },
    { authorize: { status: 'CHALL', challenge: 'abc123' } },
    { authorize: { status: 'OK' } },
  ];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    calls.push(command);
    const body = responses.shift();
    return { ok: true, status: 200, async json() { return body; } };
  };
  const mist = createMistApi({
    username: 'v2control',
    password: 'secret',
    bootstrapAccount: true,
    fetchFn,
  });
  await mist.ensureHttpProtocol({ port: 8080 });
  assert.deepEqual(calls[0].authorize, { username: 'v2control', password: '' });
  assert.deepEqual(calls[1].authorize, {
    new_username: 'v2control',
    new_password: 'secret',
  });
  assert.deepEqual(calls[2].authorize, { username: 'v2control', password: '' });
  assert.equal(calls[3].authorize.password, '7840a038e45863d5ef110af0145f1b06');
  assert.deepEqual(calls[4].authorize, { username: 'v2control', password: '' });
  assert.equal(calls[5].authorize.password, '7840a038e45863d5ef110af0145f1b06');
});

test('Mist API never creates an account unless bootstrapAccount is explicitly enabled', async () => {
  const calls = [];
  const fetchFn = async (_url, options) => {
    calls.push(JSON.parse(new URLSearchParams(options.body).get('command')));
    return { ok: true, status: 200, async json() { return { authorize: { status: 'NOACC' } }; } };
  };
  const mist = createMistApi({ username: 'v2control', password: 'secret', fetchFn });
  await assert.rejects(() => mist.ensureHttpProtocol({ port: 8080 }), /no account/i);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).includes('new_password'), false);
});


test('Mist API nukeStream performs a targeted hard reset without deleting configuration', async () => {
  const transport = createFetchRecorder({});
  const mist = createMistApi({ fetchFn: transport.fetchFn });

  await mist.nukeStream('test-ts');

  assert.deepEqual(commandFrom(transport.calls[0]), { nuke_stream: 'test-ts' });
});


test('Mist API ensures viewer sessions use stream plus stable token without viewer IP', async () => {
  const calls = [];
  const fetchFn = async (_url, options) => {
    const command = JSON.parse(new URLSearchParams(options.body).get('command'));
    calls.push(command);
    if (command.config_backup) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { config_backup: { config: { sessionViewerMode: 14 } } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const mist = createMistApi({ fetchFn });
  const result = await mist.ensureViewerSessionMode({ mode: 10 });
  assert.deepEqual(calls, [
    { config_backup: true },
    { config: { sessionViewerMode: 10 } },
  ]);
  assert.deepEqual(result, { changed: true, previousMode: 14, mode: 10 });
});

test('Mist API leaves viewer session mode untouched when already configured', async () => {
  const transport = createFetchRecorder({
    config_backup: { config: { sessionViewerMode: 10 } },
  });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  const result = await mist.ensureViewerSessionMode({ mode: 10 });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(commandFrom(transport.calls[0]), { config_backup: true });
  assert.deepEqual(result, { changed: false, previousMode: 10, mode: 10 });
});
