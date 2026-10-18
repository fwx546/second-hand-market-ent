import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getExternalAuthConfig, handleExternalAuth, resolveExternalViewer } from '../server/external-auth.mjs';
import { A, ORIGIN, PNG, api, fixture, productInput } from './support.mjs';

const keys = await generateKeyPair('RS256');
const differentKeys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'main-key', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://login.testprovider.com/oidc';
const cryptoHash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
function takeCookies(response) { return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; '); }
function authRequest(path, cookie = '', { method = 'GET', origin } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('Origin', origin);
  return new Request(new URL(path, ORIGIN), { method, headers });
}
function makeProvider(t, options = {}) {
  const env = Object.assign(fixture(t), {
    JUZI_AUTH_ISSUER: ISSUER, JUZI_AUTH_CLIENT_ID: 'juzi-test-client', JUZI_AUTH_ORIGIN: ORIGIN,
    JUZI_AUTH_PHONE_ENABLED: 'true', JUZI_AUTH_WECHAT_ENABLED: 'true', ...options.env,
  });
  const codes = new Map(), requests = [];
  const metadata = {
    issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    ...options.metadata,
  };
  const fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, method: init.method || 'GET' });
    if (options.fetchOverride) {
      const override = await options.fetchOverride(url, init);
      if (override) return override;
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(metadata);
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      const fields = new URLSearchParams(init.body), record = codes.get(fields.get('code'));
      assert(record, 'Only a test code minted by this issuer may be exchanged.');
      assert.equal(fields.get('grant_type'), 'authorization_code');
      assert.equal(fields.get('client_id'), env.JUZI_AUTH_CLIENT_ID);
      assert.equal(fields.get('redirect_uri'), `${env.JUZI_AUTH_ORIGIN}/api/auth/callback`);
      assert.equal(await cryptoHash(fields.get('code_verifier')), record.challenge, 'Token exchange must prove PKCE.');
      if (env.JUZI_AUTH_TOKEN_AUTH_METHOD === 'client_secret_post') assert.equal(fields.get('client_secret'), env.JUZI_AUTH_CLIENT_SECRET);
      if (env.JUZI_AUTH_TOKEN_AUTH_METHOD === 'client_secret_basic') assert(new Headers(init.headers).get('authorization')?.startsWith('Basic '));
      return Response.json({ id_token: record.token, access_token: 'PROVIDER_ACCESS_TOKEN_MUST_NOT_PERSIST', token_type: 'Bearer' });
    }
    throw new Error('Unexpected test-provider request');
  };
  const context = { fetch, development: false };
  async function start(returnTo = '/#/profile') {
    const response = await handleExternalAuth(authRequest(`/api/auth/start?return_to=${encodeURIComponent(returnTo)}`), env, context);
    return { response, cookie: takeCookies(response), authorization: new URL(response.headers.get('location'), ORIGIN) };
  }
  async function issue(flow, overrides = {}, signingKey = keys.privateKey, algorithm = 'RS256') {
    const now = Math.floor(Date.now() / 1000), claims = {
      iss: ISSUER, aud: env.JUZI_AUTH_CLIENT_ID, sub: 'private-provider-subject', iat: now, exp: now + 300,
      nonce: flow.authorization.searchParams.get('nonce'), email: 'PRIVATE_ACCOUNT_EMAIL@example.com', phone_number: 'PRIVATE_PHONE_NUMBER', ...overrides,
    };
    for (const [key, value] of Object.entries(claims)) if (value === undefined) delete claims[key];
    const token = await new SignJWT(claims).setProtectedHeader({ alg: algorithm, kid: 'main-key' }).sign(signingKey);
    const code = crypto.randomUUID();
    codes.set(code, { token, challenge: flow.authorization.searchParams.get('code_challenge') });
    const path = `/api/auth/callback?code=${code}&state=${flow.authorization.searchParams.get('state')}`;
    return { code, token, path };
  }
  async function login(overrides = {}) {
    const flow = await start(), issued = await issue(flow, overrides);
    const response = await handleExternalAuth(authRequest(issued.path, flow.cookie), env, context);
    const cookie = takeCookies(response).split('; ').filter(part => !part.startsWith('__Host-juzi_auth_flow=')).join('; ');
    return { flow, issued, response, cookie };
  }
  return { env, fetch, context, requests, start, issue, login };
}

