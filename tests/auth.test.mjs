import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from '../server/school-auth.mjs';
import { ORIGIN, PNG, fixture, api, productInput } from './support.mjs';

// Synthetic recipients are only passed to the injected in-memory mail transport, never a real service.
const EMAIL_A = 'otp.fixture.alpha@student.xjtlu.edu.cn';
const EMAIL_B = 'otp.fixture.beta@student.xjtlu.edu.cn';
const SECRET = 'test-only-hmac-secret-never-use-in-production-0123456789';
const sessionHash = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
function cookies(response) { return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; '); }
function mergeCookies(...values) {
  const result = new Map();
  for (const value of values) for (const part of value.split('; ')) {
    const separator = part.indexOf('='); if (separator < 0) continue;
    if (part.slice(separator + 1)) result.set(part.slice(0, separator), part.slice(separator + 1));
    else result.delete(part.slice(0, separator));
  }
  return [...result].map(([key, value]) => `${key}=${value}`).join('; ');
}
function setup(t, options = {}) {
  const env = Object.assign(fixture(t), {
    JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_ORIGIN: ORIGIN, JUZI_EMAIL_FROM: 'Test Mailer <auth-test@mailer.invalid>',
    RESEND_API_KEY: 're_TEST_ONLY_NOT_A_REAL_KEY', JUZI_EMAIL_AUTH_SECRET: SECRET, ...options.env,
  });
  const sent = [];
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers), body = JSON.parse(init.body);
    assert.equal(headers.get('authorization'), `Bearer ${env.RESEND_API_KEY}`);
    const code = body.text.match(/验证码：(\d{6})/)[1];
    const record = { challengeId: headers.get('idempotency-key'), code, body };
    sent.push(record);
    if (options.transport) return options.transport(record);
    return Response.json({ id: crypto.randomUUID() });
  };
  return { env, sent, fetch, development: options.development || false, base: options.base || ORIGIN };
}
function request(state, path, { body, cookie = '', method = 'POST', origin = state.base, headers = {} } = {}) {
  const allHeaders = new Headers(headers);
  if (origin !== null) allHeaders.set('Origin', origin);
  if (cookie) allHeaders.set('Cookie', cookie);
  let content;
  if (body !== undefined) { allHeaders.set('Content-Type', 'application/json'); content = typeof body === 'string' ? body : JSON.stringify(body); }
  return new Request(`${state.base}${path}`, { method, headers: allHeaders, body: content });
}
async function auth(state, path, options = {}) {
  const response = await handleSchoolAuth(request(state, path, options), state.env, { development: state.development, fetch: state.fetch });
  assert(response, 'Expected a school-auth route.');
  return { response, status: response.status, data: await response.json(), cookie: cookies(response) };
}
async function send(state, email = EMAIL_A, cookie = '') { return auth(state, '/api/auth/email/send', { body: { email }, cookie }); }
async function verify(state, challenge, email = EMAIL_A, cookie = challenge.cookie, code) {
  const recorded = state.sent.find(record => record.challengeId === challenge.data.challengeId);
  return auth(state, '/api/auth/email/verify', { body: { email, challengeId: challenge.data.challengeId, code: code ?? recorded.code }, cookie });
}
async function login(state, email = EMAIL_A, cookie = '') {
  const challenge = await send(state, email, cookie); assert.equal(challenge.status, 200);
  const result = await verify(state, challenge, email, mergeCookies(cookie, challenge.cookie)); assert.equal(result.status, 200);
  return { challenge, result, cookie: mergeCookies(cookie, challenge.cookie, result.cookie) };
}
async function viewer(state, cookie) { return resolveSchoolViewer(request(state, '/api/me', { method: 'GET', cookie }), state.env, { development: state.development }); }

