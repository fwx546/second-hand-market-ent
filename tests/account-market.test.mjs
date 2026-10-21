import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { A, B, api, fixture, publish, productInput, upload } from './support.mjs';

test('profile is private, validated, persisted and isolated from listing nicknames', async t => {
  const env = fixture(t);
  assert.equal((await api(env, '/api/me', { method: 'PATCH', body: { displayName: '访客' } })).status, 401);
  assert.equal((await api(env, '/api/me', { method: 'PATCH', viewer: A, origin: null, body: { displayName: '小橘' } })).status, 403);
  const saved = await api(env, '/api/me', { method: 'PATCH', viewer: A, body: { displayName: '  图书馆小橘  ', campus: '太仓校区' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.user, { id: A.userId, displayName: '图书馆小橘', campus: '太仓校区', publishSeller: '', publishContactType: '', publishContactValue: '', language: 'zh', phone: '', wechat: '', qq: '', emailMasked: A.emailMasked, schoolVerified: false, emailVerified: true });
  assert.equal(saved.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await api(env, '/api/me', { viewer: A })).data.user, saved.data.user);
  assert.equal((await api(env, '/api/me', { viewer: B })).data.user.displayName, '橘子同学');
  assert.equal((await api(env, '/api/me', { viewer: B })).data.user.campus, '');
  const created = await publish(env, A, { seller: '商品公开昵称' });
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.displayName, '图书馆小橘');
  const path = `/api/products/${created.data.product.id}`;
  await api(env, path, { method: 'PATCH', viewer: A, body: { seller: '新的商品昵称' } });
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.displayName, '图书馆小橘');
  await api(env, '/api/me', { method: 'PATCH', viewer: A, body: { displayName: '账户新昵称', campus: '' } });
  assert.equal((await api(env, path)).data.product.seller, '新的商品昵称');
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.campus, '');
  const publicText = JSON.stringify((await api(env, '/api/products')).data);
  assert(!publicText.includes('账户新昵称'));
  assert(!publicText.includes(A.emailMasked));
});

test('successful publishing saves private defaults for the owner and future listings', async t => {
  const env = fixture(t);
  const first = await publish(env, A, { seller: '第一位卖家', contactType: 'qq', contactValue: '123456789' });
  assert.equal(first.status, 201);
  const owner = (await api(env, '/api/me', { viewer: A })).data.user;
  assert.equal(owner.publishSeller, '第一位卖家');
  assert.equal(owner.publishContactType, 'qq');
  assert.equal(owner.publishContactValue, '123456789');
  assert.equal((await api(env, '/api/me', { viewer: B })).data.user.publishContactValue, '');
  assert.equal((await api(env, '/api/me')).data.user, null);
  assert(!JSON.stringify((await api(env, '/api/products')).data).includes('123456789'));

  await api(env, `/api/products/${first.data.product.id}`, { method: 'PATCH', viewer: A, body: { seller: '只修改旧商品', contactValue: 'old_only' } });
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.publishContactValue, '123456789');
  const second = await publish(env, A, { seller: '最新卖家', contactType: 'wechat', contactValue: 'new_wechat' });
  assert.equal(second.status, 201);
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.publishContactValue, 'new_wechat');
  assert.equal((await api(env, `/api/products/${first.data.product.id}/contact`, { viewer: A })).data.value, 'old_only');
});

test('existing listings supply defaults until the next successful publication', async t => {
  const env = fixture(t);
  const first = await publish(env, A, { seller: '旧卖家', contactType: 'phone', contactValue: '13800138000' });
  env.DB.sqlite.prepare("UPDATE users SET publish_seller = '', publish_contact_type = '', publish_contact_value = '' WHERE id = ?").run(A.userId);
  const defaults = (await api(env, '/api/me', { viewer: A })).data.user;
  assert.equal(defaults.publishSeller, '旧卖家');
  assert.equal(defaults.publishContactType, 'phone');
  assert.equal(defaults.publishContactValue, '13800138000');
  assert.equal(first.status, 201);
});

