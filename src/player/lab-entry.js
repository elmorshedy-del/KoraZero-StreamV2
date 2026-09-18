import { createPlayerController } from './player-controller.js';
import { createBrowserHlsFactory } from './hls-adapter.js';
import { fetchPlaybackDescriptor } from './playback-descriptor.js';
import { createTelemetrySnapshot } from './session-telemetry.js';

const video = document.querySelector('#live-video');
const form = document.querySelector('#lab-form');
const input = document.querySelector('#channel-input');
const stateEl = document.querySelector('#player-state');
const output = document.querySelector('#telemetry-output');

const controller = createPlayerController({
  video,
  hlsFactory: createBrowserHlsFactory(),
});

controller.subscribe((state) => {
  stateEl.textContent = state.status;
  output.textContent = JSON.stringify(createTelemetrySnapshot(video, state), null, 2);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const channelId = input.value.trim();
  if (!channelId) return;
  try {
    const descriptor = await fetchPlaybackDescriptor(channelId);
    controller.load(descriptor);
  } catch (error) {
    output.textContent = JSON.stringify({
      status: 'DESCRIPTOR_ERROR',
      channelId,
      message: error instanceof Error ? error.message : String(error),
    }, null, 2);
  }
});

const telemetryTick = setInterval(() => {
  output.textContent = JSON.stringify(createTelemetrySnapshot(video, controller.getState()), null, 2);
}, 1000);

window.addEventListener('pagehide', () => {
  clearInterval(telemetryTick);
  controller.destroy();
}, { once: true });
