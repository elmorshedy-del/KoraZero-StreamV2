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
  let autoplayRequested = false;
  let playAttempt = 0;
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
  const onCanPlay = () => {
    if (autoplayRequested) void requestPlayback(generation);
  };
  const onNativeError = () => scheduleRecovery(new Error('Native HLS media error'));

  video.addEventListener?.('playing', onPlaying);
  video.addEventListener?.('waiting', onWaiting);
  video.addEventListener?.('canplay', onCanPlay);
  video.addEventListener?.('loadedmetadata', onCanPlay);
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
    video.pause?.();

    if (engine?.kind === 'hls.js') {
      if (engine.errorEvent && engine.errorHandler) {
        engine.instance.off?.(engine.errorEvent, engine.errorHandler);
      }
      engine.instance.destroy();
    }

    if (engine?.kind === 'native-hls') {
      video.removeAttribute?.('src');
      video.load?.();
    }

    engine = null;
  }

  async function playOnce(expectedGeneration) {
    if (
      destroyed
      || expectedGeneration !== generation
      || !autoplayRequested
      || typeof video.play !== 'function'
    ) {
      return false;
    }

    const attempt = ++playAttempt;
    try {
      const result = video.play();
      if (result?.then) await result;
      if (destroyed || expectedGeneration !== generation || attempt !== playAttempt) return false;
      return true;
    } catch (error) {
      if (destroyed || expectedGeneration !== generation || attempt !== playAttempt) return false;
      throw error;
    }
  }

  async function requestPlayback(expectedGeneration) {
    if (destroyed || expectedGeneration !== generation || !autoplayRequested) return false;

    try {
      return await playOnce(expectedGeneration);
    } catch (error) {
      if (destroyed || expectedGeneration !== generation) return false;

      const blocked = error?.name === 'NotAllowedError';
      if (blocked && !video.muted) {
        video.muted = true;
        if ('defaultMuted' in video) video.defaultMuted = true;
        try {
          return await playOnce(expectedGeneration);
        } catch (mutedError) {
          if (destroyed || expectedGeneration !== generation) return false;
          setState({
            status: 'BUFFERING',
            error: new Error(`Autoplay retry failed: ${mutedError?.message || String(mutedError)}`),
          });
          return false;
        }
      }

      // A source may not be ready yet. canplay/loadedmetadata will retry automatically.
      setState({
        status: 'BUFFERING',
        error: new Error(`Playback start pending: ${error?.message || String(error)}`),
      });
      return false;
    }
  }

  function beginUserPlaybackIntent() {
    autoplayRequested = true;
    if ('autoplay' in video) video.autoplay = true;
    if ('playsInline' in video) video.playsInline = true;

    // Run synchronously from the click handler. On browsers that preserve a
    // media-element user activation this keeps the element unlocked while
    // the backend prepares the next source. Failure here is harmless; the
    // verified source will retry, with muted fallback only if required.
    if (typeof video.play === 'function' && (engine || video.src)) {
      try {
        const result = video.play();
        result?.catch?.(() => {});
      } catch {}
    }
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
      if (autoplayRequested) void requestPlayback(expectedGeneration);
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
      if (autoplayRequested) void requestPlayback(expectedGeneration);
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

  function load(nextDescriptor, { autoplay = false } = {}) {
    if (!nextDescriptor?.channelId || !nextDescriptor?.manifestUrl) {
      throw new TypeError('channelId and manifestUrl are required');
    }

    destroyed = false;
    cancelRecovery();
    teardownEngine();
    recoveryAttempts = 0;
    descriptor = { ...nextDescriptor };
    autoplayRequested = Boolean(autoplay);
    if ('autoplay' in video) video.autoplay = autoplayRequested;
    if ('playsInline' in video) video.playsInline = true;
    generation += 1;
    startEngine(descriptor, generation);
  }

  function stop() {
    cancelRecovery();
    autoplayRequested = false;
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
    video.removeEventListener?.('canplay', onCanPlay);
    video.removeEventListener?.('loadedmetadata', onCanPlay);
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

  return {
    load,
    stop,
    destroy,
    getState,
    subscribe,
    beginUserPlaybackIntent,
  };
}