test('profile rejects mass assignment, invalid campus, mailbox nicknames and empty changes', async t => {
  const env = fixture(t);
  for (const body of [{}, { displayName: '' }, { displayName: 'x'.repeat(21) }, { displayName: 'name@example.invalid' }, { displayName: '两\n行' }, { displayName: null }, { campus: '主校区' }, { campus: null }, { userId: B.userId }, { emailVerified: true }, { role: 'admin' }]) {
    assert.equal((await api(env, '/api/me', { method: 'PATCH', viewer: A, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await api(env, '/api/me', { method: 'PATCH', viewer: A, body: { displayName: '小橘' } })).status, 200);
  assert.equal((await api(env, '/api/me', { method: 'PATCH', viewer: A, body: { campus: 'SIP 校区' } })).status, 200);
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.displayName, '小橘');
});

test('account settings persist privately and reject invalid contact details', async t => {
  const env = fixture(t);
  const body = { language: 'en', phone: '13800138000', wechat: 'Orange_123', qq: '12345678' };
  const saved = await api(env, '/api/me', { method: 'PATCH', viewer: A, body });
  assert.equal(saved.status, 200);
  for (const [key, value] of Object.entries(body)) assert.equal(saved.data.user[key], value);
  assert.equal((await api(env, '/api/me', { viewer: A })).data.user.language, 'en');
  assert.equal((await api(env, '/api/me', { viewer: B })).data.user.phone, '');
  assert(!JSON.stringify((await api(env, '/api/products')).data).includes(body.phone));
  for (const invalid of [{ language: 'fr' }, { phone: '123' }, { phone: null }, { wechat: 'bad' }, { qq: '00000' }]) {
    assert.equal((await api(env, '/api/me', { method: 'PATCH', viewer: A, body: invalid })).status, 400);
  }
  const cleared = await api(env, '/api/me', { method: 'PATCH', viewer: A, body: { phone: '', wechat: '', qq: '' } });
  assert.equal(cleared.data.user.phone, '');
});

test('buyers and sellers can exchange private messages only inside their product conversation', async t => {
  const env = fixture(t), listing = await publish(env, A), productId = listing.data.product.id;
  const started = await api(env, '/api/conversations', { method: 'POST', viewer: B, body: { productId } });
  assert.equal(started.status, 200);
  const conversationId = started.data.conversationId;
  assert.equal((await api(env, '/api/conversations', { method: 'POST', viewer: B, body: { productId } })).data.conversationId, conversationId);
  assert.equal((await api(env, '/api/me/conversations', { viewer: A })).data.items[0].role, 'seller');
  assert.equal((await api(env, '/api/me/conversations', { viewer: B })).data.items[0].role, 'buyer');
  assert.equal((await api(env, `/api/conversations/${conversationId}/messages`, { method: 'POST', viewer: B, body: { body: '你好，还在出售吗？' } })).status, 201);
  const received = await api(env, `/api/conversations/${conversationId}/messages`, { viewer: A });
  assert.equal(received.data.items[0].body, '你好，还在出售吗？');
  assert.equal(received.data.items[0].mine, false);
  assert.equal((await api(env, `/api/conversations/${conversationId}/messages`, { viewer: B })).data.items[0].mine, true);
  assert.equal((await api(env, `/api/conversations/${conversationId}/messages`, { viewer: { ...B, userId: 'intruder' } })).status, 404);
  assert.equal((await api(env, '/api/conversations', { method: 'POST', viewer: A, body: { productId } })).status, 400);
  assert.equal((await api(env, `/api/conversations/${conversationId}/messages`, { method: 'POST', viewer: B, body: { body: '' } })).status, 400);
});

test('product cards are generated for the conversation product and survive message reloads', async t => {
  const env=fixture(t),listing=await publish(env,A),productId=listing.data.product.id;
  const started=await api(env,'/api/conversations',{method:'POST',viewer:B,body:{productId}});
  const conversationId=started.data.conversationId,path=`/api/conversations/${conversationId}/messages`;
  const sent=await api(env,path,{method:'POST',viewer:B,body:{type:'product_card'}});
  assert.equal(sent.status,201);
  assert.equal(sent.data.message.kind,'product_card');
  assert.equal(sent.data.message.card.productId,productId);
  assert.equal(sent.data.message.card.title,listing.data.product.title);
  assert.equal(sent.data.message.card.price,listing.data.product.price);
  assert.match(sent.data.message.card.imageUrl,/^\/api\/media\//);
  const received=await api(env,path,{viewer:A});
  assert.equal(received.data.items[0].kind,'product_card');
  assert.equal(received.data.items[0].card.productId,productId);
  assert.equal(received.data.items[0].mine,false);
  assert.equal((await api(env,'/api/me/conversations',{viewer:A})).data.items[0].lastMessage,'发送了商品卡片');
  assert.equal((await api(env,path,{method:'POST',viewer:B,body:{body:'\u2063juzi:product-card:v1'}})).status,400);
  assert.equal((await api(env,path,{method:'POST',viewer:{...B,userId:'intruder'},body:{type:'product_card'}})).status,404);
});

test('sold listings leave public feed, contacts, favorites and media while owner retains history', async t => {
  const env = fixture(t), created = await publish(env), item = created.data.product, path = `/api/products/${item.id}`;
  await api(env, `/api/me/favorites/${item.id}`, { method: 'PUT', viewer: B });
  assert.equal((await api(env, path, { method: 'PATCH', viewer: B, body: { status: 'sold' } })).status, 403);
  const sold = await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'sold' } });
  assert.equal(sold.status, 200); assert.equal(sold.data.product.status, 'sold');
  const row = env.DB.sqlite.prepare('SELECT status, sold_at, deleted_at FROM products WHERE id = ?').get(item.id);
  assert.equal(row.status, 'inactive'); assert.equal(typeof row.sold_at, 'number'); assert.equal(row.deleted_at, null);
  for (const viewer of [null, B]) {
    assert.equal((await api(env, path, { viewer })).status, 404);
    assert.equal((await api(env, item.images[0], { viewer })).status, 404);
  }
  assert.equal((await api(env, `${path}/contact`, { viewer: B })).status, 404);
  assert.equal((await api(env, `${path}/contact`, { viewer: A })).status, 200);
  assert.equal((await api(env, '/api/me/products', { viewer: A })).data.items[0].status, 'sold');
  assert.equal((await api(env, '/api/me/favorites', { viewer: B })).data.items.length, 0);
  assert.equal((await api(env, '/api/products')).data.total, 0);
  const edited = await api(env, path, { method: 'PATCH', viewer: A, body: { description: '售出后保留的商品描述。' } });
  assert.equal(edited.data.product.status, 'sold');
  assert.equal(env.DB.sqlite.prepare('SELECT sold_at FROM products WHERE id = ?').get(item.id).sold_at, row.sold_at);
  const active = await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'active' } });
  assert.equal(active.data.product.status, 'active');
  assert.equal(env.DB.sqlite.prepare('SELECT sold_at FROM products WHERE id = ?').get(item.id).sold_at, null);
  assert.equal((await api(env, '/api/me/favorites', { viewer: B })).data.items.length, 1);
});

