import test from 'node:test';
import assert from 'node:assert/strict';
import { A, B, PNG, api, fixture } from './support.mjs';
import { DEMO_OWNER_ID, demoImages } from '../server/demo-catalog.mjs';

// Count executions of the real SQLite statements, including bound arguments,
// rather than matching mocked SQL or merely counting calls to prepare().
async function countedRequest(env, path, options) {
  const queries = [];
  const wrap = (prepared, sql, values = []) => ({
    bind(...bound) { return wrap(prepared.bind(...bound), sql, bound); },
    ...Object.fromEntries(['first', 'all', 'run'].map(method => [method, async () => {
      queries.push({ sql, values });
      assert(values.length <= 100, `D1 parameter limit exceeded: ${values.length}`);
      return prepared[method]();
    }])),
  });
  const result = await api({ ...env, DB: {
    prepare(sql) { return wrap(env.DB.prepare(sql), sql); },
    batch(statements) { return env.DB.batch(statements); },
  } }, path, options);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert(queries.length < 50, `${path} executed ${queries.length} queries`);
  return { ...result, queries };
}

function seedUser(env, userId, verifiedAt) {
  env.DB.sqlite.prepare('INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(userId, '私人账户昵称', 1);
  if (verifiedAt !== undefined) env.DB.sqlite.prepare('INSERT INTO school_email_accounts (email_hash, user_id, email_masked, verified_at) VALUES (?, ?, ?, ?)')
    .run(`private-email-hash-${userId}`, userId, 'private***@student.xjtlu.edu.cn', verifiedAt);
}

function seedListings(env, count, { prefix, owners, state = () => 'active', createdAt = 1000 }) {
  const insertProduct = env.DB.sqlite.prepare(`INSERT INTO products
    (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, sold_at, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMedia = env.DB.sqlite.prepare('INSERT INTO media (id, owner_id, object_key, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const attachMedia = env.DB.sqlite.prepare('INSERT INTO product_media (product_id, media_id, position) VALUES (?, ?, ?)');
  const insertContact = env.DB.sqlite.prepare('INSERT INTO private_contacts (product_id, type, value) VALUES (?, ?, ?)');
  const products = [];
  env.DB.sqlite.exec('BEGIN');
  try {
    for (let index = 0; index < count; index++) {
      const id = `${prefix}_${String(index).padStart(5, '0')}`, owner = owners[index % owners.length], status = state(index);
      insertProduct.run(id, owner, `商品 ${id}`, ['appliance', 'ebike', 'daily'][index % 3], 100 + index, 200 + index,
        '几乎全新', 'SIP 校区', '公共面交点', '这是用于列表查询的商品描述。', '{"数量":"1"}', 0, '同名卖家',
        status === 'active' ? 'active' : 'inactive', status === 'sold' ? 2 : null, status === 'deleted' ? 3 : null, createdAt, createdAt);
      insertContact.run(id, 'wechat', `private-contact-${id}`);
      const imageIds = index % 17 === 0 ? [] : [`${id}_first`, `${id}_last`];
      // Deliberately insert in reverse order, with nonconsecutive positions.
      for (const [mediaId, position] of [[imageIds[1], 7], [imageIds[0], 2]]) {
        if (!mediaId) continue;
        insertMedia.run(mediaId, owner, `private-object/${mediaId}`, 'image/png', PNG.length, 1);
        attachMedia.run(id, mediaId, position);
      }
      products.push({ id, owner, status, imageIds });
    }
    env.DB.sqlite.exec('COMMIT');
  } catch (error) { env.DB.sqlite.exec('ROLLBACK'); throw error; }
  return products;
}

function assertDto(item, expected, viewer, verified) {
  assert.equal(item.id, expected.id);
  assert.equal(item.mine, expected.owner === viewer?.userId);
  assert.equal(item.status, expected.status);
  assert.equal(item.seller, '同名卖家');
  assert.equal(item.sellerEmailVerified, verified);
  assert.deepEqual(item.imageIds, expected.imageIds);
  assert.deepEqual(item.images, expected.imageIds.map(id => `/api/media/${id}`));
  for (const key of ['owner_id', 'ownerId', 'email_hash', 'email_masked', 'contactType', 'contactValue']) assert(!Object.hasOwn(item, key), key);
}

function assertPrivateDataAbsent(data, owners) {
  const serialized = JSON.stringify(data);
  for (const secret of [...owners, 'private-email-hash-', 'private***@', 'private-contact-', 'private-object/', '私人账户昵称']) {
    assert(!serialized.includes(secret), `Leaked ${secret}`);
  }
}

test('100 real listings from 100 same-named sellers use five queries with correct badges, order and ownership', async t => {
  const env = fixture(t), owners = [A.userId, B.userId, ...Array.from({ length: 98 }, (_, i) => `other-owner-${i}`)];
  const verified = new Map();
  for (const [index, owner] of owners.entries()) {
    // A stored timestamp of zero retains the old Boolean(verified_at) behavior.
    const timestamp = index === 98 ? 0 : index % 2 === 0 ? 123 : undefined;
    seedUser(env, owner, timestamp); verified.set(owner, Boolean(timestamp));
  }
  const products = seedListings(env, 100, { prefix: 'public', owners });
  seedListings(env, 3, { prefix: 'hidden', owners: [A.userId], state: i => ['inactive', 'sold', 'deleted'][i], createdAt: 99999 });
  const byId = new Map(products.map(product => [product.id, product]));
  for (const viewer of [null, A, B]) {
    const { data, queries } = await countedRequest(env, '/api/products?pageSize=100', { viewer });
    assert.equal(data.total, 100); assert.equal(data.realTotal, 100); assert.equal(data.hasMore, false);
    assert.deepEqual(data.items.map(item => item.id), products.map(product => product.id).reverse());
    for (const item of data.items) {
      const expected = byId.get(item.id);
      assertDto(item, expected, viewer, verified.get(expected.owner));
    }
    assert.equal(queries.length, 5);
    assert.equal(queries.filter(query => query.sql.includes('product_media')).length, 1);
    assert.equal(queries.filter(query => query.sql.includes('school_email_accounts')).length, 1);
    assert.equal(queries.filter(query => query.values.length === 100).length, 2);
    assert(!queries.some(query => /private_contacts|email_hash|email_masked/.test(query.sql)));
    assertPrivateDataAbsent(data, owners);
  }
});

test('unbounded history and favorites retain every item in three queries, including over 2400 historical listings', async t => {
  const env = fixture(t);
  seedUser(env, A.userId, 123); seedUser(env, B.userId);
  const history = seedListings(env, 2501, {
    prefix: 'history', owners: [A.userId], state: i => i < 100 ? 'active' : ['inactive', 'sold', 'deleted'][i % 3],
  });
  const other = seedListings(env, 204, { prefix: 'other', owners: [B.userId], state: i => i < 201 ? 'active' : ['inactive', 'sold', 'deleted'][i - 201] });
  const favorite = env.DB.sqlite.prepare('INSERT INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?)');
  for (const product of [...history, ...other]) favorite.run(A.userId, product.id, 1);
  for (const product of history) favorite.run(B.userId, product.id, 1);
  // Concurrent readers must not share ownership or cached verification state.
  const results = await Promise.all([
    countedRequest(env, '/api/me/products', { viewer: A }),
    countedRequest(env, '/api/me/products', { viewer: B }),
    countedRequest(env, '/api/me/favorites', { viewer: A }),
    countedRequest(env, '/api/me/favorites', { viewer: B }),
  ]);
  const expectations = [history, other, [...history, ...other.filter(product => product.status === 'active')], history.filter(product => product.status === 'active')];
  for (const [index, { data, queries }] of results.entries()) {
    const expected = expectations[index], byId = new Map(expected.map(product => [product.id, product]));
    const viewer = index % 2 === 0 ? A : B;
    assert.equal(queries.length, 3);
    assert(queries.every(query => query.values.length <= 2));
    assert.deepEqual(data.items.map(item => item.id), expected.map(product => product.id).sort().reverse());
    for (const item of data.items) {
      const product = byId.get(item.id);
      assertDto(item, product, viewer, product.owner === A.userId);
    }
    assertPrivateDataAbsent(data, [A.userId, B.userId]);
  }
});

test('list metadata batching preserves public and owner-only media permissions', async t => {
  const env = fixture(t);
  seedUser(env, A.userId, 123); seedUser(env, B.userId);
  const products = seedListings(env, 5, { prefix: 'permissions', owners: [A.userId], state: i => ['active', 'active', 'inactive', 'sold', 'deleted'][i] });
  for (const product of products) for (const mediaId of product.imageIds) {
    await env.BUCKET.put(`private-object/${mediaId}`, PNG);
  }
  const list = await countedRequest(env, '/api/products?pageSize=100');
  assert.deepEqual(new Set(list.data.items.map(item => item.id)), new Set(products.slice(0, 2).map(product => product.id)));
  const own = await countedRequest(env, '/api/me/products', { viewer: A });
  assert.equal(own.data.items.length, 5);
  assert.deepEqual((await countedRequest(env, '/api/me/products', { viewer: B })).data.items, []);
  for (const product of products.slice(1)) {
    const path = `/api/media/${product.imageIds[0]}`;
    const owner = await countedRequest(env, path, { viewer: A });
    assert.equal(owner.queries.length, 1);
    assert.deepEqual(Buffer.from(owner.data), PNG);
    for (const viewer of [null, B]) {
      const media = await api(env, path, { viewer });
      assert.equal(media.status, product.status === 'active' ? 200 : 404);
    }
  }
});

test('default feed, demo-only pages and empty results avoid DTO query fan-out', async t => {
  const env = fixture(t, { includeDemo: true });
  seedUser(env, A.userId, 123);
  // Even a verified system owner must never give demo cards a real seller badge.
  seedUser(env, DEMO_OWNER_ID, 123);
  seedListings(env, 100, { prefix: 'recent', owners: [A.userId], createdAt: Date.now() + 1000 });
  const initial = await countedRequest(env, '/api/products');
  assert.equal(initial.data.items.length, 24); assert.equal(initial.queries.length, 5);
  const demoPage = await countedRequest(env, '/api/products?pageSize=100&page=2');
  assert.equal(demoPage.data.items.length, 18); assert.equal(demoPage.queries.length, 3);
  for (const item of demoPage.data.items) {
    assert.equal(item.isDemo, true); assert.equal(item.mine, false); assert.equal(item.sellerEmailVerified, false);
    assert.deepEqual(item.imageIds, []); assert.deepEqual(item.images, demoImages(item.id));
  }
  const empty = await countedRequest(env, '/api/products?query=will-never-match');
  assert.deepEqual(empty.data.items, []); assert.equal(empty.queries.length, 3);
});
