import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBucket, StorageUnavailableError } from '../cloudflare/supabase-storage.mjs';
import { PNG } from './support.mjs';

const SECRET = 'sb_secret_TEST_ONLY_NOT_A_REAL_KEY_0123456789';
const BASE = 'https://testonlyprojectref001.supabase.co';
const env = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEY: SECRET };
const fakeJwt = role => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.TEST_SIGNATURE`;
function setup(respond = () => new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length), ETag: '"test-etag"' } })) {
  const calls = [];
  const bucket = createSupabaseBucket(env, { fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); } });
  return { bucket, calls };
}

test('private read uses the fixed Supabase project, server apikey and exact image bytes', async () => {
  const { bucket, calls } = setup(), object = await bucket.get('market/photo id.png');
  assert.equal(calls[0].url, `${BASE}/storage/v1/object/juzi-market-private/market/photo%20id.png`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.get('apikey'), SECRET);
  assert.equal(calls[0].init.headers.has('authorization'), false, 'New keys are not JWTs.');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.has('range'), false);
  assert.equal(object.size, PNG.length);
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.equal(object.etag, 'test-etag');
  assert.equal(object.httpEtag, '"test-etag"');
  assert.deepEqual(Buffer.from(await object.arrayBuffer()), PNG);
  assert.deepEqual(Buffer.from(await new Response(object.body).arrayBuffer()), PNG);
  const headers = new Headers(); object.writeHttpMetadata(headers);
  assert.equal(headers.get('content-type'), 'image/png');
  assert(!JSON.stringify(object).includes(SECRET));
});

test('only hosted HTTPS Supabase endpoints and privileged server keys configure a bucket', () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('Should not call'); };
  for (const SUPABASE_URL of ['https://attacker.example', 'http://testonlyprojectref001.supabase.co', `${BASE}.evil.example`, `${BASE}/other`, `${BASE}?key=secret`, `${BASE}#x`, 'https://secret@testonlyprojectref001.supabase.co', 'https://testonlyprojectref001.supabase.co:443', 'https://localhost.supabase.co', `${BASE}\n`]) {
    assert.equal(createSupabaseBucket({ ...env, SUPABASE_URL }, { fetch }), null, SUPABASE_URL);
  }
  for (const SUPABASE_SECRET_KEY of ['', 'sb_publishable_TEST_ONLY_0123456789', fakeJwt('anon'), 'secret value', `${SECRET}\n`]) {
    assert.equal(createSupabaseBucket({ ...env, SUPABASE_SECRET_KEY }, { fetch }), null);
  }
  for (const SUPABASE_STORAGE_BUCKET of ['../public', 'bucket/path', 'x?public=true', 'PUBLIC BUCKET']) {
    assert.equal(createSupabaseBucket({ ...env, SUPABASE_STORAGE_BUCKET }, { fetch }), null);
  }
  assert(createSupabaseBucket({ ...env, SUPABASE_URL: `${BASE}/` }, { fetch }));
  assert.equal(calls, 0);
});

