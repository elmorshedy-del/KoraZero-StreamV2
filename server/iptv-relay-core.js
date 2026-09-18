const VLC_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';
const TS_PACKET_BYTES = 188;
const MIST_TIMEOUT_RESET_BYTES = 25_600;
const NULL_BURST_PACKETS = 140;
const DEFAULT_IDLE_KEEPALIVE_MS = 2_000;

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

export function createIptvRelay(env = process.env, { fetchFn = globalThis.fetch, log = () => {}, idleKeepaliveMs = DEFAULT_IDLE_KEEPALIVE_MS } = {}) {
  const portal = normalizePortal(required(env, 'V2_IPTV_PORTAL_URL'));
  const username = required(env, 'V2_IPTV_USERNAME');
  const password = required(env, 'V2_IPTV_PASSWORD');
  const allowedStreamId = required(env, 'V2_IPTV_TEST_STREAM_ID');
  if (!/^\d+$/.test(allowedStreamId)) throw new Error('V2_IPTV_TEST_STREAM_ID must be numeric');

  const stats = {
    activePulls: 0,
    totalPulls: 0,
    maxConcurrentPulls: 0,
    rejectedConcurrentPulls: 0,
    lastStatus: null,
    realBytes: 0,
    keepaliveBursts: 0,
    keepaliveBytes: 0,
  };

  function snapshot() {
    return Object.freeze({ ...stats });
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

    const match = pathname.match(/^\/live\/(\d+)\.ts$/);
    if (!match || match[1] !== allowedStreamId) return new Response('Not found', { status: 404 });

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

    if (stats.activePulls >= 1) {
      stats.rejectedConcurrentPulls += 1;
      return new Response('Upstream pull already active', {
        status: 503,
        headers: { 'retry-after': '1', 'cache-control': 'no-store' },
      });
    }

    stats.activePulls += 1;
    stats.totalPulls += 1;
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
    };

    const target = `${portal}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${allowedStreamId}.ts`;
    try {
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
        release();
        controller.abort();
        return new Response(`Upstream error ${upstream.status}`, { status: 502, headers: { 'cache-control': 'no-store' } });
      }

      let finalHost = null;
      try { finalHost = upstream.url ? new URL(upstream.url).host : null; } catch {}
      log({ event: 'upstream-open', streamId: allowedStreamId, status: upstream.status, finalHost });

      const reader = upstream.body.getReader();
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

              stats.realBytes += value?.byteLength || 0;
              const framed = framer.push(value || new Uint8Array(0));
              if (framed.length) {
                out.enqueue(framed);
                return;
              }
            }
          } catch (error) {
            release();
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
          'content-type': upstream.headers.get('content-type') || 'video/mp2t',
          'cache-control': 'no-store',
          'x-kz-relay': 'iptv',
        },
      });
    } catch (error) {
      release();
      controller.abort();
      if (error?.name === 'AbortError') return new Response('Upstream aborted', { status: 502 });
      throw error;
    }
  }

  return Object.freeze({ handle, stats: snapshot });
}
