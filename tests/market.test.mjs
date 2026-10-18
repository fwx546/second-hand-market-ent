import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A, B, PNG, SQLiteD1, MemoryBucket, fixture, api, productInput, publish, upload } from './support.mjs';

test('empty production database; identity never publishes account email or full name', async t => {
  const env = fixture(t);
  const catalog = await api(env, '/api/products');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.items, []);
  assert.equal(catalog.data.total, 0);
  assert.deepEqual(catalog.data.categoryCounts, { all: 0, appliance: 0, ebike: 0, daily: 0 });
  const anonymous = await api(env, '/api/me');
  assert.equal(anonymous.data.user, null);
  assert.equal(anonymous.data.development, false);
  assert.equal(anonymous.data.capabilities.canPublish, false);
  const loggedIn = await api(env, '/api/me', { viewer: { ...A, email: 'private@school.edu', displayName: 'PRIVATE_FULL_NAME' } });
  assert.deepEqual(loggedIn.data.user, { id: A.userId, displayName: '橘子同学', schoolVerified: false, emailVerified: true, emailMasked: A.emailMasked });
  assert.equal(loggedIn.data.capabilities.canPublish, true);
  assert.equal(loggedIn.data.signInUrl, '/#/login');
  assert.equal(loggedIn.data.authentication.provider, 'school_email');
  assert.equal((await api(env, '/api/me', { viewer: { userId: A.userId, provider: 'chatgpt' } })).data.user, null);
  assert.equal((await api(env, '/api/me', { viewer: { userId: A.userId, provider: 'external' } })).data.user, null);
  assert.equal(loggedIn.response.headers.get('cache-control'), 'no-store');
  assert(!JSON.stringify(loggedIn.data).includes('private@'));
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal((await api(env, '/api/me', { headers: { 'x-development': 'true' } })).data.development, false);
  assert.equal((await api(env, '/api/me', { backendOptions: { development: true } })).data.development, true);
});

test('anonymous cannot mutate, read contacts/private pages, or impersonate platform headers', async t => {
  const env = fixture(t);
  const created = await publish(env);
  assert.equal(created.status, 201);
  for (const [method, path] of [['POST', '/api/products'], ['POST', '/api/media'], ['PATCH', `/api/products/${created.data.product.id}`], ['PUT', `/api/me/favorites/${created.data.product.id}`], ['DELETE', `/api/me/favorites/${created.data.product.id}`]]) {
    const result = await api(env, path, { method, body: {}, headers: { 'oai-authenticated-user-id': A.userId, 'oai-authenticated-user-email': 'fake@test.com' } });
    assert.equal(result.status, 401, path);
    assert.equal(result.data.error.code, 'AUTH_REQUIRED');
  }
  for (const path of ['/api/me/products', '/api/me/favorites', `/api/products/${created.data.product.id}/contact`]) {
    assert.equal((await api(env, path)).status, 401, path);
  }
});

test('each write requires exact same Origin, including favorites and photo uploads', async t => {
  const env = fixture(t);
  const image = await upload(env);
  for (const origin of [null, 'https://attacker.example', 'null', 'https://juzi.example.evil', 'http://juzi.example']) {
    const result = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([image.data.mediaId]), origin });
    assert.equal(result.status, 403);
    assert.equal(result.data.error.code, 'ORIGIN_REJECTED');
  }
  const crossSite = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([image.data.mediaId]), headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 0);
});

