import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('release candidate contains relay recovery, two-slot controller, fingerprint guard, and opt-in scheduler together', () => {
  const providerHls = read('server/provider-hls-source.js');
  const relay = read('server/iptv-relay-core.js');
  const gateway = read('server/gateway-service.js');
  const scheduler = read('server/slot-scheduler.js');
  const index = read('server/index.js');

  assert.match(providerHls, /onRecovery/);
  assert.match(providerHls, /gapBudget/i);
  assert.match(relay, /accountFingerprint/);
  assert.match(relay, /hlsSegmentRetries/);
  assert.match(gateway, /slot_manual_hold/);
  assert.match(gateway, /all_slots_busy/);
  assert.match(scheduler, /schedule-unavailable/);
  assert.match(index, /process\.env\.V2_AUTO_SCHEDULE === 'true'/);
  assert.match(index, /if \(false\) app\.sourceSupervisor\.start\(\)/);
});
