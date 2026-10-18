import { createServer } from 'node:http';
import { MAX_BODY_BYTES, relayError } from './core.mjs';

const MAX_READ_MS = 10000;

async function writeResponse(response, outgoing, closeConnection = false) {
  if (outgoing.destroyed || outgoing.writableEnded) return;
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) outgoing.setHeader(key, value);
  if (closeConnection) outgoing.setHeader('Connection', 'close');
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Read at most 2 KiB before constructing a web Request, including chunked bodies. */
function readIncoming(incoming) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []; let size = 0, completed = false;
    const timer = setTimeout(() => finish(null, { status: 408, code: 'REQUEST_TIMEOUT' }), MAX_READ_MS);
    function finish(value, failure) {
      if (completed) return;
      completed = true; clearTimeout(timer);
      incoming.removeListener('data', onData); incoming.removeListener('end', onEnd);
      incoming.removeListener('aborted', onAborted); incoming.removeListener('error', onError);
      incoming.on('error', () => {});
      if (failure) { incoming.pause(); rejectBody(failure); }
      else resolveBody(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(null, { status: 413, code: 'BODY_TOO_LARGE' });
      else chunks.push(chunk);
    }
    function onEnd() { finish(Buffer.concat(chunks, size)); }
    function onAborted() { finish(null, { status: 400, code: 'REQUEST_ABORTED' }); }
    function onError() { finish(null, { status: 400, code: 'REQUEST_ABORTED' }); }
    incoming.on('data', onData); incoming.once('end', onEnd);
    incoming.once('aborted', onAborted); incoming.once('error', onError);
  });
}

/** Render terminates TLS. Trust only configured Host, never X-Forwarded-* to select the public origin. */
export function createRelayHttpServer(relay) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 2048 || incoming.url.includes('\\')) {
        await writeResponse(relayError('INVALID_REQUEST', 'Invalid request target.', 400), outgoing, true); return;
      }
      if (relay.publicOrigin && incoming.headers.host !== new URL(relay.publicOrigin).host) {
        await writeResponse(relayError('WRONG_HOST', 'Unexpected request host.', 421), outgoing, true); return;
      }
      if (!['/send', '/healthz'].includes(incoming.url)) {
        await writeResponse(relayError('NOT_FOUND', 'Endpoint not found.', 404), outgoing, true); return;
      }
      const length = incoming.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
        await writeResponse(relayError('BODY_TOO_LARGE', 'Request body is too large.', 413), outgoing, true); return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const requestUrl = `${relay.publicOrigin || 'http://127.0.0.1'}${incoming.url}`;
      // Includes constant-time Bearer verification: invalid tokens cannot keep us waiting for a body.
      const earlyResponse = relay.preflight(new Request(requestUrl, { method: incoming.method, headers }));
      if (earlyResponse) { await writeResponse(earlyResponse, outgoing, true); return; }
      const bytes = await readIncoming(incoming);
      const request = new Request(requestUrl, { method: incoming.method, headers, body: bytes });
      await writeResponse(await relay.handle(request), outgoing);
    } catch (failure) {
      const status = failure?.status === 413 ? 413 : failure?.status === 408 ? 408 : 400;
      const code = status === 413 ? 'BODY_TOO_LARGE' : status === 408 ? 'REQUEST_TIMEOUT' : 'INVALID_REQUEST';
      await writeResponse(relayError(code, 'Request could not be read.', status), outgoing, true).catch(() => {});
    }
  });
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 100;
  server.setTimeout(20000, socket => socket.destroy());
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  return server;
}
