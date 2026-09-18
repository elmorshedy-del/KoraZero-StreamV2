import { createApp } from './app.js';
import { runConfiguredHlsSmokeTest } from './hls-smoke.js';

const app = createApp();
const smokeChannel = String(process.env.V2_SMOKE_TEST_CHANNEL || '').trim() || null;
await app.bootstrap({ activateChannel: smokeChannel });
const smoke = await runConfiguredHlsSmokeTest(process.env);
if (smoke) {
  console.log(`V2 HLS smoke passed channel=${smoke.channelId} status=${smoke.status} bytes=${smoke.bytes}`);
}
app.server.listen(app.port, '0.0.0.0', () => {
  console.log(`KoraZero Stream V2 control/player service listening on ${app.port}`);
});
