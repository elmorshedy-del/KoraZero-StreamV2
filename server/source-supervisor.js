export function createSourceSupervisor({
  registry,
  mist,
  unhealthyThreshold = 2,
  nativeRecoveryGraceMs = 5000,
  postRearmGraceMs = 8000,
  baseBackoffMs = 2000,
  maxBackoffMs = 8000,
  nowFn = Date.now,
  intervalMs = 1000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  inputExitPollMs = 100,
  inputExitTimeoutMs = 7000,
  onError = () => {},
  onEvent = () => {},
}) {
  if (!registry) throw new Error('source supervisor requires registry');
  if (!mist) throw new Error('source supervisor requires Mist API');
  if (!Number.isInteger(unhealthyThreshold) || unhealthyThreshold < 1) {
    throw new Error('unhealthyThreshold must be a positive integer');
  }
  if (!Number.isFinite(nativeRecoveryGraceMs) || nativeRecoveryGraceMs < 0) {
    throw new Error('nativeRecoveryGraceMs must be >= 0');
  }
  if (!Number.isFinite(postRearmGraceMs) || postRearmGraceMs < 0) {
    throw new Error('postRearmGraceMs must be >= 0');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error('intervalMs must be >= 1');
  }
  if (!Number.isFinite(inputExitPollMs) || inputExitPollMs < 1) {
    throw new Error('inputExitPollMs must be >= 1');
  }
  if (!Number.isFinite(inputExitTimeoutMs) || inputExitTimeoutMs < 1) {
    throw new Error('inputExitTimeoutMs must be >= 1');
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
        unhealthySince: null,
        recoveryAttempts: 0,
        nextRecoveryAt: 0,
        recoveryGraceUntil: 0,
        lastMediaMs: null,
      });
    }
    return states.get(channelId);
  }

  function snapshot(state) {
    return { ...state };
  }

  async function waitForInputExit(channelId) {
    const deadline = Number(nowFn()) + inputExitTimeoutMs;
    while (true) {
      const status = await mist.getStream(channelId);
      if (Number(status?.inputs ?? 0) === 0) return;

      const now = Number(nowFn());
      if (now >= deadline) {
        throw new Error(`Mist input did not exit after nuke for ${channelId}`);
      }
      await sleepFn(Math.min(inputExitPollMs, Math.max(1, deadline - now)));
    }
  }

  function clearFailureState(state) {
    state.healthy = true;
    state.consecutiveUnhealthy = 0;
    state.unhealthySince = null;
    state.recoveryAttempts = 0;
    state.nextRecoveryAt = 0;
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
    const previousMediaMs = state.lastMediaMs;
    const mediaProgressing = !hasMediaClock
      || previousMediaMs === null
      || parsedMediaMs > previousMediaMs;
    const provedMediaProgress = hasMediaClock
      && previousMediaMs !== null
      && parsedMediaMs > previousMediaMs;

    if (hasMediaClock) state.lastMediaMs = parsedMediaMs;

    const now = Number(nowFn());

    // A newly re-armed Mist input needs time to establish a fresh media clock.
    // Do not let the fallback supervisor fight that startup.
    if (state.recoveryGraceUntil > now) {
      if (inputPresent && (provedMediaProgress || !hasMediaClock)) {
        state.recoveryGraceUntil = 0;
        clearFailureState(state);
      } else {
        state.healthy = inputPresent;
        state.consecutiveUnhealthy = 0;
        state.unhealthySince = null;
      }
      return snapshot(state);
    }

    const healthy = inputPresent && mediaProgressing;
    if (healthy) {
      state.recoveryGraceUntil = 0;
      clearFailureState(state);
      return snapshot(state);
    }

    state.healthy = false;
    state.consecutiveUnhealthy += 1;
    if (state.unhealthySince === null) state.unhealthySince = now;

    const thresholdReached = state.consecutiveUnhealthy >= unhealthyThreshold;
    const nativeGraceElapsed = now - state.unhealthySince >= nativeRecoveryGraceMs;
    const backoffElapsed = now >= state.nextRecoveryAt;

    if (thresholdReached && nativeGraceElapsed && backoffElapsed) {
      const recoveryStartedAt = Number(nowFn());
      onEvent({ type: 'recovery-start', channelId, atMs: recoveryStartedAt });

      // Mist's nuke_stream starts MistUtilNuke asynchronously. MistUtilNuke itself
      // allows up to five seconds for clean shutdown before force cleanup.
      await mist.nukeStream(channelId);
      const nukeCompletedAt = Number(nowFn());
      onEvent({
        type: 'nuke-complete',
        channelId,
        atMs: nukeCompletedAt,
        durationMs: nukeCompletedAt - recoveryStartedAt,
      });

      if (inputPresent) await waitForInputExit(channelId);
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
      state.nextRecoveryAt = rearmCompletedAt + delay;
      state.recoveryGraceUntil = rearmCompletedAt + postRearmGraceMs;
      state.consecutiveUnhealthy = 0;
      state.unhealthySince = null;
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
