import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../gmail-apps-script/Code.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../gmail-apps-script/appsscript.json', import.meta.url), 'utf8'));
const SECRET = 'unit_test_only_' + 'g'.repeat(40);
const EMAIL = 'example.student23@student.xjtlu.edu.cn';
const PREFIX = 'juzi_mail_r_';
const canonical = body => ['juzi-gmail-v1', body.requestId, body.email, body.code, String(body.issuedAt)].join('\n');
const sign = body => ({ ...body, signature: createHmac('sha256', SECRET).update(canonical(body)).digest('hex') });
const request = (body, overrides = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { contentLength: Buffer.byteLength(text), postData: { type: 'application/json', contents: text }, ...overrides };
};

function fixture(options = {}) {
  let seconds = 1792320000;
  let held = false;
  let writes = 0;
  let quotaCalls = 0;
  let releases = 0;
  const calls = [];
  const store = new Map(Object.entries({ ENABLED: 'true', JUZI_GMAIL_SCRIPT_SECRET: SECRET, ...options.properties }));
  const properties = {
    getProperty(key) { if (options.readError) throw Error('private provider detail'); return store.get(key) ?? null; },
    getProperties() { if (options.ledgerReadError) throw Error('private storage detail'); return Object.fromEntries(store); },
    setProperty(key, value) {
      writes++;
      if (options.failWrite?.(writes, key, value)) throw Error('private write detail');
      store.set(key, value);
    },
    deleteProperty(key) { store.delete(key); },
  };
  const context = createContext({
    Date: { now: () => seconds * 1000 },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      computeHmacSha256Signature(value, key, charset) {
        assert.equal(charset, 'UTF-8');
        return [...createHmac('sha256', key).update(value).digest()].map(byte => byte > 127 ? byte - 256 : byte);
      },
    },
    PropertiesService: { getScriptProperties: () => properties },
    LockService: {
      getScriptLock: () => {
        let owned = false;
        return {
          tryLock(timeout) { assert.equal(timeout, 1000); if (held || options.busy) return false; held = true; owned = true; return true; },
          hasLock: () => owned,
          releaseLock() { assert.equal(owned, true); held = false; owned = false; releases++; },
        };
      },
    },
    MailApp: {
      getRemainingDailyQuota() {
        quotaCalls++;
        if (options.quotaError) throw Error('private quota detail');
        return options.quota ?? 100;
      },
      sendEmail(message) {
        calls.push(JSON.parse(JSON.stringify(message)));
        options.send?.(message);
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType(type) { this.type = type; return this; } }),
    },
  });
  runInContext(source, context, { filename: 'Code.gs' });
  return {
    calls, store, context,
    get quotaCalls() { return quotaCalls; },
    get releases() { return releases; },
    get now() { return seconds; },
    advance(value) { seconds += value; },
    body(overrides = {}) { return sign({ version: 1, requestId: randomUUID(), email: EMAIL, code: '614289', issuedAt: seconds, ...overrides }); },
    post(body, event) { const output = context.doPost(event ?? request(body)); assert.equal(output.type, 'application/json'); return JSON.parse(output.text); },
    records() { return [...store].filter(([key]) => key.startsWith(PREFIX)).map(([key, value]) => [key, JSON.parse(value)]); },
  };
}

test('Apps Script manifest requests only send-mail permission and health is read-only', () => {
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.send_mail']);
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.exceptionLogging, 'NONE');
  const f = fixture({ readError: true });
  assert.deepEqual(JSON.parse(f.context.doGet().text), { ok: true, service: 'juzi-gmail' });
  assert.equal(f.quotaCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.authorizeMailbox(), 100);
  assert.equal(f.quotaCalls, 1);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(source, /GmailApp|Session\.|Logger\.|console\.|UrlFetchApp/);
});

test('Apps Script sends fixed plain-text school OTP and persists only keyed hashes', () => {
  const f = fixture(), body = f.body();
  assert.deepEqual(f.post(body), { ok: true, id: body.requestId });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['body', 'name', 'subject', 'to']);
  assert.equal(f.calls[0].to, EMAIL);
  assert.equal(f.calls[0].name, '橘子集');
  assert.match(f.calls[0].body, /614289/);
  assert.match(f.calls[0].body, /10 分钟/);
  const [[key, entry]] = f.records();
  assert.equal(key, PREFIX + body.requestId);
  assert.equal(entry.state, 'sent');
  assert.match(entry.recipient, /^[a-f0-9]{64}$/);
  assert.match(entry.content, /^[a-f0-9]{64}$/);
  const persisted = JSON.stringify(entry);
  for (const privateValue of [EMAIL, body.code, SECRET, body.signature]) assert.equal(persisted.includes(privateValue), false);
  assert.equal(f.releases, 1);
});