test('external auth is disabled by default and exposes no secrets or fake login', async t => {
  const env = fixture(t);
  assert.deepEqual(getExternalAuthConfig(env), { configured: false, methods: { phone: false, wechat: false }, startUrl: '/api/auth/start' });
  const response = await handleExternalAuth(authRequest('/api/auth/start'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AUTH_DISABLED');
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal((await handleExternalAuth(authRequest('/api/auth/callback'), env)).headers.get('location'), '/#/login?auth_error=not_configured');
  assert.equal(await resolveExternalViewer(authRequest('/api/me'), env), null);
  assert.equal(await handleExternalAuth(authRequest('/callback'), env), null, 'Sites callback remains untouched');
});

test('configuration requires explicit methods, exact origin and valid token auth', async t => {
  const provider = makeProvider(t);
  assert.equal(getExternalAuthConfig(provider.env).configured, true);
  for (const changes of [
    { JUZI_AUTH_ORIGIN: '' }, { JUZI_AUTH_CLIENT_ID: '' }, { JUZI_AUTH_ISSUER: 'http://login.testprovider.com/oidc' },
    { JUZI_AUTH_ISSUER: 'https://127.0.0.1/oidc' }, { JUZI_AUTH_ISSUER: 'https://metadata.google.internal/oidc' },
    { JUZI_AUTH_ORIGIN: `${ORIGIN}/` }, { JUZI_AUTH_ORIGIN: 'http://localhost:4174' },
    { JUZI_AUTH_PHONE_ENABLED: 'false', JUZI_AUTH_WECHAT_ENABLED: 'false' },
    { JUZI_AUTH_TOKEN_AUTH_METHOD: 'client_secret_basic', JUZI_AUTH_CLIENT_SECRET: '' }, { JUZI_AUTH_TOKEN_AUTH_METHOD: 'invented' },
  ]) assert.equal(getExternalAuthConfig({ ...provider.env, ...changes }).configured, false, JSON.stringify(changes));
  const local = { ...provider.env, JUZI_AUTH_ORIGIN: 'http://localhost:4174' };
  assert.equal(getExternalAuthConfig(local, { development: true }).configured, true);
  assert.equal(getExternalAuthConfig({ ...local, JUZI_AUTH_ORIGIN: 'http://127.0.0.1:4174' }, { development: true }).configured, false);
  const exposed = JSON.stringify(getExternalAuthConfig({ ...provider.env, JUZI_AUTH_CLIENT_SECRET: 'PRIVATE_SECRET' }));
  assert(!exposed.includes('PRIVATE_SECRET')); assert(!exposed.includes(ISSUER));
});

test('start uses issuer-path discovery, fixed Code+PKCE+nonce and secure browser binding', async t => {
  const provider = makeProvider(t), flow = await provider.start('/#/publish');
  assert.equal(flow.response.status, 303);
  assert.equal(provider.requests[0].url, `${ISSUER}/.well-known/openid-configuration`);
  const params = flow.authorization.searchParams;
  assert.equal(params.get('response_type'), 'code'); assert.equal(params.get('scope'), 'openid');
  assert.equal(params.get('code_challenge_method'), 'S256'); assert.equal(params.get('redirect_uri'), `${ORIGIN}/api/auth/callback`);
  for (const name of ['state', 'nonce', 'code_challenge']) assert.match(params.get(name), /^[A-Za-z0-9_-]{43}$/);
  const setCookie = flow.response.headers.getSetCookie()[0];
  assert(setCookie.startsWith('__Host-')); assert(setCookie.includes('HttpOnly')); assert(setCookie.includes('SameSite=Lax')); assert(setCookie.includes('Secure'));
  const row = provider.env.DB.sqlite.prepare('SELECT * FROM auth_flows').get();
  assert.notEqual(row.state_hash, params.get('state'));
  assert(!JSON.stringify(row).includes(flow.cookie.split('=')[1]));
  assert.equal(row.return_to, '/#/publish'); assert.equal(row.expires_at - row.created_at, 600000);
});

test('cross-origin/reserved return paths cannot become login open redirects', async t => {
  const provider = makeProvider(t);
  for (const returnTo of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/%2f%2fevil.example', '/api/auth/start', '/callback', '/signin-with-chatgpt', '/api/me']) {
    const flow = await provider.start(returnTo), issued = await provider.issue(flow);
    const response = await handleExternalAuth(authRequest(issued.path, flow.cookie), provider.env, provider.context);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/', returnTo);
  }
});

test('valid callback stores opaque session hashes only and supports stable private identity', async t => {
  const provider = makeProvider(t), login = await provider.login();
  assert.equal(login.response.status, 303); assert.equal(login.response.headers.get('location'), '/#/profile');
  const viewer = await resolveExternalViewer(authRequest('/api/me', login.cookie), provider.env);
  assert.match(viewer.userId, /^oidc_[0-9a-f]{64}$/); assert.equal(viewer.provider, 'external');
  assert.equal(provider.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_flows').get().n, 0);
  const sessions = provider.env.DB.sqlite.prepare('SELECT * FROM auth_sessions').all();
  assert.equal(sessions.length, 1); assert.equal(sessions[0].expires_at - sessions[0].created_at, 7 * 86400000);
  const rawSession = login.cookie.split('=')[1];
  assert.notEqual(sessions[0].session_hash, rawSession);
  const stored = JSON.stringify({ sessions, users: provider.env.DB.sqlite.prepare('SELECT * FROM users').all() });
  for (const forbidden of [rawSession, login.issued.token, 'PROVIDER_ACCESS_TOKEN_MUST_NOT_PERSIST', 'PRIVATE_ACCOUNT_EMAIL', 'PRIVATE_PHONE_NUMBER', 'private-provider-subject']) assert(!stored.includes(forbidden), 'No provider token/profile/raw session persists.');
  const again = await provider.login();
  assert.equal((await resolveExternalViewer(authRequest('/api/me', again.cookie), provider.env)).userId, viewer.userId);
});

test('state is browser-bound, expires, and is consumed atomically against replay', async t => {
  const provider = makeProvider(t), flow = await provider.start(), issued = await provider.issue(flow);
  const badBinding = `${flow.cookie.split('=')[0]}=${'X'.repeat(43)}`;
  const bad = await handleExternalAuth(authRequest(issued.path, badBinding), provider.env, provider.context);
  assert.equal(bad.headers.get('location'), '/#/login?auth_error=invalid_state');
  const outcomes = await Promise.all([1, 2].map(() => handleExternalAuth(authRequest(issued.path, flow.cookie), provider.env, provider.context)));
  assert.equal(outcomes.filter(response => response.headers.get('location') === '/#/profile').length, 1);
  assert.equal(outcomes.filter(response => response.headers.get('location') === '/#/login?auth_error=invalid_state').length, 1);
  assert.equal(provider.requests.filter(request => request.url.endsWith('/token')).length, 1);
  const expiredFlow = await provider.start(), expiredCode = await provider.issue(expiredFlow);
  provider.env.DB.sqlite.prepare('UPDATE auth_flows SET expires_at = ?').run(Date.now() - 1);
  const expired = await handleExternalAuth(authRequest(expiredCode.path, expiredFlow.cookie), provider.env, provider.context);
  assert.equal(expired.headers.get('location'), '/#/login?auth_error=expired_flow');
});

test('provider denial and malformed callback errors are fixed and never reflect provider text', async t => {
  const provider = makeProvider(t), flow = await provider.start();
  const path = `/api/auth/callback?state=${flow.authorization.searchParams.get('state')}&error=SECRET_PROVIDER_DETAIL&error_description=PRIVATE_PROFILE`;
  const response = await handleExternalAuth(authRequest(path, flow.cookie), provider.env, provider.context);
  assert.equal(response.headers.get('location'), '/#/login?auth_error=provider_error');
  assert(!JSON.stringify([...response.headers]).includes('SECRET_PROVIDER_DETAIL'));
  assert.equal(provider.requests.filter(request => request.url.endsWith('/token')).length, 0);
});

test('invalid signatures, algorithms, issuer, audience, nonce, exp and iat never create sessions', async t => {
  const cases = [
    { claims: { iss: 'https://other.testprovider.com/oidc' } }, { claims: { aud: 'other-client' } }, { claims: { nonce: 'WRONG_NONCE' } },
    { claims: { exp: Math.floor(Date.now() / 1000) - 120 } }, { claims: { iat: Math.floor(Date.now() / 1000) + 120 } },
    { claims: { iat: undefined } }, { claims: { nonce: undefined } }, { claims: { sub: undefined } },
    { claims: { aud: ['juzi-test-client', 'other-client'] } }, { claims: { aud: ['juzi-test-client', 'other-client'], azp: 'other-client' } },
    { claims: {}, key: differentKeys.privateKey }, { claims: {}, key: new TextEncoder().encode('a'.repeat(32)), algorithm: 'HS256' },
  ];
  for (const entry of cases) {
    const provider = makeProvider(t), flow = await provider.start(), issued = await provider.issue(flow, entry.claims, entry.key, entry.algorithm);
    const response = await handleExternalAuth(authRequest(issued.path, flow.cookie), provider.env, provider.context);
    assert.equal(response.headers.get('location'), '/#/login?auth_error=invalid_token', JSON.stringify(entry.claims));
    assert.equal(provider.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  }
  const valid = makeProvider(t), login = await valid.login({ aud: ['juzi-test-client', 'other-client'], azp: 'juzi-test-client' });
  assert.equal(login.response.headers.get('location'), '/#/profile');
});

test('discovery refuses issuer mismatch, private endpoints, redirect responses and oversized bodies', async t => {
  const scenarios = [
    { metadata: { issuer: 'https://wrong.testprovider.com/oidc' } },
    { metadata: { token_endpoint: 'https://127.0.0.1/token' } },
    { metadata: { jwks_uri: 'https://[::1]/jwks' } },
    { metadata: { authorization_endpoint: 'https://metadata.google.internal/login' } },
    { fetchOverride: async () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/' } }) },
    { fetchOverride: async () => new Response('x'.repeat(65537)) },
  ];
  for (const options of scenarios) {
    const provider = makeProvider(t, options), started = await provider.start();
    assert.equal(started.response.status, 503);
    assert.equal(provider.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_flows').get().n, 0);
    assert.equal(provider.requests.length, 1);
  }
});

test('client authentication modes are explicit; local HTTP cookies require trusted development flag', async t => {
  for (const method of ['client_secret_post', 'client_secret_basic']) {
    const provider = makeProvider(t, { env: { JUZI_AUTH_TOKEN_AUTH_METHOD: method, JUZI_AUTH_CLIENT_SECRET: 'TEST_ONLY_SECRET' } });
    assert.equal((await provider.login()).response.headers.get('location'), '/#/profile');
  }
  const provider = makeProvider(t, { env: { JUZI_AUTH_ORIGIN: 'http://localhost:4174' } });
  const request = new Request('http://localhost:4174/api/auth/start');
  assert.equal((await handleExternalAuth(request, provider.env, { fetch: provider.fetch })).status, 503);
  const local = await handleExternalAuth(request, provider.env, { fetch: provider.fetch, development: true });
  assert.equal(local.status, 303);
  const value = local.headers.getSetCookie()[0];
  assert(value.startsWith('juzi_dev_auth_flow=')); assert(!value.includes('; Secure')); assert(value.includes('HttpOnly'));
});

test('session expiry cleanup and POST same-origin logout revoke only the current session', async t => {
  const provider = makeProvider(t), loginA = await provider.login(), loginB = await provider.login({ sub: 'different-subject' });
  const viewerB = await resolveExternalViewer(authRequest('/api/me', loginB.cookie), provider.env);
  assert.equal((await handleExternalAuth(authRequest('/api/auth/logout', loginA.cookie), provider.env)).status, 405);
  for (const origin of [undefined, 'https://attacker.example']) {
    assert.equal((await handleExternalAuth(authRequest('/api/auth/logout', loginA.cookie, { method: 'POST', origin }), provider.env)).status, 403);
  }
  const loggedOut = await handleExternalAuth(authRequest('/api/auth/logout', loginA.cookie, { method: 'POST', origin: ORIGIN }), provider.env);
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(await loggedOut.json(), { redirectTo: '/signout-with-chatgpt?return_to=%2F' });
  assert(loggedOut.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
  assert.equal(await resolveExternalViewer(authRequest('/api/me', loginA.cookie), provider.env), null);
  assert.equal((await resolveExternalViewer(authRequest('/api/me', loginB.cookie), provider.env)).userId, viewerB.userId);
  provider.env.DB.sqlite.prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal(await resolveExternalViewer(authRequest('/api/me', loginB.cookie), provider.env), null);
  assert.equal(provider.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('external sessions authorize real marketplace operations without weakening owner/contact checks', async t => {
  const provider = makeProvider(t), loginA = await provider.login(), loginB = await provider.login({ sub: 'provider-user-B' });
  const viewerA = await resolveExternalViewer(authRequest('/api/me', loginA.cookie), provider.env);
  const viewerB = await resolveExternalViewer(authRequest('/api/me', loginB.cookie), provider.env);
  const form = new FormData(); form.append('file', new Blob([PNG], { type: 'image/png' }), 'test.png');
  const image = await api(provider.env, '/api/media', { method: 'POST', viewer: viewerA, body: form });
  assert.equal(image.status, 201);
  const product = await api(provider.env, '/api/products', { method: 'POST', viewer: viewerA, body: productInput([image.data.mediaId]) });
  assert.equal(product.status, 201);
  assert.equal((await api(provider.env, `/api/products/${product.data.product.id}/contact`)).status, 401);
  assert.equal((await api(provider.env, `/api/products/${product.data.product.id}/contact`, { viewer: viewerB })).status, 200);
  assert.equal((await api(provider.env, `/api/products/${product.data.product.id}`, { method: 'PATCH', viewer: viewerB, body: { price: 1 } })).status, 403);
  assert.equal((await api(provider.env, '/api/me/products', { viewer: viewerA })).data.items.length, 1);
  assert.equal((await api(provider.env, '/api/me/products', { viewer: A })).data.items.length, 0);
  const again = await provider.login();
  const sameViewer = await resolveExternalViewer(authRequest('/api/me', again.cookie), provider.env);
  assert.equal(sameViewer.userId, viewerA.userId);
  assert.equal((await api(provider.env, '/api/me', { viewer: sameViewer })).data.user.displayName, '小橘同学');
});
