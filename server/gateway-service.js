import { probeHlsPlayback } from './playback-probe.js';

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
  fetchFn = globalThis.fetch,
  playbackProbeFn = probeHlsPlayback,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!registry) throw new Error('gateway requires registry');
  if (!mist) throw new Error('gateway requires Mist API');
  const hlsBase = trimBase(publicHlsBase);
  const relay = trimBase(relayBase);
  if (!hlsBase) throw new Error('gateway requires publicHlsBase');

  let activeCatalogChannel = null;
  let switchTail = Promise.resolve();
  let attemptSequence = 0;
  const latestAttempts = new Map();

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

  function beginAttempt(streamId, name) {
    const attempt = {
      attemptId: `${Date.now()}-${++attemptSequence}`,
      streamId,
      name,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      phase: 'catalog-resolved',
      ok: null,
      error: null,
      events: [],
      verification: null,
    };
    latestAttempts.set(streamId, attempt);
    return attempt;
  }

  function record(attempt, phase, details = {}) {
    attempt.phase = phase;
    attempt.events.push({
      at: new Date().toISOString(),
      phase,
      ...details,
    });
    if (attempt.events.length > 60) attempt.events.splice(0, attempt.events.length - 60);
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

  async function observeMistInputExit(channelId, timeoutMs = 1_500) {
    const startedAt = Date.now();
    let lastStatus = null;
    while (Date.now() - startedAt < timeoutMs) {
      lastStatus = await mist.getStream(channelId);
      if (!lastStatus.active || Number(lastStatus.inputs || 0) === 0) {
        return { stopped: true, waitMs: Date.now() - startedAt, status: lastStatus };
      }
      await sleepFn(150);
    }
    return { stopped: false, waitMs: Date.now() - startedAt, status: lastStatus };
  }

  async function cleanDynamicMistStreams(attempt) {
    const configured = typeof mist.listConfiguredStreams === 'function'
      ? await mist.listConfiguredStreams()
      : [];
    const dynamic = configured.filter((name) => name.startsWith('iptv-'));
    record(attempt, 'mist-cleanup-start', { configuredDynamic: dynamic.length });

    for (const channelId of dynamic) {
      record(attempt, 'mist-nuke', { channelId });
      await mist.nukeStream(channelId);
      await mist.deleteStream(channelId);
      const exit = await observeMistInputExit(channelId);
      record(attempt, exit.stopped ? 'mist-stopped' : 'mist-stop-stale', {
        channelId,
        waitMs: exit.waitMs,
        active: Boolean(exit.status?.active),
        inputs: Number(exit.status?.inputs || 0),
      });
    }

    activeCatalogChannel = null;
    return dynamic;
  }

  async function failAttempt(attempt, error, mistChannelId = null) {
    attempt.ok = false;
    attempt.error = error instanceof Error ? error.message : String(error);

    if (mistChannelId) {
      try { await mist.nukeStream(mistChannelId); } catch {}
      try { await mist.deleteStream(mistChannelId); } catch {}
      try {
        const exit = await observeMistInputExit(mistChannelId, 1_500);
        record(attempt, exit.stopped ? 'failed-cleanup-stopped' : 'failed-cleanup-stale', {
          channelId: mistChannelId,
          waitMs: exit.waitMs,
          active: Boolean(exit.status?.active),
          inputs: Number(exit.status?.inputs || 0),
        });
      } catch {}
    }

    activeCatalogChannel = null;
    attempt.finishedAt = new Date().toISOString();
    record(attempt, 'failed', { error: attempt.error });
  }

  async function switchCatalogChannel(streamId) {
    const entry = await catalogEntry(streamId);
    const mistChannelId = `iptv-${streamId}`;
    const attempt = beginAttempt(streamId, entry.name);

    try {
      await cleanDynamicMistStreams(attempt);

      record(attempt, 'provider-slot-wait');
      const slot = await catalogClient.waitForFreeSlot({ timeoutMs: 30_000, pollMs: 250 });
      record(attempt, 'provider-slot-free', {
        activeConnections: slot.activeConnections,
        maxConnections: slot.maxConnections,
      });

      const source = `${relay}/live/${encodeURIComponent(streamId)}.ts`;
      record(attempt, 'mist-add', { channelId: mistChannelId });
      await mist.addStream(mistChannelId, source, { always_on: true });
      activeCatalogChannel = { streamId, mistChannelId };

      const result = descriptor(mistChannelId, {
        streamId,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
      });

      record(attempt, 'hls-verify-start', { manifestUrl: result.manifestUrl });
      const verification = await playbackProbeFn({
        manifestUrl: result.manifestUrl,
        fetchFn,
      });
      attempt.verification = verification;
      attempt.ok = true;
      attempt.finishedAt = new Date().toISOString();
      record(attempt, 'verified', {
        segmentBytes: verification.segmentBytes,
        totalMs: verification.totalMs,
      });

      let relayStats = null;
      try {
        relayStats = await catalogClient.stats();
      } catch {}
      const streamRelayStats = relayStats?.streams?.[streamId] || null;

      return {
        ...result,
        verified: true,
        diagnostics: {
          attemptId: attempt.attemptId,
          segmentBytes: verification.segmentBytes,
          verificationMs: verification.totalMs,
          transportMode: streamRelayStats?.transportMode || null,
          playlistFetches: streamRelayStats?.playlistFetches ?? null,
          segmentFetches: streamRelayStats?.segmentFetches ?? null,
        },
      };
    } catch (error) {
      await failAttempt(attempt, error, mistChannelId);
      throw new Error(`Playback verification failed at ${attempt.phase}: ${attempt.error}`);
    }
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

    diagnostic(streamId) {
      return latestAttempts.get(String(streamId)) || null;
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
