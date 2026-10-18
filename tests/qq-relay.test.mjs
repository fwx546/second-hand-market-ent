import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createRelay, readRelayConfig, qqTransportOptions } from '../relay/core.mjs';
import { createRelayHttpServer } from '../relay/http.mjs';

// All credentials and recipients below are fictional; transport is always injected.
const TOKEN = 'unit_test_only_' + 'x'.repeat(40);
const ENV = { JUZI_RELAY_TOKEN: TOKEN, QQ_SMTP_USER: '123456789@qq.com', QQ_SMTP_AUTH_CODE: 'abcdefghijklmnop' };
const SCHOOL_EMAIL = 'example.student23@student.xjtlu.edu.cn';
const bodyFor = overrides => ({ requestId: randomUUID(), email: SCHOOL_EMAIL, code: '614289', ...overrides });
const accepted = message => ({ accepted: [message.envelope.to[0]], rejected: [], response: '250 2.0.0 accepted' });
function requestFor(body = bodyFor(), { headers = {}, method = 'POST', path = '/send', signal } = {}) {
  return new Request(`http://127.0.0.1:4180${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, signal,
    body: method === 'GET' || method === 'HEAD' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function result(relay, body, options) {
  const response = await relay.handle(requestFor(body, options));
  return { response, status: response.status, data: await response.json() };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'juzi-qq-relay-test-'));
  const filename = join(directory, 'relay.sqlite');
  const env = { ...ENV, ...options.env };
  const calls = [];
  const sendMail = message => { calls.push(message); return options.sendMail ? options.sendMail(message) : Promise.resolve(accepted(message)); };
  let relay = createRelay({ env, filename, sendMail, timeoutMs: options.timeoutMs, now: options.now });
  const value = {
    calls, filename, env,
    get relay() { return relay; },
    async restart() { await relay.close(); relay = createRelay({ env, filename, sendMail, now: options.now }); },
    async rows() {
      await relay.close();
      const sqlite = new DatabaseSync(filename);
      try { return sqlite.prepare('SELECT * FROM relay_requests ORDER BY created_at, request_id').all(); }
      finally { sqlite.close(); }
    },
  };
  t.after(async () => {
    await relay.close();
    // No recursive deletion: this fixture owns only the files directly in its temp directory.
    for (const entry of readdirSync(directory)) unlinkSync(join(directory, entry));
    rmdirSync(directory);
  });
  return value;
}

test('QQ relay configuration and transport fix SMTP/TLS and reject incomplete settings', () => {
  const config = readRelayConfig(ENV), options = qqTransportOptions(config);
  assert.equal(config.dailyLimit, 50);
  assert.equal(readRelayConfig({ ...ENV, QQ_RELAY_DAILY_LIMIT: '' }).dailyLimit, 50);
  assert.equal(options.host, 'smtp.qq.com'); assert.equal(options.port, 465);
  assert.equal(options.secure, true); assert.equal(options.pool, false);
  assert.deepEqual(options.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.qq.com' });
  for (const field of ['logger', 'debug', 'transactionLog']) assert.equal(options[field], false);
  for (const field of ['disableFileAccess', 'disableUrlAccess']) assert.equal(options[field], true);
  assert.equal(options.maxRecipients, 1);
  assert.equal(readRelayConfig({ ...ENV, QQ_SMTP_AUTH_CODE: ' abcdefghijklmnop ' }).authCode, 'abcdefghijklmnop');
  for (const overrides of [
    { JUZI_RELAY_TOKEN: '' }, { JUZI_RELAY_TOKEN: 'short' }, { JUZI_RELAY_TOKEN: `${TOKEN}\n` },
    { QQ_SMTP_USER: 'attacker@example.com' }, { QQ_SMTP_USER: 'Display <123456789@qq.com>' },
    { QQ_SMTP_AUTH_CODE: 'password12345678' }, { QQ_SMTP_AUTH_CODE: '' },
    { QQ_RELAY_DAILY_LIMIT: '0' }, { QQ_RELAY_DAILY_LIMIT: '1001' }, { QQ_RELAY_DAILY_LIMIT: '2.5' },
  ]) assert.throws(() => readRelayConfig({ ...ENV, ...overrides }), /configuration/);
  assert.throws(() => createRelay({ env: ENV, sendMail: accepted, timeoutMs: 12001 }), /runtime/);
});

test('QQ relay confirms one SMTP target, fixes message fields and persists only hashes', async t => {
  const f = fixture(t), body = bodyFor({ email: ' Example.Student23@student.xjtlu.edu.cn ' });
  const response = await result(f.relay, body);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.data), ['id']); assert.match(response.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(response.response.headers.get('cache-control'), 'no-store');
  assert.equal(response.response.headers.get('access-control-allow-origin'), null);
  assert.equal(f.calls.length, 1);
  const message = f.calls[0];
  assert.deepEqual(message.from, { name: '橘子集', address: ENV.QQ_SMTP_USER });
  assert.deepEqual(message.to, [{ address: SCHOOL_EMAIL }]);
  assert.deepEqual(message.envelope, { from: ENV.QQ_SMTP_USER, to: [SCHOOL_EMAIL] });
  assert.match(message.text, /614289/); assert.match(message.text, /10 分钟/);
  assert.equal(message.disableFileAccess, true); assert.equal(message.disableUrlAccess, true);
  for (const field of ['html', 'attachments', 'cc', 'bcc', 'raw', 'headers', 'replyTo']) assert.equal(message[field], undefined);
  const rows = await f.rows();
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].confirmation_id, response.data.id);
  assert.match(rows[0].recipient_hash, /^[0-9a-f]{64}$/); assert.match(rows[0].content_hmac, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['confirmation_id', 'content_hmac', 'created_at', 'recipient_hash', 'request_id', 'status']);
  const file = readFileSync(f.filename);
  for (const secret of [SCHOOL_EMAIL, ENV.QQ_SMTP_USER, ENV.QQ_SMTP_AUTH_CODE, TOKEN]) assert.equal(file.includes(Buffer.from(secret)), false);
});

test('QQ relay checks authentication, rejects browser requests and exposes only the send route', async t => {
  const f = fixture(t);
  const cases = [
    [{ headers: { authorization: '' } }, 401],
    [{ headers: { authorization: 'Bearer wrong' } }, 401],
    [{ headers: { authorization: `Basic ${TOKEN}` } }, 401],
    [{ headers: { origin: 'http://localhost:4174' } }, 403],
    [{ headers: { origin: 'null' } }, 403],
    [{ headers: { origin: '' } }, 403],
    [{ method: 'GET' }, 405],
    [{ path: '/anything' }, 404],
    [{ path: '/send/' }, 404],
    [{ path: '/send?to=other' }, 404],
  ];
  for (const [options, status] of cases) assert.equal((await result(f.relay, bodyFor(), options)).status, status);
  assert.equal(f.calls.length, 0);
});

test('QQ relay rejects foreign domains, injection fields, malformed JSON and invalid OTP/IDs', async t => {
  const f = fixture(t);
  for (const email of [
    'student@example.com', 'student@sub.student.xjtlu.edu.cn', 'student@student.xjtlu.edu.cn.attacker.com',
    '.student@student.xjtlu.edu.cn', 'student.@student.xjtlu.edu.cn', 'stu..dent@student.xjtlu.edu.cn',
    'student@STUDENT.XJTLU.EDU.CN\r\nBcc:other@example.com', 'a@student.xjtlu.edu.cn,b@student.xjtlu.edu.cn',
    '<student@student.xjtlu.edu.cn>', '学生@student.xjtlu.edu.cn', `${'a'.repeat(65)}@student.xjtlu.edu.cn`, '', null, [],
  ]) assert.equal((await result(f.relay, bodyFor({ email }))).status, 400);
  for (const code of ['12345', '1234567', '12345a', '１２３４５６', 123456, null]) assert.equal((await result(f.relay, bodyFor({ code }))).status, 400);
  for (const requestId of ['not-a-uuid', randomUUID() + 'x', null, '00000000-0000-0000-0000-000000000000']) assert.equal((await result(f.relay, bodyFor({ requestId }))).status, 400);
  for (const key of ['from', 'subject', 'text', 'attachments', 'cc', 'bcc', 'to', '__proto__']) {
    const value = bodyFor(); Object.defineProperty(value, key, { enumerable: true, value: 'injected' });
    assert.equal((await result(f.relay, value)).status, 400);
  }
  for (const raw of ['', '{', 'null', '[]', '{}']) assert.equal((await result(f.relay, raw)).status, 400);
  const missing = bodyFor(); delete missing.code;
  assert.equal((await result(f.relay, missing)).status, 400);
  assert.equal((await result(f.relay, bodyFor(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await result(f.relay, 'x'.repeat(2049))).status, 413);
  assert.equal((await result(f.relay, bodyFor(), { headers: { 'content-length': '99999' } })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('QQ relay handles a bounded chunked web Request and interrupted body without SMTP', async t => {
  const f = fixture(t); let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2049)); },
    cancel() { cancelled = true; },
  });
  const large = new Request('http://127.0.0.1/send', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal((await f.relay.handle(large)).status, 413); assert.equal(cancelled, true);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('fictional read failure')); } });
  const interrupted = new Request('http://127.0.0.1/send', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: broken, duplex: 'half' });
  assert.equal((await f.relay.handle(interrupted)).status, 400);
  const abort = new AbortController(); abort.abort();
  assert.equal((await result(f.relay, bodyFor(), { signal: abort.signal })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('QQ relay successful retries survive restart and different content conflicts', async t => {
  const f = fixture(t), body = bodyFor();
  const first = await result(f.relay, body);
  assert.equal((await result(f.relay, body)).data.id, first.data.id);
  assert.equal((await result(f.relay, { ...body, requestId: body.requestId.toUpperCase(), email: SCHOOL_EMAIL.toUpperCase() })).data.id, first.data.id);
  assert.equal((await result(f.relay, { ...body, code: '789101' })).status, 409);
  assert.equal((await result(f.relay, { ...body, email: 'another.student@student.xjtlu.edu.cn' })).status, 409);
  await f.restart();
  const repeated = await result(f.relay, body);
  assert.equal(repeated.status, 200); assert.equal(repeated.data.id, first.data.id);
  assert.equal(f.calls.length, 1);
});

test('QQ relay token rotation cannot silently resend a retained successful request', async t => {
  const f = fixture(t), body = bodyFor();
  assert.equal((await result(f.relay, body)).status, 200);
  const rotated = 'unit_test_rotated_' + 'y'.repeat(40);
  f.env.JUZI_RELAY_TOKEN = rotated;
  await f.restart();
  const retry = await result(f.relay, body, { headers: { authorization: `Bearer ${rotated}` } });
  assert.equal(retry.status, 409); assert.equal(retry.data.error.code, 'REQUEST_CONFLICT');
  assert.equal(f.calls.length, 1);
});

test('QQ relay requires accepted target, empty rejected list and final SMTP 250', async t => {
  const outcomes = [
    { accepted: [], rejected: [], response: '250 accepted' },
    { accepted: ['other@student.xjtlu.edu.cn'], rejected: [], response: '250 accepted' },
    { accepted: [SCHOOL_EMAIL, 'other@student.xjtlu.edu.cn'], rejected: [], response: '250 accepted' },
    { accepted: [SCHOOL_EMAIL], rejected: ['other@student.xjtlu.edu.cn'], response: '250 accepted' },
    { accepted: [SCHOOL_EMAIL], rejected: [], response: '251 forward' },
    { accepted: [SCHOOL_EMAIL], rejected: [], response: '2500 invalid' },
    { accepted: [SCHOOL_EMAIL], response: '250 accepted' },
    { accepted: [SCHOOL_EMAIL], rejected: [] }, null,
  ];
  let index = 0;
  const f = fixture(t, { sendMail: async () => outcomes[index++] });
  for (let count = 0; count < outcomes.length; count++) {
    const body = bodyFor(), failed = await result(f.relay, body);
    assert.equal(failed.status, 503); assert.equal(failed.data.id, undefined);
    assert.equal((await result(f.relay, body)).status, 409);
  }
  assert.equal(f.calls.length, outcomes.length);
  assert.equal((await f.rows()).every(row => row.status === 'unknown'), true);
});

test('QQ relay does not leak SMTP errors or retry failures, and failures use persistent quota', async t => {
  const f = fixture(t, { env: { QQ_RELAY_DAILY_LIMIT: '2' }, sendMail: async () => { throw new Error(`SMTP ${SCHOOL_EMAIL} ${ENV.QQ_SMTP_AUTH_CODE} code 614289`); } });
  const firstBody = bodyFor(), first = await result(f.relay, firstBody);
  assert.equal(first.status, 503);
  const serialized = JSON.stringify(first.data);
  for (const value of [SCHOOL_EMAIL, ENV.QQ_SMTP_AUTH_CODE, '614289', 'SMTP']) assert.equal(serialized.includes(value), false);
  assert.equal((await result(f.relay, firstBody)).status, 409);
  assert.equal((await result(f.relay, bodyFor())).status, 503);
  await f.restart();
  const limited = await result(f.relay, bodyFor());
  assert.equal(limited.status, 429); assert.equal(limited.data.error.code, 'RELAY_DAILY_LIMIT');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.rows()).every(row => row.status === 'failed'), true);
});

test('QQ relay simultaneous requests cannot exceed the quota or open two SMTP sessions', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { env: { QQ_RELAY_DAILY_LIMIT: '1' }, sendMail: async message => { entered.resolve(); await finish.promise; return accepted(message); } });
  const body = bodyFor(), pending = result(f.relay, body);
  await entered.promise;
  assert.equal((await result(f.relay, body)).status, 409);
  const other = await Promise.all(Array.from({ length: 8 }, () => result(f.relay, bodyFor())));
  assert.equal(other.every(value => value.status === 503 && value.data.error.code === 'RELAY_BUSY'), true);
  assert.equal(f.calls.length, 1);
  finish.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await result(f.relay, bodyFor())).status, 429);
});

test('QQ relay quota is rolling 24h and second process cannot take the active ledger', async t => {
  let clock = 1750000000000;
  const f = fixture(t, { env: { QQ_RELAY_DAILY_LIMIT: '1' }, now: () => clock });
  assert.throws(() => createRelay({ env: ENV, filename: f.filename, sendMail: async message => accepted(message) }), /ledger/);
  assert.equal((await result(f.relay, bodyFor())).status, 200);
  clock += 86400000 - 1;
  assert.equal((await result(f.relay, bodyFor())).status, 429);
  clock += 1;
  assert.equal((await result(f.relay, bodyFor())).status, 200);
  assert.equal(f.calls.length, 2);
});

test('QQ relay restart marks reserved deliveries unknown and never automatically resends', async t => {
  const f = fixture(t), body = bodyFor();
  const succeeded = await result(f.relay, body);
  assert.equal(succeeded.status, 200);
  await f.relay.close();
  const sqlite = new DatabaseSync(f.filename);
  sqlite.prepare("UPDATE relay_requests SET status='reserved', confirmation_id=NULL WHERE request_id=?").run(body.requestId);
  sqlite.close();
  await f.restart();
  assert.equal((await result(f.relay, body)).status, 409);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.rows())[0].status, 'unknown');
});

test('QQ relay timeout retains busy until SMTP really settles and never adopts late success', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { env: { QQ_RELAY_DAILY_LIMIT: '1' }, timeoutMs: 15, sendMail: async message => { entered.resolve(); await finish.promise; return accepted(message); } });
  const body = bodyFor(), pending = result(f.relay, body);
  await entered.promise;
  assert.equal((await pending).status, 503);
  assert.equal((await result(f.relay, body)).status, 409);
  assert.equal((await result(f.relay, bodyFor())).data.error.code, 'RELAY_BUSY');
  finish.resolve();
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assert.equal((await result(f.relay, body)).status, 409);
  assert.equal((await result(f.relay, bodyFor())).status, 429);
  await f.restart();
  assert.equal((await result(f.relay, bodyFor())).status, 429);
  assert.equal((await result(f.relay, body)).status, 409);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.rows())[0].status, 'unknown');
});

function sendHttp(port, bytes, headers = {}) {
  return new Promise((resolveHttp, rejectHttp) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/send', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolveHttp({ status: incoming.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', rejectHttp);
    if (Array.isArray(bytes)) { for (const part of bytes) outgoing.write(part); outgoing.end(); }
    else outgoing.end(bytes);
  });
}

test('QQ relay HTTP wrapper limits streamed bodies, rejects browsers and survives disconnect', async t => {
  const f = fixture(t), server = createRelayHttpServer(f.relay);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolveClose => { server.closeIdleConnections(); server.close(resolveClose); }));
  const port = server.address().port;
  assert.equal((await sendHttp(port, 'x', { 'content-length': '9999' })).status, 413);
  assert.equal((await sendHttp(port, [Buffer.alloc(1025), Buffer.alloc(1024)], { 'transfer-encoding': 'chunked' })).status, 413);
  assert.equal((await sendHttp(port, JSON.stringify(bodyFor()), { origin: 'http://localhost:4174' })).status, 403);
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {}); await once(socket, 'connect');
  socket.write(`POST /send HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await new Promise(resolveTurn => setTimeout(resolveTurn, 20)); socket.destroy();
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assert.equal(f.calls.length, 0);
  const valid = await sendHttp(port, JSON.stringify(bodyFor()));
  assert.equal(valid.status, 200); assert.equal(f.calls.length, 1);
});
