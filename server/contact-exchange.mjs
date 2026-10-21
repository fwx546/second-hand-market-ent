const DAY = 86400000;
const TYPES = ['wechat', 'phone', 'qq'];
class ExchangeError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new ExchangeError(status, code, message); };
const stmt = (db, sql, values = []) => db.prepare(sql).bind(...values);
const first = (db, sql, values = []) => stmt(db, sql, values).first();
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function contactExchangeReady(db) {
  return Boolean(await first(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_exchanges'"));
}
function contact(body) {
  if (body.consent !== true) fail(400, 'CONSENT_REQUIRED', '请明确同意本次交换后再提交。');
  if (!TYPES.includes(body.type) || typeof body.value !== 'string') fail(400, 'INVALID_CONTACT', '请选择联系方式并填写正确内容。');
  const value = body.value.trim();
  if (value.length < 3 || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value) ||
      body.type === 'phone' && !/^1[3-9]\d{9}$/.test(value) || body.type === 'qq' && !/^[1-9]\d{4,11}$/.test(value)) {
    fail(400, 'INVALID_CONTACT', '请填写有效联系方式：微信 3–80 字符、QQ 5–12 位数字、手机号 11 位。');
  }
  return { type: body.type, value };
}
function publicExchange(row, userId, now) {
  if (!row) return null;
  const status = row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status;
  const outgoing = row.requester_id === userId;
  const value = { id: row.id, status, direction: outgoing ? 'outgoing' : 'incoming', offeredType: row.requester_type, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
  // No number is returned at all for pending/declined/cancelled/expired/revoked states.
  if (status === 'accepted') {
    const requester = { type: row.requester_type, value: row.requester_value };
    const responder = { type: row.responder_type, value: row.responder_value };
    value.contacts = { mine: outgoing ? requester : responder, other: outgoing ? responder : requester };
  }
  return value;
}
async function state(db, conversationId, userId, now) {
  const row = await first(db, 'SELECT * FROM contact_exchanges WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [conversationId]);
  return { enabled: true, exchange: publicExchange(row, userId, now) };
}
async function payload(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'JSON_REQUIRED', '请提交 JSON。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_REQUEST', '申请内容为空。');
  let size = 0; const parts = [];
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096) fail(413, 'REQUEST_TOO_LARGE', '申请内容过长。');
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let result;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    result = JSON.parse(new TextDecoder().decode(bytes));
  } catch { fail(400, 'INVALID_REQUEST', '申请格式不正确。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'INVALID_REQUEST', '申请格式不正确。');
  return result;
}

// Caller has already checked school-email identity and same-Origin for writes.
export async function handleContactExchange(request, db, conversationId, userId) {
  try {
    const conversation = await first(db, 'SELECT id FROM conversations WHERE id=? AND (buyer_id=? OR seller_id=?)', [conversationId, userId, userId]);
    if (!conversation) fail(404, 'NOT_FOUND', '对话不存在或你无权访问。');
    const enabled = await contactExchangeReady(db);
    if (request.method === 'GET') return json(enabled ? await state(db, conversationId, userId, Date.now()) : { enabled: false, exchange: null });
    if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '不支持此操作。');
    if (!enabled) fail(503, 'CONTACT_EXCHANGE_PENDING', '交换联系方式暂未开通，仍可正常私信。');
    const body = await payload(request), now = Date.now();
    const sharing = body.action === 'request' || body.action === 'accept';
    const keys = ['action', ...(body.action !== 'request' ? ['requestId'] : []), ...(sharing ? ['type', 'value', 'consent'] : [])];
    if (!['request', 'accept', 'decline', 'cancel', 'revoke'].includes(body.action) || Object.keys(body).some(key => !keys.includes(key))) fail(400, 'INVALID_ACTION', '申请操作不正确。');
    if (body.action === 'request') {
      const offered = contact(body), exchangeId = `exchange_${crypto.randomUUID()}`;
      const results = await db.batch([
        stmt(db, "UPDATE contact_exchanges SET status='expired', requester_value='', responder_value=NULL, updated_at=? WHERE conversation_id=? AND status='pending' AND expires_at<=?", [now, conversationId, now]),
        stmt(db, `INSERT INTO contact_exchanges (id,conversation_id,requester_id,requester_type,requester_value,status,created_at,updated_at,expires_at)
          SELECT ?,?,?,?,?,'pending',?,?,?
          WHERE NOT EXISTS (SELECT 1 FROM contact_exchanges WHERE conversation_id=? AND status IN ('pending','accepted'))
          AND NOT EXISTS (SELECT 1 FROM contact_exchanges WHERE conversation_id=? AND status IN ('declined','revoked') AND updated_at>?)
          AND (SELECT count(*) FROM contact_exchanges WHERE requester_id=? AND created_at>?)<5
          AND (SELECT count(*) FROM contact_exchanges WHERE conversation_id=? AND created_at>?)<3`,
        [exchangeId, conversationId, userId, offered.type, offered.value, now, now, now + 7 * DAY, conversationId, conversationId, now - DAY, userId, now - DAY, conversationId, now - DAY]),
      ]);
      if (!results[1].meta?.changes) {
        const active = await first(db, "SELECT id FROM contact_exchanges WHERE conversation_id=? AND status IN ('pending','accepted')", [conversationId]);
        if (active) fail(409, 'EXCHANGE_ACTIVE', '已有待处理或已同意的交换，请刷新对话。');
        fail(429, 'EXCHANGE_RATE_LIMIT', '申请暂不可发送，请勿频繁申请；对方拒绝或停止共享后请等待 24 小时。');
      }
      return json(await state(db, conversationId, userId, now), 201);
    }
    if (typeof body.requestId !== 'string' || !/^exchange_[A-Za-z0-9-]{1,100}$/.test(body.requestId)) fail(400, 'INVALID_REQUEST', '申请编号无效。');
    const where = 'id=? AND conversation_id=?', args = [body.requestId, conversationId];
    let result;
    if (body.action === 'accept') {
      const reply = contact(body);
      result = await stmt(db, `UPDATE contact_exchanges SET status='accepted', responder_type=?, responder_value=?, updated_at=? WHERE ${where} AND status='pending' AND requester_id<>? AND expires_at>?`, [reply.type, reply.value, now, ...args, userId, now]).run();
    } else {
      const status = { decline: 'declined', cancel: 'cancelled', revoke: 'revoked' }[body.action];
      const guard = body.action === 'decline' ? "status='pending' AND requester_id<>? AND expires_at>?" : body.action === 'cancel' ? "status='pending' AND requester_id=? AND expires_at>?" : "status='accepted'";
      result = await stmt(db, `UPDATE contact_exchanges SET status=?, requester_value='', responder_value=NULL, updated_at=? WHERE ${where} AND ${guard}`, [status, now, ...args, ...(body.action === 'revoke' ? [] : [userId, now])]).run();
    }
    if (!result.meta?.changes) fail(409, 'EXCHANGE_STATE_CHANGED', '申请状态已变化、已过期或你不能执行此操作，请刷新后重试。');
    return json(await state(db, conversationId, userId, now));
  } catch (error) {
    if (error instanceof ExchangeError) return json({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  }
}
