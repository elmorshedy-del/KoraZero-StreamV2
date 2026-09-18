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


async function fetchJson(url, fetchFn) {
  const response = await fetchFn(url, { cache: 'no-store' });
  if (!response?.ok) throw new Error(`Source stats request failed with HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

function firstMediaUri(body) {
  const lines = playlistLines(body);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXTINF:')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].startsWith('#')) return lines[j];
      }
    }
  }
  return null;
}

async function consumeOneHlsSegment({ rootUrl, fetchFn }) {
  const rootResponse = await fetchFn(rootUrl, { cache: 'no-store' });
  if (!rootResponse?.ok) throw new Error(`Fanout root playlist failed with HTTP ${rootResponse?.status ?? 'unknown'}`);
  const rootBody = await rootResponse.text();

  let mediaUrl = rootUrl;
  let mediaBody = rootBody;
  const variant = masterVariantUri(rootBody);
  if (variant) {
    mediaUrl = new URL(variant, rootUrl).toString();
    const mediaResponse = await fetchFn(mediaUrl, { cache: 'no-store' });
    if (!mediaResponse?.ok) throw new Error(`Fanout media playlist failed with HTTP ${mediaResponse?.status ?? 'unknown'}`);
    mediaBody = await mediaResponse.text();
  }

  const segment = firstMediaUri(mediaBody);
  if (!segment) throw new Error('Fanout media playlist contains no segment');
  const segmentUrl = new URL(segment, mediaUrl).toString();
  const segmentResponse = await fetchFn(segmentUrl, { cache: 'no-store' });
  if (!segmentResponse?.ok) throw new Error(`Fanout segment failed with HTTP ${segmentResponse?.status ?? 'unknown'}`);
  const bytes = await segmentResponse.arrayBuffer();
  if (!bytes || bytes.byteLength < 1) throw new Error('Fanout segment was empty');
  return bytes.byteLength;
}

export async function runFanoutSmokeTest({
  channelId,
  hlsBase,
  sourceStatsUrl,
  viewers = 5,
  fetchFn = globalThis.fetch,
}) {
  if (!channelId) throw new Error('Fanout smoke requires channelId');
  if (!hlsBase) throw new Error('Fanout smoke requires hlsBase');
  if (!sourceStatsUrl) throw new Error('Fanout smoke requires sourceStatsUrl');
  if (!Number.isInteger(viewers) || viewers < 2) throw new Error('Fanout smoke requires at least two viewers');
  if (typeof fetchFn !== 'function') throw new Error('Fanout smoke requires fetch');

  const before = await fetchJson(sourceStatsUrl, fetchFn);
  if (Number(before.activePulls) !== 1) {
    throw new Error(`Fanout smoke expected exactly one active upstream pull before viewers, got ${before.activePulls}`);
  }

  const rootUrl = smokeUrl(hlsBase, channelId);
  await Promise.all(Array.from({ length: viewers }, () => consumeOneHlsSegment({ rootUrl, fetchFn })));

  const after = await fetchJson(sourceStatsUrl, fetchFn);
  if (Number(after.activePulls) !== 1) {
    throw new Error(`Fanout smoke expected exactly one active upstream pull after viewers, got ${after.activePulls}`);
  }
  if (Number(after.totalPulls) !== Number(before.totalPulls)) {
    throw new Error(`Fanout smoke opened new upstream pulls: before=${before.totalPulls} after=${after.totalPulls}`);
  }

  return {
    ok: true,
    channelId,
    viewers,
    upstreamPulls: Number(after.activePulls),
    totalPulls: Number(after.totalPulls),
  };
}


export async function runConfiguredFanoutSmokeTest(env = process.env, options = {}) {
  const viewersRaw = String(env.V2_FANOUT_VIEWERS || '').trim();
  const sourceStatsUrl = String(env.V2_FANOUT_SOURCE_STATS_URL || '').trim();
  if (!viewersRaw && !sourceStatsUrl) return null;

  const channelId = String(env.V2_SMOKE_TEST_CHANNEL || '').trim();
  const hlsBase = String(env.V2_MIST_HLS_INTERNAL_BASE || '').trim();
  if (!channelId) throw new Error('V2_SMOKE_TEST_CHANNEL is required when fanout smoke is enabled');
  if (!hlsBase) throw new Error('V2_MIST_HLS_INTERNAL_BASE is required when fanout smoke is enabled');
  if (!sourceStatsUrl) throw new Error('V2_FANOUT_SOURCE_STATS_URL is required when fanout smoke is enabled');

  const viewers = Number(viewersRaw || 5);
  if (!Number.isInteger(viewers) || viewers < 2) {
    throw new Error('V2_FANOUT_VIEWERS must be an integer >= 2');
  }

  return runFanoutSmokeTest({
    channelId,
    hlsBase,
    sourceStatsUrl,
    viewers,
    ...options,
  });
}
