const CHANNEL_RE = /^iptv-(\d+)$/;

function parseTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeSchedule(value, configuredSlots) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return null;
  const slots = new Set(configuredSlots);
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const slot = String(entry.slot || '');
    const channelId = String(entry.channelId || '').toLowerCase();
    const streamMatch = CHANNEL_RE.exec(channelId);
    const startMs = parseTime(entry.startAt);
    const endMs = parseTime(entry.endAt);
    if (!slots.has(slot) || !streamMatch || startMs === null || endMs === null || endMs <= startMs) return null;
    const streamId = String(entry.streamId || streamMatch[1]);
    if (streamId !== streamMatch[1]) return null;
    return {
      ...entry,
      slot,
      channelId,
      streamId,
      matchId: String(entry.matchId || ''),
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      startMs,
      endMs,
      kickoffMs: startMs + 15 * 60 * 1000,
    };
  }).filter(Boolean);
  return { ...value, entries };
}

function statusRows(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['matches', 'fixtures', 'games', 'today']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function rowMatchId(row) {
  return String(row?.matchId ?? row?.id ?? row?.uid ?? '');
}

function rowIsLive(row) {
  const value = String(row?.status?.type?.state ?? row?.status?.state ?? row?.status ?? '').toLowerCase();
  return value === 'live' || value === 'in' || value === 'in_progress' || value === 'in progress';
}

export function createSlotScheduler({
  gateway,
  fetchFn = globalThis.fetch,
  scheduleUrl = 'https://korazero.com/assets/data/v2-slot-schedule.json',
  todayUrl = 'https://korazero.com/assets/data/today.json',
  nowFn = Date.now,
  intervalMs = 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = () => {},
} = {}) {
  if (!gateway) throw new Error('slot scheduler requires gateway');
  if (typeof fetchFn !== 'function') throw new Error('slot scheduler requires fetch');

  let latestSchedule = null;
  let timer = null;
  let runningTick = null;

  async function fetchJson(url) {
    const response = await fetchFn(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response?.ok) throw new Error(`schedule fetch failed with HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  function configuredSlotsFrom(state) {
    return Array.isArray(state?.slots)
      ? state.slots.map((slot) => String(slot.slot || '')).filter(Boolean)
      : [];
  }

  function coveringEntry(slot, nowMs, schedule = latestSchedule) {
    return schedule?.entries
      ?.filter((entry) => entry.slot === slot && entry.startMs <= nowMs && nowMs < entry.endMs)
      .sort((a, b) => a.startMs - b.startMs || a.matchId.localeCompare(b.matchId))[0] || null;
  }

  function manualUntilFor(slot, nowMs = nowFn()) {
    const current = coveringEntry(String(slot), nowMs);
    return current
      ? current.endAt
      : new Date(nowMs + 3 * 60 * 60 * 1000).toISOString();
  }

  gateway.setManualUntilResolver?.(manualUntilFor);

  async function previousMatchStillLive(entry, nowMs) {
    if (!entry || nowMs >= entry.endMs) return false;
    try {
      const today = await fetchJson(todayUrl);
      const row = statusRows(today).find((item) => rowMatchId(item) === entry.matchId);
      return row ? rowIsLive(row) : true;
    } catch {
      return true;
    }
  }

  async function tick() {
    if (runningTick) return runningTick;
    runningTick = (async () => {
      let state;
      let rawSchedule;
      try {
        state = await gateway.active();
        const configuredSlots = configuredSlotsFrom(state);
        if (!configuredSlots.length) return { changed: false, reason: 'no_slots' };
        rawSchedule = await fetchJson(scheduleUrl);
        const nextSchedule = normalizeSchedule(rawSchedule, configuredSlots);
        if (!nextSchedule) return { changed: false, reason: 'invalid_schedule' };

        const nowMs = nowFn();
        const slotStates = new Map((state.slots || []).map((slot) => [String(slot.slot), slot]));
        const actions = [];

        for (const slot of configuredSlots) {
          let slotState = slotStates.get(slot) || { slot, channelId: null, mode: 'auto', manualUntil: null };

          if (slotState.mode === 'manual') {
            const untilMs = parseTime(slotState.manualUntil);
            if (untilMs !== null && untilMs <= nowMs) {
              await gateway.resumeAuto(slot);
              actions.push({ action: 'resume-auto', slot });
              slotState = { ...slotState, mode: 'auto', manualUntil: null };
            } else {
              continue;
            }
          }

          const oldOwned = latestSchedule?.entries?.find((entry) =>
            entry.slot === slot
            && entry.channelId === slotState.channelId
            && entry.startMs <= nowMs
            && nowMs < entry.endMs
          ) || null;

          const desired = coveringEntry(slot, nowMs, nextSchedule);

          // A newly fetched schedule is never allowed to cut a match that already
          // started under the previous valid schedule.
          if (oldOwned && (!desired || desired.matchId !== oldOwned.matchId)) {
            continue;
          }

          if (desired) {
            if (slotState.channelId === desired.channelId) continue;

            if (slotState.channelId) {
              const previous = latestSchedule?.entries?.find((entry) =>
                entry.slot === slot && entry.channelId === slotState.channelId
              ) || null;
              if (previous && nowMs < desired.kickoffMs) {
                const live = await previousMatchStillLive(previous, nowMs);
                if (live) continue;
              }
            }

            await gateway.activate(desired.streamId, { slot });
            actions.push({ action: 'activate', slot, matchId: desired.matchId, streamId: desired.streamId });
            continue;
          }

          const endedOwned = latestSchedule?.entries?.find((entry) =>
            entry.slot === slot
            && entry.channelId === slotState.channelId
            && nowMs >= entry.endMs
          ) || null;
          if (slotState.channelId && endedOwned) {
            await gateway.stopDynamic({ slot });
            actions.push({ action: 'stop', slot, matchId: endedOwned.matchId });
          }
        }

        latestSchedule = nextSchedule;
        return { changed: actions.length > 0, actions };
      } catch (error) {
        log({ event: 'slot-scheduler-error', error: error instanceof Error ? error.message : String(error) });
        return { changed: false, reason: 'fetch_or_runtime_error' };
      }
    })().finally(() => {
      runningTick = null;
    });
    return runningTick;
  }

  function start() {
    if (timer) return false;
    timer = setIntervalFn(() => { tick().catch(() => {}); }, intervalMs);
    tick().catch(() => {});
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
    manualUntilFor,
    get running() { return Boolean(timer); },
  });
}
