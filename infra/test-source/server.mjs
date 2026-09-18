import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TS_CONTENT_TYPE = 'video/mp2t';

const FFMPEG_ARGS = Object.freeze([
  '-hide_banner', '-loglevel', 'warning',
  '-re',
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p',
  '-g', '50',
  '-keyint_min', '50',
  '-sc_threshold', '0',
  '-b:v', '1800k',
  '-maxrate', '1800k',
  '-bufsize', '3600k',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ar', '48000',
  '-ac', '2',
  '-f', 'mpegts',
  '-mpegts_flags', '+resend_headers',
  'pipe:1',
]);

export function createSyntheticTsServer({ spawnFn = spawn, controlToken = '' } = {}) {
  const stats = {
    activePulls: 0,
    totalPulls: 0,
    maxConcurrentPulls: 0,
    headRequests: 0,
  };
  const sessions = new Set();

  return createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/stats') {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const body = JSON.stringify(stats);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/control/disconnect') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!controlToken || req.headers.authorization !== `Bearer ${controlToken}`) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const active = [...sessions];
      for (const session of active) {
        session.res.destroy();
        session.stop();
      }
      const body = JSON.stringify({ disconnected: active.length });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url.pathname !== '/live.ts') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (req.method === 'HEAD') {
      stats.headRequests += 1;
      res.writeHead(200, {
        'content-type': TS_CONTENT_TYPE,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    stats.totalPulls += 1;
    stats.activePulls += 1;
    stats.maxConcurrentPulls = Math.max(stats.maxConcurrentPulls, stats.activePulls);

    res.writeHead(200, {
      'content-type': TS_CONTENT_TYPE,
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();

    const child = spawnFn('ffmpeg', [...FFMPEG_ARGS], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stopped = false;
    let session = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (session) sessions.delete(session);
      stats.activePulls = Math.max(0, stats.activePulls - 1);
      child.kill?.('SIGTERM');
    };
    session = { res, stop };
    sessions.add(session);

    child.stdout.on?.('error', (error) => {
      if (!res.destroyed) res.destroy(error);
      stop();
    });
    child.on?.('error', (error) => {
      if (!res.destroyed) res.destroy(error);
      stop();
    });
    child.on?.('exit', () => {
      if (!res.writableEnded) res.end();
      stop();
    });

    req.on('aborted', stop);
    res.on('close', stop);
    child.stdout.pipe(res);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const server = createSyntheticTsServer({
    controlToken: process.env.TEST_SOURCE_CONTROL_TOKEN || '',
  });
  server.listen(port, '::', () => {
    console.log(`Synthetic MPEG-TS source listening on [::]:${port}/live.ts`);
  });
}
