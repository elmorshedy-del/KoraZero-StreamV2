import { createProviderHlsTsStream, isHlsResponse } from './provider-hls-source.js';

const VLC_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';
const TS_PACKET_BYTES = 188;
const MIST_TIMEOUT_RESET_BYTES = 25_600;
const NULL_BURST_PACKETS = 140;
const DEFAULT_IDLE_KEEPALIVE_MS = 2_000;
const DEFAULT_CATALOG_TTL_MS = 60_000;

function concatBytes(left, right) {
  if (!left?.length) return right;
  if (!right?.length) return left;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function createNullBurst() {
  const burst = new Uint8Array(NULL_BURST_PACKETS * TS_PACKET_BYTES);
  for (let packet = 0; packet < NULL_BURST_PACKETS; packet += 1) {
    const offset = packet * TS_PACKET_BYTES;
    burst[offset] = 0x47;
    burst[offset + 1] = 0x1f;
    burst[offset + 2] = 0xff;
    burst[offset + 3] = 0x10 | (packet & 0x0f);
    burst.fill(0xff, offset + 4, offset + TS_PACKET_BYTES);
  }
  if (burst.length <= MIST_TIMEOUT_RESET_BYTES) throw new Error('IPTV null burst is too small for Mist timeout reset');
  return burst;
}

const NULL_BURST = createNullBurst();

function createTsFramer() {
  let carry = new Uint8Array(0);
  let synced = false;

  function findSync(bytes) {
    if (bytes.length < TS_PACKET_BYTES * 2) return -1;
    const limit = Math.min(TS_PACKET_BYTES, bytes.length - TS_PACKET_BYTES);
    for (let offset = 0; offset < limit; offset += 1) {
      if (bytes[offset] === 0x47 && bytes[offset + TS_PACKET_BYTES] === 0x47) return offset;
    }
    return -1;
  }

  return {
    push(value) {
      let bytes = concatBytes(carry, value);
      carry = new Uint8Array(0);

      if (!synced) {
        const offset = findSync(bytes);
        if (offset < 0) {
          carry = bytes.slice(Math.max(0, bytes.length - (TS_PACKET_BYTES * 2 - 1)));
          return new Uint8Array(0);
        }
        bytes = bytes.slice(offset);
        synced = true;
      }

      let packetCount = Math.floor(bytes.length / TS_PACKET_BYTES);
      let validPackets = 0;
      while (validPackets < packetCount && bytes[validPackets * TS_PACKET_BYTES] === 0x47) validPackets += 1;

      if (validPackets < packetCount) {
        const validBytes = validPackets * TS_PACKET_BYTES;
        const output = bytes.slice(0, validBytes);
        carry = bytes.slice(validBytes + 1);
        synced = false;
        return output;
      }

      const fullBytes = packetCount * TS_PACKET_BYTES;
      carry = bytes.slice(fullBytes);
      return bytes.slice(0, fullBytes);
    },
  };
}

function parsePatPrograms(bytes) {
  const programs = new Map();
  for (let offset = 0; offset + TS_PACKET_BYTES <= bytes.length; offset += TS_PACKET_BYTES) {
    const packet = bytes.subarray(offset, offset + TS_PACKET_BYTES);
    if (packet[0] !== 0x47) continue;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (pid !== 0 || !(packet[1] & 0x40)) continue;

    const adaptationControl = (packet[3] >> 4) & 0x03;
    if (adaptationControl === 0 || adaptationControl === 2) continue;

    let payloadOffset = 4;
    if (adaptationControl === 3) {
      payloadOffset += 1 + packet[4];
      if (payloadOffset >= TS_PACKET_BYTES) continue;
    }

    const pointerField = packet[payloadOffset];
    const sectionStart = payloadOffset + 1 + pointerField;
    if (sectionStart + 8 > TS_PACKET_BYTES) continue;
    if (packet[sectionStart] !== 0x00) continue;

    const sectionLength = ((packet[sectionStart + 1] & 0x0f) << 8) | packet[sectionStart + 2];
    const sectionEnd = sectionStart + 3 + sectionLength;
    if (sectionEnd > TS_PACKET_BYTES || sectionLength < 9) continue;

    const programLoopStart = sectionStart + 8;
    const programLoopEnd = sectionEnd - 4;
    for (let cursor = programLoopStart; cursor + 4 <= programLoopEnd; cursor += 4) {
      const programNumber = (packet[cursor] << 8) | packet[cursor + 1];
      if (programNumber === 0) continue;
      const pmtPid = ((packet[cursor + 2] & 0x1f) << 8) | packet[cursor + 3];
      programs.set(programNumber, pmtPid);
    }
  }
  return [...programs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([programNumber, pmtPid]) => ({ programNumber, pmtPid }));
}

function required(env, key) {
  const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
  if (!value || value === '__SET_IN_RAILWAY__') throw new Error(`${key} is required`);
  return value;
}

function normalizePortal(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('V2_IPTV_PORTAL_URL must use http or https');
  }
  url.search = '';
  url.hash = '';
  let path = url.pathname;
  if (path.toLowerCase().endsWith('/player_api.php')) path = path.slice(0, -15);
  while (path.endsWith('/')) path = path.slice(0, -1);
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

function createStreamStats() {
  return {
    activePulls: 0,
    totalPulls: 0,
    providerAttempts: 0,
    successfulProviderOpens: 0,
    failedProviderOpens: 0,
    rejectedConcurrentPulls: 0,
    realBytes: 0,
    keepaliveBursts: 0,
    keepaliveBytes: 0,
    transportMode: null,
    upstreamStatus: null,
    upstreamContentType: null,
    firstMediaByteMs: null,
    playlistFetches: 0,
    segmentFetches: 0,
    segmentBytes: 0,
    lastSegmentStatus: null,
    lastSegmentContentType: null,
    lastError: null,
    lastMediaAt: null,
  };
}

function cleanCatalogText(value, maxLength = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createIptvRelay(env = process.env, { fetchFn = globalThis.fetch, log = () => {}, idleKeepaliveMs = DEFAULT_IDLE_KEEPALIVE_MS } = {}) {
  const portal = normalizePortal(required(env, 'V2_IPTV_PORTAL_URL'));
  const username = required(env, 'V2_IPTV_USERNAME');
  const password = required(env, 'V2_IPTV_PASSWORD');
  const catalogMode = env.V2_IPTV_CATALOG_MODE === 'true';
  const catalogTtlMs = Math.max(5_000, parseNonNegativeInt(env.V2_IPTV_CATALOG_TTL_MS, DEFAULT_CATALOG_TTL_MS));
  const maxActivePulls = parseNonNegativeInt(env.V2_IPTV_MAX_ACTIVE_PULLS, 0);
  const allowedRaw = typeof env.V2_IPTV_ALLOWED_STREAM_IDS === 'string' ? env.V2_IPTV_ALLOWED_STREAM_IDS.trim() : '';
  const fallbackRaw = typeof env.V2_IPTV_TEST_STREAM_ID === 'string' ? env.V2_IPTV_TEST_STREAM_ID.trim() : '';
  const staticIdsRaw = allowedRaw || fallbackRaw;
  const allowedStreamIds = new Set(staticIdsRaw.split(',').map((value) => value.trim()).filter(Boolean));
  if ([...allowedStreamIds].some((streamId) => !/^\d+$/.test(streamId))) throw new Error('Configured IPTV stream ids must be numeric');
  if (!catalogMode && !allowedStreamIds.size) throw new Error('At least one IPTV stream id or catalog mode is required');
  const streamStats = Object.fromEntries([...allowedStreamIds].map((streamId) => [streamId, createStreamStats()]));

  let catalogCache = null;
  let catalogPromise = null;

  function getStreamStats(streamId) {
    if (!streamStats[streamId]) streamStats[streamId] = createStreamStats();
    return streamStats[streamId];
  }

  function playerApiUrl(action = null) {
    const url = new URL(`${portal}/player_api.php`);
    url.searchParams.set('username', username);
    url.searchParams.set('password', password);
    if (action) url.searchParams.set('action', action);
    return url.toString();
  }

  async function fetchProviderJson(action = null) {
    const response = await fetchFn(playerApiUrl(action), {
      method: 'GET',
      headers: { 'User-Agent': VLC_USER_AGENT, Accept: 'application/json,*/*' },
      redirect: 'follow',
    });
    if (!response?.ok) throw new Error(`Provider API ${action || 'account'} failed with HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async function loadCatalog() {
    const now = Date.now();
    if (catalogCache && catalogCache.expiresAt > now) return catalogCache.value;
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const [streamsResult, categoriesResult] = await Promise.allSettled([
        fetchProviderJson('get_live_streams'),
        fetchProviderJson('get_live_categories'),
      ]);
      if (streamsResult.status !== 'fulfilled' || !Array.isArray(streamsResult.value)) throw new Error('Provider live catalog is unavailable');
      const rawCategories = categoriesResult.status === 'fulfilled' && Array.isArray(categoriesResult.value) ? categoriesResult.value : [];
      const categoryById = new Map(rawCategories
        .map((row) => [String(row?.category_id ?? '').trim(), cleanCatalogText(row?.category_name)])
        .filter(([id, name]) => /^\d+$/.test(id) && name));
      const channels = streamsResult.value.map((row) => {
        const streamId = String(row?.stream_id ?? '').trim();
        if (!/^\d+$/.test(streamId)) return null;
        const categoryId = String(row?.category_id ?? '').trim();
        return {
          streamId,
          name: cleanCatalogText(row?.name) || `Stream ${streamId}`,
          categoryId: /^\d+$/.test(categoryId) ? categoryId : '',
          categoryName: categoryById.get(categoryId) || 'Other',
          tvArchive: Number(row?.tv_archive || 0) === 1,
          isAdult: Number(row?.is_adult || 0) === 1,
        };
      }).filter(Boolean);
      const counts = new Map();
      for (const channel of channels) counts.set(channel.categoryId, (counts.get(channel.categoryId) || 0) + 1);
      const categories = [...categoryById.entries()].map(([categoryId, name]) => ({
        categoryId, name, count: counts.get(categoryId) || 0,
      })).filter((category) => category.count > 0);
      const value = { fetchedAt: new Date().toISOString(), channelCount: channels.length, categories, channels };
      catalogCache = { value, ids: new Set(channels.map((channel) => channel.streamId)), expiresAt: Date.now() + catalogTtlMs };
      return value;
    })().finally(() => { catalogPromise = null; });
    return catalogPromise;
  }

  async function accountStatus() {
    const payload = await fetchProviderJson();
    const user = payload?.user_info || {};
    return {
      auth: Number(user.auth || 0),
      status: cleanCatalogText(user.status, 40),
      activeConnections: parseNonNegativeInt(user.active_cons, 0),
      maxConnections: parseNonNegativeInt(user.max_connections, 0),
      allowedOutputFormats: Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats.map((value) => cleanCatalogText(value, 20)).filter(Boolean) : [],
    };
  }

  async function waitForProviderSlotFree(signal, timeoutMs = 15_000) {
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) {
        const error = new Error('Provider slot wait aborted');
        error.name = 'AbortError';
        throw error;
      }
      const status = await accountStatus();
      if (status.activeConnections === 0) return { ...status, waitMs: Date.now() - startedAt };
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Provider slot did not clear within ${timeoutMs}ms (active=${status.activeConnections}, max=${status.maxConnections})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function isAllowedStreamId(streamId) {
    if (allowedStreamIds.has(streamId)) return true;
    if (!catalogMode) return false;
    await loadCatalog();
    return catalogCache?.ids?.has(streamId) === true;
  }

  const stats = {
    activePulls: 0,
    totalPulls: 0,
    maxConcurrentPulls: 0,
    rejectedConcurrentPulls: 0,
    lastStatus: null,
    providerAttempts: 0,
    successfulProviderOpens: 0,
    failedProviderOpens: 0,
    realBytes: 0,
    keepaliveBursts: 0,
    keepaliveBytes: 0,
  };

  function snapshot() {
    return Object.freeze({ ...stats, streams: Object.freeze(Object.fromEntries(Object.entries(streamStats).map(([streamId, value]) => [streamId, Object.freeze({ ...value })]))) });
  }

  async function handle({ method = 'GET', pathname = '/', signal } = {}) {
    if (pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (pathname === '/stats') {
      return new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (pathname === '/catalog' && method === 'GET') {
      return new Response(JSON.stringify(await loadCatalog()), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (pathname === '/account' && method === 'GET') {
      return new Response(JSON.stringify(await accountStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    const match = pathname.match(/^\/live\/(\d+)\.ts$/);
    const requestedStreamId = match?.[1] || null;
    if (!requestedStreamId || !(await isAllowedStreamId(requestedStreamId))) return new Response('Not found', { status: 404 });
    const currentStreamStats = getStreamStats(requestedStreamId);

    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'video/mp2t',
          'cache-control': 'no-store',
        },
      });
    }
    if (method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

    if ((maxActivePulls > 0 && stats.activePulls >= maxActivePulls) || currentStreamStats.activePulls >= 1) {
      stats.rejectedConcurrentPulls += 1;
      currentStreamStats.rejectedConcurrentPulls += 1;
      return new Response('Upstream pull already active', {
        status: 503,
        headers: { 'retry-after': '1', 'cache-control': 'no-store' },
      });
    }

    stats.activePulls += 1;
    stats.totalPulls += 1;
    currentStreamStats.activePulls += 1;
    currentStreamStats.totalPulls += 1;
    stats.maxConcurrentPulls = Math.max(stats.maxConcurrentPulls, stats.activePulls);

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener?.('abort', abort);
      stats.activePulls = Math.max(0, stats.activePulls - 1);
      currentStreamStats.activePulls = Math.max(0, currentStreamStats.activePulls - 1);
    };

    const target = `${portal}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${requestedStreamId}.ts`;
    try {
      stats.providerAttempts += 1;
      currentStreamStats.providerAttempts += 1;
      const upstream = await fetchFn(target, {
        method: 'GET',
        headers: {
          'User-Agent': VLC_USER_AGENT,
          Accept: 'video/mp2t,*/*',
          Range: 'bytes=0-',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      stats.lastStatus = upstream.status;
      if (!upstream.ok || !upstream.body) {
        stats.failedProviderOpens += 1;
        currentStreamStats.failedProviderOpens += 1;
        release();
        controller.abort();
        return new Response(`Upstream error ${upstream.status}`, { status: 502, headers: { 'cache-control': 'no-store' } });
      }

      stats.successfulProviderOpens += 1;
      currentStreamStats.successfulProviderOpens += 1;
      currentStreamStats.upstreamStatus = upstream.status;
      currentStreamStats.upstreamContentType = upstream.headers.get('content-type') || null;
      currentStreamStats.lastError = null;

      let finalHost = null;
      try { finalHost = upstream.url ? new URL(upstream.url).host : null; } catch {}
      log({ event: 'upstream-open', streamId: requestedStreamId, status: upstream.status, finalHost });

      const mediaStartedAt = Date.now();
      let sourceBody = upstream.body;
      if (isHlsResponse(upstream)) {
        currentStreamStats.transportMode = 'hls-to-ts';
        log({
          event: 'transport-mode',
          streamId: requestedStreamId,
          mode: currentStreamStats.transportMode,
          upstreamStatus: upstream.status,
          upstreamContentType: currentStreamStats.upstreamContentType,
        });
        sourceBody = await createProviderHlsTsStream({
          initialResponse: upstream,
          initialUrl: upstream.url || target,
          fetchFn,
          waitForFree: () => waitForProviderSlotFree(controller.signal),
          signal: controller.signal,
          userAgent: VLC_USER_AGENT,
          onPlaylist(meta) {
            currentStreamStats.playlistFetches += 1;
            log({ event: 'hls-playlist', streamId: requestedStreamId, ...meta });
          },
          onSegment(meta) {
            currentStreamStats.segmentFetches += 1;
            currentStreamStats.segmentBytes += meta.bytes;
            currentStreamStats.lastSegmentStatus = meta.status;
            currentStreamStats.lastSegmentContentType = meta.contentType;
            currentStreamStats.lastMediaAt = new Date().toISOString();
            log({ event: 'hls-segment', streamId: requestedStreamId, ...meta });
          },
        });
      } else {
        currentStreamStats.transportMode = 'raw-ts';
        log({
          event: 'transport-mode',
          streamId: requestedStreamId,
          mode: currentStreamStats.transportMode,
          upstreamStatus: upstream.status,
          upstreamContentType: currentStreamStats.upstreamContentType,
        });
      }

      const reader = sourceBody.getReader();
      const framer = createTsFramer();
      let pendingRead = null;

      const getPendingRead = () => {
        if (!pendingRead) {
          pendingRead = reader.read().then(
            (result) => ({ ok: true, result }),
            (error) => ({ ok: false, error }),
          );
        }
        return pendingRead;
      };

      const body = new ReadableStream({
        async pull(out) {
          try {
            while (true) {
              let timer = null;
              const idle = new Promise((resolve) => {
                timer = setTimeout(() => resolve({ idle: true }), idleKeepaliveMs);
              });
              const winner = await Promise.race([
                getPendingRead().then((read) => ({ idle: false, read })),
                idle,
              ]);
              if (timer) clearTimeout(timer);

              if (winner.idle) {
                stats.keepaliveBursts += 1;
                stats.keepaliveBytes += NULL_BURST.length;
                currentStreamStats.keepaliveBursts += 1;
                currentStreamStats.keepaliveBytes += NULL_BURST.length;
                out.enqueue(NULL_BURST);
                return;
              }

              pendingRead = null;
              if (!winner.read.ok) throw winner.read.error;
              const { done, value } = winner.read.result;
              if (done) {
                release();
                out.close();
                return;
              }

              const receivedBytes = value?.byteLength || 0;
              if (receivedBytes > 0 && currentStreamStats.firstMediaByteMs === null) {
                currentStreamStats.firstMediaByteMs = Date.now() - mediaStartedAt;
              }
              if (receivedBytes > 0) currentStreamStats.lastMediaAt = new Date().toISOString();
              stats.realBytes += receivedBytes;
              currentStreamStats.realBytes += receivedBytes;
              const framed = framer.push(value || new Uint8Array(0));
              if (framed.length) {
                const transportPrograms = parsePatPrograms(framed);
                if (transportPrograms.length) {
                  currentStreamStats.transportPrograms = transportPrograms;
                  currentStreamStats.transportProgramCount = transportPrograms.length;
                  currentStreamStats.transportKind = transportPrograms.length > 1 ? 'mpts' : 'spts';
                }
                out.enqueue(framed);
                return;
              }
            }
          } catch (error) {
            release();
            if (error?.name === 'AbortError') {
              log({ event: 'stream-cancelled', streamId: requestedStreamId });
              return;
            }
            currentStreamStats.lastError = cleanCatalogText(error?.message || String(error), 240);
            log({ event: 'stream-body-error', streamId: requestedStreamId, error: currentStreamStats.lastError });
            out.error(error);
          }
        },
        async cancel(reason) {
          controller.abort();
          try { await reader.cancel(reason); } catch {}
          release();
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'video/mp2t',
          'cache-control': 'no-store',
          'x-kz-relay': 'iptv',
          'x-kz-transport': currentStreamStats.transportMode || 'unknown',
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        log({ event: 'upstream-cancelled', streamId: requestedStreamId });
        release();
        controller.abort();
        return new Response('Upstream aborted', { status: 502 });
      }
      currentStreamStats.lastError = cleanCatalogText(error?.message || String(error), 240);
      log({ event: 'upstream-error', streamId: requestedStreamId, error: currentStreamStats.lastError });
      if (stats.lastStatus == null || currentStreamStats.successfulProviderOpens < currentStreamStats.providerAttempts - currentStreamStats.failedProviderOpens) {
        stats.failedProviderOpens += 1;
        currentStreamStats.failedProviderOpens += 1;
      }
      release();
      controller.abort();
      throw error;
    }
  }

  return Object.freeze({ handle, stats: snapshot });
}
