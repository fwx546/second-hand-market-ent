import { demoImages } from './demo-catalog.mjs';
import { CONTACT_EXCHANGE_MESSAGE_PREFIX, handleContactExchange } from './contact-exchange.mjs';

const CATEGORIES = ['appliance', 'ebike', 'daily', 'service'];
const SERVICE_DIRECTIONS = ['学习辅导', '游戏服务', '设计与创作', '技术支持', '生活协助', '其他'];
const SERVICE_MODES = ['线上服务', '线下服务', '线上／线下均可'];
const SERVICE_UNITS = ['每次', '每小时', '每课时', '每项', '自定义'];
const SERVICE_REQUIRED = ['服务方向', '计价单位', '服务方式', '服务范围', '服务时长／交付周期', '预约安排'];
const SERVICE_OPTIONAL = ['自定义单位', '经验／作品说明', '线上沟通方式'];
const CAMPUSES = ['SIP 校区', '太仓校区'];
const CONDITIONS = ['全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹'];
const CONTACT_TYPES = ['wechat', 'phone', 'qq'];
const FIELDS = ['title', 'category', 'price', 'originalPrice', 'condition', 'campus', 'location', 'description', 'specs', 'graduation', 'seller', 'contactType', 'contactValue', 'imageIds'];
const MAX_IMAGE = 8 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const PRODUCT_CARD_MESSAGE = '\u2063juzi:product-card:v1';

class MarketError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new MarketError(status, code, message); }
function json(value, status = 200, headers = {}) { return Response.json(value, { status, headers: { ...PRIVATE_HEADERS, ...headers } }); }
function statement(db, sql, values = []) { return db.prepare(sql).bind(...values); }
async function first(db, sql, values = []) { return statement(db, sql, values).first(); }
async function serviceSchemaReady(db) {
  const row = await first(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'");
  return Boolean(row?.sql?.includes("'service'") && row.sql.includes("'不适用'"));
}
async function requireServiceSchema(db, category) {
  if (category === 'service' && !await serviceSchemaReady(db)) fail(503, 'SERVICE_SCHEMA_PENDING', '服务发布暂未开通，请稍后再试。');
}
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
  const service = input.category === 'service';
  const value = {
    title: text(input.title, '商品标题', 1, 100),
    category: choice(input.category, CATEGORIES, '分类'),
    priceCents: cents(input.price, '转让价格', 0.01),
    originalPriceCents: service ? 0 : cents(input.originalPrice, '购入价格', 0),
    condition: service ? '不适用' : choice(input.condition, CONDITIONS, '成色'),
    campus: choice(input.campus, CAMPUSES, '校区'),
    location: service && input.specs?.['服务方式'] === '线上服务' ? '线上服务' : text(input.location, service ? '服务地点' : '面交地点', 1, 100),
    description: text(input.description, '商品描述', 5, 2000, true),
    seller: text(input.seller, '卖家昵称', 1, 30),
    contactType: choice(input.contactType ?? 'wechat', CONTACT_TYPES, '联系方式类型'),
    contactValue: text(input.contactValue ?? '', '联系方式', 0, 80),
  };
  if (value.contactValue && value.contactValue.length < 3) fail(400, 'INVALID_INPUT', '联系方式至少 3 个字符，或留空使用私信。');
  if (typeof input.graduation !== 'boolean') fail(400, 'INVALID_INPUT', '毕业转让应为布尔值。');
  value.graduation = service ? false : input.graduation;
  if (!input.specs || typeof input.specs !== 'object' || Array.isArray(input.specs)) fail(400, 'INVALID_INPUT', '请填写商品参数。');
  const entries = Object.entries(input.specs);
  if (!entries.length || entries.length > 10) fail(400, 'INVALID_INPUT', '商品参数应为 1–10 项。');
  value.specs = Object.fromEntries(entries.flatMap(([key, item]) => {
    const name = text(key, '参数名', 1, 40);
    if (service && ![...SERVICE_REQUIRED, ...SERVICE_OPTIONAL].includes(name)) fail(400, 'INVALID_INPUT', '服务包含不适用的参数。');
    if (service && SERVICE_OPTIONAL.includes(name) && item === '') return [];
    if (value.category === 'daily' && name === '尺寸' && item === '') return [];
    return [[name, text(item, '参数内容', 1, 200)]];
  }));
  const required = service ? SERVICE_REQUIRED : value.category === 'ebike' ? ['购入时间', '电池情况', '卖家自述续航'] : value.category === 'daily' ? ['数量', '使用情况'] : ['型号', '使用情况'];
  if (required.some(key => !Object.hasOwn(value.specs, key))) fail(400, 'INVALID_INPUT', '请填写该分类的完整商品参数。');
  if (service) {
    choice(value.specs['服务方向'], SERVICE_DIRECTIONS, '服务方向');
    choice(value.specs['服务方式'], SERVICE_MODES, '服务方式');
    choice(value.specs['计价单位'], SERVICE_UNITS, '计价单位');
    if (value.specs['计价单位'] === '自定义') value.specs['自定义单位'] = text(value.specs['自定义单位'], '自定义单位', 1, 20);
    else delete value.specs['自定义单位'];
    if (value.specs['服务方式'] === '线下服务') delete value.specs['线上沟通方式'];
  }
  if (!Array.isArray(input.imageIds) || input.imageIds.length < 1 || input.imageIds.length > 6 || new Set(input.imageIds).size !== input.imageIds.length) {
    fail(400, 'INVALID_INPUT', '请选择 1–6 张不同的商品照片。');
  }
  value.imageIds = input.imageIds.map(id);
  return value;
}

