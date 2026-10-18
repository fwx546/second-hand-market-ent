/**
 * 橘子集 school-email delivery endpoint for Google Apps Script V8.
 * Copy this file into Code.gs. Keep the shared secret in Script Properties,
 * never in this file. Only the website server signs requests to this endpoint.
 * MailApp uses the deploying account and requires sending permission only.
 */
var JUZI_MAIL_LEDGER_PREFIX = 'juzi_mail_r_';
var JUZI_MAIL_DAY_SECONDS = 86400;
var JUZI_MAIL_RETENTION_SECONDS = 172800;
var JUZI_MAIL_MAX_RECORDS = 220;

function doGet() {
  // Public health checks neither inspect private settings nor consume mail quota.
  return juziMailJson_({ ok: true, service: 'juzi-gmail' });
}

function authorizeMailbox() {
  // Run once as the owner to authorize MailApp. This function sends no email.
  // Do not expose the remaining quota in the public health endpoint.
  return MailApp.getRemainingDailyQuota();
}

function doPost(event) {
  var lock;
  try {
    var properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('ENABLED') !== 'true') return juziMailError_('disabled');
    var secret = properties.getProperty('JUZI_GMAIL_SCRIPT_SECRET');
    var limitText = properties.getProperty('JUZI_GMAIL_DAILY_LIMIT');
    var limit = limitText === null || limitText === '' ? 50 : Number(limitText);
    if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(secret) ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (limitText !== null && limitText !== '' && !/^[1-9][0-9]{0,2}$/.test(limitText))) {
      return juziMailError_('configuration');
    }

    var input = juziMailRequest_(event);
    if (!input) return juziMailError_('invalid_request');
    var signed = ['juzi-gmail-v1', input.requestId, input.email, input.code, String(input.issuedAt)].join('\n');
    if (!juziMailEqual_(input.signature, juziMailHmac_(signed, secret))) return juziMailError_('unauthorized');
    var now = Math.floor(Date.now() / 1000);
    if (input.issuedAt < now - 300 || input.issuedAt > now + 30) return juziMailError_('stale_request');

    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return juziMailError_('busy');
    // Recheck the operational switch while holding the lock.
    if (properties.getProperty('ENABLED') !== 'true') return juziMailError_('disabled');
    var records = juziMailReadLedger_(properties, now);
    if (!records) return juziMailError_('storage_unavailable');
    var key = JUZI_MAIL_LEDGER_PREFIX + input.requestId;
    var content = juziMailHmac_(['juzi-gmail-content-v1', input.requestId, input.email, input.code].join('\n'), secret);
    var recipient = juziMailHmac_('juzi-gmail-recipient-v1\n' + input.email, secret);
    var previous = records.filter(function (item) { return item.key === key; })[0];
    if (previous) {
      if (!juziMailEqual_(previous.value.content, content)) return juziMailError_('invalid_request');
      // A timed-out execution may have delivered its email. Never send it again.
      return previous.value.state === 'sent' ? juziMailJson_({ ok: true, id: input.requestId }) : juziMailError_('delivery_unknown');
    }
    if (records.length >= JUZI_MAIL_MAX_RECORDS) return juziMailError_('storage_full');
    var recent = records.filter(function (item) { return item.value.at > now - JUZI_MAIL_DAY_SECONDS; });
    if (recent.length >= limit) return juziMailError_('daily_limit');
    var recipientRecords = recent.filter(function (item) { return juziMailEqual_(item.value.recipient, recipient); });
    if (recipientRecords.some(function (item) { return item.value.at > now - 60; })) return juziMailError_('recipient_rate_limited');
    if (recipientRecords.length >= 10) return juziMailError_('recipient_daily_limit');
    var quota;
    try { quota = MailApp.getRemainingDailyQuota(); } catch (_) { return juziMailError_('provider_unavailable'); }
    if (!Number.isInteger(quota) || quota < 1) return juziMailError_('daily_limit');
    var reservation = { v: 1, at: now, recipient: recipient, content: content, state: 'pending' };
    // A durable reservation precedes every send. All outcomes consume our limit.
    try { properties.setProperty(key, JSON.stringify(reservation)); }
    catch (_) { return juziMailError_('storage_unavailable'); }
    try {
      MailApp.sendEmail({
        to: input.email,
        subject: '橘子集 · 学校邮箱登录验证码',
        body: '你的橘子集登录验证码为：' + input.code + '\n\n验证码 10 分钟内有效，请勿向他人透露。\n如果不是你本人操作，请忽略本邮件。\n\n橘子集 · 西交利物浦大学校园二手交易平台\n本次验证仅确认学校邮箱使用权。',
        name: '橘子集'
      });
      reservation.state = 'sent';
      properties.setProperty(key, JSON.stringify(reservation));
      return juziMailJson_({ ok: true, id: input.requestId });
    } catch (_) {
      reservation.state = 'unknown';
      // A failure to save this state leaves the existing pending reservation,
      // which is equally non-retriable. Never expose provider error messages.
      try { properties.setProperty(key, JSON.stringify(reservation)); } catch (_) {}
      return juziMailError_('delivery_unknown');
    }
  } catch (_) {
    return juziMailError_('provider_unavailable');
  } finally {
    try { if (lock && lock.hasLock()) lock.releaseLock(); } catch (_) {}
  }
}

