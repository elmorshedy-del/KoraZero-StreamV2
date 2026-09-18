function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function createGatewayService({ registry, mist, publicHlsBase }) {
  if (!registry) throw new Error('gateway requires registry');
  if (!mist) throw new Error('gateway requires Mist API');
  const hlsBase = trimBase(publicHlsBase);
  if (!hlsBase) throw new Error('gateway requires publicHlsBase');

  function channel(channelId) {
    const entry = registry.get(channelId);
    if (!entry) throw new Error(`Unknown channel: ${channelId}`);
    return entry;
  }

  function playback(channelId) {
    channel(channelId);
    return {
      channelId,
      manifestUrl: `${hlsBase}/${encodeURIComponent(channelId)}/index.m3u8`,
    };
  }

  return Object.freeze({
    playback,

    async activate(channelId) {
      const entry = channel(channelId);
      await mist.addStream(channelId, entry.source, { always_on: true });
      return playback(channelId);
    },

    async status(channelId) {
      channel(channelId);
      const runtime = await mist.getStream(channelId);
      return {
        channelId,
        active: runtime.active,
        viewers: runtime.viewers,
        inputs: runtime.inputs,
        outputs: runtime.outputs,
        tracks: runtime.tracks,
        status: runtime.status,
        health: runtime.health,
        manifestUrl: playback(channelId).manifestUrl,
      };
    },

    async stop(channelId) {
      channel(channelId);
      await mist.deleteStream(channelId);
      return { channelId, stopped: true };
    },
  });
}
