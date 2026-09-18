import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetrySnapshot } from '../src/player/session-telemetry.js';

test('telemetry snapshot reports player state and forward buffer without controlling playback', () => {
  const video = {
    currentTime: 12.5,
    readyState: 3,
    paused: false,
    buffered: {
      length: 1,
      start() { return 0; },
      end() { return 17.25; },
    },
  };
  const snapshot = createTelemetrySnapshot(video, {
    status: 'PLAYING',
    engine: 'hls.js',
    channelId: 'bein-1',
    generation: 3,
    error: null,
  });
  assert.deepEqual(snapshot, { status:'PLAYING', engine:'hls.js', channelId:'bein-1', generation:3, currentTime:12.5, bufferAhead:4.75, readyState:3, paused:false, error:null });
});