test('mail login is gracefully disabled without complete configuration; guest still works', async t => {
  const state = setup(t, { env: { JUZI_EMAIL_ENABLED: 'false' } });
  assert.deepEqual(getSchoolAuthConfig(state.env), { configured: false, domain: 'student.xjtlu.edu.cn', sendUrl: '/api/auth/email/send', verifyUrl: '/api/auth/email/verify' });
  const result = await send(state);
  assert.equal(result.status, 503); assert.equal(result.data.error.code, 'EMAIL_AUTH_DISABLED');
  assert.equal(state.sent.length, 0); assert.equal(result.data.code, undefined);
  assert.equal((await auth(state, '/api/auth/guest')).status, 200);
  for (const env of [
    { RESEND_API_KEY: '' }, { JUZI_EMAIL_AUTH_SECRET: 'short' }, { JUZI_EMAIL_FROM: 'bad\r\nBcc: other@mailer.invalid' },
    { JUZI_EMAIL_ORIGIN: `${ORIGIN}/` }, { JUZI_EMAIL_ORIGIN: 'http://localhost:4174' },
    { JUZI_EMAIL_DAILY_LIMIT: '0' }, { JUZI_EMAIL_DAILY_LIMIT: '10001' }, { JUZI_EMAIL_DAILY_LIMIT: '1.5' },
  ]) assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_ENABLED: 'true', ...env }).configured, false);
  for (const value of ['', '   ', ' 1000 ']) assert.equal(getSchoolAuthConfig({ ...state.env, JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_DAILY_LIMIT: value }).configured, true);
});

test('strict student domain and flexible ASCII local part normalize trim/case without exposing full email', async t => {
  const state = setup(t);
  for (const email of [
    'person@xjtlu.edu.cn', 'person@student.xjtlu.edu.cn.evil.test', 'person@sub.student.xjtlu.edu.cn',
    'person@other.example', '.person@student.xjtlu.edu.cn', 'person.@student.xjtlu.edu.cn', 'per..son@student.xjtlu.edu.cn',
    'person name@student.xjtlu.edu.cn', `${'x'.repeat(65)}@student.xjtlu.edu.cn`, 'name\r\n@ student.xjtlu.edu.cn',
  ]) assert.equal((await send(state, email)).status, 400, email);
  const email = '  Flexible.Name%+tag@STUDENT.XJTLU.EDU.CN  ', result = await send(state, email);
  assert.equal(result.status, 200);
  assert.deepEqual(state.sent[0].body.to, ['flexible.name%+tag@student.xjtlu.edu.cn']);
  assert.equal(state.sent[0].body.from, state.env.JUZI_EMAIL_FROM);
  assert(state.sent[0].body.text.includes('不验证在读学籍'));
  assert.equal(result.data.emailMasked, 'fl***@student.xjtlu.edu.cn');
  assert.deepEqual(Object.keys(result.data).sort(), ['challengeId', 'emailMasked', 'expiresIn', 'retryAfter']);
  assert.equal(result.data.expiresIn, 600); assert.equal(result.data.retryAfter, 60);
  const row = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get();
  assert.match(row.email_hash, /^[0-9a-f]{64}$/); assert.equal(row.delivery_status, 'sent');
  assert.notEqual(row.code_hash, state.sent[0].code); assert(!JSON.stringify(row).includes('flexible.name'));
  assert(result.response.headers.getSetCookie()[0].includes('HttpOnly')); assert(result.response.headers.getSetCookie()[0].includes('Secure'));
});

test('all auth mutations require exact Origin, JSON field allowlists and a 4KiB body limit', async t => {
  const state = setup(t);
  for (const path of ['/api/auth/email/send', '/api/auth/email/verify', '/api/auth/logout', '/api/auth/guest']) {
    for (const origin of [null, 'https://attacker.example']) assert.equal((await auth(state, path, { origin, body: {} })).status, 403);
    assert.equal((await auth(state, path, { body: { role: 'admin' } })).status, 400);
    assert.equal((await auth(state, path, { body: { unused: 'x'.repeat(5000) } })).status, 413);
    assert.equal((await auth(state, path, { method: 'GET' })).status, 405);
  }
  assert.equal(state.sent.length, 0);
  assert.equal((await auth(state, '/api/auth/email/send', { body: '{bad-json' })).status, 400);
});

