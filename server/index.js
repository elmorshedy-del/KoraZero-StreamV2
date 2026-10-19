import { createApp } from './app.js';
import {
  runConfiguredFanoutSmokeTest,
  runConfiguredHlsSmokeTest,
  runConfiguredRecoverySmokeTest,
} from './hls-smoke.js';
import { createSlotScheduler } from './slot-scheduler.js';

const app = createApp();
const smokeChannel = String(process.env.V2_SMOKE_TEST_CHANNEL || '').trim() || null;
await app.bootstrap({ activateChannel: smokeChannel });

const emergency3645Only = process.env.V2_EMERGENCY_3645_ONLY === 'true';
const smoke = emergency3645Only ? null : await runConfiguredHlsSmokeTest(process.env);
if (smoke) {
  console.log(`V2 HLS smoke passed channel=${smoke.channelId} status=${smoke.status} bytes=${smoke.bytes}`);
}

const fanout = emergency3645Only ? null : await runConfiguredFanoutSmokeTest(process.env);
if (fanout) {
  console.log(`V2 fanout smoke passed channel=${fanout.channelId} viewers=${fanout.viewers} upstreamPulls=${fanout.upstreamPulls} totalPulls=${fanout.totalPulls}`);
}

// Emergency: keep automatic remount disabled; Mist handles reconnects natively.
if (false) app.sourceSupervisor.start();

const recovery = emergency3645Only ? null : await runConfiguredRecoverySmokeTest(process.env);
if (recovery) {
  console.log(`V2 recovery smoke passed channel=${recovery.channelId} reconnectPulls=${recovery.reconnectPulls} upstreamPulls=${recovery.upstreamPulls} totalPulls=${recovery.totalPulls} timings=${JSON.stringify(recovery.timings)}`);
}

const slotScheduler = process.env.V2_AUTO_SCHEDULE === 'true'
  ? createSlotScheduler({
    gateway: app.gateway,
    scheduleUrl: String(
      process.env.V2_SLOT_SCHEDULE_URL
        || 'https://korazero.com/assets/data/v2-slot-schedule.json',
    ).trim(),
    todayUrl: String(
      process.env.V2_TODAY_URL
        || 'https://korazero.com/assets/data/today.json',
    ).trim(),
    log(event) {
      console.log(`V2 slot scheduler ${JSON.stringify(event)}`);
    },
  })
  : null;

app.server.listen(app.port, '0.0.0.0', () => {
  console.log(`KoraZero Stream V2 control/player service listening on ${app.port}`);
  if (slotScheduler) {
    slotScheduler.start();
    console.log('V2 automatic slot schedule enabled');
  }
});
