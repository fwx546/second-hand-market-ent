const DOMAIN = 'student.xjtlu.edu.cn';
const DAY = 86400000, OTP_LIFETIME = 600000, SESSION_LIFETIME = 7 * DAY;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const PRIVATE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const encoder = new TextEncoder();

class AuthError extends Error {
  constructor(status, code, message, retryAfter = 0, cookies = []) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; this.cookies = cookies;
  }
}
function fail(status, code, message, retryAfter) { throw new AuthError(status, code, message, retryAfter); }
function json(value, status = 200, cookies = [], retryAfter = 0) {
  const headers = new Headers({ ...PRIVATE, 'Content-Type': 'application/json' });
  if (retryAfter) headers.set('Retry-After', String(retryAfter));
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(value), { status, headers });
}
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
async function hash(value) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function emailHash(email) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(email)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function otpHash(secret, challenge, addressHash, bindingHash, code) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${challenge}\0${addressHash}\0${bindingHash}\0${code}`))));
}
function generateCode() {
  const range = 1000000, ceiling = 0x100000000 - 0x100000000 % range, bytes = new Uint32Array(1);
  do { crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
  return String(bytes[0] % range).padStart(6, '0');
}
function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'INVALID_EMAIL', '请输入有效的学校学生邮箱。');
  const email = value.trim().toLowerCase(), parts = email.split('@');
  if (email.length > 254 || parts.length !== 2 || parts[1] !== DOMAIN || !/^[a-z0-9._%+-]{1,64}$/.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) {
    fail(400, 'INVALID_EMAIL', `请使用 @${DOMAIN} 学生邮箱。`);
  }
  return email;
}
function mask(email) { return `${email.split('@')[0].slice(0, 2)}***@${DOMAIN}`; }
function verifiedDisplayName(email) { return email.trim().split('@')[0].replace(/[0-9]/g, '').slice(0, 20) || '橘子同学'; }
function originConfig(env, development = false) {
  try {
    const origin = env.JUZI_EMAIL_ORIGIN?.trim();
    if (!origin) return null;
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password) return null;
    const local = development === true && url.protocol === 'http:' && url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !local) return null;
    return { origin, secure: !local };
  } catch { return null; }
}
function senderValid(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n]/.test(value)) return false;
  const input = value.trim(), angle = input.match(/^[^<>]{1,80}\s*<([^<>\s]+)>$/);
  const address = angle ? angle[1] : input;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(address);
}
function relayUrl(value, origin) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const raw = value.trim();
    if (/[\u0000-\u0020\u007F?#]/.test(raw) || /^https?:\/\/[^/]*@/i.test(raw)) return null;
    const url = new URL(raw), hostname = url.hostname.toLowerCase();
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/send') return null;
    // Loopback HTTP is only meaningful for the trusted localhost development app.
    if (url.protocol === 'http:') return !origin.secure && ['localhost', '127.0.0.1'].includes(hostname) ? url.href : null;
    // Production relays must be public HTTPS DNS hosts; no IP/private-host credentials sink.
    if (url.protocol !== 'https:' || !hostname.includes('.') || hostname.endsWith('.') ||
        /^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[') ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)) return null;
    return url.href;
  } catch { return null; }
}
function gmailScriptUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // Only the published Google web app endpoint is a credential destination.
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{16,256}\/exec$/.test(raw) ? raw : null;
}
function gmailContentUrl(value) {
  // ContentService responds with a one-time result URL. Never forward the POST
  // or its signature to it, and never follow a Google sign-in redirect.
  return typeof value === 'string' && !/[#\u0000-\u0020\u007F\\]/.test(value) && /^https:\/\/script\.googleusercontent\.com\/macros\/echo\?[^#\u0000-\u0020\u007F\\]{1,4096}$/.test(value) ? value : null;
}
function config(env, development = false) {
  const origin = originConfig(env, development), daily = String(env.JUZI_EMAIL_DAILY_LIMIT ?? '').trim() || '1000';
  if (env.JUZI_EMAIL_ENABLED !== 'true' || !origin ||
      typeof env.JUZI_EMAIL_AUTH_SECRET !== 'string' || env.JUZI_EMAIL_AUTH_SECRET.length < 32 || env.JUZI_EMAIL_AUTH_SECRET.length > 4096 ||
      !/^[1-9]\d{0,4}$/.test(daily) || Number(daily) > 10000) return null;
  const provider = String(env.JUZI_EMAIL_PROVIDER ?? '').trim() || 'resend';
  const common = { ...origin, provider, secret: env.JUZI_EMAIL_AUTH_SECRET, dailyLimit: Number(daily) };
  if (provider === 'resend') {
    if (!senderValid(env.JUZI_EMAIL_FROM) || typeof env.RESEND_API_KEY !== 'string' || !env.RESEND_API_KEY.trim() || /[\r\n]/.test(env.RESEND_API_KEY)) return null;
    return { ...common, from: env.JUZI_EMAIL_FROM.trim(), apiKey: env.RESEND_API_KEY };
  }
  if (provider === 'qq_relay') {
    const url = relayUrl(env.JUZI_EMAIL_RELAY_URL, origin), token = env.JUZI_EMAIL_RELAY_TOKEN;
    if (!url || typeof token !== 'string' || token.length < 32 || token.length > 4096 || /[^\x21-\x7E]/.test(token)) return null;
    return { ...common, relayUrl: url, relayToken: token };
  }
  if (provider === 'gmail_apps_script') {
    const url = gmailScriptUrl(env.JUZI_GMAIL_SCRIPT_URL), secret = env.JUZI_GMAIL_SCRIPT_SECRET;
    if (!url || typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || /[^\x21-\x7E]/.test(secret)) return null;
    return { ...common, gmailScriptUrl: url, gmailScriptSecret: secret };
  }
  return null;
}
export function getSchoolAuthConfig(env, { development = false } = {}) {
  return { configured: Boolean(config(env, development)), domain: DOMAIN, sendUrl: '/api/auth/email/send', verifyUrl: '/api/auth/email/verify' };
}
function cookieNames(settings) {
  return settings.secure ? { session: '__Host-juzi_school_session', browser: '__Host-juzi_school_browser' } : { session: 'juzi_dev_school_session', browser: 'juzi_dev_school_browser' };
}
function cookie(name, value, maxAge, secure) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; }
function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  if (raw.length > 16384) return null;
  const found = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  const value = found[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function clearedCookies(settings) {
  // Keep the non-login browser binding: clearing it on guest/logout would reset its send budget.
  const names = ['__Host-juzi_school_session', 'juzi_dev_school_session', '__Host-juzi_session', 'juzi_dev_session', '__Host-juzi_auth_flow', 'juzi_dev_auth_flow', 'juzi_dev_preview'];
  return names.map(name => cookie(name, '', 0, name.startsWith('__Host-') || settings.secure));
}
function statement(db, sql, values = []) { return db.prepare(sql).bind(...values); }
function requireDb(env) { if (!env.DB) fail(503, 'AUTH_UNAVAILABLE', '登录服务暂不可用，请稍后重试。'); return env.DB; }
async function cleanup(db) {
  const now = Date.now();
  await db.batch([
    statement(db, 'DELETE FROM school_email_challenges WHERE created_at <= ?', [now - DAY]),
    statement(db, 'DELETE FROM auth_sessions WHERE expires_at <= ?', [now]),
  ]);
}
async function readBody(request, allowed) {
  if (Number(request.headers.get('content-length')) > 4096) fail(413, 'BODY_TOO_LARGE', '提交内容过大。');
  const chunks = [], reader = request.body?.getReader();
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '提交内容过大。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  if (!size) return {};
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'UNSUPPORTED_TYPE', '请提交 JSON 数据。');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'INVALID_INPUT', '提交数据无法读取。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', '提交字段无效。');
  return body;
}
async function rateError(db, addressHash, bindingHash, dailyLimit, now) {
  const email = await statement(db, 'SELECT count(*) AS n, max(created_at) AS latest FROM school_email_challenges WHERE email_hash = ? AND created_at > ?', [addressHash, now - DAY]).first();
  if (email.latest !== null && email.latest > now - 60000) fail(429, 'EMAIL_RATE_LIMIT', '请稍等一分钟后再获取验证码。', Math.max(1, Math.ceil((email.latest + 60000 - now) / 1000)));
  if (Number(email.n) >= 10) fail(429, 'EMAIL_RATE_LIMIT', '该邮箱 24 小时内最多获取 10 次验证码，请稍后再试。', 3600);
  const browser = await statement(db, 'SELECT count(*) AS n FROM school_email_challenges WHERE binding_hash = ? AND created_at > ?', [bindingHash, now - DAY]).first();
  if (Number(browser.n) >= 20) fail(429, 'BROWSER_RATE_LIMIT', '当前浏览器请求过于频繁，请稍后再试。', 3600);
  const global = await statement(db, 'SELECT count(*) AS n FROM school_email_challenges WHERE created_at > ?', [now - DAY]).first();
  if (Number(global.n) >= dailyLimit) fail(429, 'EMAIL_DAILY_LIMIT', '今日邮件发送额度已用完，请稍后再试。', 3600);
  fail(429, 'EMAIL_RATE_LIMIT', '请求过于频繁，请稍后再试。', 60);
}
async function deliveryResult(response, limit = 16384, requireJson = false) {
  if (!response.ok || response.redirected || response.status >= 300 && response.status < 400 || Number(response.headers.get('content-length')) > limit ||
      requireJson && !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); throw new Error('Delivery failed');
  }
  const reader = response.body?.getReader(), chunks = []; let size = 0;
  if (!reader) throw new Error('Delivery unconfirmed');
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Delivery response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function deliver(cfg, email, code, challengeId, fetchImpl) {
  const relay = cfg.provider === 'qq_relay', gmail = cfg.provider === 'gmail_apps_script';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), relay || gmail ? 15000 : 5000);
  try {
    if (gmail) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const canonical = ['juzi-gmail-v1', challengeId, email, code, String(issuedAt)].join('\n');
      const key = await crypto.subtle.importKey('raw', encoder.encode(cfg.gmailScriptSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      let response = await fetchImpl(cfg.gmailScriptUrl, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ version: 1, requestId: challengeId, email, code, issuedAt, signature }),
      });
      if (!response.redirected && (response.status === 302 || response.status === 303)) {
        const target = gmailContentUrl(response.headers.get('location'));
        await response.body?.cancel();
        if (!target) throw new Error('Delivery redirect rejected');
        response = await fetchImpl(target, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
      }
      const result = await deliveryResult(response, 4096, true);
      if (!result || result.ok !== true || result.id !== challengeId) throw new Error('Delivery unconfirmed');
      return;
    }
    const response = await fetchImpl(relay ? cfg.relayUrl : RESEND_ENDPOINT, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: relay ? { Authorization: `Bearer ${cfg.relayToken}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': challengeId },
      body: JSON.stringify(relay ? { requestId: challengeId, email, code } : { from: cfg.from, to: [email], subject: '橘子集 · 学校邮箱登录验证码', text: `你的橘子集登录验证码：${code}\n\n验证码 10 分钟内有效，请勿转发。如果不是你本人操作，请忽略此邮件。\n\n橘子集是校园闲置交易平台。本次仅验证你对学生邮箱的控制权，不验证在读学籍；这不是学校官方通知。` }),
    });
    const result = await deliveryResult(response);
    if (typeof result.id !== 'string' || !result.id.trim() || result.id.length > 200) throw new Error('Delivery unconfirmed');
  } finally { clearTimeout(timer); }
}
async function send(request, env, cfg, body, fetchImpl) {
  const db = requireDb(env), email = normalizeEmail(body.email), now = Date.now(), addressHash = await emailHash(email);
  const browser = readCookie(request, cookieNames(cfg).browser) || randomToken(), bindingHash = await hash(browser);
  const browserCookie = cookie(cookieNames(cfg).browser, browser, DAY / 1000, cfg.secure);
  const challengeId = crypto.randomUUID(), code = generateCode(), digest = await otpHash(cfg.secret, challengeId, addressHash, bindingHash, code);
  await cleanup(db);
  const reserved = await statement(db, 'INSERT INTO school_email_challenges (id, email_hash, binding_hash, code_hash, email_masked, created_at, expires_at, attempts, consumed_at, delivery_status) SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM school_email_challenges WHERE email_hash = ? AND created_at > ?) AND (SELECT count(*) FROM school_email_challenges WHERE email_hash = ? AND created_at > ?) < 10 AND (SELECT count(*) FROM school_email_challenges WHERE binding_hash = ? AND created_at > ?) < 20 AND (SELECT count(*) FROM school_email_challenges WHERE created_at > ?) < ?',
    [challengeId, addressHash, bindingHash, digest, mask(email), now, now + OTP_LIFETIME, 'pending', addressHash, now - 60000, addressHash, now - DAY, bindingHash, now - DAY, now - DAY, cfg.dailyLimit]).run();
  if (!reserved.meta?.changes) await rateError(db, addressHash, bindingHash, cfg.dailyLimit, now);
  try {
    await deliver(cfg, email, code, challengeId, fetchImpl);
    await statement(db, "UPDATE school_email_challenges SET delivery_status = 'sent' WHERE id = ?", [challengeId]).run();
  } catch {
    await statement(db, "UPDATE school_email_challenges SET delivery_status = 'failed' WHERE id = ?", [challengeId]).run();
    throw new AuthError(503, 'EMAIL_DELIVERY_FAILED', '验证码邮件未能确认发送，请稍后重新获取。', 60, [browserCookie]);
  }
  return json({ challengeId, expiresIn: 600, retryAfter: 60, emailMasked: mask(email) }, 200, [browserCookie]);
}
async function verify(request, env, cfg, body) {
  const db = requireDb(env), email = normalizeEmail(body.email), addressHash = await emailHash(email);
  if (typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challengeId) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) fail(400, 'INVALID_CODE', '请输入六位验证码，或重新获取验证码。');
  const browser = readCookie(request, cookieNames(cfg).browser);
  if (!browser) fail(400, 'INVALID_CODE', '验证码与当前浏览器不匹配，请重新获取。');
  const bindingHash = await hash(browser), now = Date.now(), digest = await otpHash(cfg.secret, body.challengeId, addressHash, bindingHash, body.code);
  // Exactly one concurrent matching request may consume the challenge; wrong guesses increment atomically.
  const row = await statement(db, "UPDATE school_email_challenges SET attempts = attempts + CASE WHEN code_hash = ? THEN 0 ELSE 1 END, consumed_at = CASE WHEN code_hash = ? THEN ? ELSE NULL END WHERE id = ? AND email_hash = ? AND binding_hash = ? AND delivery_status = 'sent' AND consumed_at IS NULL AND expires_at > ? AND attempts < 5 RETURNING email_hash, email_masked, code_hash, consumed_at, attempts",
    [digest, digest, now, body.challengeId, addressHash, bindingHash, now]).first();
  if (!row) {
    const challenge = await statement(db, 'SELECT expires_at, attempts, consumed_at FROM school_email_challenges WHERE id = ? AND email_hash = ? AND binding_hash = ?', [body.challengeId, addressHash, bindingHash]).first();
    if (challenge && !challenge.consumed_at && challenge.attempts >= 5) fail(429, 'CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新获取。', 60);
    if (challenge && !challenge.consumed_at && challenge.expires_at <= now) fail(410, 'CODE_EXPIRED', '验证码已过期，请重新获取。');
    fail(400, 'INVALID_CODE', '验证码无效或已使用，请核对后重试。');
  }
  if (row.code_hash !== digest) {
    if (row.attempts >= 5) fail(429, 'CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新获取。', 60);
    fail(400, 'INVALID_CODE', '验证码不正确，请核对后重试。');
  }
  const displayName = verifiedDisplayName(body.email), candidateUserId = `school_${crypto.randomUUID()}`, session = randomToken(), previous = readCookie(request, cookieNames(cfg).session);
  const batch = [
    statement(db, 'INSERT INTO users (id, display_name, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM school_email_accounts WHERE email_hash = ?)', [candidateUserId, displayName, now, addressHash]),
    statement(db, 'INSERT INTO school_email_accounts (email_hash, user_id, email_masked, verified_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT(email_hash) DO NOTHING', [addressHash, candidateUserId, row.email_masked, now, candidateUserId]),
    statement(db, 'UPDATE school_email_accounts SET verified_at = ? WHERE email_hash = ?', [now, addressHash]),
    statement(db, 'UPDATE users SET display_name = ? WHERE id = (SELECT user_id FROM school_email_accounts WHERE email_hash = ?)', [displayName, addressHash]),
    statement(db, 'INSERT INTO auth_sessions (session_hash, user_id, expires_at, created_at) SELECT ?, user_id, ?, ? FROM school_email_accounts WHERE email_hash = ?', [await hash(session), now + SESSION_LIFETIME, now, addressHash]),
    statement(db, 'DELETE FROM auth_sessions WHERE expires_at <= ?', [now]),
  ];
  if (previous) batch.push(statement(db, 'DELETE FROM auth_sessions WHERE session_hash = ?', [await hash(previous)]));
  await db.batch(batch);
  return json({ ok: true }, 200, [cookie(cookieNames(cfg).session, session, SESSION_LIFETIME / 1000, cfg.secure)]);
}

