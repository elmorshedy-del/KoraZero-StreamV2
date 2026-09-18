const HLS_MIME = 'application/vnd.apple.mpegurl';
const RECOVERY_BASE_MS = 1000;
const RECOVERY_FACTOR = 2;
const RECOVERY_MAX_MS = 10000;
const RECOVERY_MAX_ATTEMPTS = 4;
const RECOVERY_JITTER = 0.2;

export function createPlayerController({ video, hlsFactory, clock = globalThis, random = Math.random }) {
  if (!video) throw new TypeError('video is required');

  let engine = null;
  let generation = 0;
  let descriptor = null;
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  let destroyed = false;
  const listeners = new Set();
  let state = {
    status: 'IDLE',
    engine: null,
    channelId: null,
    generation,
    error: null,
  };

  const onPlaying = () => {
    recoveryAttempts = 0;
    setState({ status: 'PLAYING', error: null });
  };
  const onWaiting = () => setState({ status: 'BUFFERING' });
  const onNativeError = () => scheduleRecovery(new Error('Native HLS media error'));

  video.addEventListener?.('playing', onPlaying);
  video.addEventListener?.('waiting', onWaiting);
  video.addEventListener?.('error', onNativeError);

  function setState(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  }

  function cancelRecovery() {
    if (recoveryTimer !== null) {
      clock.clearTimeout?.(recoveryTimer);
      recoveryTimer = null;
    }
  }

  function teardownEngine() {
    if (engine?.kind === 'hls.js') {
      if (engine.errorEvent && engine.errorHandler) {
        engine.instance.off?.(engine.errorEvent, engine.errorHandler);
      }
      engine.instance.destroy();
    }
    if (engine?.kind === 'native-hls') {
      video.pause?.();
      video.removeAttribute?.('src');
      video.load?.();
    }
    engine = null;
  }

  function startEngine(activeDescriptor, expectedGeneration) {
    if (destroyed || expectedGeneration !== generation) return;

    teardownEngine();
    setState({
      status: 'LOADING',
      engine: null,
      channelId: activeDescriptor.channelId,
      generation,
      error: null,
    });

    if (video.canPlayType?.(HLS_MIME)) {
      video.src = activeDescriptor.manifestUrl;
      engine = { kind: 'native-hls' };
      setState({ engine: 'native-hls' });
      video.load?.();
      return;
    }

    if (hlsFactory?.isSupported?.()) {
      const instance = hlsFactory();
      const errorEvent = hlsFactory.events?.ERROR ?? 'error';
      const errorHandler = (_event, data = {}) => {
        if (!data.fatal) return;
        scheduleRecovery(new Error(`Fatal hls.js error: ${data.type ?? data.details ?? 'unknown'}`));
      };
      engine = { kind: 'hls.js', instance, errorEvent, errorHandler };
      setState({ engine: 'hls.js' });
      instance.on?.(errorEvent, errorHandler);
      instance.attachMedia(video);
      instance.loadSource(activeDescriptor.manifestUrl);
      return;
    }

    setState({ status: 'ERROR', error: new Error('HLS playback is not supported in this browser') });
  }

  function computeDelay(attempt) {
    const raw = Math.min(RECOVERY_MAX_MS, RECOVERY_BASE_MS * (RECOVERY_FACTOR ** attempt));
    const jitterFactor = 1 + ((random() * 2) - 1) * RECOVERY_JITTER;
    return Math.round(raw * jitterFactor);
  }

  function scheduleRecovery(reason) {
    if (destroyed || !descriptor || recoveryTimer !== null) return;
    if (recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
      setState({ status: 'ERROR', error: new Error(`Player recovery attempts exhausted: ${reason.message}`) });
      return;
    }

    const expectedGeneration = generation;
    const delay = computeDelay(recoveryAttempts);
    recoveryAttempts += 1;
    setState({ status: 'BUFFERING', error: reason });

    recoveryTimer = clock.setTimeout(() => {
      recoveryTimer = null;
      if (destroyed || expectedGeneration !== generation) return;
      startEngine(descriptor, expectedGeneration);
    }, delay);
  }

  function load(nextDescriptor) {
    if (!nextDescriptor?.channelId || !nextDescriptor?.manifestUrl) {
      throw new TypeError('channelId and manifestUrl are required');
    }

    destroyed = false;
    cancelRecovery();
    teardownEngine();
    recoveryAttempts = 0;
    descriptor = { ...nextDescriptor };
    generation += 1;
    startEngine(descriptor, generation);
  }

  function stop() {
    cancelRecovery();
    teardownEngine();
    descriptor = null;
    recoveryAttempts = 0;
    generation += 1;
    setState({ status: 'STOPPED', engine: null, channelId: null, generation, error: null });
  }

  function destroy() {
    destroyed = true;
    stop();
    destroyed = true;
    video.removeEventListener?.('playing', onPlaying);
    video.removeEventListener?.('waiting', onWaiting);
    video.removeEventListener?.('error', onNativeError);
  }

  function getState() {
    return { ...state };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
  }

  return { load, stop, destroy, getState, subscribe };
}
