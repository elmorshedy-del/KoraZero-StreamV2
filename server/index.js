import { createApp } from './app.js';
import {
  runConfiguredFanoutSmokeTest,
  runConfiguredHlsSmokeTest,
  runConfiguredRecoverySmokeTest,
} from './hls-smoke.js';

const app = createApp();
const smokeChannel = String(process.env.V2_SMOKE_TEST_CHANNEL || '').trim() || null;
await app.bootstrap({ activateChannel: smokeChannel });

const smoke = await runConfiguredHlsSmokeTest(process.env);
if (smoke) {
  console.log(`V2 HLS smoke passed channel=${smoke.channelId} status=${smoke.status} bytes=${smoke.bytes}`);
}

const fanout = await runConfiguredFanoutSmokeTest(process.env);
if (fanout) {
  console.log(`V2 fanout smoke passed channel=${fanout.channelId} viewers=${fanout.viewers} upstreamPulls=${fanout.upstreamPulls} totalPulls=${fanout.totalPulls}`);
}

const recovery = await runConfiguredRecoverySmokeTest(process.env);
if (recovery) {
  console.log(`V2 recovery smoke passed channel=${recovery.channelId} reconnectPulls=${recovery.reconnectPulls} upstreamPulls=${recovery.upstreamPulls} totalPulls=${recovery.totalPulls}`);
}

app.server.listen(app.port, '0.0.0.0', () => {
  console.log(`KoraZero Stream V2 control/player service listening on ${app.port}`);
});
