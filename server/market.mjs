const CATEGORIES = ['appliance', 'ebike', 'daily'];
const CAMPUSES = ['SIP 校区', '太仓校区'];
const CONDITIONS = ['几乎全新', '九成新', '八成新'];
const CONTACT_TYPES = ['wechat', 'phone', 'qq'];
const FIELDS = ['title', 'category', 'price', 'originalPrice', 'condition', 'campus', 'location', 'description', 'specs', 'graduation', 'seller', 'contactType', 'contactValue', 'imageIds'];
const MAX_IMAGE = 8 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

class MarketError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new MarketError(status, code, message); }
function json(value, status = 200, headers = {}) { return Response.json(value, { status, headers: { ...PRIVATE_HEADERS, ...headers } }); }
function statement(db, sql, values = []) { return db.prepare(sql).bind(...values); }
async function first(db, sql, values = []) { return statement(db, sql, values).first(); }
async function all(db, sql, values = []) { return (await statement(db, sql, values).all()).results || []; }
function requireDb(env) {
  if (!env?.DB) fail(503, 'SERVICE_UNAVAILABLE', '数据库暂不可用，请稍后重试。');
  return env.DB;
}
function requireBucket(env) {
  if (!env?.BUCKET) fail(503, 'SERVICE_UNAVAILABLE', '图片存储暂不可用，请稍后重试。');
  return env.BUCKET;
}
function requireViewer(viewer) {
  if (!viewer?.userId) fail(401, 'AUTH_REQUIRED', '请先登录。');
  return viewer.userId;
}
function requireOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    fail(403, 'ORIGIN_REJECTED', '请从本站发起操作。');
  }
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(400, 'INVALID_ID', '记录编号无效。');
  return value;
}
function text(value, name, min, max, multiline = false) {
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT', `${name}格式不正确。`);
  const result = value.trim();
  if (result.length < min || result.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(result) || (!multiline && /[\r\n\t]/.test(result))) {
    fail(400, 'INVALID_INPUT', `${name}应为 ${min}–${max} 个字符。`);
  }
  return result;
}
function choice(value, choices, name) {
  if (!choices.includes(value)) fail(400, 'INVALID_INPUT', `${name}选项无效。`);
  return value;
}
function cents(value, name, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > 100000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    fail(400, 'INVALID_INPUT', `${name}应为 ${minimum}–100000 元，最多两位小数。`);
  }
  return Math.round(value * 100);
}
async function readBytes(request, maximum) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > maximum) fail(413, 'BODY_TOO_LARGE', '上传内容过大。');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '上传内容过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function payload(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'UNSUPPORTED_TYPE', '请提交 JSON 数据。');
  let body;
  try { body = JSON.parse(new TextDecoder().decode(await readBytes(request, 65536))); }
  catch (error) { if (error instanceof MarketError) throw error; fail(400, 'INVALID_JSON', 'JSON 数据无法读取。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_INPUT', '请提交有效商品信息。');
  return body;
}
function checkFields(body, patch = false) {
  const allowed = patch ? [...FIELDS, 'status'] : FIELDS;
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) {
    fail(400, 'INVALID_INPUT', '商品包含不可修改的字段或没有修改内容。');
  }
}
function validateProduct(input) {
  const value = {
    title: text(input.title, '商品标题', 1, 100),
    category: choice(input.category, CATEGORIES, '分类'),
    priceCents: cents(input.price, '转让价格', 0.01),
    originalPriceCents: cents(input.originalPrice, '购入价格', 0),
    condition: choice(input.condition, CONDITIONS, '成色'),
    campus: choice(input.campus, CAMPUSES, '校区'),
    location: text(input.location, '面交地点', 1, 100),
    description: text(input.description, '商品描述', 5, 2000, true),
    seller: text(input.seller, '卖家昵称', 1, 30),
    contactType: choice(input.contactType, CONTACT_TYPES, '联系方式类型'),
    contactValue: text(input.contactValue, '联系方式', 3, 80),
  };
  if (typeof input.graduation !== 'boolean') fail(400, 'INVALID_INPUT', '毕业转让应为布尔值。');
  value.graduation = input.graduation;
  if (!input.specs || typeof input.specs !== 'object' || Array.isArray(input.specs)) fail(400, 'INVALID_INPUT', '请填写商品参数。');
  const entries = Object.entries(input.specs);
  if (!entries.length || entries.length > 10) fail(400, 'INVALID_INPUT', '商品参数应为 1–10 项。');
  value.specs = Object.fromEntries(entries.map(([key, item]) => [text(key, '参数名', 1, 40), text(item, '参数内容', 1, 200)]));
  const required = value.category === 'ebike' ? ['购入时间', '电池情况', '卖家自述续航'] : value.category === 'daily' ? ['尺寸', '数量', '使用情况'] : ['型号', '使用情况'];
  if (required.some(key => !Object.hasOwn(value.specs, key))) fail(400, 'INVALID_INPUT', '请填写该分类的完整商品参数。');
  if (!Array.isArray(input.imageIds) || input.imageIds.length < 1 || input.imageIds.length > 6 || new Set(input.imageIds).size !== input.imageIds.length) {
    fail(400, 'INVALID_INPUT', '请选择 1–6 张不同的商品照片。');
  }
  value.imageIds = input.imageIds.map(id);
  return value;
}
async function ensureUser(db, userId) {
  await statement(db, 'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING', [userId, '橘子同学', Date.now()]).run();
}
async function productRow(db, productId) { return first(db, 'SELECT * FROM products WHERE id = ?', [productId]); }
function visible(row, viewer) { return row && (row.status === 'active' || row.owner_id === viewer?.userId); }
function owned(row, viewer) {
  if (!row) fail(404, 'NOT_FOUND', '商品不存在。');
  if (row.owner_id !== viewer?.userId) fail(403, 'FORBIDDEN', '只能管理自己发布的商品。');
}
async function mediaIds(db, productId) {
  return (await all(db, 'SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position', [productId])).map(row => row.media_id);
}
async function dto(db, row, viewer) {
  const imageIds = await mediaIds(db, row.id);
  return {
    id: row.id, title: row.title, category: row.category, price: row.price_cents / 100, originalPrice: row.original_price_cents / 100,
    condition: row.condition, campus: row.campus, location: row.location, description: row.description,
    specs: JSON.parse(row.specs_json), graduation: Boolean(row.graduation), seller: row.seller, avatar: '🍊',
    createdAt: row.created_at, status: row.status, mine: row.owner_id === viewer?.userId,
    images: imageIds.map(mediaId => `/api/media/${encodeURIComponent(mediaId)}`), imageIds,
  };
}
async function dtos(db, rows, viewer) { return Promise.all(rows.map(row => dto(db, row, viewer))); }
function positiveInteger(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) fail(400, 'INVALID_INPUT', '分页参数无效。');
  return Number(value);
}
async function listProducts(db, search, viewer) {
  const page = positiveInteger(search.get('page'), 1, 1000000), pageSize = positiveInteger(search.get('pageSize'), 24, 100);
  const category = search.get('category') || 'all', campus = search.get('campus') || '', condition = search.get('condition') || '';
  choice(category, ['all', ...CATEGORIES], '分类');
  if (campus) choice(campus, CAMPUSES, '校区');
  if (condition) choice(condition, CONDITIONS, '成色');
  const query = text(search.get('query') || '', '搜索词', 0, 100), sort = search.get('sort') || 'newest';
  choice(sort, ['newest', 'price-asc', 'price-desc'], '排序');
  const where = ["status = 'active'"], values = [];
  for (const [column, value] of [['category', category === 'all' ? '' : category], ['campus', campus], ['condition', condition]]) {
    if (value) { where.push(`${column} = ?`); values.push(value); }
  }
  if (query) {
    where.push("instr(lower(title || ' ' || description || ' ' || CASE category WHEN 'appliance' THEN '小电器' WHEN 'ebike' THEN '电瓶车' ELSE '生活用品' END), lower(?)) > 0");
    values.push(query);
  }
  for (const [key, clause] of [['cheap', 'price_cents <= 10000'], ['fresh', "condition = '几乎全新'"], ['graduation', 'graduation = 1']]) {
    const value = search.get(key);
    if (value !== null && !['0', '1'].includes(value)) fail(400, 'INVALID_INPUT', '筛选参数无效。');
    if (value === '1') where.push(clause);
  }
  const clause = where.join(' AND '), order = sort === 'price-asc' ? 'price_cents ASC' : sort === 'price-desc' ? 'price_cents DESC' : 'created_at DESC';
  const count = await first(db, `SELECT count(*) AS total FROM products WHERE ${clause}`, values);
  const rows = await all(db, `SELECT * FROM products WHERE ${clause} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
  const categoryCounts = { all: 0, appliance: 0, ebike: 0, daily: 0 };
  for (const group of await all(db, "SELECT category, count(*) AS total FROM products WHERE status = 'active' GROUP BY category")) {
    categoryCounts[group.category] = Number(group.total); categoryCounts.all += Number(group.total);
  }
  const total = Number(count.total);
  return json({ items: await dtos(db, rows, viewer), total, categoryCounts, page, pageSize, hasMore: page * pageSize < total });
}
async function assertImagesOwned(db, imageIds, userId) {
  const rows = await all(db, `SELECT id FROM media WHERE owner_id = ? AND id IN (${imageIds.map(() => '?').join(',')})`, [userId, ...imageIds]);
  if (rows.length !== imageIds.length) fail(403, 'INVALID_MEDIA_OWNER', '只能使用自己上传的照片。');
}
function productGuard(productId, status) {
  return {
    sql: `EXISTS (SELECT 1 FROM products guarded WHERE guarded.id = ?${status ? ' AND guarded.status = ?' : ''})`,
    values: status ? [productId, status] : [productId],
  };
}
function imageStatements(db, productId, imageIds, status) {
  const guard = productGuard(productId, status);
  return imageIds.map((mediaId, position) => statement(db, `INSERT INTO product_media (product_id, media_id, position) SELECT ?, ?, ? WHERE ${guard.sql}`, [productId, mediaId, position, ...guard.values]));
}
function contactStatement(db, productId, value, status) {
  const guard = productGuard(productId, status);
  return statement(db, `INSERT INTO private_contacts (product_id, type, value) SELECT ?, ?, ? WHERE ${guard.sql} ON CONFLICT(product_id) DO UPDATE SET type = excluded.type, value = excluded.value`, [productId, value.contactType, value.contactValue, ...guard.values]);
}
async function assertActiveQuota(db, userId) {
  const row = await first(db, "SELECT count(*) AS n FROM products WHERE owner_id = ? AND status = 'active'", [userId]);
  if (Number(row.n) >= 100) fail(429, 'ACTIVE_LIMIT', '最多同时上架 100 件商品，请先下架一些闲置。');
}
async function assertCreateQuota(db, userId) {
  const row = await first(db, 'SELECT count(*) AS n FROM products WHERE owner_id = ? AND created_at >= ?', [userId, Date.now() - DAY]);
  if (Number(row.n) >= 20) fail(429, 'PUBLISH_LIMIT', '24 小时内最多新发布 20 件商品，请稍后再试。');
  await assertActiveQuota(db, userId);
}
async function assertUploadQuota(db, userId) {
  const row = await first(db, 'SELECT count(*) AS n FROM media WHERE owner_id = ? AND created_at >= ?', [userId, Date.now() - DAY]);
  if (Number(row.n) >= 60) fail(429, 'UPLOAD_LIMIT', '24 小时内最多上传 60 张照片，请稍后再试。');
}
async function createProduct(request, db, viewer) {
  const userId = requireViewer(viewer), body = await payload(request);
  checkFields(body);
  const value = validateProduct(body);
  await assertCreateQuota(db, userId);
  await assertImagesOwned(db, value.imageIds, userId);
  await ensureUser(db, userId);
  const productId = crypto.randomUUID(), now = Date.now();
  const results = await db.batch([
    statement(db, "INSERT INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM products WHERE owner_id = ? AND created_at >= ?) < 20 AND (SELECT count(*) FROM products WHERE owner_id = ? AND status = 'active') < 100",
      [productId, userId, value.title, value.category, value.priceCents, value.originalPriceCents, value.condition, value.campus, value.location, value.description, JSON.stringify(value.specs), Number(value.graduation), value.seller, 'active', now, now, userId, now - DAY, userId]),
    contactStatement(db, productId, value), ...imageStatements(db, productId, value.imageIds),
    statement(db, 'UPDATE users SET display_name = ? WHERE id = ? AND EXISTS (SELECT 1 FROM products WHERE id = ?)', [value.seller, userId, productId]),
  ]);
  if (!results[0].meta?.changes) { await assertCreateQuota(db, userId); fail(429, 'PUBLISH_LIMIT', '发布过于频繁，请稍后再试。'); }
  return json({ product: await dto(db, await productRow(db, productId), viewer) }, 201);
}
async function updateProduct(request, db, productId, viewer) {
  const userId = requireViewer(viewer), existing = await productRow(db, productId);
  owned(existing, viewer);
  const body = await payload(request);
  checkFields(body, true);
  const status = Object.hasOwn(body, 'status') ? choice(body.status, ['active', 'inactive'], '商品状态') : existing.status;
  if (status === 'active' && existing.status === 'inactive') await assertActiveQuota(db, userId);
  const activeGuard = "(? = 'inactive' OR status = 'active' OR (SELECT count(*) FROM products WHERE owner_id = ? AND status = 'active') < 100)";
  if (Object.keys(body).length === 1 && Object.hasOwn(body, 'status')) {
    const result = await statement(db, `UPDATE products SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND ${activeGuard}`, [status, Date.now(), productId, userId, status, userId]).run();
    if (!result.meta?.changes) fail(429, 'ACTIVE_LIMIT', '最多同时上架 100 件商品，请先下架一些闲置。');
  } else {
    const contact = await first(db, 'SELECT type, value FROM private_contacts WHERE product_id = ?', [productId]);
    const value = validateProduct({
      title: existing.title, category: existing.category, price: existing.price_cents / 100, originalPrice: existing.original_price_cents / 100,
      condition: existing.condition, campus: existing.campus, location: existing.location, description: existing.description,
      specs: JSON.parse(existing.specs_json), graduation: Boolean(existing.graduation), seller: existing.seller,
      contactType: contact?.type, contactValue: contact?.value, imageIds: await mediaIds(db, productId), ...body,
    });
    await assertImagesOwned(db, value.imageIds, userId);
    const guard = productGuard(productId, status);
    const results = await db.batch([
      statement(db, `UPDATE products SET title = ?, category = ?, price_cents = ?, original_price_cents = ?, condition = ?, campus = ?, location = ?, description = ?, specs_json = ?, graduation = ?, seller = ?, status = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND ${activeGuard}`,
        [value.title, value.category, value.priceCents, value.originalPriceCents, value.condition, value.campus, value.location, value.description, JSON.stringify(value.specs), Number(value.graduation), value.seller, status, Date.now(), productId, userId, status, userId]),
      contactStatement(db, productId, value, status), statement(db, `DELETE FROM product_media WHERE product_id = ? AND ${guard.sql}`, [productId, ...guard.values]),
      ...imageStatements(db, productId, value.imageIds, status), statement(db, `UPDATE users SET display_name = ? WHERE id = ? AND ${guard.sql}`, [value.seller, userId, ...guard.values]),
    ]);
    if (!results[0].meta?.changes) fail(429, 'ACTIVE_LIMIT', '最多同时上架 100 件商品，请先下架一些闲置。');
  }
  return json({ product: await dto(db, await productRow(db, productId), viewer) });
}
function sniffImage(bytes) {
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  const decoder = new TextDecoder('ascii');
  if (bytes.length >= 12 && decoder.decode(bytes.slice(0, 4)) === 'RIFF' && decoder.decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  fail(400, 'INVALID_IMAGE', '照片内容必须是 JPG、PNG 或 WebP。');
}
async function uploadMedia(request, env, db, viewer) {
  const userId = requireViewer(viewer), bucket = requireBucket(env);
  await assertUploadQuota(db, userId);
  const contentType = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data;/i.test(contentType)) fail(415, 'UNSUPPORTED_TYPE', '请使用照片上传表单。');
  const bytes = await readBytes(request, MAX_IMAGE + 65536);
  let form;
  try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { fail(400, 'INVALID_IMAGE', '照片表单无法读取。'); }
  const files = form.getAll('file'), file = files[0];
  if (files.length !== 1 || !(file instanceof Blob) || [...form.keys()].some(key => key !== 'file')) fail(400, 'INVALID_IMAGE', '每次请选择一张照片。');
  if (file.size === 0 || file.size > MAX_IMAGE) fail(413, 'IMAGE_TOO_LARGE', '单张照片应大于 0 且不超过 8 MB。');
  const imageBytes = new Uint8Array(await file.arrayBuffer()), actualType = sniffImage(imageBytes);
  if (file.type !== actualType) fail(400, 'INVALID_IMAGE', '照片类型与实际内容不一致。');
  await ensureUser(db, userId);
  const mediaId = crypto.randomUUID(), objectKey = `market/${crypto.randomUUID()}`;
  await bucket.put(objectKey, imageBytes, { httpMetadata: { contentType: actualType } });
  let inserted;
  try {
    const now = Date.now();
    inserted = await statement(db, 'INSERT INTO media (id, owner_id, object_key, content_type, size, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM media WHERE owner_id = ? AND created_at >= ?) < 60', [mediaId, userId, objectKey, actualType, imageBytes.length, now, userId, now - DAY]).run();
  } catch (error) { await bucket.delete(objectKey); throw error; }
  if (!inserted.meta?.changes) { await bucket.delete(objectKey); fail(429, 'UPLOAD_LIMIT', '24 小时内最多上传 60 张照片，请稍后再试。'); }
  return json({ mediaId, url: `/api/media/${mediaId}` }, 201);
}
async function getMedia(env, db, mediaId, viewer) {
  const row = await first(db, 'SELECT * FROM media WHERE id = ?', [mediaId]);
  if (!row) fail(404, 'NOT_FOUND', '照片不存在。');
  if (row.owner_id !== viewer?.userId) {
    const published = await first(db, "SELECT pm.media_id FROM product_media pm JOIN products p ON p.id = pm.product_id WHERE pm.media_id = ? AND p.status = 'active' LIMIT 1", [mediaId]);
    if (!published) fail(404, 'NOT_FOUND', '照片不存在。');
  }
  const object = await requireBucket(env).get(row.object_key);
  if (!object) fail(404, 'NOT_FOUND', '照片不存在。');
  return new Response(object.body, { headers: { ...PRIVATE_HEADERS, 'Content-Type': row.content_type, 'Content-Length': String(row.size) } });
}

/**
 * Verified identity is supplied only by the trusted route wrapper, never request JSON/headers.
 * @param {Request} request
 * @param {{DB?: any, BUCKET?: any}} env
 * @param {{userId: string, provider?: string}|null} viewer
 * @param {{development?: boolean, authentication?: object}} [options]
 */
export async function handleMarket(request, env, viewer = null, { development = false, authentication } = {}) {
  try {
    const method = request.method.toUpperCase(), url = new URL(request.url);
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '此请求方式不受支持。');
    if (method !== 'GET') { requireViewer(viewer); requireOrigin(request); }
    const db = requireDb(env);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/me' && method === 'GET') {
      const stored = viewer ? await first(db, 'SELECT display_name FROM users WHERE id = ?', [viewer.userId]) : null;
      return json({
        development: development === true,
        user: viewer ? { id: viewer.userId, displayName: stored?.display_name || '橘子同学', schoolVerified: false } : null,
        signInUrl: '/signin-with-chatgpt?return_to=%2F%23%2F', signOutUrl: '/signout-with-chatgpt?return_to=%2F%23%2F',
        authentication: authentication || {
          provider: viewer ? (viewer.provider === 'external' ? 'external' : 'chatgpt') : null,
          external: { configured: false, methods: { phone: false, wechat: false }, startUrl: '/api/auth/start' },
          platform: { enabled: true, signInUrl: '/signin-with-chatgpt?return_to=%2F%23%2F', signOutUrl: '/signout-with-chatgpt?return_to=%2F' },
        },
        capabilities: { canPublish: Boolean(viewer), canViewContact: Boolean(viewer), canFavorite: Boolean(viewer), schoolVerificationRequired: false },
      });
    }
    if (path === '/api/products') {
      if (method === 'GET') return await listProducts(db, url.searchParams, viewer);
      if (method === 'POST') return await createProduct(request, db, viewer);
    }
    if (path === '/api/me/products' && method === 'GET') {
      const userId = requireViewer(viewer);
      return json({ items: await dtos(db, await all(db, 'SELECT * FROM products WHERE owner_id = ? ORDER BY created_at DESC, id DESC', [userId]), viewer) });
    }
    if (path === '/api/me/favorites' && method === 'GET') {
      const userId = requireViewer(viewer);
      return json({ items: await dtos(db, await all(db, "SELECT p.* FROM products p JOIN favorites f ON f.product_id = p.id WHERE f.user_id = ? AND (p.status = 'active' OR p.owner_id = ?) ORDER BY f.created_at DESC, p.id DESC", [userId, userId]), viewer) });
    }
    let match = path.match(/^\/api\/me\/favorites\/([^/]+)$/);
    if (match && ['PUT', 'DELETE'].includes(method)) {
      const userId = requireViewer(viewer), productId = id(decodeURIComponent(match[1]));
      if (method === 'PUT') {
        const row = await productRow(db, productId);
        if (!visible(row, viewer)) fail(404, 'NOT_FOUND', '商品不存在。');
        await ensureUser(db, userId);
        await statement(db, 'INSERT INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, product_id) DO NOTHING', [userId, productId, Date.now()]).run();
      } else await statement(db, 'DELETE FROM favorites WHERE user_id = ? AND product_id = ?', [userId, productId]).run();
      return json({ ok: true });
    }
    match = path.match(/^\/api\/products\/([^/]+)(\/contact)?$/);
    if (match) {
      const productId = id(decodeURIComponent(match[1]));
      if (match[2] && method === 'GET') {
        requireViewer(viewer);
        const row = await productRow(db, productId);
        if (!visible(row, viewer)) fail(404, 'NOT_FOUND', '商品不存在或已下架。');
        const contact = await first(db, 'SELECT type, value FROM private_contacts WHERE product_id = ?', [productId]);
        if (!contact) fail(404, 'NOT_FOUND', '卖家联系方式暂不可用。');
        return json(contact);
      }
      if (!match[2] && method === 'GET') {
        const row = await productRow(db, productId);
        if (!visible(row, viewer)) fail(404, 'NOT_FOUND', '商品不存在或已下架。');
        return json({ product: await dto(db, row, viewer) });
      }
      if (!match[2] && method === 'PATCH') return await updateProduct(request, db, productId, viewer);
    }
    if (path === '/api/media' && method === 'POST') return await uploadMedia(request, env, db, viewer);
    match = path.match(/^\/api\/media\/([^/]+)$/);
    if (match && method === 'GET') return await getMedia(env, db, id(decodeURIComponent(match[1])), viewer);
    fail(404, 'NOT_FOUND', '接口不存在。');
  } catch (error) {
    if (error instanceof MarketError) return json({ error: { code: error.code, message: error.message } }, error.status, error.status === 429 ? { 'Retry-After': '3600' } : {});
    if (error instanceof URIError) return json({ error: { code: 'INVALID_ID', message: '记录编号无效。' } }, 400);
    // Internal SQL/object-store details and platform account information never leave the server.
    console.error('Marketplace request failed:', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后重试。' } }, 503);
  }
}
