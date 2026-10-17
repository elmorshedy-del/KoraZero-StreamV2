import { probeHlsPlayback } from './playback-probe.js';

function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

const CATALOG_STREAM_ID = /^\d+$/;

function abortError(message = 'Operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError();
}

export function createGatewayService({
  registry,
  mist,
  publicHlsBase,
  sourceSupervisor = null,
  catalogClient = null,
  relayBase = null,
  accounts = null,
  fetchFn = globalThis.fetch,
  playbackProbeFn = probeHlsPlayback,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!registry) throw new Error('gateway requires registry');
  if (!mist) throw new Error('gateway requires Mist API');
  const hlsBase = trimBase(publicHlsBase);
  const relay = trimBase(relayBase);
  if (!hlsBase) throw new Error('gateway requires publicHlsBase');

  const configuredAccounts = Array.isArray(accounts) && accounts.length
    ? accounts.map((account) => ({
      id: String(account.id || ''),
      relayBase: trimBase(account.relayBase),
      catalogClient: account.catalogClient,
    }))
    : null;
  const enhancedSlots = Boolean(configuredAccounts);
  const enabledAccountIds = new Set(configuredAccounts?.map((account) => account.id) || []);
  const slotState = new Map((configuredAccounts || []).map((account) => [
    account.id,
    {
      current: null,
      switchTail: Promise.resolve(),
      controller: null,
      generation: 0,
      mode: 'auto',
      manualUntil: null,
      reservedStreamId: null,
    },
  ]));
  let allocationTail = Promise.resolve();
  const inFlightByStream = new Map();

  // Legacy single-account state. This remains the only path when
  // V2_IPTV_ACCOUNTS_JSON is unset.
  let activeCatalogChannel = null;
  let switchTail = Promise.resolve();
  let activeSwitchController = null;
  let switchGeneration = 0;

  let attemptSequence = 0;
  const latestAttempts = new Map();

  function enabledAccounts() {
    return (configuredAccounts || []).filter((account) => enabledAccountIds.has(account.id));
  }

  function accountById(id) {
    return enabledAccounts().find((account) => account.id === id) || null;
  }

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

  function beginAttempt(streamId, name, slot = null) {
    const attempt = {
      attemptId: `${Date.now()}-${++attemptSequence}`,
      streamId,
      name,
      slot,
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

  async function catalogEntry(streamId, signal = null) {
    throwIfAborted(signal);
    if (!catalogClient || !relay || !CATALOG_STREAM_ID.test(streamId)) {
      throw new Error(`Unknown channel: ${streamId}`);
    }
    const catalog = await catalogClient.list({ signal });
    throwIfAborted(signal);
    const entry = catalog.channels.find((channel) => channel.streamId === streamId);
    if (!entry) throw new Error(`Unknown channel: ${streamId}`);
    return entry;
  }

  async function catalogEntryFor(account, streamId, signal = null) {
    throwIfAborted(signal);
    if (!account?.catalogClient || !account.relayBase || !CATALOG_STREAM_ID.test(streamId)) {
      throw new Error(`Unknown channel: ${streamId}`);
    }
    const catalog = await account.catalogClient.list({ signal });
    throwIfAborted(signal);
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

  async function activeDynamicState() {
    const configured = typeof mist.listConfiguredStreams === 'function'
      ? await mist.listConfiguredStreams()
      : [];
    const dynamic = configured.filter((name) => name.startsWith('iptv-'));
    const states = [];
    for (const channelId of dynamic) {
      const status = await mist.getStream(channelId);
      states.push({
        channelId,
        streamId: channelId.slice(5),
        active: Boolean(status.active),
        inputs: Number(status.inputs || 0),
        viewers: Number(status.viewers || 0),
        outputs: Number(status.outputs || 0),
        tracks: Number(status.tracks || 0),
        status: status.status || (status.active ? 'active' : 'inactive'),
        health: status.health ?? null,
        manifestUrl: `${hlsBase}/${encodeURIComponent(channelId)}/index.m3u8`,
      });
    }
    const live = states.filter((item) => item.active && item.inputs > 0);
    return {
      active: live.length === 1 ? live[0] : null,
      conflict: live.length > 1,
      live,
      configured: states,
    };
  }

  async function configuredDynamicSources() {
    if (typeof mist.listConfiguredStreamSources === 'function') {
      const values = await mist.listConfiguredStreamSources();
      return Object.fromEntries(
        Object.entries(values || {}).filter(([name]) => name.startsWith('iptv-')),
      );
    }
    const names = typeof mist.listConfiguredStreams === 'function'
      ? (await mist.listConfiguredStreams()).filter((name) => name.startsWith('iptv-'))
      : [];
    const result = {};
    for (const name of names) {
      result[name] = typeof mist.getStreamSource === 'function'
        ? await mist.getStreamSource(name)
        : null;
    }
    return result;
  }

  function ownerForSource(source) {
    const value = String(source || '');
    const matches = enabledAccounts().filter((account) => value.startsWith(`${account.relayBase}/live/`));
    return matches.length === 1 ? matches[0] : null;
  }

  async function activeMultiState() {
    const activeAccounts = enabledAccounts();
    const sources = await configuredDynamicSources();
    const states = [];

    for (const [channelId, source] of Object.entries(sources)) {
      const status = await mist.getStream(channelId);
      const owner = ownerForSource(source);
      states.push({
        channelId,
        streamId: channelId.slice(5),
        slot: owner?.id || null,
        active: Boolean(status.active),
        inputs: Number(status.inputs || 0),
        viewers: Number(status.viewers || 0),
        outputs: Number(status.outputs || 0),
        tracks: Number(status.tracks || 0),
        status: status.status || (status.active ? 'active' : 'inactive'),
        health: status.health ?? null,
        manifestUrl: `${hlsBase}/${encodeURIComponent(channelId)}/index.m3u8`,
      });
    }

    const live = states.filter((item) => item.active && item.inputs > 0);
    const liveBySlot = new Map(activeAccounts.map((account) => [account.id, []]));
    let conflict = live.length > activeAccounts.length;

    for (const item of live) {
      if (!item.slot || !liveBySlot.has(item.slot)) {
        conflict = true;
        continue;
      }
      liveBySlot.get(item.slot).push(item);
    }
    for (const items of liveBySlot.values()) {
      if (items.length > 1) conflict = true;
    }

    const slots = activeAccounts.map((account) => {
      const item = liveBySlot.get(account.id)?.[0] || null;
      const state = slotState.get(account.id);
      if (state) state.current = item ? { streamId: item.streamId, channelId: item.channelId } : null;
      return item
        ? {
          slot: account.id,
          channelId: item.channelId,
          streamId: item.streamId,
          inputs: item.inputs,
          viewers: item.viewers,
          outputs: item.outputs,
          tracks: item.tracks,
          status: item.status,
          health: item.health,
          mode: state?.mode || 'auto',
          manualUntil: state?.manualUntil || null,
        }
        : {
          slot: account.id,
          channelId: null,
          mode: state?.mode || 'auto',
          manualUntil: state?.manualUntil || null,
        };
    });

    return {
      capacity: activeAccounts.length,
      slots,
      active: live[0] || null,
      conflict,
      live,
      configured: states,
    };
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

  async function switchCatalogChannel(streamId, { signal = null, generation = 0 } = {}) {
    throwIfAborted(signal);
    const entry = await catalogEntry(streamId, signal);
    const mistChannelId = `iptv-${streamId}`;
    const existing = await activeDynamicState();
    if (!existing.conflict && existing.active?.channelId === mistChannelId) {
      activeCatalogChannel = { streamId, mistChannelId };
      return descriptor(mistChannelId, {
        streamId,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        verified: true,
        alreadyActive: true,
      });
    }
    const attempt = beginAttempt(streamId, entry.name);
    record(attempt, 'switch-generation', { generation });

    try {
      throwIfAborted(signal);
      await cleanDynamicMistStreams(attempt);
      throwIfAborted(signal);

      record(attempt, 'provider-slot-wait');
      const slot = await catalogClient.waitForFreeSlot({
        timeoutMs: 30_000,
        pollMs: 250,
        signal,
      });
      throwIfAborted(signal);
      record(attempt, 'provider-slot-free', {
        activeConnections: slot.activeConnections,
        maxConnections: slot.maxConnections,
      });

      const source = `${relay}/live/${encodeURIComponent(streamId)}.ts`;
      record(attempt, 'mist-add', { channelId: mistChannelId });
      await mist.addStream(mistChannelId, source, { always_on: true });
      activeCatalogChannel = { streamId, mistChannelId };
      throwIfAborted(signal);

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
        signal,
      });
      throwIfAborted(signal);
      attempt.verification = verification;
      attempt.ok = true;
      attempt.finishedAt = new Date().toISOString();
      record(attempt, 'verified', {
        segmentBytes: verification.segmentBytes,
        totalMs: verification.totalMs,
      });

      let relayStats = null;
      try {
        relayStats = await catalogClient.stats({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
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
      if (error?.name === 'AbortError' || signal?.aborted) {
        record(attempt, 'cancelled', {
          reason: error instanceof Error ? error.message : String(error),
          generation,
        });
        throw error?.name === 'AbortError' ? error : abortError('Channel switch cancelled');
      }
      throw new Error(`Playback verification failed at ${attempt.phase}: ${attempt.error}`);
    }
  }

  function queueCatalogSwitch(streamId, externalSignal = null) {
    const generation = ++switchGeneration;

    if (activeSwitchController && !activeSwitchController.signal.aborted) {
      activeSwitchController.abort(abortError('Superseded by newer channel selection'));
    }

    const controller = new AbortController();
    activeSwitchController = controller;

    const onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          externalSignal?.reason instanceof Error
            ? externalSignal.reason
            : abortError('Client closed playback request'),
        );
      }
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const execute = async () => {
      throwIfAborted(controller.signal);
      return switchCatalogChannel(streamId, {
        signal: controller.signal,
        generation,
      });
    };

    const run = switchTail.then(execute, execute);
    switchTail = run.catch(() => {});

    run.then(
      () => {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (activeSwitchController === controller) activeSwitchController = null;
      },
      () => {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (activeSwitchController === controller) activeSwitchController = null;
      },
    );

    return run;
  }

  function withAllocationLock(fn) {
    const run = allocationTail.then(fn, fn);
    allocationTail = run.catch(() => {});
    return run;
  }

  async function reserveMultiSlot(streamId, requestedSlot = null) {
    return withAllocationLock(async () => {
      const state = await activeMultiState();
      const already = state.live.find((item) => item.channelId === `iptv-${streamId}`);
      if (already) return { already };

      let slotId = requestedSlot ? String(requestedSlot) : null;
      if (slotId && !accountById(slotId)) {
        throw codedError('invalid_slot', `Unknown V2 slot: ${slotId}`);
      }

      if (!slotId) {
        const free = state.slots.find((item) =>
          !item.channelId && !slotState.get(item.slot)?.reservedStreamId
        );
        if (!free) throw codedError('all_slots_busy', 'All V2 slots are busy');
        slotId = free.slot;
      }

      const stateForSlot = slotState.get(slotId);
      if (!stateForSlot) throw codedError('invalid_slot', `Unknown V2 slot: ${slotId}`);
      stateForSlot.reservedStreamId = streamId;
      return { slotId };
    });
  }

  async function stopOwnedMultiSlot(slotId, attempt = null) {
    const state = await activeMultiState();
    const owned = state.live.filter((item) => item.slot === slotId);
    const channels = [];
    for (const item of owned) {
      channels.push(item.channelId);
      if (attempt) record(attempt, 'mist-nuke', { channelId: item.channelId, slot: slotId });
      try { await mist.nukeStream(item.channelId); } catch {}
      try { await mist.deleteStream(item.channelId); } catch {}
      try {
        const exit = await observeMistInputExit(item.channelId, 1_500);
        if (attempt) {
          record(attempt, exit.stopped ? 'mist-stopped' : 'mist-stop-stale', {
            channelId: item.channelId,
            slot: slotId,
            waitMs: exit.waitMs,
            active: Boolean(exit.status?.active),
            inputs: Number(exit.status?.inputs || 0),
          });
        }
      } catch {}
    }
    const stateForSlot = slotState.get(slotId);
    if (stateForSlot) stateForSlot.current = null;
    return channels;
  }

  async function cleanupFailedMultiStream(slotId, mistChannelId, attempt) {
    const account = accountById(slotId);
    if (!account || typeof mist.getStreamSource !== 'function') return;
    let source = null;
    try { source = await mist.getStreamSource(mistChannelId); } catch {}
    if (!String(source || '').startsWith(`${account.relayBase}/live/`)) return;
    try { await mist.nukeStream(mistChannelId); } catch {}
    try { await mist.deleteStream(mistChannelId); } catch {}
    try {
      const exit = await observeMistInputExit(mistChannelId, 1_500);
      record(attempt, exit.stopped ? 'failed-cleanup-stopped' : 'failed-cleanup-stale', {
        channelId: mistChannelId,
        slot: slotId,
        waitMs: exit.waitMs,
        active: Boolean(exit.status?.active),
        inputs: Number(exit.status?.inputs || 0),
      });
    } catch {}
  }

  async function switchMultiSlot(streamId, slotId, { signal = null, generation = 0 } = {}) {
    throwIfAborted(signal);
    const account = accountById(slotId);
    if (!account) throw codedError('invalid_slot', `Unknown V2 slot: ${slotId}`);
    const entry = await catalogEntryFor(account, streamId, signal);
    const mistChannelId = `iptv-${streamId}`;

    const existing = await activeMultiState();
    if (existing.conflict) throw codedError('v2_invariant_conflict', 'V2 slot ownership conflict');
    const already = existing.live.find((item) => item.channelId === mistChannelId);
    if (already) {
      return descriptor(mistChannelId, {
        streamId,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        verified: true,
        alreadyActive: true,
        slot: already.slot,
      });
    }

    const attempt = beginAttempt(streamId, entry.name, slotId);
    record(attempt, 'switch-generation', { generation, slot: slotId });

    try {
      throwIfAborted(signal);
      await stopOwnedMultiSlot(slotId, attempt);
      throwIfAborted(signal);

      record(attempt, 'provider-slot-wait', { slot: slotId });
      const providerSlot = await account.catalogClient.waitForFreeSlot({
        timeoutMs: 30_000,
        pollMs: 250,
        signal,
      });
      throwIfAborted(signal);
      record(attempt, 'provider-slot-free', {
        slot: slotId,
        activeConnections: providerSlot.activeConnections,
        maxConnections: providerSlot.maxConnections,
      });

      const source = `${account.relayBase}/live/${encodeURIComponent(streamId)}.ts`;
      record(attempt, 'mist-add', { channelId: mistChannelId, slot: slotId });
      await mist.addStream(mistChannelId, source, { always_on: true });
      const stateForSlot = slotState.get(slotId);
      if (stateForSlot) stateForSlot.current = { streamId, channelId: mistChannelId };
      throwIfAborted(signal);

      const result = descriptor(mistChannelId, {
        streamId,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        slot: slotId,
      });

      record(attempt, 'hls-verify-start', { manifestUrl: result.manifestUrl, slot: slotId });
      const verification = await playbackProbeFn({
        manifestUrl: result.manifestUrl,
        fetchFn,
        signal,
      });
      throwIfAborted(signal);
      attempt.verification = verification;
      attempt.ok = true;
      attempt.finishedAt = new Date().toISOString();
      record(attempt, 'verified', {
        slot: slotId,
        segmentBytes: verification.segmentBytes,
        totalMs: verification.totalMs,
      });

      let relayStats = null;
      try {
        relayStats = await account.catalogClient.stats({ signal });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
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
      attempt.ok = false;
      attempt.error = error instanceof Error ? error.message : String(error);
      await cleanupFailedMultiStream(slotId, mistChannelId, attempt);
      attempt.finishedAt = new Date().toISOString();
      record(attempt, 'failed', { error: attempt.error, slot: slotId });
      if (error?.name === 'AbortError' || signal?.aborted) {
        record(attempt, 'cancelled', {
          reason: attempt.error,
          generation,
          slot: slotId,
        });
        throw error?.name === 'AbortError' ? error : abortError('Channel switch cancelled');
      }
      if (error?.code) throw error;
      throw new Error(`Playback verification failed at ${attempt.phase}: ${attempt.error}`);
    }
  }

  function queueMultiSwitch(streamId, {
    slot = null,
    externalSignal = null,
    manual = false,
    manualUntil = null,
  } = {}) {
    const key = String(streamId);
    const existingPromise = inFlightByStream.get(key);
    if (existingPromise) return existingPromise;

    const request = (async () => {
      const reservation = await reserveMultiSlot(key, slot);
      if (reservation.already) {
        const stateForSlot = slotState.get(reservation.already.slot);
        if (manual && stateForSlot) {
          stateForSlot.mode = 'manual';
          stateForSlot.manualUntil = manualUntil || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
        }
        return descriptor(reservation.already.channelId, {
          streamId: key,
          verified: true,
          alreadyActive: true,
          slot: reservation.already.slot,
        });
      }

      const slotId = reservation.slotId;
      const stateForSlot = slotState.get(slotId);
      if (!stateForSlot) throw codedError('invalid_slot', `Unknown V2 slot: ${slotId}`);
      if (manual) {
        stateForSlot.mode = 'manual';
        stateForSlot.manualUntil = manualUntil || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      }

      const generation = ++stateForSlot.generation;
      if (stateForSlot.controller && !stateForSlot.controller.signal.aborted) {
        stateForSlot.controller.abort(abortError('Superseded by newer channel selection'));
      }

      const controller = new AbortController();
      stateForSlot.controller = controller;
      const onExternalAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(
            externalSignal?.reason instanceof Error
              ? externalSignal.reason
              : abortError('Client closed playback request'),
          );
        }
      };
      if (externalSignal) {
        if (externalSignal.aborted) onExternalAbort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      const execute = async () => {
        throwIfAborted(controller.signal);
        return switchMultiSlot(key, slotId, {
          signal: controller.signal,
          generation,
        });
      };

      const run = stateForSlot.switchTail.then(execute, execute);
      stateForSlot.switchTail = run.catch(() => {});

      try {
        return await run;
      } finally {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (stateForSlot.controller === controller) stateForSlot.controller = null;
        if (stateForSlot.reservedStreamId === key) stateForSlot.reservedStreamId = null;
      }
    })();

    inFlightByStream.set(key, request);
    request.finally(() => {
      if (inFlightByStream.get(key) === request) inFlightByStream.delete(key);
    }).catch(() => {});
    return request;
  }

  async function stopMulti({ slot = null, manual = false, manualUntil = null } = {}) {
    const activeAccounts = enabledAccounts();
    let slotId = slot ? String(slot) : null;
    if (!slotId) {
      if (activeAccounts.length === 1) slotId = activeAccounts[0].id;
      else throw codedError('slot_required', 'slot is required when multiple V2 accounts are configured');
    }

    if (slotId === 'all') {
      const sources = await configuredDynamicSources();
      const channels = Object.keys(sources);
      for (const channelId of channels) {
        try { await mist.nukeStream(channelId); } catch {}
        try { await mist.deleteStream(channelId); } catch {}
        try { await observeMistInputExit(channelId, 1_500); } catch {}
      }
      for (const account of activeAccounts) {
        const state = slotState.get(account.id);
        if (!state) continue;
        state.current = null;
        state.reservedStreamId = null;
        if (manual) {
          state.mode = 'manual';
          state.manualUntil = manualUntil || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
        }
      }
      return { stopped: true, slot: 'all', channels };
    }

    if (!accountById(slotId)) throw codedError('invalid_slot', `Unknown V2 slot: ${slotId}`);
    const state = slotState.get(slotId);
    if (manual && state) {
      state.mode = 'manual';
      state.manualUntil = manualUntil || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    }
    const channels = await stopOwnedMultiSlot(slotId);
    return { stopped: true, slot: slotId, channels };
  }

  return Object.freeze({
    async catalog(accountId = null) {
      if (enhancedSlots) {
        const account = accountId ? accountById(String(accountId)) : enabledAccounts()[0];
        if (!account) throw codedError('invalid_account', 'Unknown V2 account');
        return account.catalogClient.list();
      }
      if (!catalogClient) throw new Error('IPTV catalog is unavailable');
      return catalogClient.list();
    },

    diagnostic(streamId) {
      return latestAttempts.get(String(streamId)) || null;
    },

    async active() {
      if (enhancedSlots) {
        const state = await activeMultiState();
        return {
          capacity: state.capacity,
          slots: state.slots,
          active: state.active,
          conflict: state.conflict,
          live: state.live,
        };
      }
      const state = await activeDynamicState();
      return {
        active: state.active,
        conflict: state.conflict,
        live: state.live,
      };
    },

    async stopDynamic(options = {}) {
      if (enhancedSlots) return stopMulti(options);
      const configured = typeof mist.listConfiguredStreams === 'function'
        ? await mist.listConfiguredStreams()
        : [];
      const dynamic = configured.filter((name) => name.startsWith('iptv-'));
      for (const channelId of dynamic) {
        try { await mist.nukeStream(channelId); } catch {}
        try { await mist.deleteStream(channelId); } catch {}
        try { await observeMistInputExit(channelId, 1_500); } catch {}
      }
      activeCatalogChannel = null;
      return { stopped: true, channels: dynamic };
    },

    async playback(channelId, { signal = null } = {}) {
      if (registry.has(channelId)) return staticPlayback(channelId);
      if (CATALOG_STREAM_ID.test(channelId)) {
        return enhancedSlots
          ? queueMultiSwitch(channelId, { externalSignal: signal })
          : queueCatalogSwitch(channelId, signal);
      }
      throw new Error(`Unknown channel: ${channelId}`);
    },

    async activate(channelId, options = {}) {
      if (!registry.has(channelId) && CATALOG_STREAM_ID.test(channelId)) {
        return enhancedSlots
          ? queueMultiSwitch(channelId, {
            slot: options.slot || null,
            externalSignal: options.signal || null,
            manual: Boolean(options.manual),
            manualUntil: options.manualUntil || null,
          })
          : queueCatalogSwitch(channelId, options.signal || null);
      }
      const entry = staticChannel(channelId);
      await mist.addStream(channelId, entry.source, { always_on: true });
      sourceSupervisor?.arm(channelId);
      return staticPlayback(channelId);
    },

    async resumeAuto(slot) {
      if (!enhancedSlots) return { slot: 'a', mode: 'auto', manualUntil: null };
      const state = slotState.get(String(slot || ''));
      if (!state || !accountById(String(slot || ''))) throw codedError('invalid_slot', 'Unknown V2 slot');
      state.mode = 'auto';
      state.manualUntil = null;
      return { slot: String(slot), mode: state.mode, manualUntil: state.manualUntil };
    },

    setManualUntil(slot, manualUntil) {
      if (!enhancedSlots) return { slot: 'a', mode: 'manual', manualUntil };
      const slotId = String(slot || '');
      const state = slotState.get(slotId);
      if (!state || !accountById(slotId)) throw codedError('invalid_slot', 'Unknown V2 slot');
      const parsed = Date.parse(manualUntil || '');
      if (!Number.isFinite(parsed)) throw codedError('invalid_manual_until', 'manualUntil must be a valid timestamp');
      state.mode = 'manual';
      state.manualUntil = new Date(parsed).toISOString();
      return { slot: slotId, mode: state.mode, manualUntil: state.manualUntil };
    },

    setEnabledAccounts(ids) {
      if (!enhancedSlots) return;
      const requested = Array.isArray(ids) ? ids.map(String) : [];
      const valid = new Set(configuredAccounts.map((account) => account.id));
      if (!requested.length || requested.some((id) => !valid.has(id))) {
        throw codedError('invalid_account', 'Enabled V2 accounts must be configured accounts');
      }
      enabledAccountIds.clear();
      for (const id of requested) enabledAccountIds.add(id);
    },

    configuredAccounts() {
      return enhancedSlots
        ? configuredAccounts.map((account) => ({ id: account.id, relayBase: account.relayBase, catalogClient: account.catalogClient }))
        : [];
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
