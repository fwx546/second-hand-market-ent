import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRelay, readRelayConfig, qqTransportOptions } from '../relay/core.mjs';
import { createRelayHttpServer } from '../relay/http.mjs';
import { readRelayRuntime } from '../relay/runtime.mjs';

// All recipients/credentials are fictional. No SMTP library or real network mail is used.
const TOKEN = 'TEST_ONLY_PUBLIC_RELAY_' + 'x'.repeat(40);
const ORIGIN = 'https://juzi-relay-fixture.onrender.com';
const HOST = new URL(ORIGIN).host;
const ENV = { JUZI_RELAY_TOKEN: TOKEN, QQ_SMTP_USER: '123456789@qq.com', QQ_SMTP_AUTH_CODE: 'abcdefghijklmnop' };
const bodyFor = () => ({ requestId: randomUUID(), email: 'public.relay23@student.xjtlu.edu.cn', code: '462971' });
const accepted = message => ({ accepted: message.envelope.to, rejected: [], response: '250 accepted' });
const productionEnv = directory => ({ ...ENV, JUZI_RELAY_MODE: 'production', NODE_ENV: 'production',
  JUZI_RELAY_PUBLIC_ORIGIN: ORIGIN, QQ_RELAY_DATA_DIR: directory, QQ_RELAY_DB_PATH: join(directory, 'relay.sqlite') });
function fixture(t, { sendMail = accepted, limit = '50' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'juzi-public-relay-test-'));
  const env = { ...productionEnv(directory), QQ_RELAY_DAILY_LIMIT: limit }, calls = [];
  let relay = createRelay({ env, sendMail: message => { calls.push(message); return sendMail(message); } });
  const state = { directory, env, calls, get relay() { return relay; }, async restart() {
    await relay.close(); relay = createRelay({ env, sendMail: message => { calls.push(message); return sendMail(message); } });
  }, async rows() {
    await relay.close();
    const db = new DatabaseSync(env.QQ_RELAY_DB_PATH);
    try { return db.prepare('SELECT * FROM relay_requests').all(); } finally { db.close(); }
  } };
  t.after(async () => {
    await relay.close();
    for (const entry of readdirSync(directory)) unlinkSync(join(directory, entry));
    rmdirSync(directory);
  });
  return state;
}
function webRequest(body, { url = ORIGIN + '/send', headers = {}, method = 'POST' } = {}) {
  return new Request(url, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) });
}
async function listen(t, relay) {
  const server = createRelayHttpServer(relay);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return { server, port: server.address().port };
}
function http(port, { path = '/send', method = 'POST', headers = {}, body = bodyFor() } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method,
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject); request.end(method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body));
  });
}

test('public relay remains loopback unless explicitly opted into production', () => {
  const local = readRelayRuntime({ NODE_ENV: 'production', PORT: '10000', RENDER: 'true', RENDER_EXTERNAL_URL: ORIGIN });
  assert.equal(local.mode, 'local'); assert.equal(local.host, '127.0.0.1'); assert.equal(local.port, 4180);
  assert.equal(local.publicOrigin, null);
  assert.throws(() => readRelayRuntime({ QQ_RELAY_HOST: '0.0.0.0' }), /configuration/);
  for (const value of ['0', '04180', '65536', '4180x']) assert.throws(() => readRelayRuntime({ QQ_RELAY_PORT: value }), /configuration/);
  assert.throws(() => readRelayRuntime({ JUZI_RELAY_MODE: 'public' }), /configuration/);
});

test('production relay validates HTTPS public DNS origin, platform mode and persistent ledger path', t => {
  const state = fixture(t), env = state.env;
  const config = readRelayRuntime({ ...env, PORT: '10999' });
  assert.equal(config.host, '0.0.0.0'); assert.equal(config.port, 10999); assert.equal(config.filename, env.QQ_RELAY_DB_PATH);
  assert.equal(config.publicOrigin, ORIGIN);
  const provider = { ...env, JUZI_RELAY_PUBLIC_ORIGIN: undefined, RENDER: 'true', RENDER_EXTERNAL_URL: ORIGIN };
  assert.equal(readRelayRuntime(provider).publicOrigin, ORIGIN);
  assert.equal(readRelayRuntime({ ...provider, JUZI_RELAY_PUBLIC_ORIGIN: 'https://mail.example.org' }).publicOrigin, 'https://mail.example.org');
  for (const overrides of [
    { NODE_ENV: 'development' }, { QQ_RELAY_HOST: '127.0.0.1' }, { QQ_RELAY_PORT: '4180' },
    { QQ_RELAY_DATA_DIR: '' }, { QQ_RELAY_DB_PATH: '' }, { QQ_RELAY_DB_PATH: ':memory:' },
    { QQ_RELAY_DB_PATH: '.state/relay.sqlite' }, { QQ_RELAY_DB_PATH: join(env.QQ_RELAY_DATA_DIR, '..', 'other.sqlite') },
    { QQ_RELAY_DB_PATH: env.QQ_RELAY_DATA_DIR }, { QQ_RELAY_DATA_DIR: parse(env.QQ_RELAY_DATA_DIR).root },
    { PORT: '0' }, { PORT: '010000' }, { PORT: '65536' },
  ]) assert.throws(() => readRelayRuntime({ ...env, ...overrides }), /configuration/);
  for (const origin of [
    '', 'http://mail.example.org', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://mail.local', 'https://mail.internal', 'https://mail.example.org/', 'https://mail.example.org/path',
    'https://mail.example.org?token=ignored', 'https://mail.example.org#fragment', 'https://user:pass@mail.example.org',
    'https://mail.example.org:8443', 'https://mail.example.org.', 'https://mail_example.org',
  ]) assert.throws(() => readRelayRuntime({ ...env, JUZI_RELAY_PUBLIC_ORIGIN: origin }), /configuration/);
  assert.throws(() => readRelayRuntime({ ...provider, RENDER: 'false' }), /configuration/);
  assert.throws(() => createRelay({ env, filename: ':memory:', sendMail: accepted }), /persistent ledger/);
  const missingDirectory = join(state.directory, 'missing-mount');
  assert.throws(() => createRelay({ env: { ...env, QQ_RELAY_DATA_DIR: missingDirectory, QQ_RELAY_DB_PATH: join(missingDirectory, 'relay.sqlite') }, sendMail: accepted }), /persistent data directory/);
  const transport = qqTransportOptions(readRelayConfig(env));
  assert.equal(transport.host, 'smtp.qq.com'); assert.equal(transport.port, 465);
  assert.equal(transport.secure, true); assert.equal(transport.tls.rejectUnauthorized, true);
});