test('public DTO excludes all private data; authenticated contact is a separate endpoint', async t => {
  const env = fixture(t), created = await publish(env), productId = created.data.product.id;
  const detail = await api(env, `/api/products/${productId}`);
  assert.equal(detail.data.product.mine, false);
  assert.equal(detail.data.product.price, 35.25);
  const row = env.DB.sqlite.prepare('SELECT price_cents FROM products WHERE id = ?').get(productId);
  assert.equal(row.price_cents, 3525);
  for (const result of [created, detail, await api(env, '/api/products'), await api(env, '/api/me/products', { viewer: A }), await api(env, '/api/me/favorites', { viewer: B })]) {
    const serialized = JSON.stringify(result.data);
    for (const forbidden of ['contactValue', 'contactType', 'ownerId', 'owner_id', 'juzi_test_contact', A.userId, B.userId, 'email']) assert(!serialized.includes(forbidden), forbidden);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
  }
  const contact = await api(env, `/api/products/${productId}/contact`, { viewer: B });
  assert.deepEqual(contact.data, { type: 'wechat', value: 'juzi_test_contact' });
  assert.equal(contact.response.headers.get('cache-control'), 'no-store');
  assert.equal((await api(env, `/api/products/${productId}`, { viewer: A })).data.product.mine, true);
});

test('ownership enforced for edits, status changes and image references', async t => {
  const env = fixture(t), created = await publish(env), product = created.data.product;
  for (const body of [{ price: 1 }, { status: 'inactive' }]) {
    assert.equal((await api(env, `/api/products/${product.id}`, { method: 'PATCH', viewer: B, body })).status, 403);
  }
  assert.equal((await api(env, '/api/products', { method: 'POST', viewer: B, body: productInput(product.imageIds) })).status, 403);
  const otherImage = await upload(env, B);
  assert.equal((await api(env, `/api/products/${product.id}`, { method: 'PATCH', viewer: A, body: { imageIds: [otherImage.data.mediaId] } })).status, 403);
  const updated = await api(env, `/api/products/${product.id}`, { method: 'PATCH', viewer: A, body: { price: 45, seller: '新的公开昵称', contactValue: 'new_contact' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.product.price, 45);
  assert.equal(updated.data.product.seller, '新的公开昵称');
  assert.equal((await api(env, `/api/products/${product.id}/contact`, { viewer: B })).data.value, 'new_contact');
  for (const forbidden of ['ownerId', 'mine', 'role', 'createdAt']) {
    assert.equal((await api(env, `/api/products/${product.id}`, { method: 'PATCH', viewer: A, body: { [forbidden]: 'forged' } })).status, 400);
  }
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 1);
});

test('unpublished media private; inactive listing/contact/media only readable by owner', async t => {
  const env = fixture(t), image = await upload(env), imagePath = image.data.url;
  assert.equal((await api(env, imagePath)).status, 404);
  assert.equal((await api(env, imagePath, { viewer: B })).status, 404);
  const ownImage = await api(env, imagePath, { viewer: A });
  assert.equal(ownImage.status, 200);
  assert.deepEqual(Buffer.from(ownImage.data), PNG);
  const created = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([image.data.mediaId]) });
  const productId = created.data.product.id;
  assert.equal((await api(env, imagePath)).status, 200);
  assert.equal((await api(env, `/api/products/${productId}`, { method: 'PATCH', viewer: A, body: { status: 'inactive' } })).status, 200);
  for (const viewer of [null, B]) {
    assert.equal((await api(env, `/api/products/${productId}`, { viewer })).status, 404);
    assert.equal((await api(env, imagePath, { viewer })).status, 404);
  }
  assert.equal((await api(env, `/api/products/${productId}/contact`, { viewer: B })).status, 404);
  assert.equal((await api(env, `/api/products/${productId}/contact`, { viewer: A })).status, 200);
  assert.equal((await api(env, imagePath, { viewer: A })).status, 200);
  assert.equal((await api(env, '/api/products')).data.total, 0);
  assert.equal((await api(env, '/api/me/products', { viewer: A })).data.items.length, 1);
  assert.equal((await api(env, '/api/me/products', { viewer: B })).data.items.length, 0);
});

