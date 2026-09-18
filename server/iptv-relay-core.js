const VLC_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';

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

export function createIptvRelay(env = process.env, { fetchFn = globalThis.fetch, log = () => {} } = {}) {
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
      const body = new ReadableStream({
        async pull(out) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              release();
              out.close();
              return;
            }
            out.enqueue(value);
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
