import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('synthetic source image generates H264 AAC MPEG-TS over HTTP', () => {
  const path = 'infra/test-source/Dockerfile';
  assert.equal(existsSync(join(root, path)), true, 'synthetic source Dockerfile must exist');
  const dockerfile = read(path);
  assert.match(dockerfile, /ffmpeg/i);
  assert.match(dockerfile, /libx264/);
  assert.match(dockerfile, /-c:a\s+aac/);
  assert.match(dockerfile, /-f\s+mpegts/);
  assert.match(dockerfile, /-listen\s+1/);
  assert.match(dockerfile, /live\.ts/);
});

test('synthetic source does not depend on provider credentials or the legacy repo', () => {
  const dockerfile = read('infra/test-source/Dockerfile');
  assert.doesNotMatch(dockerfile, /xtream|provider|morshlive|username|password/i);
});
