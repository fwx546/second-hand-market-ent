import { handleMarket } from '../server/market.mjs';
import { getSchoolAuthConfig, handleSchoolAuth, resolveSchoolViewer } from '../server/school-auth.mjs';
import { createSupabaseBucket } from './supabase-storage.mjs';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
function secured(response, api = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  if (api) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function unavailable() {
  return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后重试。' } }, { status: 503 });
}

// Standalone Cloudflare Worker: existing D1 schema + private Supabase Storage.
// No Sites account, platform identity or local-preview bypass is consulted.
export async function handleRequest(request, bindings, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(request.url), api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  try {
    if (api) {
      if (bindings.JUZI_SITE_ENABLED !== 'true') {
        return secured(Response.json({ error: { code: 'SITE_INITIALIZING', message: '网站正在初始化，请稍后再试。' } }, { status: 503 }), true);
      }
      const env = { ...bindings, BUCKET: createSupabaseBucket(bindings, { fetch: fetchImpl }) };
      const auth = await handleSchoolAuth(request, env, { fetch: fetchImpl });
      if (auth) return secured(auth, true);
      const viewer = await resolveSchoolViewer(request, env);
      return secured(await handleMarket(request, env, viewer, { authentication: {
        provider: viewer?.provider || 'guest', email: getSchoolAuthConfig(env),
        guest: { enabled: true, startUrl: '/api/auth/guest' },
        preview: { enabled: false },
      } }), true);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return secured(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
    }
    if (!bindings.ASSETS?.fetch) return secured(unavailable());
    const assetUrl = new URL(request.url);
    if (assetUrl.pathname === '/') assetUrl.pathname = '/index.html';
    return secured(await bindings.ASSETS.fetch(new Request(assetUrl, request)));
  } catch {
    // Never echo provider errors, private rows, email values or credentials.
    return secured(unavailable(), api);
  }
}

export default { fetch: handleRequest };
