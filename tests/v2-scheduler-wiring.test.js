import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../server/index.js', import.meta.url));
const source = readFileSync(indexPath, 'utf8');

test('automatic slot scheduler remains opt-in and source supervisor stays disabled', () => {
  assert.match(source, /process\.env\.V2_AUTO_SCHEDULE === 'true'/);
  assert.match(source, /createSlotScheduler\(/);
  assert.match(source, /slotScheduler\.start\(\)/);
  assert.match(source, /if \(false\) app\.sourceSupervisor\.start\(\)/);
});

test('slot scheduler defaults to public schedule metadata and never embeds provider credentials', () => {
  assert.match(source, /v2-slot-schedule\.json/);
  assert.match(source, /today\.json/);
  assert.equal(/V2_IPTV_PASSWORD|V2_IPTV_USERNAME/.test(source), false);
});