test('favorites are isolated and additions/removals idempotent', async t => {
  const env = fixture(t), created = await publish(env), productId = created.data.product.id;
  for (let i = 0; i < 2; i++) assert.equal((await api(env, `/api/me/favorites/${productId}`, { method: 'PUT', viewer: B })).status, 200);
  assert.equal((await api(env, '/api/me/favorites', { viewer: B })).data.items.length, 1);
  assert.equal((await api(env, '/api/me/favorites', { viewer: A })).data.items.length, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM favorites').get().n, 1);
  for (let i = 0; i < 2; i++) assert.equal((await api(env, `/api/me/favorites/${productId}`, { method: 'DELETE', viewer: A })).status, 200);
  assert.equal((await api(env, '/api/me/favorites', { viewer: B })).data.items.length, 1);
  for (let i = 0; i < 2; i++) assert.equal((await api(env, `/api/me/favorites/${productId}`, { method: 'DELETE', viewer: B })).status, 200);
  assert.equal((await api(env, '/api/me/favorites', { viewer: B })).data.items.length, 0);
});

test('removing a photo from an active listing makes the detached image private again', async t => {
  const env = fixture(t), firstImage = await upload(env), secondImage = await upload(env);
  const created = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput([firstImage.data.mediaId, secondImage.data.mediaId]) });
  assert.equal((await api(env, secondImage.data.url)).status, 200);
  const updated = await api(env, `/api/products/${created.data.product.id}`, { method: 'PATCH', viewer: A, body: { imageIds: [firstImage.data.mediaId] } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.product.imageIds, [firstImage.data.mediaId]);
  assert.equal((await api(env, firstImage.data.url)).status, 200);
  assert.equal((await api(env, secondImage.data.url)).status, 404);
  assert.equal((await api(env, secondImage.data.url, { viewer: B })).status, 404);
  assert.equal((await api(env, secondImage.data.url, { viewer: A })).status, 200);
});

test('server-side form validation and parameterized search', async t => {
  const env = fixture(t), image = await upload(env), input = productInput([image.data.mediaId]);
  const invalid = [
    { title: '' }, { title: 'x'.repeat(101) }, { description: '短' }, { campus: '其他学校' }, { category: 'all' },
    { condition: '随便' }, { price: 0 }, { price: 0.001 }, { price: '1' }, { price: 100000.01 }, { originalPrice: -1 },
    { graduation: 'true' }, { specs: {} }, { specs: { 型号: '型号' } }, { seller: '' }, { seller: 'x'.repeat(31) },
    { contactType: 'email' }, { contactValue: '' }, { imageIds: [] }, { imageIds: [image.data.mediaId, image.data.mediaId] },
    { imageIds: Array(7).fill(image.data.mediaId) }, { ownerId: B.userId }, { mine: true }, { role: 'admin' }, { createdAt: 1 },
  ];
  for (const extra of invalid) {
    const result = await api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, ...extra } });
    assert.equal(result.status, 400, JSON.stringify(extra));
  }
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 0);
  const created = await api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, title: "风扇 ' 测试" } });
  assert.equal(created.status, 201);
  assert.equal((await api(env, `/api/products?query=${encodeURIComponent("' OR 1=1 --")}`)).data.total, 0);
  assert.equal((await api(env, '/api/products?query=风扇')).data.total, 1);
  assert.equal((await api(env, '/api/products?page=0')).status, 400);
  assert.equal((await api(env, '/api/products?pageSize=999')).status, 400);
  assert.equal((await api(env, '/api/products?sort=unknown')).status, 400);
  assert.equal((await api(env, '/api/products?cheap=true')).status, 400);
  assert.equal((await api(env, `/api/products/${created.data.product.id}`, { method: 'PATCH', viewer: A, body: { status: 'sold' } })).status, 400);
  assert.equal((await api(env, '/api/products', { method: 'POST', viewer: A, body: '{broken' })).status, 400);
  assert.equal((await api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, description: 'x'.repeat(70000) } })).status, 413);
});

