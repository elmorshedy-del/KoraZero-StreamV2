import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerController } from '../src/player/player-controller.js';
import { createBrowserHlsFactory } from '../src/player/hls-adapter.js';

function createVideo({ nativeHls = false } = {}) {
  const events = new Map();
  return { src: '', loadCalls: 0, pauseCalls: 0, canPlayType(type) { return nativeHls && type === 'application/vnd.apple.mpegurl' ? 'probably' : ''; }, addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); }, emit(name, detail) { events.get(name)?.(detail); }, load() { this.loadCalls += 1; }, pause() { this.pauseCalls += 1; }, removeAttribute(name) { if (name === 'src') this.src = ''; } };
}

function createHlsFactory({ supported = true } = {}) {
  const instances = [];
  function factory() {
    const instance = { attachCalls: 0, loadCalls: [], destroyCalls: 0, attachMedia() { this.attachCalls += 1; }, loadSource(url) { this.loadCalls.push(url); }, destroy() { this.destroyCalls += 1; }, on() {}, off() {} };
    instances.push(instance);
    return instance;
  }
  factory.isSupported = () => supported;
  factory.instances = instances;
  return factory;
}

test('uses native HLS when the video element supports it', () => {
  const video = createVideo({ nativeHls: true });
  const hlsFactory = createHlsFactory();
  const player = createPlayerController({ video, hlsFactory });
  player.load({ channelId: 'bein-1', manifestUrl: 'https://v2.example/hls/bein-1/index.m3u8' });
  assert.equal(video.src, 'https://v2.example/hls/bein-1/index.m3u8');
  assert.equal(hlsFactory.instances.length, 0);
  assert.deepEqual(player.getState(), { status: 'LOADING', engine: 'native-hls', channelId: 'bein-1', generation: 1, error: null });
});

test('uses hls.js when native HLS is unavailable and hls.js is supported', () => {
  const video = createVideo({ nativeHls: false });
  const hlsFactory = createHlsFactory({ supported: true });
  const player = createPlayerController({ video, hlsFactory });
  player.load({ channelId: 'bein-1', manifestUrl: 'https://v2.example/hls/bein-1/index.m3u8' });
  assert.equal(hlsFactory.instances.length, 1);
  assert.equal(hlsFactory.instances[0].attachCalls, 1);
  assert.deepEqual(hlsFactory.instances[0].loadCalls, ['https://v2.example/hls/bein-1/index.m3u8']);
  assert.equal(player.getState().engine, 'hls.js');
});

test('enters ERROR when neither native HLS nor hls.js is supported', () => {
  const player = createPlayerController({ video: createVideo(), hlsFactory: createHlsFactory({ supported: false }) });
  player.load({ channelId: 'bein-1', manifestUrl: 'https://v2.example/hls/bein-1/index.m3u8' });
  assert.equal(player.getState().status, 'ERROR');
});

test('a second load tears down the old engine before creating the next one', () => {
  const video = createVideo();
  const hlsFactory = createHlsFactory();
  const player = createPlayerController({ video, hlsFactory });
  player.load({ channelId: 'one', manifestUrl: 'https://v2.example/hls/one/index.m3u8' });
  const first = hlsFactory.instances[0];
  player.load({ channelId: 'two', manifestUrl: 'https://v2.example/hls/two/index.m3u8' });
  assert.equal(first.destroyCalls, 1);
  assert.equal(player.getState().channelId, 'two');
});

test('browser hls adapter wraps an injected Hls class without global player logic', () => {
  class FakeHls { static isSupported() { return true; } }
  const factory = createBrowserHlsFactory(FakeHls);
  assert.equal(factory.isSupported(), true);
  assert.ok(factory() instanceof FakeHls);
});