test('public health endpoint returns only readiness without mail, authentication or quota writes', async t => {
  const state = fixture(t), { server, port } = await listen(t, state.relay);
  assert.equal(server.maxConnections, 100); assert.equal(server.maxRequestsPerSocket, 100);
  const response = await http(port, { path: '/healthz', method: 'GET', headers: { authorization: '' } });
  assert.equal(response.status, 200); assert.deepEqual(response.data, { ok: true });
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal((await http(port, { path: '/healthz' })).status, 405);
  assert.equal((await http(port, { path: '/healthz?detail=true', method: 'GET' })).status, 404);
  assert.equal((await http(port, { path: '/healthz', method: 'GET', headers: { origin: 'https://other.example.org' } })).status, 403);
  assert.equal(state.calls.length, 0); assert.equal((await state.rows()).length, 0);
});

test('production listener rejects incorrect Host and forwarded host/protocol spoofing', async t => {
  const state = fixture(t), { port } = await listen(t, state.relay);
  for (const path of ['/send', '/healthz']) {
    const response = await http(port, { path, method: path === '/healthz' ? 'GET' : 'POST', headers: {
      host: 'attacker.example.org', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https',
    } });
    assert.equal(response.status, 421);
  }
  assert.equal((await state.relay.handle(webRequest(bodyFor(), { url: 'http://' + HOST + '/send' }))).status, 421);
  assert.equal((await state.relay.handle(webRequest(bodyFor(), { headers: { host: 'attacker.example.org' } }))).status, 421);
  assert.equal(state.calls.length, 0); assert.equal((await state.rows()).length, 0);
});

test('production rejects unauthenticated body uploads before waiting for a body or opening SMTP', async t => {
  const state = fixture(t), { port } = await listen(t, state.relay);
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {}); await once(socket, 'connect');
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Authentication waited for an unread body.')); }, 1000);
    socket.once('data', chunk => { clearTimeout(timer); resolve(chunk.toString()); socket.destroy(); });
  });
  socket.write(`POST /send HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer incorrect\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`);
  assert.match(await response, /^HTTP\/1\.1 401 /);
  assert.equal((await http(port, { headers: { origin: 'https://market.example.org' } })).status, 403);
  assert.equal((await http(port, { headers: { authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await http(port, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(state.calls.length, 0); assert.equal((await state.rows()).length, 0);
});

test('production exact send route preserves persistent quota and one-send idempotency across restart', async t => {
  const state = fixture(t, { limit: '1' }), body = bodyFor(), { port } = await listen(t, state.relay);
  for (const path of ['/send/', '/send?debug=true', '/x/../send', '/%73end']) assert.equal((await http(port, { path })).status, 404);
  const first = await http(port, { body });
  assert.equal(first.status, 200); assert.match(first.data.id, /^[a-f0-9-]{36}$/); assert.equal(state.calls.length, 1);
  await state.restart();
  const replay = await state.relay.handle(webRequest(body));
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), first.data);
  assert.equal((await state.relay.handle(webRequest(bodyFor()))).status, 429); assert.equal(state.calls.length, 1);
  const rows = await state.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'sent');
});

test('bounded production shutdown records unknown before closing and cannot adopt late SMTP success', async t => {
  let resolveSend;
  const pendingSMTP = new Promise(resolve => { resolveSend = resolve; });
  const state = fixture(t, { sendMail: () => pendingSMTP }), body = bodyFor();
  const pending = state.relay.handle(webRequest(body));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls.length, 1);
  await state.relay.close({ timeoutMs: 15 });
  assert.equal((await state.rows())[0].status, 'unknown');
  resolveSend(accepted(state.calls[0]));
  assert.equal((await pending).status, 503);
  await state.restart();
  assert.equal((await state.relay.handle(webRequest(body))).status, 409); assert.equal(state.calls.length, 1);
});