test('filters, totals, category counts, stable pagination and sorting reflect database', async t => {
  const env = fixture(t);
  await publish(env, A, { title: '低价毕业风扇', price: 10, graduation: true });
  await publish(env, B, { title: '生活用品收纳盒', price: 120, category: 'daily', campus: '太仓校区', specs: { 尺寸: '小号', 数量: '一个', 使用情况: '九成新' } });
  await publish(env, A, { title: '第二件小电器', price: 30, condition: '几乎全新' });
  const page = await api(env, '/api/products?sort=price-asc&pageSize=1&page=2');
  assert.equal(page.data.items[0].price, 30);
  assert.equal(page.data.total, 3);
  assert.equal(page.data.page, 2);
  assert.equal(page.data.pageSize, 1);
  assert.equal(page.data.hasMore, true);
  assert.deepEqual(page.data.categoryCounts, { all: 3, appliance: 2, ebike: 0, daily: 1 });
  assert.equal((await api(env, '/api/products?category=appliance&cheap=1&graduation=1&campus=SIP%20校区')).data.items[0].title, '低价毕业风扇');
  assert.equal((await api(env, '/api/products?fresh=1')).data.total, 1);
  assert.equal((await api(env, '/api/products?category=daily&sort=price-desc')).data.items[0].price, 120);
  assert.equal((await api(env, '/api/products?page=100')).data.items.length, 0);
});

test('actual image signature, declared type, size and image count enforced server-side', async t => {
  const env = fixture(t);
  assert.equal((await upload(env, A, { bytes: Buffer.from('<script>bad</script>') })).status, 400);
  assert.equal((await upload(env, A, { type: 'image/jpeg' })).status, 400);
  const tooLarge = new Uint8Array(8 * 1024 * 1024 + 1); tooLarge.set(PNG);
  assert.equal((await upload(env, A, { bytes: tooLarge })).status, 413);
  const empty = new FormData(); empty.append('file', new Blob([], { type: 'image/png' }), 'empty.png');
  assert.equal((await api(env, '/api/media', { method: 'POST', viewer: A, body: empty })).status, 413);
  const twice = new FormData();
  twice.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png'); twice.append('file', new Blob([PNG], { type: 'image/png' }), 'b.png');
  assert.equal((await api(env, '/api/media', { method: 'POST', viewer: A, body: twice })).status, 400);
  assert.equal(env.BUCKET.objects.size, 0);
  const uploaded = await upload(env, A, { name: '../../untrusted.png' });
  assert.equal(uploaded.status, 201);
  const key = [...env.BUCKET.objects.keys()][0];
  assert.match(key, /^market\/[0-9a-f-]{36}$/);
  assert(!key.includes('untrusted'));
});

test('data survives separate database connection and handler lifecycle', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'juzi-market-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'market.sqlite'), bucket = new MemoryBucket();
  const initial = { DB: new SQLiteD1(filename), BUCKET: bucket };
  const created = await publish(initial), productId = created.data.product.id;
  await api(initial, `/api/me/favorites/${productId}`, { method: 'PUT', viewer: B });
  initial.DB.close();
  const reopened = { DB: new SQLiteD1(filename, false), BUCKET: bucket };
  try {
    assert.equal((await api(reopened, '/api/products')).data.total, 1);
    assert.equal((await api(reopened, '/api/me/favorites', { viewer: B })).data.items[0].id, productId);
    assert.equal((await api(reopened, `/api/products/${productId}/contact`, { viewer: B })).data.value, 'juzi_test_contact');
    assert.equal((await api(reopened, created.data.product.images[0])).status, 200);
  } finally { reopened.DB.close(); }
});

test('rolling upload quota is per user and enforced even during parallel R2 uploads', async t => {
  const env = fixture(t);
  const results = await Promise.all(Array.from({ length: 65 }, () => upload(env)));
  assert.equal(results.filter(result => result.status === 201).length, 60);
  assert.equal(results.filter(result => result.status === 429).length, 5);
  assert(results.filter(result => result.status === 429).every(result => result.data.error.code === 'UPLOAD_LIMIT'));
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM media WHERE owner_id = ?').get(A.userId).n, 60);
  assert.equal(env.BUCKET.objects.size, 60, 'R2 objects rejected at the atomic quota guard are cleaned up');
  assert.equal((await upload(env, B)).status, 201);
  env.DB.sqlite.prepare('UPDATE media SET created_at = ? WHERE owner_id = ?').run(Date.now() - 25 * 3600000, A.userId);
  assert.equal((await upload(env)).status, 201);
});

