export function createSourceSupervisor({
  registry,
  mist,
  unhealthyThreshold = 2,
  baseBackoffMs = 2000,
  maxBackoffMs = 8000,
  nowFn = Date.now,
  intervalMs = 1000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  onError = () => {},
  onEvent = () => {},
}) {
  if (!registry) throw new Error('source supervisor requires registry');
  if (!mist) throw new Error('source supervisor requires Mist API');
  if (!Number.isInteger(unhealthyThreshold) || unhealthyThreshold < 1) {
    throw new Error('unhealthyThreshold must be a positive integer');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error('intervalMs must be >= 1');
  }

  const states = new Map();
  const armed = new Set();
  let timer = null;
  let tickRunning = false;

  function stateFor(channelId) {
    if (!states.has(channelId)) {
      states.set(channelId, {
        channelId,
        healthy: false,
        consecutiveUnhealthy: 0,
        recoveryAttempts: 0,
        nextRecoveryAt: 0,
        lastMediaMs: null,
      });
    }
    return states.get(channelId);
  }

  function snapshot(state) {
    return { ...state };
  }

  async function check(channelId) {
    const entry = registry.get(channelId);
    if (!entry) throw new Error(`Unknown channel: ${channelId}`);

    const state = stateFor(channelId);
    const status = await mist.getStream(channelId);
    const inputPresent = Number(status?.inputs ?? 0) > 0;
    const rawMediaMs = status?.lastms;
    const parsedMediaMs = rawMediaMs === null || rawMediaMs === undefined || rawMediaMs === ''
      ? null
      : Number(rawMediaMs);
    const hasMediaClock = Number.isFinite(parsedMediaMs);
    const mediaProgressing = !hasMediaClock
      || state.lastMediaMs === null
      || parsedMediaMs > state.lastMediaMs;
    const healthy = inputPresent && mediaProgressing;

    if (hasMediaClock) state.lastMediaMs = parsedMediaMs;

    if (healthy) {
      state.healthy = true;
      state.consecutiveUnhealthy = 0;
      state.recoveryAttempts = 0;
      state.nextRecoveryAt = 0;
      return snapshot(state);
    }

    state.healthy = false;
    state.consecutiveUnhealthy += 1;

    const now = Number(nowFn());
    const thresholdReached = state.consecutiveUnhealthy >= unhealthyThreshold;
    const backoffElapsed = now >= state.nextRecoveryAt;

    if (thresholdReached && backoffElapsed) {
      const recoveryStartedAt = Number(nowFn());
      onEvent({ type: 'recovery-start', channelId, atMs: recoveryStartedAt });

      await mist.nukeStream(channelId);
      const nukeCompletedAt = Number(nowFn());
      onEvent({
        type: 'nuke-complete',
        channelId,
        atMs: nukeCompletedAt,
        durationMs: nukeCompletedAt - recoveryStartedAt,
      });

      await mist.addStream(channelId, entry.source, { always_on: true });
      const rearmCompletedAt = Number(nowFn());
      onEvent({
        type: 'rearm-complete',
        channelId,
        atMs: rearmCompletedAt,
        durationMs: rearmCompletedAt - nukeCompletedAt,
        recoveryMs: rearmCompletedAt - recoveryStartedAt,
      });
      state.recoveryAttempts += 1;
      const delay = Math.min(
        maxBackoffMs,
        baseBackoffMs * (2 ** Math.max(0, state.recoveryAttempts - 1)),
      );
      state.nextRecoveryAt = now + delay;
      state.consecutiveUnhealthy = 0;
      state.lastMediaMs = null;
    }

    return snapshot(state);
  }

  function arm(channelId) {
    if (!registry.get(channelId)) throw new Error(`Unknown channel: ${channelId}`);
    armed.add(channelId);
  }

  function disarm(channelId) {
    armed.delete(channelId);
    states.delete(channelId);
  }

  function armedChannels() {
    return [...armed];
  }

  async function checkArmed() {
    if (tickRunning) return;
    tickRunning = true;
    try {
      for (const channelId of [...armed]) {
        await check(channelId);
      }
    } finally {
      tickRunning = false;
    }
  }

  function start() {
    if (timer !== null) return;
    timer = setIntervalFn(async () => {
      try {
        await checkArmed();
      } catch (error) {
        onError(error);
      }
    }, intervalMs);
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return Object.freeze({
    check,
    checkArmed,
    arm,
    disarm,
    armedChannels,
    start,
    stop,
  });
}
