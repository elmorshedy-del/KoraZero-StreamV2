function asMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const slot = String(entry.slot || '');
  const streamId = String(entry.streamId || '');
  const channelId = String(entry.channelId || '');
  const startMs = asMs(entry.startAt);
  const endMs = asMs(entry.endAt);
  if (!slot || !/^\d+$/.test(streamId) || channelId !== `iptv-${streamId}`) return null;
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    ...entry,
    slot,
    streamId,
    channelId,
    startMs,
    endMs,
    kickoffMs: startMs + (15 * 60 * 1000),
  };
}

function normalizeSchedule(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) {
    throw new Error('Invalid V2 slot schedule');
  }
  return value.entries.map(normalizeEntry).filter(Boolean);
}

function matchesArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.matches)) return value.matches;
  return [];
}

export function createSlotScheduler({
  gateway,
  scheduleUrl,
  todayUrl = 'https://korazero.com/assets/data/today.json',
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  intervalMs = 60_000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  log = () => {},
} = {}) {
  if (!gateway) throw new Error('slot scheduler requires gateway');
  if (!scheduleUrl) throw new Error('slot scheduler requires scheduleUrl');
  if (typeof fetchFn !== 'function') throw new Error('slot scheduler requires fetch');
  if (typeof nowFn !== 'function') throw new Error('slot scheduler requires nowFn');

  let timer = null;
  let tickTail = Promise.resolve();
  const ownedBySlot = new Map();

  async function fetchJson(url) {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response?.ok) throw new Error(`V2 scheduler fetch failed with HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async function todayStatuses() {
    try {
      const value = await fetchJson(todayUrl);
      return new Map(matchesArray(value).map((match) => [String(match?.id || ''), String(match?.status || '').toLowerCase()]));
    } catch {
      return null;
    }
  }

  function activeEntry(entries, slot, now) {
    return entries
      .filter((entry) => entry.slot === slot && entry.startMs <= now && now < entry.endMs)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || String(a.matchId).localeCompare(String(b.matchId)))[0] || null;
  }

  function nextEntry(entries, slot, now) {
    return entries
      .filter((entry) => entry.slot === slot && entry.startMs > now)
      .sort((a, b) => a.startMs - b.startMs || String(a.matchId).localeCompare(String(b.matchId)))[0] || null;
  }

  async function reconcileManualHold(slotState, entries, now) {
    if (slotState.mode !== 'manual') return false;
    const manualUntil = asMs(slotState.manualUntil);
    const covering = activeEntry(entries, slotState.slot, now);
    if (covering && typeof gateway.setManualUntil === 'function' && manualUntil !== covering.endMs) {
      gateway.setManualUntil(slotState.slot, new Date(covering.endMs).toISOString());
      slotState.manualUntil = new Date(covering.endMs).toISOString();
    }
    const effectiveUntil = asMs(slotState.manualUntil);
    if (effectiveUntil !== null && effectiveUntil > now) return true;
    if (typeof gateway.resumeAuto === 'function') await gateway.resumeAuto(slotState.slot);
    slotState.mode = 'auto';
    slotState.manualUntil = null;
    return false;
  }

  async function shouldDelayHandover(previous, next, now) {
    if (!previous || !next || now >= next.kickoffMs) return false;
    const statuses = await todayStatuses();
    if (!statuses) return true;
    return statuses.get(String(previous.matchId || '')) === 'live';
  }

  async function runTick() {
    let schedule;
    try {
      schedule = normalizeSchedule(await fetchJson(scheduleUrl));
    } catch (error) {
      log({ event: 'v2-scheduler-schedule-unavailable', error: error?.message || String(error) });
      return { ok: false, changed: false, reason: 'schedule-unavailable' };
    }

    const now = Number(nowFn());
    if (!Number.isFinite(now)) throw new Error('slot scheduler nowFn must return epoch milliseconds');

    const state = await gateway.active();
    if (state?.conflict) {
      log({ event: 'v2-scheduler-conflict' });
      return { ok: false, changed: false, reason: 'gateway-conflict' };
    }

    const slots = Array.isArray(state?.slots) && state.slots.length
      ? state.slots.map((slot) => ({ ...slot }))
      : [{ slot: 'a', channelId: state?.active?.channelId || null, streamId: state?.active?.streamId || null, mode: 'auto', manualUntil: null }];

    let changed = false;

    for (const slotState of slots) {
      const slotId = String(slotState.slot || '');
      if (!slotId) continue;
      const slotEntries = schedule.filter((entry) => entry.slot === slotId);
      if (!slotEntries.length && !ownedBySlot.has(slotId)) continue;

      if (await reconcileManualHold(slotState, slotEntries, now)) continue;

      let owned = ownedBySlot.get(slotId) || null;
      const current = activeEntry(slotEntries, slotId, now);
      const upcoming = nextEntry(slotEntries, slotId, now);

      if (!owned && current && slotState.channelId === current.channelId) {
        owned = current;
        ownedBySlot.set(slotId, current);
      }

      if (owned && now < owned.endMs) {
        // A started entry is frozen until its original endAt. If a regenerated
        // schedule drops or outranks it, keep serving it rather than preempting
        // a live match.
        continue;
      }

      if (owned && now >= owned.endMs) {
        if (current && current.matchId !== owned.matchId) {
          const delay = await shouldDelayHandover(owned, current, now);
          if (!delay) {
            await gateway.activate(current.streamId, { slot: slotId });
            ownedBySlot.set(slotId, current);
            changed = true;
            continue;
          }
          continue;
        }

        if (!current) {
          if (upcoming && upcoming.startMs <= now) continue;
          const liveChannel = slotState.channelId;
          if (!liveChannel || liveChannel === owned.channelId) {
            await gateway.stopDynamic({ slot: slotId });
            ownedBySlot.delete(slotId);
            changed = true;
          }
          continue;
        }
      }

      if (current && (!owned || owned.matchId !== current.matchId)) {
        if (slotState.channelId === current.channelId) {
          ownedBySlot.set(slotId, current);
          continue;
        }
        await gateway.activate(current.streamId, { slot: slotId });
        ownedBySlot.set(slotId, current);
        changed = true;
      }
    }

    return { ok: true, changed };
  }

  function tick() {
    const run = tickTail.then(runTick, runTick);
    tickTail = run.catch(() => {});
    return run;
  }

  function start() {
    if (timer) return false;
    timer = setIntervalFn(() => {
      tick().catch((error) => log({ event: 'v2-scheduler-error', error: error?.message || String(error) }));
    }, intervalMs);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return Object.freeze({
    tick,
    start,
    stop,
    running: () => Boolean(timer),
    owned: () => new Map(ownedBySlot),
  });
}