test('rolling new-publish quota is atomic, per account, and cannot be reset by taking listings down', async t => {
  const env = fixture(t), image = await upload(env), input = productInput([image.data.mediaId]);
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => api(env, '/api/products', { method: 'POST', viewer: A, body: { ...input, title: `好物 ${index}` } })));
  assert.equal(results.filter(result => result.status === 201).length, 20);
  assert.equal(results.filter(result => result.status === 429).length, 5);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 20);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM private_contacts').get().n, 20);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM product_media').get().n, 20);
  env.DB.sqlite.prepare("UPDATE products SET status = 'inactive' WHERE owner_id = ?").run(A.userId);
  const blocked = await api(env, '/api/products', { method: 'POST', viewer: A, body: input });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error.code, 'PUBLISH_LIMIT');
  assert.equal((await publish(env, B)).status, 201);
  env.DB.sqlite.prepare('UPDATE products SET created_at = ? WHERE owner_id = ?').run(Date.now() - 25 * 3600000, A.userId);
  assert.equal((await api(env, '/api/products', { method: 'POST', viewer: A, body: input })).status, 201);
});

test('100 active cap applies to creation and concurrent reactivation, preserving a rejected edit', async t => {
  const env = fixture(t), created = await publish(env), original = created.data.product;
  const initial = env.DB.sqlite.prepare('SELECT * FROM products WHERE id = ?').get(original.id);
  const contact = env.DB.sqlite.prepare('SELECT * FROM private_contacts WHERE product_id = ?').get(original.id);
  const columns = Object.keys(initial), oldTime = Date.now() - 48 * 3600000;
  const insert = env.DB.sqlite.prepare(`INSERT INTO products (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  function historical(productId, status) {
    insert.run(...columns.map(column => column === 'id' ? productId : column === 'status' ? status : ['created_at', 'updated_at'].includes(column) ? oldTime : initial[column]));
    env.DB.sqlite.prepare('INSERT INTO private_contacts (product_id, type, value) VALUES (?, ?, ?)').run(productId, contact.type, contact.value);
    env.DB.sqlite.prepare('INSERT INTO product_media (product_id, media_id, position) VALUES (?, ?, 0)').run(productId, original.imageIds[0]);
  }
  for (let index = 0; index < 99; index++) historical(`historical-${index}`, 'active');
  historical('inactive-one', 'inactive'); historical('inactive-two', 'inactive');
  const full = await api(env, '/api/products', { method: 'POST', viewer: A, body: productInput(original.imageIds) });
  assert.equal(full.status, 429); assert.equal(full.data.error.code, 'ACTIVE_LIMIT');
  assert.equal((await api(env, '/api/products/inactive-one', { method: 'PATCH', viewer: A, body: { status: 'active' } })).status, 429);
  assert.equal((await api(env, `/api/products/${original.id}`, { method: 'PATCH', viewer: A, body: { price: 40 } })).status, 200, 'existing active item can still be edited');
  await api(env, `/api/products/${original.id}`, { method: 'PATCH', viewer: A, body: { status: 'inactive' } });
  const results = await Promise.all(['inactive-one', 'inactive-two'].map(productId => api(env, `/api/products/${productId}`, { method: 'PATCH', viewer: A, body: { status: 'active', price: 99, contactValue: 'updated_only_if_active' } })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 429).length, 1);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM products WHERE status = 'active'").get().n, 100);
  const rejectedId = ['inactive-one', 'inactive-two'][results.findIndex(result => result.status === 429)];
  const unchanged = env.DB.sqlite.prepare('SELECT * FROM products WHERE id = ?').get(rejectedId);
  assert.equal(unchanged.status, 'inactive'); assert.equal(unchanged.price_cents, initial.price_cents);
  assert.equal(env.DB.sqlite.prepare('SELECT value FROM private_contacts WHERE product_id = ?').get(rejectedId).value, contact.value);
  assert.equal((await api(env, `/api/products/${rejectedId}`, { method: 'PATCH', viewer: A, body: { description: '下架期间仍然可以修改描述。' } })).status, 200);
});
