function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function smokeUrl(hlsBase, channelId) {
  return `${normalizeBase(hlsBase)}/${encodeURIComponent(channelId)}/index.m3u8`;
}

function playlistLines(body) {
  return String(body || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function playablePlaylist(body) {
  const lines = playlistLines(body);
  const hasSegmentDuration = lines.some((line) => line.startsWith('#EXTINF:'));
  const hasSegmentUri = lines.some((line) => !line.startsWith('#'));
  return lines[0] === '#EXTM3U'
    && !lines.some((line) => line.startsWith('#EXT-X-ERROR:'))
    && hasSegmentDuration
    && hasSegmentUri;
}

function masterVariantUri(body) {
  const lines = playlistLines(body);
  if (lines[0] !== '#EXTM3U' || lines.some((line) => line.startsWith('#EXT-X-ERROR:'))) return null;
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:') && !lines[i + 1].startsWith('#')) {
      return lines[i + 1];
    }
  }
  return null;
}

export async function runHlsSmokeTest({
  channelId,
  hlsBase,
  attempts = 8,
  delayMs = 1500,
  timeoutMs = 5000,
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  abortSignalFactory = (ms) => AbortSignal.timeout(ms),
}) {
  if (!channelId) throw new Error('HLS smoke requires channelId');
  if (!hlsBase) throw new Error('HLS smoke requires hlsBase');
  if (typeof fetchFn !== 'function') throw new Error('HLS smoke requires fetch');

  const url = smokeUrl(hlsBase, channelId);
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        cache: 'no-store',
        signal: abortSignalFactory(timeoutMs),
      });
      const body = await response.text();
      const contentType = response.headers?.get?.('content-type') ?? null;
      if (response.ok && playablePlaylist(body)) {
        return {
          ok: true,
          channelId,
          status: response.status,
          contentType,
          bytes: Buffer.byteLength(body),
        };
      }
      if (response.ok) {
        const variant = masterVariantUri(body);
        if (variant) {
          const childUrl = new URL(variant, url).toString();
          const childResponse = await fetchFn(childUrl, {
            cache: 'no-store',
            signal: abortSignalFactory(timeoutMs),
          });
          const childBody = await childResponse.text();
          if (childResponse.ok && playablePlaylist(childBody)) {
            return {
              ok: true,
              channelId,
              status: childResponse.status,
              contentType: childResponse.headers?.get?.('content-type') ?? contentType,
              bytes: Buffer.byteLength(body) + Buffer.byteLength(childBody),
            };
          }
        }
      }
      last = `HTTP ${response.status}${body.includes('#EXT-X-ERROR:') ? ' with Mist HLS error playlist' : ''}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) await sleepFn(delayMs);
  }

  throw new Error(`HLS smoke failed for ${channelId}: ${last ?? 'unknown error'}`);
}

export async function runConfiguredHlsSmokeTest(env = process.env, options = {}) {
  const channelId = String(env.V2_SMOKE_TEST_CHANNEL || '').trim();
  const hlsBase = String(env.V2_MIST_HLS_INTERNAL_BASE || '').trim();
  if (!channelId && !hlsBase) return null;
  if (!channelId) throw new Error('V2_SMOKE_TEST_CHANNEL is required when V2_MIST_HLS_INTERNAL_BASE is set');
  if (!hlsBase) throw new Error('V2_MIST_HLS_INTERNAL_BASE is required when V2_SMOKE_TEST_CHANNEL is set');
  return runHlsSmokeTest({ channelId, hlsBase, ...options });
}
