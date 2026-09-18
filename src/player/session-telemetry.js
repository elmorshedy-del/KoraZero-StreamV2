function forwardBuffer(video) {
  const ranges = video.buffered;
  if (!ranges?.length) return 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (video.currentTime >= start && video.currentTime <= end) {
      return Math.max(0, end - video.currentTime);
    }
  }
  return 0;
}

export function createTelemetrySnapshot(video, state) {
  return {
    status: state.status,
    engine: state.engine,
    channelId: state.channelId,
    generation: state.generation,
    currentTime: Number(video.currentTime || 0),
    bufferAhead: Number(forwardBuffer(video).toFixed(3)),
    readyState: Number(video.readyState || 0),
    paused: Boolean(video.paused),
    error: state.error?.message ?? null,
  };
}
