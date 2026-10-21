import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { A, B, api, fixture, productInput, upload } from './support.mjs';

const serviceSpecs = () => ({ 服务方向: '学习辅导', 计价单位: '每小时', 服务方式: '线上服务', 服务范围: 'Python 基础与练习讲解', '服务时长／交付周期': '每次 60 分钟', 预约安排: '提前一天预约' });
async function create(env, extra = {}) {
  const photo = await upload(env);
  return api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([photo.data.mediaId], { category: 'service', specs: serviceSpecs(), ...extra }) });
}

test('services publish with meaningful fields, normalize physical fields, filter and preserve ownership', async t => {
  const env = fixture(t), created = await create(env);
  assert.equal(created.status, 201);
  const p = created.data.product;
  assert.equal(p.condition, '不适用'); assert.equal(p.originalPrice, 0); assert.equal(p.graduation, false); assert.equal(p.location, '线上服务');
  for (const query of ['category=service', 'serviceDirection=学习辅导', 'serviceMode=线上服务', 'query=服务类', 'query=Python']) {
    const list = await api(env, '/api/products?' + query);
    assert.equal(list.data.total, 1); assert.equal(list.data.categoryCounts.service, 1);
  }
  assert.equal((await api(env, '/api/products?fresh=1')).data.total, 0);
  assert.equal((await api(env, '/api/products?serviceMode=任意')).status, 400);
  assert.equal((await api(env, `/api/products/${p.id}`, { method: 'PATCH', viewer: B, body: { title: '冒用修改' } })).status, 403);
  assert.equal((await api(env, `/api/products/${p.id}`, { method: 'PATCH', viewer: A, body: { status: 'inactive' } })).status, 200);
  assert.equal((await api(env, `/api/products/${p.id}`)).status, 404);
  assert.equal((await api(env, `/api/products/${p.id}`, { method: 'PATCH', viewer: A, body: { status: 'active' } })).status, 200);
});

test('services reject incomplete/physical specs and require location or custom units when applicable', async t => {
  const env = fixture(t);
  for (const specs of [{ 数量: '不限', 使用情况: '很好' }, { ...serviceSpecs(), 预约安排: '' }, { ...serviceSpecs(), 服务方式: '随意' }, { ...serviceSpecs(), 计价单位: '自定义' }]) {
    assert.equal((await create(env, { specs })).status, 400);
  }
  assert.equal((await create(env, { location: '', specs: { ...serviceSpecs(), 服务方式: '线下服务' } })).status, 400);
  const result = await create(env, { specs: { ...serviceSpecs(), 计价单位: '自定义', 自定义单位: '每45分钟', '经验／作品说明': '' } });
  assert.equal(result.status, 201); assert.equal(result.data.product.specs.自定义单位, '每45分钟');
  assert(!Object.hasOwn(result.data.product.specs, '经验／作品说明'));
});

test('transactional D1 migration preserves existing listings, private contacts, images, favorites and messages', async t => {
  const env = fixture(t, { migrate: false }), db = env.DB.sqlite;
  db.exec(readFileSync(new URL('../cloudflare/migrations/0001_schema.sql', import.meta.url), 'utf8'));
  assert.equal((await api(env, '/api/me')).data.capabilities.servicePublishingReady, false);
  const pending = await create(env);
  assert.equal(pending.status, 503); assert.equal(pending.data.error.code, 'SERVICE_SCHEMA_PENDING');
  const photo = await upload(env);
  const result = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([photo.data.mediaId]) });
  const id = result.data.product.id;
  await api(env, `/api/me/favorites/${id}`, { method: 'PUT', viewer: B });
  const convo = await api(env, '/api/conversations', { method: 'POST', viewer: B, body: { productId: id } });
  await api(env, `/api/conversations/${convo.data.conversationId}/messages`, { method: 'POST', viewer: B, body: { body: '测试消息，方便面交吗？' } });
  const tables = ['products', 'private_contacts', 'media', 'product_media', 'favorites', 'conversations', 'messages'];
  const rows = () => tables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
  const before = rows(); assert.equal(before[6].length, 1);
  db.exec('BEGIN');
  try { db.exec(readFileSync(new URL('../cloudflare/migrations/0002_service_listings.sql', import.meta.url), 'utf8')); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.deepEqual(rows(), before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await api(env, '/api/me')).data.capabilities.servicePublishingReady, true);
  assert.equal((await create(env)).status, 201);
});
