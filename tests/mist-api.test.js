import test from 'node:test';
import assert from 'node:assert/strict';
import { createMistApi } from '../server/mist-api.js';

function createFetchRecorder(responseBody = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async json() { return responseBody; } };
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
  assert.deepEqual(commandFrom(transport.calls[0]), { addstream: { 'bein-1': { source: 'https://provider.invalid/source.ts' } } });
});

test('Mist API deleteStream sends deletestream without touching other streams', async () => {
  const transport = createFetchRecorder({ streams: { 'incomplete list': 1 } });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  await mist.deleteStream('bein-1');
  assert.deepEqual(commandFrom(transport.calls[0]), { deletestream: 'bein-1' });
});

test('Mist API getStream uses active_streams and never sends the destructive streams setter', async () => {
  const transport = createFetchRecorder({ active_streams: { 'bein-1': { viewers: 2, inputs: 1, outputs: 2, tracks: 2, status: 'online' } } });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  const status = await mist.getStream('bein-1');
  const command = commandFrom(transport.calls[0]);
  assert.equal(Object.hasOwn(command, 'streams'), false);
  assert.deepEqual(command, { active_streams: { stream: 'bein-1', fields: ['viewers', 'inputs', 'outputs', 'health', 'tracks', 'status'], longform: true } });
  assert.deepEqual(status, { streamName: 'bein-1', active: true, viewers: 2, inputs: 1, outputs: 2, tracks: 2, status: 'online', health: null });
});

test('Mist API getStream returns inactive when stream is not in active_streams', async () => {
  const transport = createFetchRecorder({ active_streams: {} });
  const mist = createMistApi({ fetchFn: transport.fetchFn });
  assert.deepEqual(await mist.getStream('bein-1'), { streamName: 'bein-1', active: false, viewers: 0, inputs: 0, outputs: 0, tracks: 0, status: 'inactive', health: null });
});

test('Mist API rejects non-success HTTP responses', async () => {
  const fetchFn = async () => ({ ok: false, status: 503, async json() { return {}; } });
  const mist = createMistApi({ fetchFn });
  await assert.rejects(() => mist.getStream('bein-1'), /503/);
});