test('recycle-bin deletion is owner-only, idempotent and restored explicitly as inactive', async t => {
  const env = fixture(t), created = await publish(env), item = created.data.product, path = `/api/products/${item.id}`;
  assert.equal((await api(env, path, { method: 'DELETE' })).status, 401);
  assert.equal((await api(env, path, { method: 'DELETE', viewer: B })).status, 403);
  assert.equal((await api(env, path, { method: 'DELETE', viewer: A, origin: null })).status, 403);
  assert.equal((await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'deleted' } })).status, 400);
  const deleted = await api(env, path, { method: 'DELETE', viewer: A });
  assert.equal(deleted.status, 200); assert.equal(deleted.data.product.status, 'deleted');
  const deletedAt = env.DB.sqlite.prepare('SELECT deleted_at FROM products WHERE id = ?').get(item.id).deleted_at;
  assert.equal((await api(env, path, { method: 'DELETE', viewer: A })).data.product.status, 'deleted');
  assert.equal(env.DB.sqlite.prepare('SELECT deleted_at FROM products WHERE id = ?').get(item.id).deleted_at, deletedAt);
  for (const viewer of [null, B]) {
    assert.equal((await api(env, path, { viewer })).status, 404);
    assert.equal((await api(env, item.images[0], { viewer })).status, 404);
  }
  assert.equal((await api(env, `${path}/contact`, { viewer: B })).status, 404);
  assert.equal((await api(env, item.images[0], { viewer: A })).status, 200);
  for (const body of [{ status: 'active' }, { status: 'sold' }, { price: 1 }, { status: 'inactive', price: 1 }]) assert.equal((await api(env, path, { method: 'PATCH', viewer: A, body })).status, 409);
  assert.equal((await api(env, '/api/me/products', { viewer: A })).data.items[0].status, 'deleted');
  const restored = await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'inactive' } });
  assert.equal(restored.data.product.status, 'inactive');
  const row = env.DB.sqlite.prepare('SELECT sold_at, deleted_at FROM products WHERE id = ?').get(item.id);
  assert.equal(row.sold_at, null); assert.equal(row.deleted_at, null);
  assert.equal((await api(env, path)).status, 404);
  assert.equal((await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'active' } })).data.product.status, 'active');
  assert.equal((await api(env, item.images[0])).status, 200);
});

