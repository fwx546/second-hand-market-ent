import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from '../server/school-auth.mjs';
import { fixture, ORIGIN } from './support.mjs';

// Every request uses an injected transport. No Google account or live mail is used.
const EMAIL = 'gmail.worker.fixture@student.xjtlu.edu.cn';
const SCRIPT_URL = 'https://script.google.com/macros/s/TEST_ONLY_DEPLOYMENT_IDENTIFIER_0123456789/exec';
const CONTENT_URL = 'https://script.googleusercontent.com/macros/echo?user_content_key=TEST_ONLY&lib=TEST_ONLY';
const SCRIPT_SECRET = 'TEST_ONLY_GMAIL_SCRIPT_SECRET_NEVER_REAL_0123456789';
const AUTH_SECRET = 'TEST_ONLY_AUTH_SECRET_NEVER_REAL_0123456789';

function setup(t, options = {}) {
  const env = Object.assign(fixture(t), {
    JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_ORIGIN: ORIGIN, JUZI_EMAIL_AUTH_SECRET: AUTH_SECRET,
    JUZI_EMAIL_PROVIDER: 'gmail_apps_script', JUZI_GMAIL_SCRIPT_URL: SCRIPT_URL, JUZI_GMAIL_SCRIPT_SECRET: SCRIPT_SECRET,
    ...options.env,
  });
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return options.transport ? options.transport(call, calls) : Response.json({ ok: true, id: calls[0].body.requestId });
  };
  return { env, calls, fetch };
}
async function auth(state, path, body, cookie = '') {
  const response = await handleSchoolAuth(new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  }), state.env, { fetch: state.fetch });
  return { response, status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
}
const send = (state, email = EMAIL, cookie = '') => auth(state, '/api/auth/email/send', { email }, cookie);
async function assertFailedChallenge(state, result) {
  assert.equal(result.status, 503);
  assert.equal(result.data.error.code, 'EMAIL_DELIVERY_FAILED');
  assert.equal(result.data.challengeId, undefined);
  assert(!JSON.stringify(result.data).includes('PRIVATE_PROVIDER_DETAILS'));
  const row = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get();
  assert.equal(row.delivery_status, 'failed');
  const original = state.calls[0].body;
  const verified = await auth(state, '/api/auth/email/verify', { email: EMAIL, challengeId: original.requestId, code: original.code }, result.cookie);
  assert.equal(verified.status, 400);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  assert.equal((await send(state, EMAIL, result.cookie)).status, 429, 'Uncertain deliveries consume the send cooldown.');
}

test('gmail_apps_script configuration is isolated from QQ and Resend credentials', async t => {
  const state = setup(t);
  assert.equal(getSchoolAuthConfig(state.env).configured, true);
  assert.equal(getSchoolAuthConfig({ ...state.env, RESEND_API_KEY: '\r\nunused', JUZI_EMAIL_FROM: 'unused invalid', JUZI_EMAIL_RELAY_TOKEN: 'unused' }).configured, true);
  for (const env of [
    { JUZI_GMAIL_SCRIPT_URL: '' }, { JUZI_GMAIL_SCRIPT_SECRET: '' }, { JUZI_GMAIL_SCRIPT_SECRET: 'x'.repeat(31) },
    { JUZI_GMAIL_SCRIPT_SECRET: 'x'.repeat(4097) }, { JUZI_GMAIL_SCRIPT_SECRET: 'x'.repeat(32) + '\n' },
    { JUZI_GMAIL_SCRIPT_SECRET: 'x'.repeat(32) + ' ' }, { JUZI_GMAIL_SCRIPT_SECRET: 'x'.repeat(32) + '非ASCII' },
    { JUZI_EMAIL_ENABLED: 'false' }, { JUZI_EMAIL_AUTH_SECRET: 'short' }, { JUZI_EMAIL_ORIGIN: '' }, { JUZI_EMAIL_DAILY_LIMIT: '0' },
  ]) {
    assert.equal(getSchoolAuthConfig({ ...state.env, ...env }).configured, false, Object.keys(env).join(','));
  }
  const disabled = setup(t, { env: { JUZI_GMAIL_SCRIPT_SECRET: '' } });
  assert.equal((await send(disabled)).data.error.code, 'EMAIL_AUTH_DISABLED');
  assert.equal(disabled.calls.length, 0);
});

