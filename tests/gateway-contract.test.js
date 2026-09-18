import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('browser source contains no provider secret or direct-source configuration', () => {
  const source = walk(join(root, 'src'))
    .filter((path) => /\.(html|js|css|json)$/i.test(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  for (const token of ['V2_SOURCE_URL', 'provider_password', 'provider_username', '/live/username/password/']) {
    assert.equal(source.includes(token), false, `src/ must not contain ${token}`);
  }
});

test('gateway contract defines KoraZero-owned HLS as the browser boundary', () => {
  const contractPath = join(root, 'docs/gateway-contract.md');
  assert.equal(existsSync(contractPath), true, 'gateway contract must exist');
  const contract = readFileSync(contractPath, 'utf8');
  assert.match(contract, /\/hls\/\{stream\}\/index\.m3u8/);
  assert.match(contract, /browser.*never.*provider/i);
});

test('MistServer skeleton uses the official image and keeps management private', () => {
  const composePath = join(root, 'infra/mistserver/docker-compose.yml');
  assert.equal(existsSync(composePath), true, 'MistServer compose file must exist');
  const compose = readFileSync(composePath, 'utf8');
  assert.match(compose, /ddvtech\/mistserver/);
  assert.match(compose, /127\.0\.0\.1:4242:4242/);
  assert.match(compose, /8080:8080/);
});
