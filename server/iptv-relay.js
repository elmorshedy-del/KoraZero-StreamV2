import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createIptvRelay } from './iptv-relay-core.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

const relay = createIptvRelay(process.env, {
  log(event) {
    console.log(`V2 IPTV relay ${JSON.stringify(event)}`);
  },
});

const server = createServer(async (req, res) => {
  const abortController = new AbortController();
  res.once('close', () => abortController.abort());

  try {
    const pathname = new URL(req.url || '/', 'http://relay.internal').pathname;
    const response = await relay.handle({
      method: req.method || 'GET',
      pathname,
      signal: abortController.signal,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (!response.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body);
    body.on('error', (error) => {
      console.error(`V2 IPTV relay body error ${error?.name || 'Error'}: ${error?.message || 'unknown'}`);
      if (!res.destroyed) res.destroy(error);
    });
    body.pipe(res);
  } catch (error) {
    console.error(`V2 IPTV relay request failed ${error?.name || 'Error'}: ${error?.message || 'unknown'}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Relay error');
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
});

server.listen(port, '::', () => {
  console.log(`KoraZero Stream V2 private IPTV relay listening on ${port}`);
});