test('only a strict published Google Apps Script URL can receive signed OTP requests', t => {
  const state = setup(t);
  for (const url of [
    SCRIPT_URL.replace('https:', 'http:'), SCRIPT_URL.replace('script.google.com', 'script.google.com.evil.example'),
    SCRIPT_URL.replace('script.google.com', 'script.googleusercontent.com'), SCRIPT_URL.replace('script.google.com', 'script.google.com:443'),
    SCRIPT_URL.replace('script.google.com', 'user:password@script.google.com'), SCRIPT_URL.replace('script.google.com', '@script.google.com'),
    `${SCRIPT_URL}?`, `${SCRIPT_URL}?token=secret`, `${SCRIPT_URL}#`, `${SCRIPT_URL}#fragment`, `${SCRIPT_URL}/`,
    SCRIPT_URL.replace('/exec', '/dev'), SCRIPT_URL.replace('/macros/', '/x/../macros/'), SCRIPT_URL.replace('/macros/', '/%6dacros/'),
    SCRIPT_URL.replace('/macros/', '\\macros/'), 'https://script.google.com/macros/s/short/exec',
    'https://127.0.0.1/macros/s/TEST_ONLY_DEPLOYMENT_IDENTIFIER/exec', 'javascript:alert(1)',
  ]) assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_GMAIL_SCRIPT_URL: url }).configured, false, url);
  assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_GMAIL_SCRIPT_URL: `  ${SCRIPT_URL}  ` }).configured, true);
});

test('Gmail request has a canonical signed body and confirms the normal school OTP login', async t => {
  const state = setup(t), before = Math.floor(Date.now() / 1000), result = await send(state, `  ${EMAIL.toUpperCase()}  `);
  assert.equal(result.status, 200); assert.equal(state.calls.length, 1);
  const { url, init, body } = state.calls[0];
  assert.equal(url, SCRIPT_URL); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
  assert(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'email', 'issuedAt', 'requestId', 'signature', 'version']);
  assert.equal(body.version, 1); assert.equal(body.email, EMAIL); assert.equal(body.requestId, result.data.challengeId);
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(body.code, /^\d{6}$/); assert.match(body.signature, /^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(body.issuedAt)); assert(body.issuedAt >= before && body.issuedAt <= Math.floor(Date.now() / 1000));
  const canonical = ['juzi-gmail-v1', body.requestId, EMAIL, body.code, String(body.issuedAt)].join('\n');
  assert.equal(body.signature, createHmac('sha256', SCRIPT_SECRET).update(canonical).digest('hex'));
  const headers = new Headers(init.headers);
  assert.equal(headers.get('content-type'), 'application/json'); assert.equal(headers.get('authorization'), null);
  assert(!init.body.includes(SCRIPT_SECRET)); assert(!JSON.stringify(init.headers).includes(SCRIPT_SECRET));
  const verified = await auth(state, '/api/auth/email/verify', { email: EMAIL, challengeId: body.requestId, code: body.code }, result.cookie);
  assert.equal(verified.status, 200);
  const user = await resolveSchoolViewer(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: `${result.cookie}; ${verified.cookie}` } }), state.env);
  assert.equal(user.provider, 'school_email'); assert.equal(user.emailVerified, true);
  assert.equal(state.calls.length, 1, 'Verification never resends mail.');
});

test('Google ContentService 302 and 303 redirect only once with a credential-free GET', async t => {
  for (const status of [302, 303]) {
    const state = setup(t, { transport: (_call, calls) => calls.length === 1 ? new Response('redirect', { status, headers: { Location: CONTENT_URL } }) : Response.json({ ok: true, id: calls[0].body.requestId }) });
    assert.equal((await send(state)).status, 200);
    assert.equal(state.calls.length, 2);
    const call = state.calls[1];
    assert.equal(call.url, CONTENT_URL); assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.body, undefined); assert.equal(call.body, undefined);
    assert.deepEqual([...new Headers(call.init.headers)], [['accept', 'application/json']]);
    assert.equal(call.init.signal, state.calls[0].init.signal, 'Both fetches share the same total deadline.');
  }
});

