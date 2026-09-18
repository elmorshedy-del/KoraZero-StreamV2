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

export function isHlsResponse(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  return contentType.includes('mpegurl') || contentType.includes('m3u8');
}

export async function createProviderHlsTsStream({
  initialResponse,
  initialUrl,
  fetchFn = globalThis.fetch,
  waitForFree = async () => {},
  signal = null,
  userAgent = 'VLC/3.0.18 LibVLC/3.0.18',
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onPlaylist = () => {},
  onSegment = () => {},
} = {}) {
  if (!initialResponse?.ok) throw new Error('Provider HLS adapter requires a successful initial response');
  if (typeof fetchFn !== 'function') throw new Error('Provider HLS adapter requires fetch');
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

  async function fetchPlaylist(url) {
    assertNotAborted(signal);
    await waitForFree();
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
    if (!response?.ok) throw new Error(`Provider HLS playlist failed with HTTP ${response?.status ?? 'unknown'}`);
    const text = await response.text();
    const parsed = manifestInfo(text);
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
    const child = await fetchPlaylist(variantUrl);
    mediaUrl = child.response.url || variantUrl;
    current = child.parsed;
    if (current.variant) throw new Error('Nested HLS master playlists are not supported');
  }

  const seen = new Set();
  let pendingSegments = current.segments.map((uri) => new URL(uri, mediaUrl).toString());
  let endList = current.endList;
  let targetDuration = current.targetDuration;
  let cancelled = false;

  async function refreshMediaPlaylist() {
    const refreshed = await fetchPlaylist(mediaUrl);
    mediaUrl = refreshed.response.url || mediaUrl;
    current = refreshed.parsed;
    if (current.variant) throw new Error('Media playlist unexpectedly became a master playlist');
    targetDuration = current.targetDuration || targetDuration;
    endList = current.endList;
    pendingSegments.push(...current.segments.map((uri) => new URL(uri, mediaUrl).toString()));
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

        await waitForFree();
        assertNotAborted(signal);
        const startedAt = Date.now();
        const response = await fetchFn(segmentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            Accept: 'video/mp2t,*/*',
          },
          redirect: 'follow',
          signal,
        });
        if (!response?.ok) throw new Error(`Provider HLS segment failed with HTTP ${response?.status ?? 'unknown'}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!likelyMpegTs(bytes)) {
          throw new Error(`Provider HLS segment is not MPEG-TS (content-type=${response.headers?.get?.('content-type') || 'unknown'})`);
        }
        onSegment({
          status: response.status,
          contentType: response.headers?.get?.('content-type') || null,
          bytes: bytes.length,
          elapsedMs: Date.now() - startedAt,
        });
        return bytes;
      }

      if (endList) return null;

      const pollMs = Number.isFinite(targetDuration) && targetDuration > 0
        ? Math.max(250, Math.min(1500, targetDuration * 250))
        : DEFAULT_POLL_MS;
      await sleepFn(pollMs);
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
