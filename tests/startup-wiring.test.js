import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../server/index.js', import.meta.url));

test('startup runs the configured fanout smoke before opening the control listener', () => {
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /runConfiguredFanoutSmokeTest/);
  assert.match(source, /await\s+runConfiguredFanoutSmokeTest\(process\.env\)/);
  assert.match(source, /V2 fanout smoke passed/);
  assert.ok(
    source.indexOf('runConfiguredFanoutSmokeTest(process.env)') < source.indexOf('app.server.listen'),
    'fanout smoke must finish before the public listener opens',
  );
});
