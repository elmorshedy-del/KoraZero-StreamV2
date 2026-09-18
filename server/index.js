import { createApp } from './app.js';

const app = createApp();
app.server.listen(app.port, '0.0.0.0', () => {
  console.log(`KoraZero Stream V2 control/player service listening on ${app.port}`);
});