async function listConversations(db, userId) {
  const rows = await all(db, `SELECT c.id, c.product_id, c.buyer_id, c.seller_id, c.updated_at, p.title, p.seller, p.status,
    u.display_name AS other_name,
    (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
    (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
    FROM conversations c JOIN products p ON p.id = c.product_id
    JOIN users u ON u.id = CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END
    WHERE c.buyer_id = ? OR c.seller_id = ? ORDER BY c.updated_at DESC, c.id DESC`, [userId, userId, userId]);
  return rows.map(row => ({ id: row.id, productId: row.product_id, title: row.title, seller: row.seller, productStatus: row.status,
    otherName: row.other_name || '橘子同学', lastMessage: row.last_message === PRODUCT_CARD_MESSAGE ? '发送了商品卡片' : row.last_message?.startsWith(CONTACT_EXCHANGE_MESSAGE_PREFIX) ? '申请交换联系方式' : row.last_message || '开始聊聊这件好物', updatedAt: row.last_message_at || row.updated_at,
    role: row.buyer_id === userId ? 'buyer' : 'seller' }));
}

async function conversationRow(db, conversationId, userId) {
  return first(db, 'SELECT * FROM conversations WHERE id = ? AND (buyer_id = ? OR seller_id = ?)', [conversationId, userId, userId]);
}

async function conversationProductCard(db, productId) {
  const product = await productRow(db, productId);
  if (!product) return null;
  const image = await first(db, 'SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position LIMIT 1', [productId]);
  return { productId, title: product.title, price: product.price_cents / 100,
    imageUrl: image ? `/api/media/${encodeURIComponent(image.media_id)}` : '',
    status: productStatus(product), category: product.category };
}

function conversationMessage(row, userId, card, exchange) {
  const productCard = row.body === PRODUCT_CARD_MESSAGE;
  const exchangeId = row.body.startsWith(CONTACT_EXCHANGE_MESSAGE_PREFIX) ? row.body.slice(CONTACT_EXCHANGE_MESSAGE_PREFIX.length) : '';
  return { id: row.id, senderId: row.sender_id, body: productCard ? '' : row.body,
    kind: productCard ? 'product_card' : exchangeId ? 'contact_exchange' : 'text', ...(productCard ? { card } : {}),
    ...(exchangeId ? { body: '', exchange: { id: exchangeId, status: exchange?.status || 'unknown', offeredType: exchange?.requester_type || '' } } : {}),
    createdAt: row.created_at, mine: row.sender_id === userId };
}

async function startConversation(request, db, viewer) {
  const userId = requireViewer(viewer), body = await payload(request);
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'productId')) fail(400, 'INVALID_INPUT', '请提供商品编号。');
  const productId = id(body.productId), product = await productRow(db, productId);
  if (!visible(product, viewer) || product.is_demo) fail(404, 'NOT_FOUND', '商品不存在或暂不可联系。');
  if (product.owner_id === userId) fail(400, 'SELF_MESSAGE', '不能给自己发布的商品发消息。');
  await ensureUser(db, userId);
  const now = Date.now(), conversationId = `conv_${crypto.randomUUID()}`;
  await statement(db, `INSERT INTO conversations (id, product_id, buyer_id, seller_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(product_id, buyer_id) DO NOTHING`,
    [conversationId, productId, userId, product.owner_id, now, now]).run();
  const existing = await first(db, 'SELECT id FROM conversations WHERE product_id = ? AND buyer_id = ?', [productId, userId]);
  return json({ conversationId: existing.id });
}

