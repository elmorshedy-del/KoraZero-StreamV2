import { createPlayerController } from './player-controller.js';
import { createBrowserHlsFactory } from './hls-adapter.js';
import { fetchPlaybackDescriptor } from './playback-descriptor.js';

const video = document.querySelector('#live-video');
const stateEl = document.querySelector('#player-state');
const messageEl = document.querySelector('#player-message');
const channelEl = document.querySelector('#channel-id');
const engineEl = document.querySelector('#player-engine');
const titleEl = document.querySelector('#channel-title');

const controller = createPlayerController({
  video,
  hlsFactory: createBrowserHlsFactory(),
});

controller.subscribe((state) => {
  stateEl.textContent = state.status;
  channelEl.textContent = state.channelId ?? '—';
  engineEl.textContent = state.engine ?? '—';
  messageEl.textContent = state.error?.message ?? state.status;
});

const params = new URLSearchParams(location.search);
const channelId = params.get('channel');
const title = params.get('title');

if (title) titleEl.textContent = title;

if (channelId) {
  try {
    const descriptor = await fetchPlaybackDescriptor(channelId);
    controller.load(descriptor);
  } catch (error) {
    messageEl.textContent = error instanceof Error ? error.message : String(error);
  }
} else {
  messageEl.textContent = 'Add ?channel=<logical-channel-id> to start the V2 prototype.';
}

window.addEventListener('pagehide', () => controller.destroy(), { once: true });
