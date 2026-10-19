const DEFAULT_POLL_MS = 500;

function lines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function manifestInfo(text) {
  const all = lines(text);
  if (all[0] !== '#EXTM3U') throw new Error('Provider HLS response is not an M3U8 playlist');

  let variant = null;
  for (let i = 0; i < all.length - 1; i += 1) {
    if (all[i].startsWith('#EXT-X-STREAM-INF:')) {
      variant = all.slice(i + 1).find((line) => !line.startsWith('#')) || null;
      break;
    }
  }

  const targetMatch = /^#EXT-X-TARGETDURATION:([0-9.]+)/m.exec(String(text || ''));
  const mediaSequenceMatch = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(String(text || ''));
  return {
    variant,
    targetDuration: targetMatch ? Number(targetMatch[1]) : null,
    mediaSequence: mediaSequenceMatch ? Number(mediaSequenceMatch[1]) : null,
    endList: all.includes('#EXT-X-ENDLIST'),
    segments: variant ? [] : all.filter((line) => !line.startsWith('#')),
  };
}

function likelyMpegTs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 188 * 2) return false;
  const limit = Math.min(188, bytes.length - 188);
  for (let offset = 0; offset < limit; offset += 1) {
    if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47) return true;
  }
  return false;
}

function abortError() {
  const error = new Error('Provider HLS adapter aborted');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function httpError(message, status, retriable = false) {
  const error = new Error(message);
  error.status = status;
  error.retriable = retriable;
  return error;
}

function retryDelayMs(attempt) {
  return Math.min(500 * (2 ** Math.max(0, attempt - 1)), 4_000);
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

export function isHlsResponse(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  return contentType.includes('mpegurl') || contentType.includes('m3u8');
}

export async function createProviderHlsTsStream({
  initialResponse,
  initialUrl,
  fetchFn = globalThis.fetch,
  signal = null,
  userAgent = 'VLC/3.0.18 LibVLC/3.0.18',
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = Date.now,
  maxGapMs = null,
  onPlaylist = () => {},
  onSegment = () => {},
  onRecovery = () => {},
} = {}) {
  if (!initialResponse?.ok) throw new Error('Provider HLS adapter requires a successful initial response');
  if (typeof fetchFn !== 'function') throw new Error('Provider HLS adapter requires fetch');
  if (typeof nowFn !== 'function') throw new Error('Provider HLS adapter requires nowFn');
  const firstUrl = initialResponse.url || initialUrl;
  if (!firstUrl) throw new Error('Provider HLS adapter requires an initial URL');

  const initialText = await initialResponse.text();
  let mediaUrl = firstUrl;
  let current = manifestInfo(initialText);
  onPlaylist({
    kind: current.variant ? 'master' : 'media',
    status: initialResponse.status,
    bytes: new TextEncoder().encode(initialText).length,
    targetDuration: current.targetDuration,
    mediaSequence: current.mediaSequence,
    segmentCount: current.segments.length,
  });

  async function fetchPlaylistOnce(url) {
    assertNotAborted(signal);
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      },
      redirect: 'follow',
      signal,
    });
    if (!response?.ok) {
      throw httpError(
        `Provider HLS playlist failed with HTTP ${response?.status ?? 'unknown'}`,
        response?.status ?? null,
        true,
      );
    }
    let text;
    let parsed;
    try {
      text = await response.text();
      parsed = manifestInfo(text);
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      if (error instanceof TypeError) error.retriable = true;
      else if (error && typeof error === 'object') error.retriable = true;
      throw error;
    }
    onPlaylist({
      kind: parsed.variant ? 'master' : 'media',
      status: response.status,
      bytes: new TextEncoder().encode(text).length,
      targetDuration: parsed.targetDuration,
      mediaSequence: parsed.mediaSequence,
      segmentCount: parsed.segments.length,
    });
    return { response, parsed };
  }

  if (current.variant) {
    const variantUrl = new URL(current.variant, firstUrl).toString();
    const child = await fetchPlaylistOnce(variantUrl);
    mediaUrl = child.response.url || variantUrl;
    current = child.parsed;
    if (current.variant) throw new Error('Nested HLS master playlists are not supported');
  }

  const seen = new Set();
  let pendingSegments = current.segments.map((uri) => new URL(uri, mediaUrl).toString());
  let endList = current.endList;
  let targetDuration = current.targetDuration;
  let cancelled = false;
  let gapEpisode = null;

  function configuredGapBudgetMs() {
    if (Number.isFinite(maxGapMs) && maxGapMs > 0) return Number(maxGapMs);
    const targetMs = Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration * 3_000 : 0;
    return Math.max(12_000, targetMs);
  }

  function beginGap(error) {
    if (!gapEpisode) {
      gapEpisode = {
        startedAt: nowFn(),
        originalError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  function gapElapsedMs() {
    return gapEpisode ? Math.max(0, nowFn() - gapEpisode.startedAt) : 0;
  }

  function throwIfGapExpired() {
    if (gapEpisode && gapElapsedMs() > configuredGapBudgetMs()) throw gapEpisode.originalError;
  }

  function emitRecovery(kind, extra = {}) {
    const event = { kind, gapMs: gapElapsedMs() };
    if (extra.status !== undefined) event.status = extra.status;
    if (extra.attempt !== undefined) event.attempt = extra.attempt;
    if (extra.dropped !== undefined) event.dropped = extra.dropped;
    onRecovery(event);
  }

  async function sleepWithAbort(ms) {
    assertNotAborted(signal);
    try {
      await sleepFn(ms);
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      throw error;
    }
    assertNotAborted(signal);
  }

  function trimCatchUpIfNeeded() {
    if (!gapEpisode) return;
    const queued = new Set();
    const unseen = [];
    for (const segmentUrl of pendingSegments) {
      if (seen.has(segmentUrl) || queued.has(segmentUrl)) continue;
      queued.add(segmentUrl);
      unseen.push(segmentUrl);
    }
    pendingSegments = unseen;
    if (pendingSegments.length > 3) {
      const dropped = pendingSegments.length - 2;
      pendingSegments = pendingSegments.slice(-2);
      emitRecovery('catch-up', { dropped });
    }
  }

  async function refreshMediaPlaylist() {
    let attempt = 0;
    while (true) {
      assertNotAborted(signal);
      try {
        const refreshed = await fetchPlaylistOnce(mediaUrl);
        mediaUrl = refreshed.response.url || mediaUrl;
        current = refreshed.parsed;
        if (current.variant) throw new Error('Media playlist unexpectedly became a master playlist');
        targetDuration = current.targetDuration || targetDuration;
        endList = current.endList;
        pendingSegments.push(...current.segments.map((uri) => new URL(uri, mediaUrl).toString()));
        trimCatchUpIfNeeded();
        return;
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        beginGap(error);
        throwIfGapExpired();
        attempt += 1;
        emitRecovery('playlist-retry', { status: error?.status ?? null, attempt });
        await sleepWithAbort(retryDelayMs(attempt));
        throwIfGapExpired();
      }
    }
  }

  async function fetchSegmentBytes(segmentUrl) {
    let attempt = 0;
    while (true) {
      assertNotAborted(signal);
      const startedAt = nowFn();
      try {
        const response = await fetchFn(segmentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            Accept: 'video/mp2t,*/*',
          },
          redirect: 'follow',
          signal,
        });

        if (!response?.ok) {
          const status = response?.status ?? null;
          const error = httpError(
            `Provider HLS segment failed with HTTP ${status ?? 'unknown'}`,
            status,
            status === 429 || (Number.isInteger(status) && status >= 500),
          );
          if (status === 404 || status === 410) {
            beginGap(error);
            throwIfGapExpired();
            emitRecovery('segment-skip', { status });
            await refreshMediaPlaylist();
            return null;
          }
          throw error;
        }

        let bytes;
        try {
          bytes = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
          if (error && typeof error === 'object') error.retriable = error instanceof TypeError;
          throw error;
        }

        if (!likelyMpegTs(bytes)) {
          const error = new Error(
            `Provider HLS segment is not MPEG-TS (content-type=${response.headers?.get?.('content-type') || 'unknown'})`,
          );
          error.status = response.status;
          error.retriable = true;
          throw error;
        }

        onSegment({
          status: response.status,
          contentType: response.headers?.get?.('content-type') || null,
          bytes: bytes.length,
          elapsedMs: nowFn() - startedAt,
        });
        gapEpisode = null;
        return bytes;
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        if (!error?.retriable && !(error instanceof TypeError)) throw error;
        beginGap(error);
        throwIfGapExpired();
        attempt += 1;
        emitRecovery('segment-retry', { status: error?.status ?? null, attempt });
        await sleepWithAbort(retryDelayMs(attempt));
        throwIfGapExpired();
      }
    }
  }

  async function nextSegmentBytes() {
    while (!cancelled) {
      assertNotAborted(signal);

      while (pendingSegments.length) {
        const segmentUrl = pendingSegments.shift();
        if (seen.has(segmentUrl)) continue;
        seen.add(segmentUrl);
        if (seen.size > 200) {
          const oldest = seen.values().next().value;
          seen.delete(oldest);
        }

        const bytes = await fetchSegmentBytes(segmentUrl);
        if (bytes) return bytes;
      }

      if (endList) return null;

      const pollMs = Number.isFinite(targetDuration) && targetDuration > 0
        ? Math.max(250, Math.min(1500, targetDuration * 250))
        : DEFAULT_POLL_MS;
      await sleepWithAbort(pollMs);
      throwIfGapExpired();
      await refreshMediaPlaylist();
    }
    return null;
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const bytes = await nextSegmentBytes();
        if (!bytes) {
          controller.close();
          return;
        }
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
