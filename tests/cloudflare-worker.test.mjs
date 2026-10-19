import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../cloudflare/worker.mjs';
import { fixture, ORIGIN, PNG, productInput } from './support.mjs';

const SECRET = 'sb_secret_TEST_ONLY_NOT_A_REAL_KEY_0123456789';
const AUTH_SECRET = 'TEST_ONLY_AUTH_SECRET_01234567890123456789';
const SCRIPT_SECRET = 'TEST_ONLY_SCRIPT_SECRET_01234567890123456789';
const SCRIPT = 'https://script.google.com/macros/s/TEST_ONLY_DEPLOYMENT_IDENTIFIER_0123456789/exec';
const EMAIL = 'worker.test23@student.xjtlu.edu.cn';
function setup(t) {
  const env = { ...fixture(t), JUZI_SITE_ENABLED: 'true', SUPABASE_URL: 'https://testonlyprojectref001.supabase.co', SUPABASE_SECRET_KEY: SECRET,
    JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_ORIGIN: ORIGIN, JUZI_EMAIL_AUTH_SECRET: AUTH_SECRET,
    JUZI_EMAIL_PROVIDER: 'gmail_apps_script', JUZI_GMAIL_SCRIPT_URL: SCRIPT, JUZI_GMAIL_SCRIPT_SECRET: SCRIPT_SECRET,
  };
  const objects = new Map(), calls = [], sent = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === SCRIPT) {
      const message = JSON.parse(init.body); sent.push(message);
      return Response.json({ ok: true, id: message.requestId });
    }
    assert.equal(new URL(url).origin, env.SUPABASE_URL);
    assert.equal(init.headers.get('apikey'), SECRET);
    const key = decodeURIComponent(new URL(url).pathname.replace('/storage/v1/object/juzi-market-private/', ''));
    if (init.method === 'POST') {
      objects.set(key, { bytes: new Uint8Array(init.body), type: init.headers.get('content-type') });
      return Response.json({ Key: `juzi-market-private/${key}` });
    }
    if (init.method === 'GET') {
      const object = objects.get(key);
      return object ? new Response(object.bytes, { headers: { 'Content-Type': object.type, 'Content-Length': String(object.bytes.length) } }) : new Response(null, { status: 404 });
    }
    if (init.method === 'DELETE') {
      for (const item of JSON.parse(init.body).prefixes) objects.delete(item);
      return Response.json([]);
    }
    throw new Error('Unexpected transport');
  };
  return { env, fetch, sent, calls, objects };
}
async function request(state, path, { method = 'GET', body, cookie = '', headers = {} } = {}) {
  const h = new Headers({ Cookie: cookie, ...headers });
  if (method !== 'GET' && method !== 'HEAD') h.set('Origin', ORIGIN);
  if (body !== undefined && !(body instanceof FormData)) { h.set('Content-Type', 'application/json'); body = JSON.stringify(body); }
  return handleRequest(new Request(`${ORIGIN}${path}`, { method, headers: h, body }), state.env, { fetch: state.fetch });
}
const cookies = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
async function login(state) {
  const response = await request(state, '/api/auth/email/send', { method: 'POST', body: { email: EMAIL } });
  assert.equal(response.status, 200);
  const { challengeId } = await response.json(), message = state.sent.at(-1);
  const verified = await request(state, '/api/auth/email/verify', { method: 'POST', cookie: cookies(response), body: { email: EMAIL, challengeId, code: message.code } });
  assert.equal(verified.status, 200);
  return cookies(verified);
}

test('full standalone path preserves OTP login, upload, publish, permissions and durable identity', async t => {
  const state = setup(t), cookie = await login(state);
  assert(cookie.startsWith('__Host-juzi_school_session='));
  const me = await (await request(state, '/api/me', { cookie })).json();
  assert.equal(me.user.emailVerified, true);
  assert.equal(me.user.displayName, 'worker.test');
  assert.equal(me.development, false); assert.equal(me.authentication.preview.enabled, false);
  const form = new FormData(); form.append('file', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const upload = await request(state, '/api/media', { method: 'POST', cookie, body: form });
  assert.equal(upload.status, 201);
  const { mediaId } = await upload.json();
  assert.equal((await request(state, `/api/media/${mediaId}`)).status, 404, 'Unpublished image is owner-only.');
  const created = await request(state, '/api/products', { method: 'POST', cookie, body: productInput([mediaId]) });
  assert.equal(created.status, 201);
  const { product } = await created.json();
  const publicImage = await request(state, `/api/media/${mediaId}`);
  assert.equal(publicImage.status, 200); assert.equal(publicImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), PNG);
  assert.equal((await request(state, `/api/products/${product.id}/contact`)).status, 401);
  assert.equal((await (await request(state, `/api/products/${product.id}/contact`, { cookie })).json()).value, 'juzi_test_contact');
  const publicCatalog = await (await request(state, '/api/products')).json();
  assert.equal(publicCatalog.items.length, 1);
  for (const value of [SECRET, AUTH_SECRET, SCRIPT_SECRET, EMAIL, 'juzi_test_contact']) assert(!JSON.stringify(publicCatalog).includes(value));
  const userId = me.user.id;
  // Existing imported school_email_accounts use the same SHA-256 normalized
  // email key. A new domain cookie login resolves this same durable user ID.
  assert.equal(state.env.DB.sqlite.prepare('SELECT email_hash FROM school_email_accounts WHERE user_id = ?').get(userId).email_hash,
    createHash('sha256').update(EMAIL).digest('hex'));
  const logout = await request(state, '/api/auth/logout', { method: 'POST', cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await (await request(state, '/api/me', { cookie })).json()).user, null);
});

