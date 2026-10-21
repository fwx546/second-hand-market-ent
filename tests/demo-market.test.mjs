import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_CATALOG, DEMO_OWNER_ID, demoImages } from '../server/demo-catalog.mjs';
import { A, B, SQLiteD1, MemoryBucket, fixture, api, publish, upload, productInput } from './support.mjs';

const MIGRATION = '0004_public_demo_catalog.sql';
const migrationFolder = new URL('../drizzle/', import.meta.url);
const migrationSQL = readFileSync(new URL(MIGRATION, migrationFolder), 'utf8');
const demoId = 'demo_juzi_01';

test('complete production migrations seed 18 clearly fictional public listings and no login identities or contacts', async t => {
  const env = fixture(t, { includeDemo: true });
  const result = await api(env, '/api/products');
  assert.equal(result.status, 200);
  assert.equal(result.data.total, 18);
  assert.equal(result.data.demoTotal, 18);
  assert.equal(result.data.realTotal, 0);
  assert.deepEqual(result.data.categoryCounts, { all: 18, appliance: 6, ebike: 6, daily: 6, service: 0 });
  assert.equal(result.data.hasMore, false);
  assert.equal(new Set(result.data.items.map(item => item.id)).size, 18);
  for (const campus of ['SIP 校区', '太仓校区']) {
    const filtered = await api(env, `/api/products?campus=${encodeURIComponent(campus)}`);
    assert.equal(filtered.data.total, 9);
    assert.equal(filtered.data.demoTotal, 9);
    assert.equal(filtered.data.realTotal, 0);
  }
  for (const product of result.data.items) {
    assert.equal(product.isDemo, true);
    assert.equal(product.mine, false);
    assert.equal(product.sellerEmailVerified, false);
    assert.match(product.seller, /（示例）$/);
    assert.match(product.description, /虚构的示例商品/);
    assert.match(product.description, /没有真实卖家或联系方式，不能交易/);
    assert.deepEqual(product.imageIds, []);
    assert.deepEqual(product.images, [DEMO_CATALOG[product.id]]);
    assert(!JSON.stringify(product).includes(DEMO_OWNER_ID), 'Internal system identity is not published');
    for (const path of product.images) {
      assert.match(path, /^\/assets\/[a-z0-9-]+\.jpg$/);
      assert(existsSync(new URL(`../public${path}`, import.meta.url)), path);
    }
    const detail = await api(env, `/api/products/${product.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.product.isDemo, true);
  }
  assert.equal(env.DB.sqlite.prepare('SELECT display_name FROM users WHERE id = ?').get(DEMO_OWNER_ID).display_name, '示例展示账号');
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  for (const table of ['school_email_accounts', 'school_email_challenges', 'auth_sessions', 'auth_flows', 'private_contacts', 'product_media', 'media']) {
    assert.equal(env.DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.deepEqual(demoImages('__proto__'), []);
  assert.deepEqual(demoImages('../private.jpg'), []);
  assert.deepEqual(demoImages('toString'), []);
});

test('raw additive production migration preserves existing users, verified accounts, sessions and goods; catalog inserts are idempotent', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of readdirSync(migrationFolder).filter(name => name.endsWith('.sql') && name < MIGRATION).sort()) {
      sqlite.exec(readFileSync(new URL(file, migrationFolder), 'utf8'));
    }
    sqlite.prepare('INSERT INTO users (id, display_name, campus, created_at) VALUES (?, ?, ?, ?)').run('real-user', '真实账号', 'SIP 校区', 1000);
    sqlite.prepare('INSERT INTO school_email_accounts (email_hash, user_id, email_masked, verified_at) VALUES (?, ?, ?, ?)').run('private-email-hash', 'real-user', 'r***@student.xjtlu.edu.cn', 2000);
    sqlite.prepare('INSERT INTO auth_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run('private-session-hash', 'real-user', 9999999999999, 2000);
    sqlite.prepare(`INSERT INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('real-product', 'real-user', '真实发布', 'daily', 1500, 3000, '九成新', 'SIP 校区', '公开面交点', '保留真实描述', '{"数量":"1"}', 0, '真实账号', 'active', 3000, 3000);
    sqlite.prepare('INSERT INTO private_contacts (product_id, type, value) VALUES (?, ?, ?)').run('real-product', 'qq', 'private-contact');
    const before = Object.fromEntries(['users', 'school_email_accounts', 'auth_sessions', 'products', 'private_contacts'].map(table => [table, sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
    // Execute the production SQL unchanged, independently of the unit fixture.
    sqlite.exec(migrationSQL);
    for (const table of ['users', 'school_email_accounts', 'auth_sessions', 'private_contacts']) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}${table === 'users' ? " WHERE id <> 'juzi_demo_catalog'" : ''}`).all().map(row => ({ ...row }));
      assert.deepEqual(rows, before[table], table);
    }
    const realProduct = { ...sqlite.prepare("SELECT * FROM products WHERE id = 'real-product'").get() };
    assert.equal(realProduct.is_demo, 0);
    delete realProduct.is_demo;
    assert.deepEqual(realProduct, before.products[0]);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM products WHERE is_demo = 1').get().n, 18);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 19);
    const beforeReplay = sqlite.prepare('SELECT * FROM products ORDER BY id').all();
    // D1 records the one-time ALTER migration in its ledger. Replaying the seed
    // statements is also safe: INSERT OR IGNORE never replaces existing data.
    const seeds = migrationSQL.split('--> statement-breakpoint').slice(1).join('\n');
    sqlite.exec(seeds); sqlite.exec(seeds);
    assert.deepEqual(sqlite.prepare('SELECT * FROM products ORDER BY id').all(), beforeReplay);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(DEMO_OWNER_ID).n, 1);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('real and demo goods share filtering, stable pagination and price order with separate matching totals', async t => {
  const env = fixture(t, { includeDemo: true });
  const real = await publish(env, A, { title: '真实小风扇', price: 2 });
  assert.equal(real.status, 201);
  const second = await publish(env, B, { title: '真实代步车', category: 'ebike', price: 10000, specs: { 购入时间: '2026 年', 电池情况: '待面交检查', 卖家自述续航: '约20公里' } });
  assert.equal(second.status, 201);
  const firstPage = (await api(env, '/api/products?sort=price-asc&pageSize=1')).data;
  const secondPage = (await api(env, '/api/products?sort=price-asc&pageSize=1&page=2')).data;
  assert.equal(firstPage.items[0].id, real.data.product.id);
  assert.equal(firstPage.items[0].isDemo, false);
  assert.equal(secondPage.items[0].id, 'demo_juzi_18');
  assert.equal(firstPage.total, 20); assert.equal(firstPage.realTotal, 2); assert.equal(firstPage.demoTotal, 18);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.categoryCounts, { all: 20, appliance: 7, ebike: 7, daily: 6, service: 0 });
  const query = (await api(env, '/api/products?query=小风扇&sort=price-asc')).data;
  assert.equal(query.total, 2); assert.equal(query.realTotal, 1); assert.equal(query.demoTotal, 1);
  assert.equal(query.items[0].isDemo, false); assert.equal(query.items[1].isDemo, true);
  const descending = (await api(env, '/api/products?sort=price-desc')).data;
  assert.equal(descending.items[0].id, second.data.product.id);
  const cheap = (await api(env, '/api/products?cheap=1')).data;
  assert.equal(cheap.total, 12); assert.equal(cheap.realTotal, 1); assert.equal(cheap.demoTotal, 11);
  const noResults = (await api(env, '/api/products?query=不存在的商品关键词')).data;
  assert.equal(noResults.total, 0); assert.equal(noResults.realTotal, 0); assert.equal(noResults.demoTotal, 0);
});

test('demo contact is never available; demo management is rejected even for a forged system owner', async t => {
  const env = fixture(t, { includeDemo: true });
  assert.equal((await api(env, `/api/products/${demoId}/contact`)).status, 401);
  for (const viewer of [A, B, { ...A, userId: DEMO_OWNER_ID }]) {
    const contact = await api(env, `/api/products/${demoId}/contact`, { viewer });
    assert.equal(contact.status, 409); assert.equal(contact.data.error.code, 'DEMO_PRODUCT');
    for (const [method, body] of [['PATCH', { status: 'inactive' }], ['PATCH', { title: '篡改示例' }], ['DELETE', undefined]]) {
      const changed = await api(env, `/api/products/${demoId}`, { method, body, viewer });
      assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'DEMO_PRODUCT');
    }
    assert.equal((await api(env, `/api/products/${demoId}`, { viewer })).data.product.mine, false);
  }
  assert.equal((await api(env, '/api/products')).data.demoTotal, 18);
});

test('demo favorites persist across connections and remain isolated per real account', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'juzi-demo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'market.sqlite');
  const first = { DB: new SQLiteD1(filename, true, { includeDemo: true }), BUCKET: new MemoryBucket() };
  try {
    assert.equal((await api(first, `/api/me/favorites/${demoId}`, { method: 'PUT', viewer: A })).status, 200);
    assert.equal((await api(first, `/api/me/favorites/${demoId}`, { method: 'PUT', viewer: A })).status, 200);
    assert.deepEqual((await api(first, '/api/me/favorites', { viewer: B })).data.items, []);
  } finally { first.DB.close(); }
  const reopened = { DB: new SQLiteD1(filename, false), BUCKET: new MemoryBucket() };
  try {
    const favorites = await api(reopened, '/api/me/favorites', { viewer: A });
    assert.equal(favorites.data.items.length, 1);
    assert.equal(favorites.data.items[0].isDemo, true);
    assert.equal(favorites.data.items[0].id, demoId);
    assert.equal((await api(reopened, `/api/me/favorites/${demoId}`, { method: 'DELETE', viewer: A })).status, 200);
    assert.deepEqual((await api(reopened, '/api/me/favorites', { viewer: A })).data.items, []);
  } finally { reopened.DB.close(); }
});

test('normal publishing cannot forge demo flags or select bundled catalog photographs', async t => {
  const env = fixture(t, { includeDemo: true });
  const uploaded = await upload(env);
  const input = productInput([uploaded.data.mediaId]);
  for (const flag of ['isDemo', 'is_demo']) {
    const result = await api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, [flag]: true } });
    assert.equal(result.status, 400);
  }
  assert.equal((await api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, imageIds: [DEMO_CATALOG[demoId]] } })).status, 400);
  const created = await api(env, '/api/products', { method: 'POST', viewer: A, body: input });
  assert.equal(created.status, 201);
  assert.equal(created.data.product.isDemo, false);
  assert.match(created.data.product.images[0], /^\/api\/media\//);
  assert.equal(env.DB.sqlite.prepare('SELECT is_demo FROM products WHERE id = ?').get(created.data.product.id).is_demo, 0);
  for (const flag of ['isDemo', 'is_demo']) {
    assert.equal((await api(env, `/api/products/${created.data.product.id}`, { method: 'PATCH', viewer: A, body: { [flag]: 1 } })).status, 400);
  }
});
