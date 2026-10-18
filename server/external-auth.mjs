import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

const FLOW_MS = 10 * 60 * 1000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CALLBACK = '/api/auth/callback';
const PRIVATE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const encoder = new TextEncoder();
const discoveryCaches = new WeakMap();

class AuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function reject(code, message, status) { throw new AuthError(code, message, status); }
function json(value, status = 200) { return Response.json(value, { status, headers: PRIVATE }); }
function redirect(location, cookies = []) {
  const headers = new Headers({ ...PRIVATE, Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function base64url(bytes) { return base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function hash(value) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function identityId(issuer, subject) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${issuer}\0${subject}`)));
  return `oidc_${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function constantEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function publicHttps(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid provider URL');
  const url = new URL(value), hostname = url.hostname.toLowerCase();
  // OIDC providers use public DNS names. Reject all IP literals (including alternate IPv4 spellings),
  // local names and reserved/private-domain endpoints before making any server-side request.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname.includes('.') ||
      /^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[') || hostname.endsWith('.') ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname) ||
      hostname === 'metadata.google.internal' || (url.port && url.port !== '443')) throw new Error('Invalid provider URL');
  return url;
}
function readConfig(env, development = false) {
  try {
    const issuer = env.JUZI_AUTH_ISSUER?.trim(), clientId = env.JUZI_AUTH_CLIENT_ID?.trim(), origin = env.JUZI_AUTH_ORIGIN?.trim();
    if (!issuer || !clientId || clientId.length > 200 || !origin) return null;
    const issuerUrl = publicHttps(issuer), originUrl = new URL(origin);
    if (issuerUrl.search || originUrl.origin !== origin || originUrl.username || originUrl.password) return null;
    const insecureLocal = development === true && originUrl.protocol === 'http:' && originUrl.hostname === 'localhost';
    if (originUrl.protocol !== 'https:' && !insecureLocal) return null;
    const tokenAuth = env.JUZI_AUTH_TOKEN_AUTH_METHOD || 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(tokenAuth)) return null;
    const secret = env.JUZI_AUTH_CLIENT_SECRET;
    if (tokenAuth !== 'none' && (typeof secret !== 'string' || !secret)) return null;
    const methods = { phone: env.JUZI_AUTH_PHONE_ENABLED === 'true', wechat: env.JUZI_AUTH_WECHAT_ENABLED === 'true' };
    if (!methods.phone && !methods.wechat) return null;
    return { issuer, clientId, origin, tokenAuth, secret, methods, secure: !insecureLocal, redirectUri: `${origin}${CALLBACK}` };
  } catch { return null; }
}

export function getExternalAuthConfig(env, { development = false } = {}) {
  const config = readConfig(env, development);
  return { configured: Boolean(config), methods: config?.methods || { phone: false, wechat: false }, startUrl: '/api/auth/start' };
}
function names(config) {
  return config.secure ? { flow: '__Host-juzi_auth_flow', session: '__Host-juzi_session' } : { flow: 'juzi_dev_auth_flow', session: 'juzi_dev_session' };
}
function cookie(name, value, maximumAge, secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maximumAge}${secure ? '; Secure' : ''}`;
}
function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  if (raw.length > 16384) return null;
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function clearCookies(config) {
  return [cookie(names(config).session, '', 0, config.secure), cookie(names(config).flow, '', 0, config.secure)];
}
function safeReturn(value) {
  if (typeof value !== 'string' || value.length > 1500 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001F\u007F]/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://return.local');
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (parsed.origin !== 'https://return.local' || decodedPath.startsWith('//') || /[\\\u0000-\u001F\u007F]/.test(decodedPath) ||
        /^\/(?:api(?:\/|$)|signin-with-chatgpt(?:\/|$)|signout-with-chatgpt(?:\/|$)|callback(?:\/|$))/.test(decodedPath)) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return '/'; }
}
function dbStatement(db, sql, values = []) { return db.prepare(sql).bind(...values); }
function requireDb(env) {
  if (!env.DB) reject('auth_unavailable', '认证服务暂不可用。', 503);
  return env.DB;
}
async function cleanup(db) {
  const now = Date.now();
  await db.batch([
    dbStatement(db, 'DELETE FROM auth_flows WHERE expires_at <= ?', [now]),
    dbStatement(db, 'DELETE FROM auth_sessions WHERE expires_at <= ?', [now]),
  ]);
}
async function boundedFetch(target, init, fetchImpl, maximum = 65536) {
  const url = publicHttps(String(target));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url.href, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.redirected || response.status >= 300 && response.status < 400 || !response.ok) throw new Error('Provider unavailable');
    if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('Provider response too large'); }
    const chunks = [], reader = response.body?.getReader();
    let size = 0;
    if (!reader) throw new Error('Empty provider response');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) { await reader.cancel(); throw new Error('Provider response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  } finally { clearTimeout(timer); }
}
async function provider(config, fetchImpl) {
  let cache = discoveryCaches.get(fetchImpl);
  if (!cache) { cache = new Map(); discoveryCaches.set(fetchImpl, cache); }
  const cached = cache.get(config.issuer);
  if (cached && cached.expires > Date.now()) return cached.value;
  const response = await boundedFetch(`${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } }, fetchImpl);
  const metadata = await response.json();
  if (metadata.issuer !== config.issuer) throw new Error('Issuer mismatch');
  const authorization = publicHttps(metadata.authorization_endpoint).href, token = publicHttps(metadata.token_endpoint).href, jwksUrl = publicHttps(metadata.jwks_uri);
  if (metadata.response_types_supported && !metadata.response_types_supported.includes('code')) throw new Error('Code flow unavailable');
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('PKCE unavailable');
  if (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes(config.tokenAuth)) throw new Error('Client authentication unavailable');
  const jwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
    [customFetch]: (url, options) => boundedFetch(url, options, fetchImpl),
  });
  const value = { authorization, token, jwks };
  cache.set(config.issuer, { expires: Date.now() + 300000, value });
  return value;
}
async function start(request, env, config, fetchImpl) {
  const db = requireDb(env), discovery = await provider(config, fetchImpl);
  const state = randomToken(), binding = randomToken(), verifier = randomToken(), nonce = randomToken(), now = Date.now();
  const returnTo = safeReturn(new URL(request.url).searchParams.get('return_to'));
  await cleanup(db);
  await dbStatement(db, 'INSERT INTO auth_flows (state_hash, binding_hash, code_verifier, nonce, issuer, client_id, redirect_uri, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [await hash(state), await hash(binding), verifier, nonce, config.issuer, config.clientId, config.redirectUri, returnTo, now + FLOW_MS, now]).run();
  const authorization = new URL(discovery.authorization);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'openid', state, nonce, code_challenge: await hash(verifier), code_challenge_method: 'S256', response_mode: 'query' })) authorization.searchParams.set(key, value);
  return redirect(authorization.href, [cookie(names(config).flow, binding, FLOW_MS / 1000, config.secure)]);
}
async function callback(request, env, config, fetchImpl) {
  const db = requireDb(env), params = new URL(request.url).searchParams, state = params.get('state'), binding = readCookie(request, names(config).flow);
  if (params.getAll('state').length !== 1 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding) reject('invalid_state', '登录状态无效。');
  const stateHash = await hash(state), bindingHash = await hash(binding), now = Date.now();
  // DELETE ... RETURNING consumes the transaction atomically, including across concurrent callbacks.
  const flow = await dbStatement(db, 'DELETE FROM auth_flows WHERE state_hash = ? AND binding_hash = ? AND expires_at > ? RETURNING *', [stateHash, bindingHash, now]).first();
  if (!flow) {
    const expired = await dbStatement(db, 'DELETE FROM auth_flows WHERE state_hash = ? AND binding_hash = ? AND expires_at <= ? RETURNING state_hash', [stateHash, bindingHash, now]).first();
    if (expired) reject('expired_flow', '登录已过期。');
    reject('invalid_state', '登录状态无效。');
  }
  if (flow.issuer !== config.issuer || flow.client_id !== config.clientId || flow.redirect_uri !== config.redirectUri) reject('invalid_state', '登录状态无效。');
  if (params.has('error')) reject('provider_denied', '登录未完成。');
  if (params.getAll('code').length !== 1 || !params.get('code') || params.get('code').length > 4096) reject('invalid_request', '登录回调无效。');
  const discovery = await provider(config, fetchImpl);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: flow.code_verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (config.tokenAuth === 'client_secret_post') body.set('client_secret', config.secret);
  if (config.tokenAuth === 'client_secret_basic') headers.Authorization = `Basic ${base64(encoder.encode(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.secret)}`))}`;
  const response = await boundedFetch(discovery.token, { method: 'POST', headers, body }, fetchImpl, 131072);
  const tokens = await response.json();
  if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 65536) reject('invalid_token', '登录凭证无效。');
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, discovery.jwks, {
      issuer: config.issuer, audience: config.clientId, algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m', clockTolerance: 5,
    }));
  } catch { reject('invalid_token', '登录凭证无效。'); }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 1024 || !constantEqual(claims.nonce, flow.nonce) ||
      typeof claims.iat !== 'number' || claims.iat < Math.floor(flow.created_at / 1000) - 60 ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) ||
      (claims.azp !== undefined && claims.azp !== config.clientId)) reject('invalid_token', '登录凭证无效。');
  const userId = await identityId(config.issuer, claims.sub), session = randomToken(), previous = readCookie(request, names(config).session);
  const statements = [
    dbStatement(db, 'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING', [userId, '橘子同学', now]),
    dbStatement(db, 'INSERT INTO auth_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [await hash(session), userId, now + SESSION_MS, now]),
  ];
  if (previous) statements.push(dbStatement(db, 'DELETE FROM auth_sessions WHERE session_hash = ?', [await hash(previous)]));
  statements.push(dbStatement(db, 'DELETE FROM auth_sessions WHERE expires_at <= ?', [now]));
  await db.batch(statements);
  return redirect(safeReturn(flow.return_to), [cookie(names(config).session, session, SESSION_MS / 1000, config.secure), cookie(names(config).flow, '', 0, config.secure)]);
}

export async function resolveExternalViewer(request, env, { development = false } = {}) {
  const config = readConfig(env, development);
  if (!config || new URL(request.url).origin !== config.origin || !env.DB) return null;
  const session = readCookie(request, names(config).session);
  if (!session) return null;
  try {
    const sessionHash = await hash(session), now = Date.now();
    const row = await dbStatement(env.DB, 'SELECT user_id, expires_at FROM auth_sessions WHERE session_hash = ?', [sessionHash]).first();
    if (!row) return null;
    if (row.expires_at <= now) { await dbStatement(env.DB, 'DELETE FROM auth_sessions WHERE session_hash = ?', [sessionHash]).run(); return null; }
    return { userId: row.user_id, provider: 'external' };
  } catch { return null; }
}

/** fetch is an optional transport dependency for protocol tests; production passes only development. */
export async function handleExternalAuth(request, env, { development = false, fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  if (!['/api/auth/start', CALLBACK, '/api/auth/logout'].includes(path)) return null;
  const expectedMethod = path === '/api/auth/logout' ? 'POST' : 'GET';
  if (request.method !== expectedMethod) return json({ error: { code: 'METHOD_NOT_ALLOWED', message: '请求方式不受支持。' } }, 405);
  const config = readConfig(env, development);
  if (path === '/api/auth/logout') {
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site' || (config && url.origin !== config.origin)) {
      return json({ error: { code: 'ORIGIN_REJECTED', message: '请从本站退出登录。' } }, 403);
    }
    const cookieConfig = config || { secure: !(development && url.protocol === 'http:' && url.hostname === 'localhost') };
    try {
      if (env.DB) {
        const session = readCookie(request, names(cookieConfig).session);
        if (session) await dbStatement(env.DB, 'DELETE FROM auth_sessions WHERE session_hash = ?', [await hash(session)]).run();
        await cleanup(env.DB);
      }
      const headers = new Headers({ ...PRIVATE, 'Content-Type': 'application/json' });
      for (const value of clearCookies(cookieConfig)) headers.append('Set-Cookie', value);
      return new Response(JSON.stringify({ redirectTo: '/signout-with-chatgpt?return_to=%2F' }), { headers });
    } catch { return json({ error: { code: 'AUTH_UNAVAILABLE', message: '暂时无法退出，请重试。' } }, 503); }
  }
  const flowClear = config ? [cookie(names(config).flow, '', 0, config.secure)] : [];
  if (!config) return path === CALLBACK ? redirect('/#/login?auth_error=not_configured', flowClear) : json({ error: { code: 'AUTH_DISABLED', message: '手机号与微信登录尚未开通。' } }, 503);
  if (url.origin !== config.origin) return path === CALLBACK ? redirect('/#/login?auth_error=login_failed', flowClear) : json({ error: { code: 'ORIGIN_REJECTED', message: '登录站点地址不匹配。' } }, 403);
  try {
    return path === CALLBACK ? await callback(request, env, config, fetchImpl) : await start(request, env, config, fetchImpl);
  } catch (error) {
    const callbackCodes = { invalid_state: 'invalid_state', expired_flow: 'expired_flow', provider_denied: 'provider_error', invalid_token: 'invalid_token' };
    const code = error instanceof AuthError && Object.hasOwn(callbackCodes, error.code) ? callbackCodes[error.code] : 'login_failed';
    if (path === CALLBACK) return redirect(`/#/login?auth_error=${code}`, flowClear);
    return json({ error: { code: 'AUTH_UNAVAILABLE', message: '登录服务暂不可用，请稍后重试。' } }, 503);
  }
}
