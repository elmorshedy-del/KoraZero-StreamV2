import test from 'node:test';
import assert from 'node:assert/strict';
import { createMistApi } from '../server/mist-api.js';

function commandFrom(options) {
  return JSON.parse(new URLSearchParams(options.body).get('command'));
}

test('Mist addStream merges explicit activation options while preserving the configured source', async () => {
  const calls = [];
  const fetchFn = async (_url, options) => {
    calls.push(options);
    return { ok: true, status: 200, async json() { return {}; } };
  };
  const mist = createMistApi({ fetchFn });
  await mist.addStream('test-ts', 'https-ts://source.example/live.ts', { always_on: true });
  assert.deepEqual(commandFrom(calls[0]), {
    addstream: {
      'test-ts': {
        always_on: true,
        source: 'https-ts://source.example/live.ts',
      },
    },
  });
});
