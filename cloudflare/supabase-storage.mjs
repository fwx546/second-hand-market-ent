// Server-only Storage transport. The browser only sees /api/media/<id> and the
// existing market handler decides whether each private object may be read.
const MAX_OBJECT = 8 * 1024 * 1024;
const MAX_JSON = 16384;
const DEFAULT_BUCKET = 'juzi-market-private';

export class StorageUnavailableError extends Error {
  constructor() { super('Image storage is temporarily unavailable.'); this.name = 'StorageUnavailableError'; }
}
const unavailable = () => { throw new StorageUnavailableError(); };

function serverKey(env) {
  const value = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7E]/.test(value)) return null;
  if (/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(value)) return { value, legacy: false };
  // A publishable/anon key must not accidentally turn this into client storage.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role' ? { value, legacy: true } : null;
  } catch { return null; }
}

function configuration(env) {
  const key = serverKey(env);
  if (!key || typeof env.SUPABASE_URL !== 'string') return null;
  // Fix the credential destination to one hosted Supabase project. No custom
  // URL, path, query, userinfo or redirect may receive the server key.
  const match = env.SUPABASE_URL.match(/^https:\/\/([a-z0-9]{10,64})\.supabase\.co\/?$/);
  const bucket = env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET;
  if (!match || typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)) return null;
  return { endpoint: `https://${match[1]}.supabase.co/storage/v1`, bucket, key };
}

function path(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || /[\u0000-\u001F\u007F\\]/.test(key)) unavailable();
  const parts = key.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) unavailable();
  return parts.map(encodeURIComponent).join('/');
}
async function bytesOf(body, maximum) {
  if (body instanceof ArrayBuffer) body = new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > maximum) unavailable();
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) {
    if (body.size > maximum) unavailable();
    return new Uint8Array(await body.arrayBuffer());
  }
  unavailable();
}
async function readLimited(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); unavailable();
  }
  const reader = response.body?.getReader(), chunks = [];
  let size = 0;
  if (!reader) return new Uint8Array();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); unavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  // Fetch runtimes may decode a compressed response while retaining the wire
  // Content-Length; the streaming size limit still applies to decoded bytes.
  if (declared !== null && !response.headers.has('content-encoding') && Number(declared) !== size) unavailable();
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function jsonOf(response) {
  try { return JSON.parse(new TextDecoder().decode(await readLimited(response, MAX_JSON))); }
  catch { unavailable(); }
}

/** The get/put/delete/head subset of R2 used by the market and migration code.
 * No public bucket URLs, signed URLs, listing route or browser Supabase client.
 */
export function createSupabaseBucket(env, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const cfg = configuration(env);
  if (!cfg) return null;
  const request = async (suffix, options, consume) => {
    const headers = new Headers(options.headers);
    headers.set('apikey', cfg.key.value);
    // New sb_secret keys are not JWTs. Only a legacy service_role JWT is also
    // sent as Bearer; the new key is authenticated by Supabase's apikey gateway.
    if (cfg.key.legacy) headers.set('Authorization', `Bearer ${cfg.key.value}`);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`${cfg.endpoint}${suffix}`, {
        ...options, headers, redirect: 'manual', signal: controller.signal,
      });
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel(); unavailable();
      }
      return await consume(response);
    } catch { unavailable(); }
    finally { clearTimeout(timer); }
  };
  const objectPath = key => `/object/${cfg.bucket}/${path(key)}`;
  const metadata = (key, response, size) => ({
    key, size, etag: (response.headers.get('etag') || '').replace(/^"|"$/g, ''),
    httpEtag: response.headers.get('etag') || '',
    httpMetadata: { contentType: response.headers.get('content-type') || 'application/octet-stream' },
    writeHttpMetadata(headers) { headers.set('Content-Type', this.httpMetadata.contentType); },
  });
  return Object.freeze({
    async get(key) {
      return request(objectPath(key), { method: 'GET' }, async response => {
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) {
          // Supabase can represent NoSuchKey as HTTP 400 with a JSON 404.
          const error = await jsonOf(response);
          if (response.status === 400 && (String(error?.statusCode) === '404' || error?.code === 'NoSuchKey')) return null;
          unavailable();
        }
        // No Range is requested. Treat an unsolicited partial response as a
        // provider failure rather than serving incomplete image bytes.
        if (response.status !== 200) { await response.body?.cancel(); unavailable(); }
        const bytes = await readLimited(response, MAX_OBJECT);
        return { ...metadata(key, response, bytes.byteLength), body: new Blob([bytes]).stream(),
          async arrayBuffer() { return bytes.slice().buffer; },
        };
      });
    },
    async head(key) {
      return request(objectPath(key), { method: 'HEAD' }, async response => {
        if (response.status === 404) return null;
        if (!response.ok) unavailable();
        const size = response.headers.get('content-length');
        if (size === null || !/^\d+$/.test(size) || Number(size) > MAX_OBJECT) unavailable();
        return metadata(key, response, Number(size));
      });
    },
    async put(key, value, options = {}) {
      const target = objectPath(key), bytes = await bytesOf(value, MAX_OBJECT);
      const contentType = options.httpMetadata?.contentType || 'application/octet-stream';
      if (typeof contentType !== 'string' || contentType.length > 200 || /[\r\n\u0000]/.test(contentType)) unavailable();
      return request(target, { method: 'POST', body: bytes, headers: {
        'Content-Type': contentType, 'Cache-Control': 'max-age=0', 'x-upsert': options.preventOverwrite === true ? 'false' : 'true',
      } }, async response => {
        const result = await jsonOf(response);
        if (!response.ok || typeof result?.Key !== 'string') unavailable();
        return { key, size: bytes.byteLength, httpMetadata: { contentType } };
      });
    },
    async delete(keys) {
      const values = Array.isArray(keys) ? keys : [keys];
      if (!values.length || values.length > 100) unavailable();
      for (const key of values) path(key);
      return request(`/object/${cfg.bucket}`, { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: values }),
      }, async response => {
        if (!response.ok) { await response.body?.cancel(); unavailable(); }
        await readLimited(response, MAX_JSON);
      });
    },
  });
}
