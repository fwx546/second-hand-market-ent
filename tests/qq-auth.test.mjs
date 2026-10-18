import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from '../server/school-auth.mjs';
import { fixture, ORIGIN } from './support.mjs';

// All delivery goes through the injected transport; these are synthetic test-only recipients.
const EMAIL = 'qq.worker.fixture@student.xjtlu.edu.cn';
const RELAY_URL = 'https://relay.example.net/send';
const RELAY_TOKEN = 'TEST_ONLY_RELAY_TOKEN_NEVER_A_REAL_SECRET_0123456789';
const HMAC_SECRET = 'TEST_ONLY_HMAC_SECRET_NEVER_A_REAL_SECRET_0123456789';
function setup(t, options = {}) {
  const env = Object.assign(fixture(t), {
    JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_ORIGIN: ORIGIN, JUZI_EMAIL_AUTH_SECRET: HMAC_SECRET,
    JUZI_EMAIL_PROVIDER: 'qq_relay', JUZI_EMAIL_RELAY_URL: RELAY_URL, JUZI_EMAIL_RELAY_TOKEN: RELAY_TOKEN,
    ...options.env,
  });
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) }; calls.push(call);
    if (options.transport) return options.transport(call);
    return Response.json({ id: 'TEST_ONLY_ACCEPTED_MESSAGE' }, { status: 201 });
  };
  return { env, calls, fetch, base: options.base || ORIGIN, development: options.development || false };
}
function request(state, path, body, cookie = '') {
  const headers = { Origin: state.base, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new Request(`${state.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function auth(state, path, body, cookie = '') {
  const response = await handleSchoolAuth(request(state, path, body, cookie), state.env, { development: state.development, fetch: state.fetch });
  return { response, status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
}
const send = (state, email = EMAIL, cookie = '') => auth(state, '/api/auth/email/send', { email }, cookie);

test('qq_relay has isolated required configuration and does not require Resend or From', t => {
  const state = setup(t);
  assert.equal(getSchoolAuthConfig(state.env).configured, true);
  assert.equal(getSchoolAuthConfig({ ...state.env, RESEND_API_KEY: '\r\nunused', JUZI_EMAIL_FROM: 'invalid unused sender' }).configured, true);
  for (const env of [
    { JUZI_EMAIL_RELAY_TOKEN: '' }, { JUZI_EMAIL_RELAY_TOKEN: 'x'.repeat(31) }, { JUZI_EMAIL_RELAY_TOKEN: 'x'.repeat(32) + '\n' },
    { JUZI_EMAIL_RELAY_URL: '' }, { JUZI_EMAIL_ENABLED: 'false' }, { JUZI_EMAIL_ORIGIN: '' },
    { JUZI_EMAIL_AUTH_SECRET: 'short' }, { JUZI_EMAIL_DAILY_LIMIT: '0' }, { JUZI_EMAIL_PROVIDER: 'unknown' },
  ]) assert.equal(getSchoolAuthConfig({ ...state.env, ...env }).configured, false, Object.keys(env).join(','));
  assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_PROVIDER: undefined }).configured, false, 'No fallback from missing Resend credentials to relay.');
  assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_PROVIDER: undefined, RESEND_API_KEY: 'TEST_ONLY', JUZI_EMAIL_FROM: 'test@mailer.invalid' }).configured, true, 'Unset provider preserves Resend default.');
});

test('production relay URLs reject credentials, query, fragment, private hosts, IPs and arbitrary paths', t => {
  const state = setup(t);
  for (const url of [
    'http://relay.example.net/send', 'http://127.0.0.1:4180/send', 'http://localhost:4180/send',
    'https://127.0.0.1/send', 'https://10.0.0.1/send', 'https://192.168.1.1/send', 'https://[::1]/send',
    'https://localhost/send', 'https://localhost./send', 'https://service.local/send', 'https://metadata.google.internal/send',
    'https://name:password@relay.example.net/send', 'https://@relay.example.net/send',
    'https://relay.example.net/send?token=not-allowed', 'https://relay.example.net/send?', 'https://relay.example.net/send#fragment', 'https://relay.example.net/send#',
    'https://relay.example.net/other', 'https://relay.example.net/send/', 'https://relay.example.net/v1/send', 'ftp://relay.example.net/send',
  ]) assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_RELAY_URL: url }).configured, false, url);
  assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_RELAY_URL: 'https://relay.example.net:8443/send' }).configured, true);
});

test('loopback HTTP is allowed only for trusted localhost development app and only /send', t => {
  const state = setup(t), local = { ...state.env, JUZI_EMAIL_ORIGIN: 'http://localhost:4174' };
  for (const url of ['http://127.0.0.1:4180/send', 'http://localhost:4180/send', 'http://localhost/send']) {
    assert.equal(getSchoolAuthConfig({ ...local, JUZI_EMAIL_RELAY_URL: url }, { development: true }).configured, true);
    assert.equal(getSchoolAuthConfig({ ...local, JUZI_EMAIL_RELAY_URL: url }).configured, false);
    assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_RELAY_URL: url }, { development: true }).configured, false, 'A remote app origin cannot use local HTTP.');
  }
  for (const url of ['http://127.0.0.2:4180/send', 'http://[::1]:4180/send', 'http://192.168.1.1:4180/send', 'http://localhost:4180/anything', 'http://localhost:4180/send?x=1']) {
    assert.equal(getSchoolAuthConfig({ ...local, JUZI_EMAIL_RELAY_URL: url }, { development: true }).configured, false, url);
  }
});

test('relay request contains exactly requestId/email/code and confirms normal OTP session flow', async t => {
  const state = setup(t), result = await send(state, `  ${EMAIL.toUpperCase()}  `);
  assert.equal(result.status, 200); assert.equal(state.calls.length, 1);
  const { url, init, body } = state.calls[0];
  assert.equal(url, RELAY_URL); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
  assert(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'email', 'requestId']);
  assert.equal(body.email, EMAIL); assert.equal(body.requestId, result.data.challengeId);
  assert.match(body.code, /^\d{6}$/); assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${RELAY_TOKEN}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('idempotency-key'), null, 'Relay requestId is the sole idempotency contract.');
  const verified = await auth(state, '/api/auth/email/verify', { email: EMAIL, challengeId: result.data.challengeId, code: body.code }, result.cookie);
  assert.equal(verified.status, 200);
  const user = await resolveSchoolViewer(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: `${result.cookie}; ${verified.cookie}` } }), state.env);
  assert.equal(user.provider, 'school_email'); assert.equal(user.emailVerified, true);
  assert.equal(state.calls.length, 1, 'Verification does not send another email.');
});

test('trusted development app can call local relay with injected transport only', async t => {
  const url = 'http://127.0.0.1:4180/send';
  const state = setup(t, { env: { JUZI_EMAIL_ORIGIN: 'http://localhost:4174', JUZI_EMAIL_RELAY_URL: url }, base: 'http://localhost:4174', development: true });
  assert.equal((await send(state)).status, 200);
  assert.equal(state.calls[0].url, url);
});

test('relay failures never become fake success and remain in cooldown/daily budgets', async t => {
  for (const transport of [
    () => new Response(null, { status: 503 }), () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
    () => Response.json({ accepted: true }), () => Response.json({ id: '' }), () => Response.json({ id: '   ' }), () => Response.json({ id: 1 }),
    () => new Response('x'.repeat(16385)), () => new Response('not-json'), () => { throw new Error('PRIVATE_SMTP_DETAILS'); },
  ]) {
    const state = setup(t, { env: { JUZI_EMAIL_DAILY_LIMIT: '1' }, transport }), result = await send(state);
    assert.equal(result.status, 503); assert.equal(result.data.error.code, 'EMAIL_DELIVERY_FAILED');
    assert.equal(result.data.challengeId, undefined); assert(!JSON.stringify(result.data).includes('PRIVATE_SMTP_DETAILS'));
    const row = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get();
    assert.equal(row.delivery_status, 'failed');
    const retry = await send(state, EMAIL, result.cookie); assert.equal(retry.status, 429);
    assert(retry.response.headers.get('retry-after'));
    const other = await send(state, 'qq.worker.other@student.xjtlu.edu.cn'); assert.equal(other.status, 429); assert.equal(other.data.error.code, 'EMAIL_DAILY_LIMIT');
    assert.equal(state.calls.length, 1, 'No automatic retry of uncertain mail delivery.');
    const body = state.calls[0].body;
    const verify = await auth(state, '/api/auth/email/verify', { email: EMAIL, challengeId: body.requestId, code: body.code }, result.cookie);
    assert.equal(verify.status, 400);
  }
});

test('QQ credentials, relay endpoint, full email and plaintext OTP never enter public config or stored challenge', async t => {
  const state = setup(t), result = await send(state), publicConfig = getSchoolAuthConfig(state.env);
  assert.deepEqual(Object.keys(publicConfig).sort(), ['configured', 'domain', 'sendUrl', 'verifyUrl']);
  const serialized = JSON.stringify({ publicConfig, response: result.data, challenge: state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get() });
  for (const secret of [RELAY_TOKEN, HMAC_SECRET, RELAY_URL, EMAIL]) assert(!serialized.includes(secret));
  assert.deepEqual(Object.keys(result.data).sort(), ['challengeId', 'emailMasked', 'expiresIn', 'retryAfter']);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
});

test('relay gets fifteen-second deadline while unchanged default Resend keeps five seconds', async t => {
  const original = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (callback, delay, ...args) => { deadlines.push(delay); return original(callback, delay, ...args); };
  try {
    const relay = setup(t); assert.equal((await send(relay)).status, 200);
    const resend = setup(t, { env: { JUZI_EMAIL_PROVIDER: undefined, RESEND_API_KEY: 'TEST_ONLY_RESEND_KEY', JUZI_EMAIL_FROM: 'test@mailer.invalid' } });
    assert.equal((await send(resend)).status, 200);
    assert.equal(resend.calls[0].url, 'https://api.resend.com/emails');
    assert(new Headers(resend.calls[0].init.headers).get('idempotency-key'));
  } finally { globalThis.setTimeout = original; }
  assert(deadlines.includes(15000)); assert(deadlines.includes(5000));
});