function juziMailRequest_(event) {
  if (!event || !event.postData || typeof event.postData.contents !== 'string' ||
      event.postData.contents.length > 2048 || !Number.isInteger(event.contentLength) ||
      event.contentLength < 1 || event.contentLength > 2048 ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(event.postData.type || '') ||
      (event.queryString !== undefined && event.queryString !== null && event.queryString !== '')) return null;
  var input;
  try { input = JSON.parse(event.postData.contents); } catch (_) { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'code,email,issuedAt,requestId,signature,version' ||
      input.version !== 1 || typeof input.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId) ||
      typeof input.email !== 'string' || input.email.length > 254 ||
      !/^[a-z0-9._%+-]{1,64}@student\.xjtlu\.edu\.cn$/.test(input.email) ||
      input.email[0] === '.' || input.email.split('@')[0].slice(-1) === '.' || input.email.split('@')[0].indexOf('..') >= 0 ||
      typeof input.code !== 'string' || !/^[0-9]{6}$/.test(input.code) ||
      !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0 ||
      typeof input.signature !== 'string' || !/^[0-9a-f]{64}$/.test(input.signature)) return null;
  return input;
}

function juziMailReadLedger_(properties, now) {
  var all = properties.getProperties();
  var records = [];
  var keys = Object.keys(all).filter(function (key) { return key.indexOf(JUZI_MAIL_LEDGER_PREFIX) === 0; });
  // Fail closed on an unexpectedly large store rather than expanding unbounded.
  if (keys.length > JUZI_MAIL_MAX_RECORDS) return null;
  for (var i = 0; i < keys.length; i++) {
    var value;
    try { value = JSON.parse(all[keys[i]]); } catch (_) { return null; }
    if (!value || Object.keys(value).sort().join(',') !== 'at,content,recipient,state,v' || value.v !== 1 ||
        !Number.isSafeInteger(value.at) || value.at < 0 || value.at > now + 30 ||
        typeof value.recipient !== 'string' || !/^[0-9a-f]{64}$/.test(value.recipient) ||
        typeof value.content !== 'string' || !/^[0-9a-f]{64}$/.test(value.content) ||
        ['pending', 'sent', 'unknown'].indexOf(value.state) < 0) return null;
    if (value.at <= now - JUZI_MAIL_RETENTION_SECONDS) properties.deleteProperty(keys[i]);
    else records.push({ key: keys[i], value: value });
  }
  return records;
}

function juziMailHmac_(value, secret) {
  return Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8).map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
}

function juziMailEqual_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function juziMailJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function juziMailError_(error) {
  return juziMailJson_({ ok: false, error: error });
}
