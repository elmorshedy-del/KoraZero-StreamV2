import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('synthetic source image runs a Node HTTP wrapper with ffmpeg installed', () => {
  const path = 'infra/test-source/Dockerfile';
  assert.equal(existsSync(join(root, path)), true, 'synthetic source Dockerfile must exist');
  const dockerfile = read(path);
  assert.match(dockerfile, /FROM node:24-alpine/);
  assert.match(dockerfile, /apk add --no-cache ffmpeg/);
  assert.match(dockerfile, /COPY infra\/test-source\/server\.mjs/);
  assert.match(dockerfile, /CMD \["node", "server\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /-listen\s+1/);
});

test('synthetic source does not depend on provider credentials or the legacy repo', () => {
  const dockerfile = read('infra/test-source/Dockerfile');
  const server = existsSync(join(root, 'infra/test-source/server.mjs')) ? read('infra/test-source/server.mjs') : '';
  assert.doesNotMatch(`${dockerfile}\n${server}`, /xtream|provider|morshlive|username|password/i);
});
