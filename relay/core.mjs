import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readRelayRuntime } from './runtime.mjs';

export const MAX_BODY_BYTES = 2048;
const DAY = 86400000;
const SCHOOL_DOMAIN = 'student.xjtlu.edu.cn';
const RELAY_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const sha256 = value => createHash('sha256').update(value).digest();

class RelayError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
const fail = (status, code, message, retryAfter) => { throw new RelayError(status, code, message, retryAfter); };
export function relayJson(value, status = 200, retryAfter = 0) {
  const headers = new Headers(RESPONSE_HEADERS);
  if (retryAfter) headers.set('Retry-After', String(retryAfter));
  return new Response(JSON.stringify(value), { status, headers });
}
export function relayError(code, message, status = 503, retryAfter = 0) {
  return relayJson({ error: { code, message } }, status, retryAfter);
}

/** Only public variable names belong in source. Never print this returned object. */
export function readRelayConfig(env) {
  const runtime = readRelayRuntime(env);
  const token = env.JUZI_RELAY_TOKEN;
  const user = typeof env.QQ_SMTP_USER === 'string' ? env.QQ_SMTP_USER.trim().toLowerCase() : '';
  const authCode = typeof env.QQ_SMTP_AUTH_CODE === 'string' ? env.QQ_SMTP_AUTH_CODE.trim() : '';
  const daily = String(env.QQ_RELAY_DAILY_LIMIT ?? '').trim() || '50';
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token) ||
      !/^[1-9]\d{4,11}@qq\.com$/.test(user) || !/^[a-zA-Z]{16}$/.test(authCode) ||
      !/^[1-9]\d{0,3}$/.test(daily) || Number(daily) > 1000) {
    throw new Error('QQ relay configuration is incomplete or invalid. See relay/.env.example.');
  }
  const configuredPath = env.QQ_RELAY_DB_PATH?.trim();
  const filename = runtime.filename || (configuredPath ? (isAbsolute(configuredPath) ? configuredPath : resolve(RELAY_DIRECTORY, configuredPath)) : resolve(RELAY_DIRECTORY, '.state', 'relay.sqlite'));
  return { token, user, authCode, dailyLimit: Number(daily), filename, publicOrigin: runtime.publicOrigin, mode: runtime.mode, dataDirectory: runtime.dataDirectory };
}

export function qqTransportOptions(config) {
  return {
    host: 'smtp.qq.com', port: 465, secure: true, pool: false,
    auth: { user: config.user, pass: config.authCode },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.qq.com' },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000, dnsTimeout: 5000,
    logger: false, debug: false, transactionLog: false,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
  };
}

function normalizedEmail(value) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'INVALID_EMAIL', 'Invalid school email.');
  const email = value.trim().toLowerCase(), parts = email.split('@');
  if (parts.length !== 2 || parts[1] !== SCHOOL_DOMAIN || !/^[a-z0-9._%+-]{1,64}$/.test(parts[0]) ||
      parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) {
    fail(400, 'INVALID_EMAIL', 'Only the configured school email domain is accepted.');
  }
  return email;
}

async function readBody(request) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') || '')) fail(415, 'UNSUPPORTED_TYPE', 'JSON is required.');
  const reader = request.body?.getReader();
  if (!reader || request.signal.aborted) fail(400, 'INVALID_INPUT', 'Request body is unavailable.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'Request body is too large.'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    fail(400, 'INVALID_INPUT', 'Request body is unavailable.');
  } finally { reader.releaseLock(); }
  if (request.signal.aborted || !size) fail(400, 'INVALID_INPUT', 'Request body is unavailable.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { fail(400, 'INVALID_INPUT', 'Invalid JSON body.'); }
  const fields = ['requestId', 'email', 'code'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 || Object.keys(body).some(key => !fields.includes(key)) ||
      typeof body.requestId !== 'string' || !UUID.test(body.requestId) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    fail(400, 'INVALID_INPUT', 'Invalid request fields.');
  }
  return { requestId: body.requestId.toLowerCase(), email: normalizedEmail(body.email), code: body.code };
}

