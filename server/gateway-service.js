function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

const CATALOG_STREAM_ID = /^\d+$/;

export function createGatewayService({
  registry,
  mist,
  publicHlsBase,
  sourceSupervisor = null,
  catalogClient = null,
  relayBase = null,
}) {
  if (!registry) throw new Error('gateway requires registry');
  if (!mist) throw new Error('gateway requires Mist API');
  const hlsBase = trimBase(publicHlsBase);
  const relay = trimBase(relayBase);
  if (!hlsBase) throw new Error('gateway requires publicHlsBase');

  let activeCatalogChannel = null;
  let switchTail = Promise.resolve();

  function staticChannel(channelId) {
    const entry = registry.get(channelId);
    if (!entry) throw new Error(`Unknown channel: ${channelId}`);
    return entry;
  }

  function descriptor(channelId, extra = {}) {
    return {
      channelId,
      ...extra,
      manifestUrl: `${hlsBase}/${encodeURIComponent(channelId)}/index.m3u8`,
    };
  }

  function staticPlayback(channelId) {
    staticChannel(channelId);
    return descriptor(channelId);
  }

  async function catalogEntry(streamId) {
    if (!catalogClient || !relay || !CATALOG_STREAM_ID.test(streamId)) {
      throw new Error(`Unknown channel: ${streamId}`);
    }
    const catalog = await catalogClient.list();
    const entry = catalog.channels.find((channel) => channel.streamId === streamId);
    if (!entry) throw new Error(`Unknown channel: ${streamId}`);
    return entry;
  }

  async function switchCatalogChannel(streamId) {
    const entry = await catalogEntry(streamId);
    const mistChannelId = `iptv-${streamId}`;

    if (activeCatalogChannel?.mistChannelId === mistChannelId) {
      return descriptor(mistChannelId, {
        streamId,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
      });
    }

    const configured = typeof mist.listConfiguredStreams === 'function'
      ? await mist.listConfiguredStreams()
      : [];
    for (const configuredName of configured) {
      if (configuredName.startsWith('iptv-') && configuredName !== mistChannelId) {
        await mist.deleteStream(configuredName);
      }
    }

    if (activeCatalogChannel?.mistChannelId && activeCatalogChannel.mistChannelId !== mistChannelId) {
      activeCatalogChannel = null;
    }

    await catalogClient.waitForFreeSlot();

    if (!configured.includes(mistChannelId)) {
      const source = `${relay}/live/${encodeURIComponent(streamId)}.ts`;
      await mist.addStream(mistChannelId, source, { always_on: true });
    }
    activeCatalogChannel = { streamId, mistChannelId };

    return descriptor(mistChannelId, {
      streamId,
      name: entry.name,
      categoryId: entry.categoryId,
      categoryName: entry.categoryName,
    });
  }

  function queueCatalogSwitch(streamId) {
    const run = switchTail.then(
      () => switchCatalogChannel(streamId),
      () => switchCatalogChannel(streamId),
    );
    switchTail = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    async catalog() {
      if (!catalogClient) throw new Error('IPTV catalog is unavailable');
      return catalogClient.list();
    },

    async playback(channelId) {
      if (registry.has(channelId)) return staticPlayback(channelId);
      if (CATALOG_STREAM_ID.test(channelId)) return queueCatalogSwitch(channelId);
      throw new Error(`Unknown channel: ${channelId}`);
    },

    async activate(channelId) {
      if (!registry.has(channelId) && CATALOG_STREAM_ID.test(channelId)) {
        return queueCatalogSwitch(channelId);
      }
      const entry = staticChannel(channelId);
      await mist.addStream(channelId, entry.source, { always_on: true });
      sourceSupervisor?.arm(channelId);
      return staticPlayback(channelId);
    },

    async status(channelId) {
      staticChannel(channelId);
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
        manifestUrl: staticPlayback(channelId).manifestUrl,
      };
    },

    async stop(channelId) {
      staticChannel(channelId);
      sourceSupervisor?.disarm(channelId);
      await mist.deleteStream(channelId);
      return { channelId, stopped: true };
    },
  });
}