test('legacy service_role key remains compatible while anon is rejected', async () => {
  const secret = fakeJwt('service_role'), calls = [];
  const bucket = createSupabaseBucket({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: secret }, { fetch: async (url, init) => {
    calls.push(init); return new Response(null, { status: 404 });
  } });
  assert.equal(await bucket.get('market/test'), null);
  assert.equal(calls[0].headers.get('apikey'), secret);
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${secret}`);
  assert.equal(createSupabaseBucket({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: fakeJwt('anon') }), null);
});

test('object keys are encoded and traversal/control inputs never reach transport', async () => {
  const { bucket, calls } = setup();
  for (const key of ['', '/start', 'end/', 'a//b', 'a/../b', './file', 'a\\b', 'x\nheader']) {
    await assert.rejects(bucket.get(key), StorageUnavailableError);
    await assert.rejects(bucket.put(key, PNG), StorageUnavailableError);
    await assert.rejects(bucket.delete(key), StorageUnavailableError);
  }
  assert.equal(calls.length, 0);
  await bucket.get('market/中文?file#name.png');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, BASE);
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert(url.pathname.includes('%3Ffile%23name.png'));
});

test('uploads preserve bytes and MIME without public URLs and use idempotent upsert', async () => {
  const { bucket, calls } = setup(() => Response.json({ Key: 'juzi-market-private/market/photo', Id: 'test' }));
  const result = await bucket.put('market/photo', PNG, { httpMetadata: { contentType: 'image/png' } });
  assert.deepEqual(result, { key: 'market/photo', size: PNG.length, httpMetadata: { contentType: 'image/png' } });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.get('content-type'), 'image/png');
  assert.equal(calls[0].init.headers.get('x-upsert'), 'true');
  assert.equal(calls[0].init.headers.get('cache-control'), 'max-age=0');
  assert.deepEqual(Buffer.from(calls[0].init.body), PNG);
  await assert.rejects(bucket.put('market/photo', new Uint8Array(8 * 1024 * 1024 + 1)), StorageUnavailableError);
  await assert.rejects(bucket.put('market/photo', PNG, { httpMetadata: { contentType: 'image/png\r\nsecret: x' } }), StorageUnavailableError);
  assert.equal(calls.length, 1);
});

test('migration may refuse overwriting an existing object without changing normal upload behavior', async () => {
  const { bucket, calls } = setup(() => Response.json({ Key: 'juzi-market-private/market/photo', Id: 'test' }));
  await bucket.put('market/photo', PNG, { httpMetadata: { contentType: 'image/png' }, preventOverwrite: true });
  assert.equal(calls[0].init.headers.get('x-upsert'), 'false');
  await bucket.put('market/photo', PNG, { httpMetadata: { contentType: 'image/png' } });
  assert.equal(calls[1].init.headers.get('x-upsert'), 'true');
  const conflict = setup(() => Response.json({ error: 'Duplicate', statusCode: '409' }, { status: 409 }));
  await assert.rejects(conflict.bucket.put('market/photo', PNG, { preventOverwrite: true }), StorageUnavailableError);
  assert.equal(conflict.calls.length, 1, 'No upsert retry may overwrite a concurrent upload.');
  assert.equal(conflict.calls[0].init.headers.get('x-upsert'), 'false');
});

test('only confirmed missing object is null, other failures are opaque and redirects are rejected', async () => {
  for (const response of [new Response(null, { status: 404 }), Response.json({ statusCode: '404', error: 'not_found' }, { status: 400 })]) {
    const { bucket } = setup(() => response);
    assert.equal(await bucket.get('market/photo'), null);
  }
  for (const response of [
    Response.json({ error: 'PRIVATE_PROVIDER_DETAILS', token: SECRET }, { status: 401 }),
    Response.json({ error: 'PRIVATE_PROVIDER_DETAILS', statusCode: '403' }, { status: 400 }),
    new Response(SECRET, { status: 503 }),
    new Response(null, { status: 302, headers: { Location: 'https://attacker.example/steal' } }),
    new Response(PNG, { status: 206, headers: { 'Content-Range': 'bytes 0-3/100' } }),
    new Response(PNG, { headers: { 'Content-Length': String(PNG.length + 1) } }),
    new Response(PNG, { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }),
  ]) {
    const { bucket, calls } = setup(() => response);
    await assert.rejects(bucket.get('market/photo'), error => {
      assert(error instanceof StorageUnavailableError);
      assert(!String(error).includes(SECRET)); assert(!String(error).includes('PRIVATE_PROVIDER_DETAILS'));
      return true;
    });
    assert.equal(calls.length, 1, 'Redirects never receive a second request.');
  }
  const { bucket } = setup(() => { throw new Error(SECRET); });
  await assert.rejects(bucket.get('market/photo'), error => error instanceof StorageUnavailableError && !String(error).includes(SECRET));
});

test('provider success bodies are bounded and malformed acknowledgements fail', async () => {
  for (const response of [Response.json({ ok: true }), new Response('x'.repeat(16385)), Response.json({ Key: 'x' }, { status: 403 })]) {
    const { bucket } = setup(() => response);
    await assert.rejects(bucket.put('market/photo', PNG), StorageUnavailableError);
  }
});

test('decoded provider JSON may retain compressed wire Content-Length', async () => {
  const { bucket } = setup(() => new Response(JSON.stringify({ Key: 'juzi-market-private/market/photo' }), {
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '12' },
  }));
  assert.equal((await bucket.put('market/photo', PNG)).size, PNG.length);
});

test('delete and HEAD stay private and preserve exact keys', async () => {
  const { bucket, calls } = setup((url, init) => init.method === 'HEAD'
    ? new Response(null, { headers: { 'Content-Length': '17', 'Content-Type': 'image/webp' } })
    : Response.json([]));
  await bucket.delete(['market/a', 'market/b']);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prefixes: ['market/a', 'market/b'] });
  const object = await bucket.head('market/a');
  assert.equal(object.size, 17); assert.equal(object.httpMetadata.contentType, 'image/webp');
  assert.equal(calls[1].init.method, 'HEAD');
  await assert.rejects(bucket.delete([]), StorageUnavailableError);
});
