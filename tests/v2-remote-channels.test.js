import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const remote = readFileSync(new URL('../src/remote.html', import.meta.url), 'utf8');

test('V2 Remote keeps the three Thamanya controls', () => {
  for (const [streamId, label] of [
    ['241362', 'Thamanya 1'],
    ['241363', 'Thamanya 2'],
    ['241364', 'Thamanya 3'],
  ]) {
    assert.match(remote, new RegExp(`\\["${streamId}","${label}"\\]`));
  }
});