test('Apps Script validates exact signed schema, domain, MIME, body length and no query credentials', () => {
  const f = fixture();
  for (const overrides of [
    { version: 2 }, { extra: 'arbitrary content' }, { code: '12345' }, { code: 123456 },
    { email: 'attacker@example.com' }, { email: 'Upper@student.xjtlu.edu.cn' },
    { email: ' person@student.xjtlu.edu.cn' }, { email: 'person@student.xjtlu.edu.cn.attacker.com' },
    { email: '.person@student.xjtlu.edu.cn' }, { email: 'person.@student.xjtlu.edu.cn' },
    { email: 'per..son@student.xjtlu.edu.cn' }, { email: 'a'.repeat(65) + '@student.xjtlu.edu.cn' },
    { requestId: 'not-a-uuid' }, { requestId: randomUUID().toUpperCase() },
    { issuedAt: '1792320000' }, { issuedAt: 1.5 }, { issuedAt: -1 },
  ]) assert.deepEqual(f.post(f.body(overrides)), { ok: false, error: 'invalid_request' });
  const body = f.body();
  for (const event of [
    undefined, {}, request('{'), request('null'), request('[]'),
    request(body, { contentLength: 2049 }), request(body, { contentLength: -1 }),
    request(' '.repeat(2049)), request(body, { contentLength: '100' }),
    request(body, { postData: { type: 'text/plain', contents: JSON.stringify(body) } }),
    request(body, { queryString: 'secret=unsafe' }),
  ]) assert.deepEqual(JSON.parse(f.context.doPost(event).text), { ok: false, error: 'invalid_request' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.records().length, 0);
  assert.equal(f.quotaCalls, 0);
  assert.deepEqual(f.post(body, request(body, { postData: { type: 'application/json; charset=UTF-8', contents: JSON.stringify(body) } })), { ok: true, id: body.requestId });
});

test('Apps Script rejects invalid signatures and stale or future timestamps without mutation', () => {
  const f = fixture();
  const good = f.body();
  for (const signature of ['a'.repeat(64), good.signature.slice(0, 63) + (good.signature.endsWith('0') ? '1' : '0')]) {
    assert.deepEqual(f.post({ ...good, signature }), { ok: false, error: 'unauthorized' });
  }
  assert.deepEqual(f.post({ ...good, signature: good.signature.toUpperCase() }), { ok: false, error: 'invalid_request' });
  for (const issuedAt of [f.now - 301, f.now + 31]) assert.deepEqual(f.post(f.body({ issuedAt })), { ok: false, error: 'stale_request' });
  assert.equal(f.records().length, 0);
  assert.equal(f.quotaCalls, 0);
  assert.equal(f.releases, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.post(f.body({ issuedAt: f.now - 300 })), { ok: true, id: f.records()[0][0].slice(PREFIX.length) });
});

test('Apps Script successful replay is idempotent across timestamps and quota exhaustion', () => {
  const f = fixture({ properties: { JUZI_GMAIL_DAILY_LIMIT: '1' } }), body = f.body();
  assert.deepEqual(f.post(body), { ok: true, id: body.requestId });
  f.advance(61);
  assert.deepEqual(f.post(sign({ ...body, issuedAt: f.now })), { ok: true, id: body.requestId });
  assert.deepEqual(f.post(f.body({ email: 'other@student.xjtlu.edu.cn' })), { ok: false, error: 'daily_limit' });
  assert.deepEqual(f.post(sign({ ...body, code: '123456', issuedAt: f.now })), { ok: false, error: 'invalid_request' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.quotaCalls, 1);
});

test('Apps Script reserves before delivery and treats transport errors as unknown without resend', () => {
  let f;
  f = fixture({ send() {
    assert.equal(f.records()[0][1].state, 'pending');
    assert.deepEqual(f.post(f.body()), { ok: false, error: 'busy' });
    throw Error('simulated provider timeout with private address and code');
  } });
  const body = f.body();
  assert.deepEqual(f.post(body), { ok: false, error: 'delivery_unknown' });
  assert.equal(f.records()[0][1].state, 'unknown');
  assert.deepEqual(f.post(body), { ok: false, error: 'delivery_unknown' });
  assert.equal(f.calls.length, 1);
  // A process killed during MailApp.sendEmail leaves pending: also non-retriable.
  const [key, entry] = f.records()[0];
  f.store.set(key, JSON.stringify({ ...entry, state: 'pending' }));
  assert.deepEqual(f.post(body), { ok: false, error: 'delivery_unknown' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.releases, 3);
});

test('Apps Script storage failures fail closed before send and preserve uncertain delivery reservation', () => {
  const reservationFailure = fixture({ failWrite: () => true });
  assert.deepEqual(reservationFailure.post(reservationFailure.body()), { ok: false, error: 'storage_unavailable' });
  assert.equal(reservationFailure.calls.length, 0);
  const confirmationFailure = fixture({ failWrite: count => count >= 2 }), body = confirmationFailure.body();
  assert.deepEqual(confirmationFailure.post(body), { ok: false, error: 'delivery_unknown' });
  assert.equal(confirmationFailure.records()[0][1].state, 'pending');
  assert.deepEqual(confirmationFailure.post(body), { ok: false, error: 'delivery_unknown' });
  assert.equal(confirmationFailure.calls.length, 1);
  const readFailure = fixture({ ledgerReadError: true });
  assert.deepEqual(readFailure.post(readFailure.body()), { ok: false, error: 'provider_unavailable' });
  assert.equal(readFailure.calls.length, 0);
});

test('Apps Script recipient limits and rolling daily limits include failed delivery attempts', () => {
  const f = fixture();
  const first = f.body();
  assert.equal(f.post(first).ok, true);
  f.advance(59);
  assert.deepEqual(f.post(f.body()), { ok: false, error: 'recipient_rate_limited' });
  f.advance(1);
  for (let i = 1; i < 10; i++) { assert.equal(f.post(f.body()).ok, true); f.advance(60); }
  assert.deepEqual(f.post(f.body()), { ok: false, error: 'recipient_daily_limit' });
  f.advance(86400);
  assert.equal(f.post(f.body()).ok, true);
  const failed = fixture({ properties: { JUZI_GMAIL_DAILY_LIMIT: '1' }, send: () => { throw Error('timeout'); } });
  assert.deepEqual(failed.post(failed.body()), { ok: false, error: 'delivery_unknown' });
  assert.deepEqual(failed.post(failed.body({ email: 'other@student.xjtlu.edu.cn' })), { ok: false, error: 'daily_limit' });
  failed.advance(86400);
  assert.deepEqual(failed.post(failed.body({ email: 'other@student.xjtlu.edu.cn' })), { ok: false, error: 'delivery_unknown' });
  assert.equal(failed.calls.length, 2);
});

test('Apps Script validates private configuration, disabled switch, mail quota and bounded lock', () => {
  for (const properties of [
    { ENABLED: 'false' }, { ENABLED: '' },
    { JUZI_GMAIL_SCRIPT_SECRET: 'short' }, { JUZI_GMAIL_SCRIPT_SECRET: SECRET + '\n' },
    { JUZI_GMAIL_DAILY_LIMIT: '0' }, { JUZI_GMAIL_DAILY_LIMIT: '101' }, { JUZI_GMAIL_DAILY_LIMIT: '1.5' },
    { JUZI_GMAIL_DAILY_LIMIT: ' 50' }, { JUZI_GMAIL_DAILY_LIMIT: '050' },
  ]) {
    const f = fixture({ properties });
    assert.deepEqual(f.post(f.body()), { ok: false, error: 'ENABLED' in properties ? 'disabled' : 'configuration' });
    assert.equal(f.calls.length, 0); assert.equal(f.records().length, 0);
  }
  for (const options of [{ quota: 0 }, { quota: -1 }, { quota: 1.5 }, { quotaError: true }, { busy: true }]) {
    const f = fixture(options);
    assert.deepEqual(f.post(f.body()), { ok: false, error: options.busy ? 'busy' : options.quotaError ? 'provider_unavailable' : 'daily_limit' });
    assert.equal(f.calls.length, 0); assert.equal(f.records().length, 0);
  }
});

test('Apps Script cleans expired ledger records and rejects corrupted or overfull ledgers', () => {
  const f = fixture();
  f.post(f.body());
  f.advance(172800);
  assert.equal(f.post(f.body()).ok, true);
  assert.equal(f.records().length, 1);
  const corrupted = fixture();
  corrupted.store.set(PREFIX + randomUUID(), '{');
  assert.deepEqual(corrupted.post(corrupted.body()), { ok: false, error: 'storage_unavailable' });
  assert.equal(corrupted.calls.length, 0);
  const full = fixture();
  for (let i = 0; i < 220; i++) full.store.set(PREFIX + randomUUID(), JSON.stringify({ v: 1, at: full.now - 90000, recipient: 'a'.repeat(64), content: 'b'.repeat(64), state: 'sent' }));
  assert.deepEqual(full.post(full.body()), { ok: false, error: 'storage_full' });
  full.store.set(PREFIX + randomUUID(), '{}');
  assert.deepEqual(full.post(full.body()), { ok: false, error: 'storage_unavailable' });
  assert.equal(full.calls.length, 0);
});