async function readConversationMessages(db, conversationId, userId) {
  const conversation = await conversationRow(db, conversationId, userId);
  if (!conversation) fail(404, 'NOT_FOUND', '对话不存在。');
  const rows = await all(db, `SELECT id, sender_id, body, created_at FROM
    (SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)
    ORDER BY created_at ASC, id ASC`, [conversationId]);
  const card = rows.some(row => row.body === PRODUCT_CARD_MESSAGE) ? await conversationProductCard(db, conversation.product_id) : null;
  const exchangeIds = [...new Set(rows.filter(row => row.body.startsWith(CONTACT_EXCHANGE_MESSAGE_PREFIX)).map(row => row.body.slice(CONTACT_EXCHANGE_MESSAGE_PREFIX.length)))];
  const exchangeRows = exchangeIds.length ? await all(db, `SELECT id,status,requester_type FROM contact_exchanges WHERE conversation_id=? AND id IN (${exchangeIds.map(() => '?').join(',')})`, [conversationId, ...exchangeIds]) : [];
  const exchanges = new Map(exchangeRows.map(row => [row.id, row]));
  return json({ items: rows.map(row => conversationMessage(row, userId, card, exchanges.get(row.body.slice(CONTACT_EXCHANGE_MESSAGE_PREFIX.length)))) });
}

