import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const remote = readFileSync(new URL('../src/remote.html', import.meta.url), 'utf8');

const REMOTE_CHANNELS = [
  ['3645', 'beIN Sports 1'],
  ['3644', 'beIN Sports 2'],
  ['3653', 'beIN Sports 3'],
  ['3652', 'beIN Sports 4'],
  ['3651', 'beIN Sports 5'],
  ['241362', 'Thamanya 1'],
  ['241363', 'Thamanya 2'],
  ['241364', 'Thamanya 3'],
  ['89778', 'Al Kass 1'],
  ['89779', 'Al Kass 2'],
  ['677', 'ON Sport HD'],
  ['244603', 'Shasha Sport 2'],
];

test('V2 Remote exposes every supported operator channel', () => {
  for (const [streamId, label] of REMOTE_CHANNELS) {
    assert.ok(remote.includes('["' + streamId + '","' + label + '"]'), streamId + ' ' + label);
  }
});

test('single-slot V2 Remote switches immediately instead of hiding a second tap below the grid', () => {
  assert.ok(remote.includes('if (slots.length === 1) {'));
  assert.ok(remote.includes('switchTo(id, label, slots[0].slot);'));
});

test('multi-slot chooser is rendered before the channel grid and scrolls into view', () => {
  assert.ok(remote.indexOf('id="chooser"') < remote.indexOf('id="grid"'));
  assert.ok(remote.includes('chooser.scrollIntoView({ behavior: "smooth", block: "center" });'));
});
