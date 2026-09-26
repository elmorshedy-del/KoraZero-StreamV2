import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function channelFrom(pathname, prefix, suffix = '') {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return null;
  const end = suffix ? -suffix.length : undefined;
  const raw = pathname.slice(prefix.length, end);
  if (!raw || raw.includes('/')) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}

function tryStatic(res, pathname, staticRoot) {
  if (!staticRoot) return false;
  const root = resolve(staticRoot);
  const requested = pathname === '/' ? '/watch.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(requested); } catch { return false; }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const path = resolve(join(root, relative));
  if (path !== root && !path.startsWith(`${root}/`)) return false;
  if (!existsSync(path) || !statSync(path).isFile()) return false;

  res.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
  return true;
}

function createRequestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      const error = new Error('Client closed playback request');
      error.name = 'AbortError';
      controller.abort(error);
    }
  };
  const onClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  return {
    signal: controller.signal,
    cleanup() {
      req.off('aborted', abort);
      res.off('close', onClose);
    },
  };
}

const OPERATOR_STREAM_IDS = new Set(['3645', '3644', '3653', '3652', '3651', '89778', '89779']);

function operatorAuthorized(req, operatorPin) {
  if (!operatorPin) return false;
  const bearer = String(req.headers.authorization || '');
  if (bearer === `Bearer ${operatorPin}`) return true;
  return String(req.headers['x-operator-pin'] || '') === operatorPin;
}

export function createControlServer({ gateway, internalToken, operatorPin = null, staticRoot = null }) {
  if (!gateway) throw new Error('control server requires gateway');
  if (!internalToken) throw new Error('control server requires internalToken');

  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/api/catalog') {
        return sendJson(res, 200, await gateway.catalog());
      }

      if (req.method === 'GET' && pathname === '/api/active') {
        return sendJson(res, 200, await gateway.active());
      }

      const diagnosticChannel = channelFrom(pathname, '/api/diagnostics/');
      if (req.method === 'GET' && diagnosticChannel) {
        const diagnostic = gateway.diagnostic?.(diagnosticChannel) || null;
        return sendJson(res, diagnostic ? 200 : 404, diagnostic || { error: 'diagnostic_not_found' });
      }

      const publicChannel = channelFrom(pathname, '/api/playback/');
      if (req.method === 'GET' && publicChannel) {
        // Numeric catalog IDs are an activation/switch operation, not a public
        // descriptor lookup. Keeping them public let crawlers switch the single
        // upstream provider slot and tear down the stream real viewers were
        // watching. Dynamic activation belongs behind the authenticated
        // /internal/channels/:id/activate route.
        if (/^\d+$/.test(publicChannel)) {
          return sendJson(res, 403, { error: 'dynamic_playback_requires_internal_activation' });
        }
        const requestAbort = createRequestAbort(req, res);
        try {
          const value = await gateway.playback(publicChannel, { signal: requestAbort.signal });
          if (requestAbort.signal.aborted || res.destroyed || res.writableEnded) return;
          return sendJson(res, 200, value);
        } finally {
          requestAbort.cleanup();
        }
      }

      if (pathname.startsWith('/operator/')) {
        if (!operatorAuthorized(req, operatorPin)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }

        if (req.method === 'GET' && pathname === '/operator/active') {
          return sendJson(res, 200, await gateway.active());
        }

        if (req.method === 'POST' && pathname === '/operator/off') {
          return sendJson(res, 200, await gateway.stopDynamic());
        }

        const streamId = channelFrom(pathname, '/operator/switch/');
        if (req.method === 'POST' && streamId) {
          if (!OPERATOR_STREAM_IDS.has(streamId)) {
            return sendJson(res, 400, { error: 'stream_not_allowed' });
          }
          return sendJson(res, 200, await gateway.activate(streamId));
        }
      }

      if (pathname.startsWith('/internal/')) {
        if (req.headers.authorization !== `Bearer ${internalToken}`) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }

        const operations = [
          { suffix: '/activate', method: 'POST', action: (id) => gateway.activate(id) },
          { suffix: '/status', method: 'GET', action: (id) => gateway.status(id) },
          { suffix: '/stop', method: 'POST', action: (id) => gateway.stop(id) },
        ];
        for (const operation of operations) {
          const channelId = channelFrom(pathname, '/internal/channels/', operation.suffix);
          if (channelId && req.method === operation.method) {
            return sendJson(res, 200, await operation.action(channelId));
          }
        }
      }

      if (req.method === 'GET' && tryStatic(res, pathname, staticRoot)) return;
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error?.name === 'AbortError' || res.destroyed || res.writableEnded) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown channel/i.test(message)) {
        return sendJson(res, 404, { error: 'unknown_channel' });
      }
      if (/provider slot still busy|provider slot did not clear/i.test(message)) {
        return sendJson(res, 503, { error: 'provider_slot_busy', detail: message });
      }
      if (/playback verification failed/i.test(message)) {
        return sendJson(res, 502, { error: 'playback_verification_failed', detail: message });
      }
      return sendJson(res, 502, { error: 'gateway_error', detail: message });
    }
  });
}
