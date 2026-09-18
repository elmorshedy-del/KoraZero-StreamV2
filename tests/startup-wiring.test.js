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

test('startup starts bounded source supervision after fanout and before recovery smoke', () => {
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /app\.sourceSupervisor\.start\(\)/);
  assert.ok(
    source.indexOf('runConfiguredFanoutSmokeTest(process.env)') < source.indexOf('app.sourceSupervisor.start()'),
    'source supervision should begin after fanout smoke',
  );
  assert.ok(
    source.indexOf('app.sourceSupervisor.start()') < source.indexOf('runConfiguredRecoverySmokeTest(process.env)'),
    'recovery smoke must validate the running source supervisor',
  );
});

test('startup runs configured recovery smoke after fanout and before opening the listener', () => {
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /runConfiguredRecoverySmokeTest/);
  assert.match(source, /await\s+runConfiguredRecoverySmokeTest\(process\.env\)/);
  assert.match(source, /V2 recovery smoke passed/);
  assert.ok(
    source.indexOf('runConfiguredFanoutSmokeTest(process.env)') < source.indexOf('runConfiguredRecoverySmokeTest(process.env)'),
    'recovery smoke should run after fanout smoke',
  );
  assert.ok(
    source.indexOf('runConfiguredRecoverySmokeTest(process.env)') < source.indexOf('app.server.listen'),
    'recovery smoke must finish before the public listener opens',
  );
});
