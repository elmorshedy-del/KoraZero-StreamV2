import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = join(root, 'src');
const forbidden = [
  'mpegts',
  'watch-loader',
  'watch-lab-continuity-guard',
  'iptv-lab.js',
  'stream-plan-api',
  '/api/xtream/media',
];

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('V2 has an isolated source tree', () => {
  assert.equal(existsSync(src), true, 'src/ must exist as the clean V2 boundary');
});

test('V2 source contains no forbidden legacy streaming behavior', () => {
  const violations = [];
  for (const file of filesUnder(src).filter((path) => /\.(html|js|css|json)$/i.test(path))) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const token of forbidden) {
      if (text.includes(token.toLowerCase())) {
        violations.push(`${relative(root, file)} contains ${token}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