test('Worker does not trust OIDC, platform headers, preview cookies or forged auth', async t => {
  const state = setup(t);
  for (const headers of [
    { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': EMAIL },
    { Authorization: `Bearer ${SECRET}` },
    { Cookie: 'juzi_dev_preview=1; __Host-juzi_session=owner' },
    { 'x-development': 'true', 'x-user-id': 'owner' },
  ]) {
    const me = await (await request(state, '/api/me', { headers })).json();
    assert.equal(me.user, null); assert.equal(me.capabilities.canPublish, false);
    assert.equal((await request(state, '/api/products', { method: 'POST', body: {}, headers })).status, 401);
  }
  assert.equal((await request(state, '/api/auth/preview', { method: 'POST', body: {} })).status, 401);
  assert.equal(state.calls.length, 0);
});

test('security headers apply to APIs and static assets and hash-route shell uses ASSETS', async t => {
  const state = setup(t), assetCalls = [];
  state.env.ASSETS = { fetch: async request => { assetCalls.push(request); return new Response('<!doctype html><html>橘子集</html>', { headers: { 'Content-Type': 'text/html' } }); } };
  for (const path of ['/', '/styles.css', '/api/me']) {
    const response = await request(state, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert(response.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert(!response.headers.has('access-control-allow-origin'));
    if (path.startsWith('/api')) assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(new URL(assetCalls[0].url).pathname, '/index.html');
  assert.equal(new URL(assetCalls[1].url).pathname, '/styles.css');
  const head = await request(state, '/styles.css', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(assetCalls.at(-1).method, 'HEAD');
  assert.equal((await request(state, '/', { method: 'POST', body: {} })).status, 405);
});

test('storage misconfiguration and provider failures do not leak secrets or permit fallback BUCKET', async t => {
  const state = setup(t), cookie = await login(state);
  state.env.SUPABASE_URL = 'https://attacker.example';
  const form = new FormData(); form.append('file', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const response = await request(state, '/api/media', { method: 'POST', cookie, body: form });
  assert.equal(response.status, 503);
  assert.equal(state.objects.size, 0);
  assert.equal(state.env.BUCKET.objects.size, 0, 'Never silently write images to an unrelated binding.');
  const data = await response.json();
  for (const value of [SECRET, AUTH_SECRET, SCRIPT_SECRET]) assert(!JSON.stringify(data).includes(value));
  state.env.DB = { prepare() { throw new Error(SECRET); } };
  const failed = await request(state, '/api/products');
  assert.equal(failed.status, 503);
  assert(!await failed.text().then(text => text.includes(SECRET)));
});

test('cross-site email and mutation requests are denied before provider calls', async t => {
  const state = setup(t);
  const response = await handleRequest(new Request(`${ORIGIN}/api/auth/email/send`, {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }),
  }), state.env, { fetch: state.fetch });
  assert.equal(response.status, 403); assert.equal(state.calls.length, 0);
  const guest = await request(state, '/api/auth/guest', { method: 'POST', body: {} });
  assert.equal(guest.status, 200);
});

test('new deployment remains closed until explicit migration cutover, while static shell is available', async t => {
  const state = setup(t);
  state.env.ASSETS = { fetch: async () => new Response('橘子集', { headers: { 'Content-Type': 'text/html' } }) };
  for (const enabled of [undefined, '', 'false', false, true, 'TRUE']) {
    state.env.JUZI_SITE_ENABLED = enabled;
    for (const path of ['/api/products', '/api/me', '/api/auth/email/send']) {
      const response = await request(state, path, path.endsWith('/send') ? { method: 'POST', body: { email: EMAIL } } : {});
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: { code: 'SITE_INITIALIZING', message: '网站正在初始化，请稍后再试。' } });
    }
    assert.equal((await request(state, '/')).status, 200);
  }
  assert.equal(state.calls.length, 0);
  state.env.JUZI_SITE_ENABLED = 'true';
  assert.equal((await request(state, '/api/products')).status, 200);
});