test('only confirmed Resend id permits success; failures count toward cooldown and cannot authenticate', async t => {
  for (const transport of [
    () => new Response(null, { status: 503 }), () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }),
    () => Response.json({ accepted: true }), () => new Response('x'.repeat(16385)), () => { throw new Error('Transport failure'); },
  ]) {
    const state = setup(t, { transport }), result = await send(state);
    assert.equal(result.status, 503); assert.equal(result.data.error.code, 'EMAIL_DELIVERY_FAILED'); assert.equal(result.data.challengeId, undefined);
    const row = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get();
    assert.equal(row.delivery_status, 'failed');
    assert.equal((await send(state, EMAIL_A, result.cookie)).status, 429);
    const forged = { data: { challengeId: row.id }, cookie: result.cookie };
    assert.equal((await verify(state, forged)).status, 400);
    assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  }
});

test('successful OTP creates private random school account and hashed 7-day session', async t => {
  const state = setup(t), logged = await login(state), user = await viewer(state, logged.cookie);
  assert.match(user.userId, /^school_[0-9a-f-]{36}$/); assert.equal(user.provider, 'school_email'); assert.equal(user.emailVerified, true);
  assert.equal(user.emailMasked, 'ot***@student.xjtlu.edu.cn');
  const row = state.env.DB.sqlite.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(row.expires_at - row.created_at, 7 * 86400000);
  const sessionCookie = logged.result.cookie.split('=')[1]; assert.notEqual(row.session_hash, sessionCookie);
  const stored = JSON.stringify({
    accounts: state.env.DB.sqlite.prepare('SELECT * FROM school_email_accounts').all(),
    challenges: state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').all(),
    sessions: state.env.DB.sqlite.prepare('SELECT * FROM auth_sessions').all(), users: state.env.DB.sqlite.prepare('SELECT * FROM users').all(),
  });
  assert(!stored.includes(EMAIL_A)); assert(!stored.includes(sessionCookie)); assert(!stored.includes(SECRET));
  assert.equal(logged.result.response.headers.get('cache-control'), 'no-store');
  state.env.DB.sqlite.prepare('UPDATE school_email_challenges SET created_at = ?').run(Date.now() - 61000);
  const again = await login(state, EMAIL_A, logged.cookie);
  assert.equal((await viewer(state, again.cookie)).userId, user.userId);
  assert.equal(await viewer(state, logged.cookie), null, 'A new login rotates its previous browser session.');
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('challenge is bound to browser and email; concurrent replay creates only one session', async t => {
  const state = setup(t), challenge = await send(state), fakeCookie = `__Host-juzi_school_browser=${'A'.repeat(43)}`;
  assert.equal((await verify(state, challenge, EMAIL_B)).status, 400);
  assert.equal((await verify(state, challenge, EMAIL_A, fakeCookie)).status, 400);
  assert.equal(state.env.DB.sqlite.prepare('SELECT attempts FROM school_email_challenges').get().attempts, 0);
  const results = await Promise.all([1, 2].map(() => verify(state, challenge)));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 400).length, 1);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
  assert.equal((await verify(state, challenge)).data.error.code, 'INVALID_CODE');
});