test('sold and deleted listings retain daily publication history and cannot evade quotas', async t => {
  const env = fixture(t), image = await upload(env), input = productInput([image.data.mediaId]);
  for (let index = 0; index < 20; index++) {
    const created = await api(env, '/api/products', { method: 'POST', viewer: A, body: input });
    const path = `/api/products/${created.data.product.id}`;
    if (index % 2) await api(env, path, { method: 'DELETE', viewer: A });
    else await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'sold' } });
  }
  assert.equal((await api(env, '/api/products')).data.total, 0);
  assert.equal((await api(env, '/api/me/products', { viewer: A })).data.items.length, 20);
  const blocked = await api(env, '/api/products', { method: 'POST', viewer: A, body: input });
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'PUBLISH_LIMIT');
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 20);
});

test('concurrent sold reactivation obeys 100-active cap and preserves rejected edits', async t => {
  const env = fixture(t), created = await publish(env), replacement = await upload(env), original = env.DB.sqlite.prepare('SELECT * FROM products').get();
  const columns = Object.keys(original), oldTime = Date.now() - 48 * 3600000;
  const insert = env.DB.sqlite.prepare(`INSERT INTO products (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let index = 0; index < 100; index++) insert.run(...columns.map(column => column === 'id' ? `historical-${index}` : column === 'status' ? index > 97 ? 'inactive' : 'active' : column === 'sold_at' ? index > 97 ? oldTime : null : ['created_at', 'updated_at'].includes(column) ? oldTime : original[column]));
  for (const productId of ['historical-98', 'historical-99']) {
    env.DB.sqlite.prepare('INSERT INTO private_contacts (product_id,type,value) VALUES (?,?,?)').run(productId, 'wechat', 'old_contact');
    env.DB.sqlite.prepare('INSERT INTO product_media (product_id,media_id,position) VALUES (?,?,0)').run(productId, created.data.product.imageIds[0]);
  }
  const results = await Promise.all(['historical-98', 'historical-99'].map(productId => api(env, `/api/products/${productId}`, { method: 'PATCH', viewer: A, body: { status: 'active', price: 99, contactValue: 'new_contact', imageIds: [replacement.data.mediaId] } })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 429).length, 1);
  const rejected = ['historical-98', 'historical-99'][results.findIndex(result => result.status === 429)];
  const unchanged = env.DB.sqlite.prepare('SELECT price_cents,sold_at,status FROM products WHERE id = ?').get(rejected);
  assert.equal(unchanged.price_cents, original.price_cents); assert.equal(unchanged.status, 'inactive'); assert.equal(unchanged.sold_at, oldTime);
  assert.equal(env.DB.sqlite.prepare('SELECT value FROM private_contacts WHERE product_id = ?').get(rejected).value, 'old_contact');
  assert.deepEqual((await api(env, `/api/products/${rejected}`, { viewer: A })).data.product.imageIds, created.data.product.imageIds);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM products WHERE status = 'active'").get().n, 100);
});

test('a deletion racing a content edit cannot be undone or alter contacts and photo references', async t => {
  for (const status of [undefined, 'active', 'inactive', 'sold']) {
    const env = fixture(t), created = await publish(env), item = created.data.product, secondPhoto = await upload(env);
    const originalBatch = env.DB.batch.bind(env.DB);
    let intervened = false;
    env.DB.batch = async statements => {
      if (!intervened && statements[0]?.sql.startsWith('UPDATE products SET title')) {
        intervened = true;
        env.DB.sqlite.prepare("UPDATE products SET status = 'inactive', deleted_at = ? WHERE id = ?").run(Date.now(), item.id);
      }
      return originalBatch(statements);
    };
    const body = { price: 1, contactValue: 'must_not_be_saved', imageIds: [secondPhoto.data.mediaId], ...(status ? { status } : {}) };
    const edited = await api(env, `/api/products/${item.id}`, { method: 'PATCH', viewer: A, body });
    assert.equal(edited.status, 409, String(status)); assert.equal(edited.data.error.code, 'PRODUCT_STATE_CHANGED');
    const persisted = (await api(env, `/api/products/${item.id}`, { viewer: A })).data.product;
    assert.equal(persisted.status, 'deleted'); assert.equal(persisted.price, item.price); assert.deepEqual(persisted.imageIds, item.imageIds);
    assert.equal((await api(env, `/api/products/${item.id}/contact`, { viewer: A })).data.value, 'juzi_test_contact');
  }
});

test('a deletion racing a status-only action requires an explicit later restore', async t => {
  for (const status of ['active', 'inactive', 'sold']) {
    const env = fixture(t), created = await publish(env), item = created.data.product;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let intervened = false;
    env.DB.prepare = sql => {
      const prepared = originalPrepare(sql), originalBind = prepared.bind.bind(prepared);
      prepared.bind = (...values) => {
        const bound = originalBind(...values), originalRun = bound.run.bind(bound);
        if (sql.startsWith('UPDATE products SET status')) bound.run = async () => {
          if (!intervened) {
            intervened = true;
            env.DB.sqlite.prepare("UPDATE products SET status = 'inactive', deleted_at = ? WHERE id = ?").run(Date.now(), item.id);
          }
          return originalRun();
        };
        return bound;
      };
      return prepared;
    };
    const path = `/api/products/${item.id}`;
    const result = await api(env, path, { method: 'PATCH', viewer: A, body: { status } });
    assert.equal(result.status, 409, status); assert.equal(result.data.error.code, 'PRODUCT_STATE_CHANGED');
    assert.equal((await api(env, path, { viewer: A })).data.product.status, 'deleted');
    assert.equal((await api(env, path, { method: 'PATCH', viewer: A, body: { status: 'inactive' } })).data.product.status, 'inactive');
  }
});

test('additive migration preserves legacy accounts, listings, contacts, favorites and images', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const folder = new URL('../drizzle/', import.meta.url), migrations = readdirSync(folder).filter(name => name.endsWith('.sql')).sort();
    for (const file of migrations.slice(0, 3)) db.exec(readFileSync(new URL(file, folder), 'utf8'));
    db.prepare('INSERT INTO users (id,display_name,created_at) VALUES (?,?,?)').run('legacy-user', '旧昵称', 1);
    db.prepare('INSERT INTO products (id,owner_id,title,category,price_cents,original_price_cents,condition,campus,location,description,specs_json,graduation,seller,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-product', 'legacy-user', '旧商品', 'appliance', 1000, 2000, '九成新', 'SIP 校区', '公共入口', '原有商品描述', '{}', 0, '旧卖家', 'active', 1, 1);
    db.prepare('INSERT INTO private_contacts VALUES (?,?,?)').run('legacy-product', 'wechat', 'legacy_contact');
    db.prepare('INSERT INTO media VALUES (?,?,?,?,?,?)').run('legacy-media', 'legacy-user', 'legacy/key', 'image/png', 80, 1);
    db.prepare('INSERT INTO product_media VALUES (?,?,?)').run('legacy-product', 'legacy-media', 0);
    db.prepare('INSERT INTO favorites VALUES (?,?,?)').run('legacy-user', 'legacy-product', 1);
    for (const file of migrations.slice(3)) db.exec(readFileSync(new URL(file, folder), 'utf8'));
    const user = db.prepare('SELECT * FROM users').get(), product = db.prepare('SELECT * FROM products').get();
    assert.equal(user.display_name, '旧昵称'); assert.equal(user.campus, '');
    assert.equal(product.title, '旧商品'); assert.equal(product.condition, '轻微使用痕迹'); assert.equal(product.status, 'active'); assert.equal(product.sold_at, null); assert.equal(product.deleted_at, null);
    for (const table of ['private_contacts', 'favorites', 'media', 'product_media']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
