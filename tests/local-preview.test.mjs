import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalPreview, resolveLocalPreviewViewer } from '../server/local-preview.mjs';
import { handleSchoolAuth } from '../server/school-auth.mjs';
import { handleMarket } from '../server/market.mjs';
import { fixture } from './support.mjs';

const LOCAL = 'http://localhost:4174';
const request = (path, { method = 'GET', origin = LOCAL, cookie = '', body } = {}) => new Request(`${LOCAL}${path}`, {
  method,
  headers: { ...(method === 'GET' ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('localhost development preview creates a separate account that can edit its profile', async t => {
  const env = fixture(t);
  const login = await handleLocalPreview(request('/api/auth/preview', { method: 'POST' }), env, { development: true });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const viewer = resolveLocalPreviewViewer(request('/api/me', { cookie }), { development: true });
  assert.equal(viewer.provider, 'local_preview');
  const me = await handleMarket(request('/api/me', { cookie }), env, viewer, { development: true });
  assert.equal(me.status, 200);
  const session = await me.json();
  assert.equal(session.user.preview, true);
  assert.equal(session.user.emailVerified, false);
  assert.equal(session.user.emailMasked, null);
  const saved = await handleMarket(request('/api/me', { method: 'PATCH', cookie, body: { displayName: '体验昵称', campus: '太仓校区' } }), env, viewer, { development: true });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).user.displayName, '体验昵称');
  const guest = await handleSchoolAuth(request('/api/auth/guest', { method: 'POST', cookie, body: {} }), env, { development: true });
  assert(guest.headers.getSetCookie().some(value => value.startsWith('juzi_dev_preview=;')));
});

test('preview login is unavailable in production, on non-local hosts, and to cross-origin requests', async t => {
  const env = fixture(t), login = request('/api/auth/preview', { method: 'POST' });
  assert.equal((await handleLocalPreview(login, env, { development: false })).status, 404);
  assert.equal(resolveLocalPreviewViewer(request('/api/me', { cookie: 'juzi_dev_preview=1' }), { development: false }), null);
  assert.equal((await handleLocalPreview(request('/api/auth/preview', { method: 'POST', origin: 'https://other.example' }), env, { development: true })).status, 403);
  const remote = new Request('https://juzi.example/api/auth/preview', { method: 'POST', headers: { Origin: 'https://juzi.example', Cookie: 'juzi_dev_preview=1' } });
  assert.equal((await handleLocalPreview(remote, env, { development: true })).status, 404);
  assert.equal(resolveLocalPreviewViewer(remote, { development: true }), null);
});