test('five wrong guesses atomically lock a challenge even during parallel verification', async t => {
  const state = setup(t), challenge = await send(state), actual = state.sent[0].code, wrong = actual === '000000' ? '000001' : '000000';
  const results = await Promise.all(Array.from({ length: 10 }, () => verify(state, challenge, EMAIL_A, challenge.cookie, wrong)));
  assert(results.every(result => [400, 429].includes(result.status)));
  assert.equal(state.env.DB.sqlite.prepare('SELECT attempts FROM school_email_challenges').get().attempts, 5);
  const correctAfterLock = await verify(state, challenge);
  assert.equal(correctAfterLock.status, 429); assert.equal(correctAfterLock.data.error.code, 'CODE_ATTEMPTS_EXCEEDED');
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('expired OTPs remain for daily budgets, and cleanup only removes sends older than 24 hours', async t => {
  const state = setup(t), challenge = await send(state), now = Date.now();
  const original = state.env.DB.sqlite.prepare('SELECT * FROM school_email_challenges').get(), columns = Object.keys(original);
  state.env.DB.sqlite.prepare('UPDATE school_email_challenges SET created_at = ?, expires_at = ?').run(now - 30 * 60000, now - 20 * 60000);
  const expired = await verify(state, challenge);
  assert.equal(expired.status, 410); assert.equal(expired.data.error.code, 'CODE_EXPIRED');
  const insert = state.env.DB.sqlite.prepare(`INSERT INTO school_email_challenges (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let index = 0; index < 9; index++) insert.run(...columns.map(column => column === 'id' ? crypto.randomUUID() : column === 'created_at' ? now - 30 * 60000 : column === 'expires_at' ? now - 20 * 60000 : original[column]));
  assert.equal((await send(state, EMAIL_A, challenge.cookie)).status, 429);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM school_email_challenges').get().n, 10);
  state.env.DB.sqlite.prepare('UPDATE school_email_challenges SET created_at = ?').run(now - 25 * 3600000);
  assert.equal((await send(state, EMAIL_A, challenge.cookie)).status, 200);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM school_email_challenges').get().n, 1);
});

test('parallel email cooldown and per-browser daily budgets are enforced before mail delivery', async t => {
  const sameEmail = setup(t), attempts = await Promise.all(Array.from({ length: 12 }, () => send(sameEmail)));
  assert.equal(attempts.filter(result => result.status === 200).length, 1);
  assert.equal(sameEmail.sent.length, 1);
  const state = setup(t), initial = await send(state), binding = initial.cookie;
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => send(state, `otp.browser-${index}@student.xjtlu.edu.cn`, binding)));
  assert.equal(results.filter(result => result.status === 200).length, 19);
  assert.equal(results.filter(result => result.status === 429).length, 5);
  assert.equal(state.sent.length, 20);
  const guest = await auth(state, '/api/auth/guest', { cookie: binding });
  assert(!guest.response.headers.getSetCookie().some(value => value.startsWith('__Host-juzi_school_browser=')));
  const limited = await send(state, EMAIL_B, binding);
  assert.equal(limited.data.error.code, 'BROWSER_RATE_LIMIT'); assert(limited.response.headers.get('retry-after'));
});

test('global configured daily budget survives parallel fresh browsers and counts failed sends', async t => {
  const state = setup(t, { env: { JUZI_EMAIL_DAILY_LIMIT: '3' } });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => send(state, `otp.global-${index}@student.xjtlu.edu.cn`)));
  assert.equal(results.filter(result => result.status === 200).length, 3);
  assert.equal(results.filter(result => result.status === 429).length, 7);
  assert.equal(state.sent.length, 3);
  const failed = setup(t, { env: { JUZI_EMAIL_DAILY_LIMIT: '1' }, transport: () => new Response(null, { status: 503 }) });
  assert.equal((await send(failed)).status, 503);
  const next = await send(failed, EMAIL_B);
  assert.equal(next.status, 429); assert.equal(next.data.error.code, 'EMAIL_DAILY_LIMIT');
  assert.equal(failed.sent.length, 1);
});

test('legacy OIDC/ChatGPT sessions cannot impersonate school-email verification', async t => {
  const state = setup(t), oldToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), now = Date.now();
  state.env.DB.sqlite.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('oidc_legacy', '旧账号', now);
  state.env.DB.sqlite.prepare('INSERT INTO auth_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(await sessionHash(oldToken), 'oidc_legacy', now + 100000, now);
  for (const cookie of [`__Host-juzi_session=${oldToken}`, `__Host-juzi_school_session=${oldToken}`]) assert.equal(await viewer(state, cookie), null);
  const spoofed = request(state, '/api/me', { method: 'GET', headers: { 'oai-authenticated-user-id': 'platform-account', 'oai-authenticated-user-email': 'not-used@host.invalid' } });
  assert.equal(await resolveSchoolViewer(spoofed, state.env), null);
  for (const path of ['/api/auth/start', '/api/auth/callback', '/callback']) assert.equal(await handleSchoolAuth(request(state, path, { method: 'GET' }), state.env), null);
  const wrapper = await readFile(new URL('../app/api/[[...path]]/route.ts', import.meta.url), 'utf8');
  assert(!wrapper.includes('getChatGPTUser')); assert(!wrapper.includes('resolveExternalViewer'));
});

test('guest/logout are idempotent, revoke school session, clear old app cookies and preserve guest read-only rights', async t => {
  for (const path of ['/api/auth/guest', '/api/auth/logout']) {
    const state = setup(t), logged = await login(state);
    assert(await viewer(state, logged.cookie));
    const result = await auth(state, path, { cookie: logged.cookie });
    assert.equal(result.status, 200); assert.deepEqual(result.data, { ok: true });
    assert(result.response.headers.getSetCookie().some(value => value.startsWith('__Host-juzi_session=')));
    assert(result.response.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
    assert.equal(await viewer(state, logged.cookie), null);
    assert.equal((await auth(state, path, { cookie: logged.cookie })).status, 200);
    assert.equal((await api(state.env, '/api/products')).status, 200);
    assert.equal((await api(state.env, '/api/products', { method: 'POST', body: {} })).status, 401);
    assert.equal((await api(state.env, '/api/products/does-not-exist/contact')).status, 401);
  }
});

test('school sessions retain ownership isolation, private contacts and verified-seller signal', async t => {
  const state = setup(t), loggedA = await login(state), loggedB = await login(state, EMAIL_B), userA = await viewer(state, loggedA.cookie), userB = await viewer(state, loggedB.cookie);
  const photo = new FormData(); photo.append('file', new Blob([PNG], { type: 'image/png' }), 'test.png');
  const uploaded = await api(state.env, '/api/media', { method: 'POST', viewer: userA, body: photo }); assert.equal(uploaded.status, 201);
  const created = await api(state.env, '/api/products', { method: 'POST', viewer: userA, body: productInput([uploaded.data.mediaId]) }); assert.equal(created.status, 201);
  assert.equal(created.data.product.sellerEmailVerified, true);
  const productPath = `/api/products/${created.data.product.id}`;
  assert.equal((await api(state.env, `${productPath}/contact`)).status, 401);
  assert.equal((await api(state.env, `${productPath}/contact`, { viewer: userB })).status, 200);
  assert.equal((await api(state.env, productPath, { method: 'PATCH', viewer: userB, body: { price: 1 } })).status, 403);
  const publicResult = await api(state.env, productPath);
  assert.equal(publicResult.data.product.sellerEmailVerified, true);
  assert(!JSON.stringify(publicResult.data).includes(EMAIL_A)); assert(!JSON.stringify(publicResult.data).includes(userA.userId));
});

test('session expiry and trusted-local cookie policy stay separate from delivery configuration', async t => {
  const state = setup(t), logged = await login(state);
  state.env.RESEND_API_KEY = '';
  assert.equal(getSchoolAuthConfig(state.env).configured, false);
  assert(await viewer(state, logged.cookie), 'Existing verified session need not send another email.');
  state.env.DB.sqlite.prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal(await viewer(state, logged.cookie), null);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  const local = setup(t, { env: { JUZI_EMAIL_ORIGIN: 'http://localhost:4174' }, base: 'http://localhost:4174', development: true });
  const result = await send(local); assert.equal(result.status, 200);
  assert(result.response.headers.getSetCookie()[0].startsWith('juzi_dev_school_browser=')); assert(!result.response.headers.getSetCookie()[0].includes('; Secure'));
  assert.equal(getSchoolAuthConfig(local.env).configured, false, 'HTTP is disabled without the trusted build flag.');
});