export async function resolveSchoolViewer(request, env, { development = false } = {}) {
  const settings = originConfig(env, development);
  if (!settings || new URL(request.url).origin !== settings.origin || !env.DB) return null;
  const session = readCookie(request, cookieNames(settings).session);
  if (!session) return null;
  try {
    const digest = await hash(session), now = Date.now();
    const row = await statement(env.DB, 'SELECT s.user_id, s.expires_at, a.email_masked FROM auth_sessions s JOIN school_email_accounts a ON a.user_id = s.user_id WHERE s.session_hash = ?', [digest]).first();
    if (!row) return null;
    if (row.expires_at <= now) { await statement(env.DB, 'DELETE FROM auth_sessions WHERE session_hash = ?', [digest]).run(); return null; }
    return { userId: row.user_id, provider: 'school_email', emailVerified: true, emailMasked: row.email_masked };
  } catch { return null; }
}

/** fetch is an injected transport only in tests; production never sets a mock or returns a code. */
export async function handleSchoolAuth(request, env, { development = false, fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
  if (!['/api/auth/email/send', '/api/auth/email/verify', '/api/auth/logout', '/api/auth/guest'].includes(path)) return null;
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: '请求方式不受支持。' } }, 405);
  const settings = originConfig(env, development), expectedOrigin = settings?.origin || url.origin;
  if (url.origin !== expectedOrigin || request.headers.get('origin') !== expectedOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: { code: 'ORIGIN_REJECTED', message: '请从本站发起登录操作。' } }, 403);
  try {
    const allowed = path.endsWith('/send') ? ['email'] : path.endsWith('/verify') ? ['email', 'challengeId', 'code'] : [];
    const body = await readBody(request, allowed);
    if (path === '/api/auth/logout' || path === '/api/auth/guest') {
      const cookieSettings = settings || { secure: !(development && url.protocol === 'http:' && url.hostname === 'localhost') };
      const expired = clearedCookies(cookieSettings);
      try {
        if (env.DB) {
          const token = readCookie(request, cookieNames(cookieSettings).session);
          if (token) await statement(env.DB, 'DELETE FROM auth_sessions WHERE session_hash = ?', [await hash(token)]).run();
          await cleanup(env.DB);
        }
      } catch { throw new AuthError(503, 'AUTH_UNAVAILABLE', '暂时无法退出，请重试。', 0, expired); }
      return json({ ok: true }, 200, expired);
    }
    const cfg = config(env, development);
    if (!cfg) fail(503, 'EMAIL_AUTH_DISABLED', '学校邮箱验证码尚未开通，你可以先以访客身份浏览。');
    return path.endsWith('/send') ? await send(request, env, cfg, body, fetchImpl) : await verify(request, env, cfg, body);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: { code: error.code, message: error.message } }, error.status, error.cookies, error.retryAfter);
    // Never log or reflect an email address, OTP, API credential, or mail-provider response.
    return json({ error: { code: 'AUTH_UNAVAILABLE', message: '登录服务暂不可用，请稍后重试。' } }, 503);
  }
}