function fixedMessage(config, body) {
  return {
    from: { name: '橘子集', address: config.user },
    to: [{ address: body.email }],
    envelope: { from: config.user, to: [body.email] },
    subject: '橘子集 · 学校邮箱登录验证码',
    text: `你的橘子集登录验证码：${body.code}\n\n验证码 10 分钟内有效，请勿转发。如非本人操作，请忽略此邮件。\n\n本次仅验证学生邮箱控制权，不验证在读学籍。这不是学校官方通知。`,
    disableFileAccess: true, disableUrlAccess: true,
  };
}

function acceptedExactly(info, email) {
  return Boolean(info && Array.isArray(info.accepted) && info.accepted.length === 1 &&
    typeof info.accepted[0] === 'string' && info.accepted[0].toLowerCase() === email &&
    Array.isArray(info.rejected) && info.rejected.length === 0 && typeof info.response === 'string' && /^250(?:\s|$)/.test(info.response));
}

/**
 * sendMail is injected in tests. The core never imports SMTP or opens a connection.
 * One process exclusively owns the ledger; a second process must fail closed.
 */
export function createRelay({ env, sendMail, now = Date.now, timeoutMs = 12000, filename } = {}) {
  const config = readRelayConfig(env || {});
  if (typeof sendMail !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw new Error('Invalid relay runtime configuration.');
  const ledgerFile = filename || config.filename;
  if (config.mode === 'production' && ledgerFile !== config.filename) throw new Error('Production relay must use the configured persistent ledger.');
  if (config.mode === 'production') {
    try { if (!statSync(config.dataDirectory).isDirectory()) throw new Error(); }
    catch { throw new Error('Production relay persistent data directory is unavailable.'); }
  }
  if (ledgerFile !== ':memory:') mkdirSync(dirname(ledgerFile), { recursive: true });
  const db = new DatabaseSync(ledgerFile);
  try {
    db.exec(`PRAGMA busy_timeout=100;
      PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS relay_requests (
        request_id TEXT PRIMARY KEY,
        recipient_hash TEXT NOT NULL,
        content_hmac TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','sent','failed','unknown')),
        confirmation_id TEXT,
        CHECK ((status='sent' AND confirmation_id IS NOT NULL) OR (status<>'sent' AND confirmation_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS relay_requests_created ON relay_requests(created_at);
      BEGIN IMMEDIATE;
      UPDATE relay_requests SET status='unknown' WHERE status='reserved';
      COMMIT;`);
  } catch {
    try { db.close(); } catch { /* no credential-bearing errors */ }
    throw new Error('Relay ledger is unavailable or already in use.');
  }
  const tokenDigest = sha256(config.token);
  const ledgerKey = createHmac('sha256', config.token).update('juzi-qq-relay-ledger-v1').digest();
  let busy = false, closing = false, closed = false, smtpSettlement = Promise.resolve();
  const inFlight = new Set();

  function reserve(body) {
    const digest = createHmac('sha256', ledgerKey).update(`${body.requestId}\0${body.email}\0${body.code}`).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT content_hmac, status, confirmation_id FROM relay_requests WHERE request_id=?').get(body.requestId);
      if (previous) {
        if (previous.content_hmac !== digest) fail(409, 'REQUEST_CONFLICT', 'This request ID was already used for different content.');
        if (previous.status === 'sent') { db.exec('COMMIT'); return previous.confirmation_id; }
        fail(409, 'REQUEST_NOT_RETRYABLE', 'This request was already attempted; request a new verification code.');
      }
      if (busy) fail(503, 'RELAY_BUSY', 'Another delivery is still running.', 2);
      const timestamp = now();
      const quota = db.prepare('SELECT count(*) AS count FROM relay_requests WHERE created_at > ?').get(timestamp - DAY);
      if (Number(quota.count) >= config.dailyLimit) fail(429, 'RELAY_DAILY_LIMIT', 'Relay sending quota has been reached.', 3600);
      db.prepare("INSERT INTO relay_requests (request_id, recipient_hash, content_hmac, created_at, status, confirmation_id) VALUES (?, ?, ?, ?, 'reserved', NULL)")
        .run(body.requestId, sha256(body.email).toString('hex'), digest, timestamp);
      db.exec('COMMIT');
      busy = true;
      return null;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* closed transaction */ } throw error; }
  }

  function preflight(request) {
    try {
      if (closing) fail(503, 'RELAY_UNAVAILABLE', 'Relay is shutting down.');
      const url = new URL(request.url);
      if (config.publicOrigin && (url.origin !== config.publicOrigin ||
          (request.headers.has('host') && request.headers.get('host') !== new URL(config.publicOrigin).host))) fail(421, 'WRONG_HOST', 'Unexpected request host.');
      if (!['/send', '/healthz'].includes(url.pathname) || url.search || url.hash) fail(404, 'NOT_FOUND', 'Endpoint not found.');
      if (request.headers.has('origin')) fail(403, 'BROWSER_REQUEST_REJECTED', 'Browser requests are not accepted.');
      if (url.pathname === '/healthz') {
        if (request.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Only GET is accepted.');
        db.prepare('SELECT 1').get();
        return relayJson({ ok: true });
      }
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Only POST is accepted.');
      const authorization = request.headers.get('authorization') || '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 4103 || !timingSafeEqual(sha256(authorization.slice(7)), tokenDigest)) fail(401, 'UNAUTHORIZED', 'Authentication is required.');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') || '')) fail(415, 'UNSUPPORTED_TYPE', 'JSON is required.');
      return null;
    } catch (error) {
      if (error instanceof RelayError) return relayError(error.code, error.message, error.status, error.retryAfter);
      return relayError('RELAY_UNAVAILABLE', 'Relay could not complete the request.');
    }
  }
  async function handle(request) {
    try {
      const rejection = preflight(request);
      if (rejection) return rejection;
      const body = await readBody(request);
      if (closing) fail(503, 'RELAY_UNAVAILABLE', 'Relay is shutting down.');
      const existingId = reserve(body);
      if (existingId) return relayJson({ id: existingId });

      let timer;
      // Even after HTTP timeout, retain the busy lock until the SMTP operation settles.
      // No retry or replacement session is started while its result is uncertain.
      const smtp = Promise.resolve().then(() => sendMail(fixedMessage(config, body)));
      smtpSettlement = smtp.then(value => ({ kind: 'result', value }), () => ({ kind: 'error' })).finally(() => { busy = false; });
      const outcome = await Promise.race([
        smtpSettlement,
        new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (closed) fail(503, 'DELIVERY_UNCONFIRMED', 'Delivery could not be confirmed; do not retry this request.');
      if (outcome.kind === 'timeout') {
        db.prepare("UPDATE relay_requests SET status='unknown' WHERE request_id=? AND status='reserved'").run(body.requestId);
        fail(503, 'DELIVERY_UNCONFIRMED', 'Delivery could not be confirmed; do not retry this request.');
      }
      if (outcome.kind !== 'result' || !acceptedExactly(outcome.value, body.email)) {
        db.prepare("UPDATE relay_requests SET status=? WHERE request_id=? AND status='reserved'").run(outcome.kind === 'error' ? 'failed' : 'unknown', body.requestId);
        fail(503, 'DELIVERY_UNCONFIRMED', 'Delivery could not be confirmed; do not retry this request.');
      }
      const confirmationId = randomUUID();
      db.prepare("UPDATE relay_requests SET status='sent', confirmation_id=? WHERE request_id=? AND status='reserved'").run(confirmationId, body.requestId);
      return relayJson({ id: confirmationId });
    } catch (error) {
      if (error instanceof RelayError) return relayError(error.code, error.message, error.status, error.retryAfter);
      // Never reflect SMTP errors, raw email, OTP, provider responses, or configuration.
      return relayError('RELAY_UNAVAILABLE', 'Relay could not complete the request.');
    }
  }
  return {
    publicOrigin: config.publicOrigin,
    preflight,
    handle(request) {
      const operation = handle(request);
      inFlight.add(operation);
      operation.finally(() => inFlight.delete(operation));
      return operation;
    },
    async close({ timeoutMs: closeTimeout } = {}) {
      if (closed) return;
      if (closeTimeout !== undefined && (!Number.isInteger(closeTimeout) || closeTimeout < 1 || closeTimeout > 300000)) throw new Error('Invalid relay shutdown timeout.');
      closing = true;
      let timer;
      const drained = Promise.allSettled([...inFlight, smtpSettlement]);
      if (closeTimeout === undefined) await drained;
      else await Promise.race([drained, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, closeTimeout); })]);
      clearTimeout(timer);
      if (!closed) {
        // A process may be killed after its grace period. Preserve ambiguity; a restart must never resend.
        db.prepare("UPDATE relay_requests SET status='unknown' WHERE status='reserved'").run();
        db.close(); closed = true;
      }
    },
  };
}
