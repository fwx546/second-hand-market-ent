const COOKIE = 'juzi_dev_preview';
const USER_ID = 'local_preview';
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function allowed(request, development) {
  const url = new URL(request.url);
  return development === true && url.protocol === 'http:' && url.hostname === 'localhost';
}

export function resolveLocalPreviewViewer(request, { development = false } = {}) {
  if (!allowed(request, development)) return null;
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  return values.length === 1 && values[0] === `${COOKIE}=1`
    ? { userId: USER_ID, provider: 'local_preview', preview: true }
    : null;
}

export async function handleLocalPreview(request, env, { development = false } = {}) {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/$/, '') !== '/api/auth/preview') return null;
  if (!allowed(request, development)) return Response.json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, { status: 404, headers: HEADERS });
  if (request.method !== 'POST') return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: '请求方式不受支持。' } }, { status: 405, headers: HEADERS });
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: { code: 'ORIGIN_REJECTED', message: '请从本站发起操作。' } }, { status: 403, headers: HEADERS });
  }
  if (!env?.DB) return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '本地数据库暂不可用。' } }, { status: 503, headers: HEADERS });
  try {
    await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(USER_ID, '本地体验账号', Date.now()).run();
    const headers = new Headers(HEADERS);
    headers.append('Set-Cookie', `${COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '本地体验账号暂不可用。' } }, { status: 503, headers: HEADERS });
  }
}