async function sendConversationMessage(request, db, conversationId, userId) {
  const body = await payload(request);
  const productCard = Object.keys(body).length === 1 && body.type === 'product_card';
  if (!productCard && (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'body'))) fail(400, 'INVALID_INPUT', '请只填写消息内容。');
  const conversation = await conversationRow(db, conversationId, userId);
  if (!conversation) fail(404, 'NOT_FOUND', '对话不存在。');
  const value = productCard ? PRODUCT_CARD_MESSAGE : text(body.body, '消息', 1, 1000, true);
  if (!productCard && (value === PRODUCT_CARD_MESSAGE || value.startsWith(CONTACT_EXCHANGE_MESSAGE_PREFIX))) fail(400, 'INVALID_INPUT', '请填写消息内容。');
  const now = Date.now(), messageId = `msg_${crypto.randomUUID()}`;
  await db.batch([
    statement(db, 'INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [messageId, conversationId, userId, value, now]),
    statement(db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', [now, conversationId]),
  ]);
  const card = productCard ? await conversationProductCard(db, conversation.product_id) : null;
  return json({ message: conversationMessage({ id: messageId, sender_id: userId, body: value, created_at: now }, userId, card) }, 201);
}
async function ensureUser(db, userId) {
  await statement(db, 'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING', [userId, '橘子同学', Date.now()]).run();
}
async function productRow(db, productId) { return first(db, 'SELECT * FROM products WHERE id = ?', [productId]); }
function productStatus(row) { return row.deleted_at !== null && row.deleted_at !== undefined ? 'deleted' : row.sold_at !== null && row.sold_at !== undefined ? 'sold' : row.status; }
function visible(row, viewer) { return row && (productStatus(row) === 'active' || row.owner_id === viewer?.userId); }
function owned(row, viewer) {
  if (!row) fail(404, 'NOT_FOUND', '商品不存在。');
  if (row.is_demo) fail(409, 'DEMO_PRODUCT', '这是示例商品，不能编辑、下架或删除。');
  if (row.owner_id !== viewer?.userId) fail(403, 'FORBIDDEN', '只能管理自己发布的商品。');
}
async function mediaIds(db, productId) {
  return (await all(db, 'SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position', [productId])).map(row => row.media_id);
}
async function dto(db, row, viewer) {
  const isDemo = Boolean(row.is_demo);
  const imageIds = isDemo ? [] : await mediaIds(db, row.id);
  const schoolAccount = isDemo ? null : await first(db, 'SELECT verified_at FROM school_email_accounts WHERE user_id = ?', [row.owner_id]);
  return productDto(row, viewer, imageIds, schoolAccount?.verified_at);
}
function productDto(row, viewer, imageIds = [], verifiedAt) {
  const isDemo = Boolean(row.is_demo);
  return {
    id: row.id, title: row.title, category: row.category, price: row.price_cents / 100, originalPrice: row.original_price_cents / 100,
    condition: row.condition, campus: row.campus, location: row.location, description: row.description,
    specs: JSON.parse(row.specs_json), graduation: Boolean(row.graduation), seller: row.seller, avatar: '🍊',
    createdAt: row.created_at, status: productStatus(row), mine: !isDemo && row.owner_id === viewer?.userId, isDemo,
    sellerEmailVerified: !isDemo && Boolean(verifiedAt),
    images: isDemo ? demoImages(row.id) : imageIds.map(mediaId => `/api/media/${encodeURIComponent(mediaId)}`), imageIds,
  };
}
async function dtos(db, rows, viewer, selection) {
  const realRows = rows.filter(row => !row.is_demo);
  const images = new Map(), verified = new Map();
  const rememberImages = results => {
    for (const { product_id, media_id } of results) {
      if (!images.has(product_id)) images.set(product_id, []);
      images.get(product_id).push(media_id);
    }
  };
  const rememberAccounts = results => {
    for (const { user_id, verified_at } of results) verified.set(user_id, verified_at);
  };
  if (realRows.length && selection) {
    // Personal history and favorites have no item limit. Reuse their exact
    // ownership/visibility selection, rather than adding queries per 100 items.
    rememberImages(await all(db, `SELECT pm.product_id, pm.media_id FROM product_media pm
      JOIN (${selection.sql}) selected ON selected.id = pm.product_id
      WHERE selected.is_demo = 0 ORDER BY pm.product_id, pm.position`, selection.values));
    rememberAccounts(await all(db, `SELECT DISTINCT a.user_id, a.verified_at FROM school_email_accounts a
      JOIN (${selection.sql}) selected ON selected.owner_id = a.user_id
      WHERE selected.is_demo = 0`, selection.values));
  } else if (realRows.length) {
    // D1 permits 100 bound parameters; public pages contain at most 100 items.
    const productIds = [...new Set(realRows.map(row => row.id))];
    const ownerIds = [...new Set(realRows.map(row => row.owner_id))];
    for (let offset = 0; offset < productIds.length; offset += 100) {
      const chunk = productIds.slice(offset, offset + 100);
      rememberImages(await all(db, `SELECT product_id, media_id FROM product_media
        WHERE product_id IN (${chunk.map(() => '?').join(',')}) ORDER BY product_id, position`, chunk));
    }
    for (let offset = 0; offset < ownerIds.length; offset += 100) {
      const chunk = ownerIds.slice(offset, offset + 100);
      rememberAccounts(await all(db, `SELECT user_id, verified_at FROM school_email_accounts
        WHERE user_id IN (${chunk.map(() => '?').join(',')})`, chunk));
    }
  }
  return rows.map(row => productDto(row, viewer, images.get(row.id) || [], verified.get(row.owner_id)));
}
async function selectedDtos(db, sql, values, viewer) {
  return dtos(db, await all(db, sql, values), viewer, { sql, values });
}
async function userDto(db, viewer) {
  if (!viewer) return null;
  const stored = await first(db, 'SELECT display_name, campus, publish_seller, publish_contact_type, publish_contact_value, language, phone, wechat, qq FROM users WHERE id = ?', [viewer.userId]);
  const previous = stored?.publish_contact_value ? null : await first(db, 'SELECT p.seller, c.type, c.value FROM products p JOIN private_contacts c ON c.product_id = p.id WHERE p.owner_id = ? AND p.is_demo = 0 ORDER BY p.created_at DESC, p.id DESC LIMIT 1', [viewer.userId]);
  return { id: viewer.userId, displayName: stored?.display_name || '橘子同学', campus: stored?.campus || '', publishSeller: stored?.publish_seller || previous?.seller || '', publishContactType: stored?.publish_contact_type || previous?.type || '', publishContactValue: stored?.publish_contact_value || previous?.value || '', language: stored?.language === 'en' ? 'en' : 'zh', phone: stored?.phone || '', wechat: stored?.wechat || '', qq: stored?.qq || '', schoolVerified: false, emailVerified: viewer.provider === 'school_email', ...(viewer.provider === 'local_preview' ? { preview: true } : {}), emailMasked: viewer.emailMasked || null };
}
async function updateProfile(request, db, viewer) {
  const userId = requireViewer(viewer), body = await payload(request);
  if (!Object.keys(body).length || Object.keys(body).some(key => !['displayName', 'campus', 'language', 'phone', 'wechat', 'qq'].includes(key))) fail(400, 'INVALID_INPUT', '个人资料包含不支持的字段。');
  const changes = {};
  if (Object.hasOwn(body, 'displayName')) {
    changes.display_name = text(body.displayName, '昵称', 1, 20);
    if (changes.display_name.includes('@')) fail(400, 'INVALID_INPUT', '昵称中请不要填写邮箱地址。');
  }
  if (Object.hasOwn(body, 'campus')) changes.campus = choice(body.campus, ['', ...CAMPUSES], '常用校区');
  if (Object.hasOwn(body, 'language')) changes.language = choice(body.language, ['zh', 'en'], '语言');
  for (const [key, label, pattern] of [['phone', '手机号', /^(?:1[3-9]\d{9})?$/], ['wechat', '微信号', /^(?:[A-Za-z][A-Za-z0-9_-]{5,19})?$/], ['qq', 'QQ 号', /^(?:[1-9]\d{4,11})?$/]]) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'string') fail(400, 'INVALID_INPUT', `${label}格式不正确。`);
    const value = body[key].trim();
    if (!pattern.test(value)) fail(400, 'INVALID_INPUT', `${label}格式不正确。`);
    changes[key] = value;
  }
  await ensureUser(db, userId);
  await statement(db, `UPDATE users SET ${Object.keys(changes).map(key => `${key} = ?`).join(', ')} WHERE id = ?`, [...Object.values(changes), userId]).run();
  return json({ user: await userDto(db, viewer) });
}
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
  const where = ["status = 'active'", 'sold_at IS NULL', 'deleted_at IS NULL'], values = [];
  for (const [key, label, options] of [['serviceDirection', '服务方向', SERVICE_DIRECTIONS], ['serviceMode', '服务方式', SERVICE_MODES]]) {
    const value = search.get(key);
    if (value) { choice(value, options, label); where.push("category = 'service'", `json_extract(specs_json, '$.${label}') = ?`); values.push(value); }
  }
  for (const [column, value] of [['category', category === 'all' ? '' : category], ['campus', campus], ['condition', condition]]) {
    if (value) { where.push(`${column} = ?`); values.push(value); }
  }
  if (query) {
    where.push("instr(lower(title || ' ' || description || ' ' || CASE category WHEN 'appliance' THEN '小电器' WHEN 'ebike' THEN '电瓶车' WHEN 'service' THEN '服务类 ' || specs_json ELSE '生活用品' END), lower(?)) > 0");
    values.push(query);
  }
  for (const [key, clause] of [['cheap', 'price_cents <= 10000'], ['fresh', "condition IN ('全新', '几乎全新')"], ['graduation', 'graduation = 1']]) {
    const value = search.get(key);
    if (value !== null && !['0', '1'].includes(value)) fail(400, 'INVALID_INPUT', '筛选参数无效。');
    if (value === '1') where.push(clause);
  }
  const clause = where.join(' AND '), order = sort === 'price-asc' ? 'price_cents ASC' : sort === 'price-desc' ? 'price_cents DESC' : 'created_at DESC';
  const count = await first(db, `SELECT count(*) AS total, COALESCE(sum(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END), 0) AS demo_total FROM products WHERE ${clause}`, values);
  const rows = await all(db, `SELECT * FROM products WHERE ${clause} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
  const categoryCounts = { all: 0, appliance: 0, ebike: 0, daily: 0, service: 0 };
  for (const group of await all(db, "SELECT category, count(*) AS total FROM products WHERE status = 'active' AND sold_at IS NULL AND deleted_at IS NULL GROUP BY category")) {
    categoryCounts[group.category] = Number(group.total); categoryCounts.all += Number(group.total);
  }
  const total = Number(count.total), demoTotal = Number(count.demo_total);
  return json({ items: await dtos(db, rows, viewer), total, realTotal: total - demoTotal, demoTotal, categoryCounts, page, pageSize, hasMore: page * pageSize < total });
}
async function assertImagesOwned(db, imageIds, userId) {
  const rows = await all(db, `SELECT id FROM media WHERE owner_id = ? AND id IN (${imageIds.map(() => '?').join(',')})`, [userId, ...imageIds]);
  if (rows.length !== imageIds.length) fail(403, 'INVALID_MEDIA_OWNER', '只能使用自己上传的照片。');
}
function productGuard(productId, status) {
  const logical = status === 'active' ? " AND guarded.status = 'active' AND guarded.sold_at IS NULL AND guarded.deleted_at IS NULL" : status === 'inactive' ? " AND guarded.status = 'inactive' AND guarded.sold_at IS NULL AND guarded.deleted_at IS NULL" : status === 'sold' ? " AND guarded.status = 'inactive' AND guarded.sold_at IS NOT NULL AND guarded.deleted_at IS NULL" : status === 'deleted' ? " AND guarded.status = 'inactive' AND guarded.deleted_at IS NOT NULL" : '';
  return {
    sql: `EXISTS (SELECT 1 FROM products guarded WHERE guarded.id = ?${logical})`,
    values: [productId],
  };
}
function imageStatements(db, productId, imageIds, status) {
  const guard = productGuard(productId, status);
  return imageIds.map((mediaId, position) => statement(db, `INSERT INTO product_media (product_id, media_id, position) SELECT ?, ?, ? WHERE ${guard.sql}`, [productId, mediaId, position, ...guard.values]));
}
function contactStatement(db, productId, value, status) {
  const guard = productGuard(productId, status);
  if (!value.contactValue) return statement(db, `DELETE FROM private_contacts WHERE product_id = ? AND ${guard.sql}`, [productId, ...guard.values]);
  return statement(db, `INSERT INTO private_contacts (product_id, type, value) SELECT ?, ?, ? WHERE ${guard.sql} ON CONFLICT(product_id) DO UPDATE SET type = excluded.type, value = excluded.value`, [productId, value.contactType, value.contactValue, ...guard.values]);
}
async function assertActiveQuota(db, userId) {
  const row = await first(db, "SELECT count(*) AS n FROM products WHERE owner_id = ? AND status = 'active' AND sold_at IS NULL AND deleted_at IS NULL", [userId]);
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
  await requireServiceSchema(db, value.category);
  await assertCreateQuota(db, userId);
  await assertImagesOwned(db, value.imageIds, userId);
  await ensureUser(db, userId);
  const productId = crypto.randomUUID(), now = Date.now();
  const results = await db.batch([
    statement(db, "INSERT INTO products (id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM products WHERE owner_id = ? AND created_at >= ?) < 20 AND (SELECT count(*) FROM products WHERE owner_id = ? AND status = 'active' AND sold_at IS NULL AND deleted_at IS NULL) < 100",
      [productId, userId, value.title, value.category, value.priceCents, value.originalPriceCents, value.condition, value.campus, value.location, value.description, JSON.stringify(value.specs), Number(value.graduation), value.seller, 'active', now, now, userId, now - DAY, userId]),
    contactStatement(db, productId, value), ...imageStatements(db, productId, value.imageIds),
    statement(db, 'UPDATE users SET publish_seller = ?, publish_contact_type = ?, publish_contact_value = ? WHERE id = ? AND EXISTS (SELECT 1 FROM products WHERE id = ? AND owner_id = ?)', [value.seller, value.contactType, value.contactValue, userId, productId, userId]),
  ]);
  if (!results[0].meta?.changes) { await assertCreateQuota(db, userId); fail(429, 'PUBLISH_LIMIT', '发布过于频繁，请稍后再试。'); }
  return json({ product: await dto(db, await productRow(db, productId), viewer) }, 201);
}
async function updateProduct(request, db, productId, viewer) {
  const userId = requireViewer(viewer), existing = await productRow(db, productId);
  owned(existing, viewer);
  const body = await payload(request);
  checkFields(body, true);
  const explicitStatus = Object.hasOwn(body, 'status');
  const status = explicitStatus ? choice(body.status, ['active', 'inactive', 'sold'], '商品状态') : productStatus(existing);
  if (productStatus(existing) === 'deleted' && !(Object.keys(body).length === 1 && body.status === 'inactive')) fail(409, 'PRODUCT_DELETED', '请先将商品从回收站恢复为下架状态。');
  if (status === 'active' && productStatus(existing) !== 'active') await assertActiveQuota(db, userId);
  const storedStatus = status === 'active' ? 'active' : 'inactive', now = Date.now();
  const soldAt = status === 'sold' ? existing.sold_at ?? now : null;
  const activeGuard = "(? <> 'active' OR (status = 'active' AND sold_at IS NULL AND deleted_at IS NULL) OR (SELECT count(*) FROM products WHERE owner_id = ? AND status = 'active' AND sold_at IS NULL AND deleted_at IS NULL) < 100)";
  if (Object.keys(body).length === 1 && Object.hasOwn(body, 'status')) {
    const result = await statement(db, `UPDATE products SET status = ?, sold_at = ?, deleted_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS ? AND (deleted_at IS NULL OR ? = 'inactive') AND ${activeGuard}`, [storedStatus, soldAt, now, productId, userId, existing.deleted_at, status, status, userId]).run();
    if (!result.meta?.changes) {
      const current = await productRow(db, productId);
      if (!current || current.deleted_at !== existing.deleted_at) fail(409, 'PRODUCT_STATE_CHANGED', '商品状态已变化，请刷新后重试。');
      fail(429, 'ACTIVE_LIMIT', '最多同时上架 100 件商品，请先下架一些闲置。');
    }
  } else {
    const contact = await first(db, 'SELECT type, value FROM private_contacts WHERE product_id = ?', [productId]);
    const value = validateProduct({
      title: existing.title, category: existing.category, price: existing.price_cents / 100, originalPrice: existing.original_price_cents / 100,
      condition: existing.condition, campus: existing.campus, location: existing.location, description: existing.description,
      specs: JSON.parse(existing.specs_json), graduation: Boolean(existing.graduation), seller: existing.seller,
      contactType: contact?.type, contactValue: contact?.value, imageIds: await mediaIds(db, productId), ...body,
    });
    await requireServiceSchema(db, value.category);
    await assertImagesOwned(db, value.imageIds, userId);
    const guard = productGuard(productId, status);
    const results = await db.batch([
      statement(db, `UPDATE products SET title = ?, category = ?, price_cents = ?, original_price_cents = ?, condition = ?, campus = ?, location = ?, description = ?, specs_json = ?, graduation = ?, seller = ?, ${explicitStatus ? 'status = ?, sold_at = ?, ' : ''}updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND ${activeGuard}${explicitStatus ? '' : ` AND ${guard.sql}`}`,
        [value.title, value.category, value.priceCents, value.originalPriceCents, value.condition, value.campus, value.location, value.description, JSON.stringify(value.specs), Number(value.graduation), value.seller, ...(explicitStatus ? [storedStatus, soldAt] : []), now, productId, userId, explicitStatus ? status : 'inactive', userId, ...(explicitStatus ? [] : guard.values)]),
      contactStatement(db, productId, value, status), statement(db, `DELETE FROM product_media WHERE product_id = ? AND ${guard.sql}`, [productId, ...guard.values]),
      ...imageStatements(db, productId, value.imageIds, status),
    ]);
    if (!results[0].meta?.changes) {
      if (!explicitStatus || productStatus(await productRow(db, productId)) === 'deleted') fail(409, 'PRODUCT_STATE_CHANGED', '商品状态已变化，请刷新后重试。');
      fail(429, 'ACTIVE_LIMIT', '最多同时上架 100 件商品，请先下架一些闲置。');
    }
  }
  return json({ product: await dto(db, await productRow(db, productId), viewer) });
}
async function deleteProduct(db, productId, viewer) {
  const userId = requireViewer(viewer), existing = await productRow(db, productId);
  owned(existing, viewer);
  // Recycle-bin deletion keeps ownership, photos and publish-quota history for restoration.
  await statement(db, "UPDATE products SET status = 'inactive', sold_at = NULL, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ? AND owner_id = ?", [Date.now(), Date.now(), productId, userId]).run();
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
    const published = await first(db, "SELECT pm.media_id FROM product_media pm JOIN products p ON p.id = pm.product_id WHERE pm.media_id = ? AND p.status = 'active' AND p.sold_at IS NULL AND p.deleted_at IS NULL LIMIT 1", [mediaId]);
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
 * @param {{userId: string, provider?: string, emailVerified?: boolean, emailMasked?: string}|null} viewer
 * @param {{development?: boolean, authentication?: object}} [options]
 */
export async function handleMarket(request, env, viewer = null, { development = false, authentication } = {}) {
  try {
    // Platform/OIDC identities and guest selections are not school-email authentication.
    if (!(viewer?.provider === 'school_email' && viewer.emailVerified === true) && !(development === true && viewer?.provider === 'local_preview' && viewer.preview === true && new URL(request.url).hostname === 'localhost')) viewer = null;
    const method = request.method.toUpperCase(), url = new URL(request.url);
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '此请求方式不受支持。');
    if (method !== 'GET') { requireViewer(viewer); requireOrigin(request); }
    const db = requireDb(env);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/me' && method === 'GET') {
      return json({
        development: development === true,
        user: await userDto(db, viewer),
        signInUrl: '/#/login', signOutUrl: '/api/auth/logout',
        authentication: authentication || {
          provider: viewer ? 'school_email' : 'guest',
          email: { configured: false, domain: 'student.xjtlu.edu.cn', sendUrl: '/api/auth/email/send', verifyUrl: '/api/auth/email/verify' },
          guest: { enabled: true, startUrl: '/api/auth/guest' },
        },
        capabilities: { canPublish: Boolean(viewer), canViewContact: false, canRequestContactExchange: Boolean(viewer), canFavorite: Boolean(viewer), schoolVerificationRequired: false, servicePublishingReady: await serviceSchemaReady(db) },
      });
    }
    if (path === '/api/me' && method === 'PATCH') return await updateProfile(request, db, viewer);
    if (path === '/api/me/conversations' && method === 'GET') return json({ items: await listConversations(db, requireViewer(viewer)) });
    if (path === '/api/conversations' && method === 'POST') return await startConversation(request, db, viewer);
    const exchangeMatch = path.match(/^\/api\/conversations\/([^/]+)\/contact-exchange$/);
    if (exchangeMatch) return await handleContactExchange(request, db, id(decodeURIComponent(exchangeMatch[1])), requireViewer(viewer));
    let conversationMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMatch) {
      const conversationId = id(decodeURIComponent(conversationMatch[1])), userId = requireViewer(viewer);
      if (method === 'GET') return await readConversationMessages(db, conversationId, userId);
      if (method === 'POST') return await sendConversationMessage(request, db, conversationId, userId);
    }
    if (path === '/api/products') {
      if (method === 'GET') return await listProducts(db, url.searchParams, viewer);
      if (method === 'POST') return await createProduct(request, db, viewer);
    }
    if (path === '/api/me/products' && method === 'GET') {
      const userId = requireViewer(viewer);
      return json({ items: await selectedDtos(db, 'SELECT * FROM products WHERE owner_id = ? ORDER BY created_at DESC, id DESC', [userId], viewer) });
    }
    if (path === '/api/me/favorites' && method === 'GET') {
      const userId = requireViewer(viewer);
      return json({ items: await selectedDtos(db, "SELECT p.* FROM products p JOIN favorites f ON f.product_id = p.id WHERE f.user_id = ? AND ((p.status = 'active' AND p.sold_at IS NULL AND p.deleted_at IS NULL) OR p.owner_id = ?) ORDER BY f.created_at DESC, p.id DESC", [userId, userId], viewer) });
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
        if (row.is_demo) fail(409, 'DEMO_PRODUCT', '这是虚构的示例商品，没有真实卖家或联系方式。');
        if (row.owner_id !== viewer.userId) fail(403, 'CONTACT_CONSENT_REQUIRED', '联系方式不直接公开，请先通过站内私信沟通。');
        const contact = await first(db, 'SELECT type, value FROM private_contacts WHERE product_id = ?', [productId]);
        return json(contact || { type: 'wechat', value: '' });
      }
      if (!match[2] && method === 'GET') {
        const row = await productRow(db, productId);
        if (!visible(row, viewer)) fail(404, 'NOT_FOUND', '商品不存在或已下架。');
        return json({ product: await dto(db, row, viewer) });
      }
      if (!match[2] && method === 'PATCH') return await updateProduct(request, db, productId, viewer);
      if (!match[2] && method === 'DELETE') return await deleteProduct(db, productId, viewer);
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
