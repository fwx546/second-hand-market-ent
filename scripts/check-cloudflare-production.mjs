import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DEMO_CATALOG } from '../server/demo-catalog.mjs';

const ORIGIN = 'https://juzi-campus-market.wenxin-fu23.workers.dev';
const CONFIG = new URL('../cloudflare/wrangler.json', import.meta.url);
const STOCK_IMAGES = new Set(Object.values(DEMO_CATALOG));
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const integer = value => Number.isSafeInteger(value) && value >= 0;

class CheckError extends Error {
  constructor(code, retryable = false, status) { super(code); this.code = code; this.retryable = retryable; this.status = status; }
}
function requireValue(value, code) { if (!value) throw new CheckError(code); }

async function jsonBody(response) {
  const reader = response.body?.getReader();
  requireValue(reader, 'JSON_INVALID');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireValue(size <= 1048576, 'RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new CheckError('JSON_INVALID'); }
  } finally { await reader.cancel().catch(() => {}); }
}

async function imageBody(response) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  requireValue(['image/jpeg', 'image/png', 'image/webp'].includes(type), 'IMAGE_INVALID');
  const size = response.headers.get('content-length');
  requireValue(size === null || (/^[0-9]+$/.test(size) && Number(size) > 0 && Number(size) <= 8388608), 'IMAGE_INVALID');
  const reader = response.body?.getReader();
  requireValue(reader, 'IMAGE_INVALID');
  const prefix = new Uint8Array(12); let length = 0;
  try {
    while (length < prefix.length) {
      const part = await reader.read();
      if (part.done) break;
      const needed = Math.min(prefix.length - length, part.value.length);
      prefix.set(part.value.subarray(0, needed), length); length += needed;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const starts = expected => length >= expected.length && expected.every((value, index) => prefix[index] === value);
  const valid = type === 'image/jpeg' ? starts([255, 216, 255])
    : type === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : starts([82, 73, 70, 70]) && length >= 12 && [87, 69, 66, 80].every((value, index) => prefix[index + 8] === value);
  requireValue(valid, 'IMAGE_INVALID');
  return { checked: true, status: response.status, type };
}

// Anonymous GETs only. No cookie jar, account/API credentials, email sends,
// redirects, arbitrary URLs or response bodies are written to build logs.
export async function checkCloudflareProduction({ config, fetchImpl = globalThis.fetch } = {}) {
  const summary = { ok: false, checks: {} };
  const deadline = AbortSignal.timeout(40000);
  let stage = 'configuration';
  async function request(path, parse) {
    requireValue(path === '/api/me' || path === '/api/products?pageSize=24' ||
      /^\/api\/media\/[A-Za-z0-9_-]{1,128}$/.test(path) || STOCK_IMAGES.has(path), 'PATH_INVALID');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(ORIGIN + path, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(6000)]),
          headers: { Accept: parse === imageBody ? 'image/jpeg,image/png,image/webp' : 'application/json' } });
        if (response.status !== 200) throw new CheckError('HTTP_FAILURE', TRANSIENT.has(response.status), response.status);
        if (parse !== imageBody) requireValue(/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || ''), 'JSON_INVALID');
        return await parse(response);
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        if (deadline.aborted) throw new CheckError('TIME_LIMIT');
        const safe = error instanceof CheckError ? error : new CheckError('UNREACHABLE', true);
        if (attempt || !safe.retryable) throw safe;
        await delay(350, undefined, { signal: deadline });
      }
    }
  }
  try {
    requireValue(config?.name === 'juzi-campus-market' && config?.vars?.JUZI_EMAIL_ORIGIN === ORIGIN &&
      config.vars.JUZI_SITE_ENABLED === 'true' && config.vars.JUZI_EMAIL_ENABLED === 'true', 'CONFIG_INVALID');
    stage = 'anonymous';
    const me = await request('/api/me', jsonBody);
    requireValue(me?.user === null && me.authentication?.provider === 'guest' &&
      me.authentication.email?.configured === true && me.authentication.email.domain === 'student.xjtlu.edu.cn' &&
      me.authentication.guest?.enabled === true && me.authentication.preview?.enabled === false &&
      me.capabilities?.canPublish === false && me.capabilities.canViewContact === false && me.capabilities.canFavorite === false &&
      me.development === false, 'ME_INVALID');
    summary.checks.anonymous = { status: 200, guest: true, schoolEmailConfigured: true, previewEnabled: false };

    stage = 'products';
    const products = await request('/api/products?pageSize=24', jsonBody);
    requireValue(Array.isArray(products?.items) && products.items.length <= 24 && integer(products.total) &&
      products.total >= products.items.length && integer(products.realTotal) && integer(products.demoTotal) &&
      products.realTotal + products.demoTotal === products.total &&
      products.items.every(item => item && typeof item === 'object' && Array.isArray(item.images)), 'PRODUCTS_INVALID');
    summary.checks.products = { status: 200, total: products.total, returned: products.items.length,
      realTotal: products.realTotal, demoTotal: products.demoTotal };

    stage = 'photo';
    const paths = products.items.flatMap(item => item.images).filter(path => typeof path === 'string');
    // Prefer a real published upload so the private storage proxy is exercised.
    const image = paths.find(path => /^\/api\/media\/[A-Za-z0-9_-]{1,128}$/.test(path)) || paths.find(path => STOCK_IMAGES.has(path));
    summary.checks.photo = image ? await request(image, imageBody) : { checked: false };
    summary.ok = true;
  } catch (error) {
    summary.failure = { stage, code: error instanceof CheckError ? error.code : deadline.aborted ? 'TIME_LIMIT' : 'CHECK_FAILED' };
    if (error instanceof CheckError && Number.isInteger(error.status)) summary.failure.status = error.status;
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let summary;
  try {
    requireValue(process.argv.length === 2, 'ARGUMENTS_INVALID');
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    summary = await checkCloudflareProduction({ config });
  } catch { summary = { ok: false, failure: { stage: 'configuration', code: 'CONFIG_INVALID' } }; }
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
}