test('sign-in redirects, arbitrary hosts, unsafe result URLs and POST-preserving redirects fail closed', async t => {
  const targets = [
    'https://accounts.google.com/ServiceLogin', 'https://evil.example/macros/echo?x=1',
    CONTENT_URL.replace('script.googleusercontent.com', 'script.googleusercontent.com.evil.example'),
    CONTENT_URL.replace('https:', 'http:'), CONTENT_URL.replace('script.googleusercontent.com', 'user:password@script.googleusercontent.com'),
    CONTENT_URL.replace('script.googleusercontent.com', 'script.googleusercontent.com:443'),
    CONTENT_URL.replace('/macros/echo', '/x/../macros/echo'), CONTENT_URL.replace('/macros/echo', '/macros/other'),
    `${CONTENT_URL}#`, `${CONTENT_URL}#fragment`, `${CONTENT_URL}&value=a b`, `${CONTENT_URL}&value=${'x'.repeat(4096)}`,
    '/macros/echo?x=1', null,
  ];
  for (const location of targets) {
    const state = setup(t, { transport: () => new Response(null, { status: 302, headers: location ? { Location: location } : {} }) });
    await assertFailedChallenge(state, await send(state)); assert.equal(state.calls.length, 1);
  }
  for (const status of [301, 307, 308]) {
    const state = setup(t, { transport: () => new Response(null, { status, headers: { Location: CONTENT_URL } }) });
    await assertFailedChallenge(state, await send(state)); assert.equal(state.calls.length, 1, 'POST is never replayed by a redirect.');
  }
});

test('a second redirect and unconfirmed, oversized or non-JSON Google responses cannot authenticate', async t => {
  for (const transport of [
    (_call, calls) => calls.length === 1 ? new Response(null, { status: 302, headers: { Location: CONTENT_URL } }) : new Response(null, { status: 302, headers: { Location: CONTENT_URL } }),
    () => Response.json({ ok: false, error: 'DAILY_LIMIT' }), () => Response.json({ ok: false, error: 'PRIVATE_PROVIDER_DETAILS' }),
    () => Response.json({ ok: true, id: crypto.randomUUID() }), () => Response.json({ id: 'unconfirmed' }),
    () => Response.json(null), () => Response.json({ ok: true }), () => new Response(null, { status: 503 }),
    () => new Response('not-json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(4097), { headers: { 'Content-Type': 'application/json' } }),
    (_call, calls) => new Response(JSON.stringify({ ok: true, id: calls[0].body.requestId }), { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' } }),
    () => { throw new Error('PRIVATE_PROVIDER_DETAILS'); },
  ]) {
    const state = setup(t, { transport });
    await assertFailedChallenge(state, await send(state));
    assert(state.calls.length <= 2, 'There is no automatic mail retry after an ambiguous result.');
  }
});

test('Gmail timeout has one 15-second deadline and invalidates the challenge without retry', async t => {
  const original = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (callback, delay, ...args) => { deadlines.push(delay); return original(callback, delay === 15000 ? 1 : delay, ...args); };
  try {
    const state = setup(t, { transport: call => new Promise((_resolve, reject) => {
      if (call.init.signal.aborted) reject(new Error('PRIVATE_PROVIDER_DETAILS'));
      else call.init.signal.addEventListener('abort', () => reject(new Error('PRIVATE_PROVIDER_DETAILS')), { once: true });
    }) });
    await assertFailedChallenge(state, await send(state));
    assert.equal(state.calls.length, 1); assert.deepEqual(deadlines, [15000]);
  } finally { globalThis.setTimeout = original; }
});

test('Gmail endpoint, shared secrets and plaintext OTP remain out of public config and the database', async t => {
  const state = setup(t), result = await send(state), publicConfig = getSchoolAuthConfig(state.env);
  assert.deepEqual(Object.keys(publicConfig).sort(), ['configured', 'domain', 'sendUrl', 'verifyUrl']);
  const challenge = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get();
  const serialized = JSON.stringify({ publicConfig, response: result.data, challenge });
  for (const secret of [SCRIPT_SECRET, AUTH_SECRET, SCRIPT_URL, EMAIL]) assert(!serialized.includes(secret));
  assert.notEqual(challenge.code_hash, state.calls[0].body.code);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
});
