function lines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function variantUri(text) {
  const all = lines(text);
  for (let i = 0; i < all.length - 1; i += 1) {
    if (all[i].startsWith('#EXT-X-STREAM-INF:')) {
      return all.slice(i + 1).find((line) => !line.startsWith('#')) || null;
    }
  }
  return null;
}

function mediaSegmentUri(text) {
  const all = lines(text);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (!all[i].startsWith('#')) return all[i];
  }
  return null;
}

function playableMediaPlaylist(text) {
  const all = lines(text);
  return all[0] === '#EXTM3U'
    && all.some((line) => line.startsWith('#EXTINF:'))
    && Boolean(mediaSegmentUri(text))
    && !all.some((line) => line.startsWith('#EXT-X-ERROR:'));
}

export async function probeHlsPlayback({
  manifestUrl,
  fetchFn = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 10,
  delayMs = 500,
  timeoutMs = 5_000,
} = {}) {
  if (!manifestUrl) throw new Error('playback probe requires manifestUrl');
  if (typeof fetchFn !== 'function') throw new Error('playback probe requires fetch');

  const startedAt = Date.now();
  let last = 'no attempt';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const rootStartedAt = Date.now();
      const root = await fetchFn(manifestUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rootText = await root.text();
      if (!root.ok) throw new Error(`root manifest HTTP ${root.status}`);

      let mediaUrl = manifestUrl;
      let mediaText = rootText;
      const variant = variantUri(rootText);
      let variantFetchMs = 0;

      if (variant) {
        mediaUrl = new URL(variant, manifestUrl).toString();
        const variantStartedAt = Date.now();
        const media = await fetchFn(mediaUrl, {
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        });
        mediaText = await media.text();
        variantFetchMs = Date.now() - variantStartedAt;
        if (!media.ok) throw new Error(`media manifest HTTP ${media.status}`);
      }

      if (!playableMediaPlaylist(mediaText)) throw new Error('media playlist has no playable segment');
      const segmentUri = mediaSegmentUri(mediaText);
      const segmentUrl = new URL(segmentUri, mediaUrl).toString();
      const segmentStartedAt = Date.now();
      const segment = await fetchFn(segmentUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!segment.ok) throw new Error(`segment HTTP ${segment.status}`);
      const bytes = await segment.arrayBuffer();
      if (!bytes || bytes.byteLength < 1) throw new Error('segment was empty');

      return {
        ok: true,
        attempt,
        segmentBytes: bytes.byteLength,
        rootFetchMs: Date.now() - rootStartedAt - variantFetchMs - (Date.now() - segmentStartedAt),
        variantFetchMs,
        segmentFetchMs: Date.now() - segmentStartedAt,
        totalMs: Date.now() - startedAt,
      };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleepFn(delayMs);
    }
  }

  throw new Error(`playback verification failed: ${last}`);
}
