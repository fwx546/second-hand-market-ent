import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareGmailMail } from '../scripts/setup-gmail-mail.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gmail-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const read = (root, file) => parseEnv(readFileSync(join(root, file), 'utf8'));
const endpoint = 'https://script.google.com/macros/s/fixture_deployment_id_123456789/exec';

test('Gmail preparation preserves a working sender, secrets and unrelated local configuration', t => {
  const root = fixture(t), original = 'JUZI_EMAIL_PROVIDER=qq_relay\nJUZI_EMAIL_ENABLED=true\n# keep\n';
  writeFileSync(join(root, '.env.local'), original);
  prepareGmailMail({ root, sender: 'fixture.sender@gmail.com' });
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), original);
  const prepared = read(root, 'gmail-apps-script/.env.local');
  assert.equal(prepared.ENABLED, 'false');
  assert.equal(prepared.JUZI_GMAIL_DAILY_LIMIT, '50');
  assert.match(prepared.JUZI_GMAIL_SCRIPT_SECRET, /^[0-9a-f]{64}$/);
  prepareGmailMail({ root });
  assert.equal(read(root, 'gmail-apps-script/.env.local').JUZI_GMAIL_SCRIPT_SECRET, prepared.JUZI_GMAIL_SCRIPT_SECRET);
  assert.throws(() => prepareGmailMail({ root, enable: true }), /部署/);
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), original);
});

test('Gmail local activation preserves the account secret and fallback and refuses secret/account conflicts', t => {
  const root = fixture(t), authSecret = 'existing-auth-secret-0123456789abcdef';
  writeFileSync(join(root, '.env.local'), `JUZI_EMAIL_AUTH_SECRET=${authSecret}\nJUZI_EMAIL_RELAY_TOKEN=fallback-keep\n`);
  prepareGmailMail({ root, sender: 'fixture.sender@gmail.com', url: endpoint, enable: true });
  const app = read(root, '.env.local'), script = read(root, 'gmail-apps-script/.env.local');
  assert.equal(app.JUZI_EMAIL_PROVIDER, 'gmail_apps_script');
  assert.equal(app.JUZI_EMAIL_ENABLED, 'true');
  assert.equal(app.JUZI_EMAIL_AUTH_SECRET, authSecret);
  assert.equal(app.JUZI_EMAIL_RELAY_TOKEN, 'fallback-keep');
  assert.equal(app.JUZI_GMAIL_SCRIPT_SECRET, script.JUZI_GMAIL_SCRIPT_SECRET);
  assert.notEqual(app.JUZI_EMAIL_AUTH_SECRET, app.JUZI_GMAIL_SCRIPT_SECRET);
  assert.throws(() => prepareGmailMail({ root, sender: 'other.fixture@gmail.com' }), /发件账号/);
  writeFileSync(join(root, '.env.local'), `JUZI_GMAIL_SCRIPT_SECRET=${'x'.repeat(64)}\n`);
  const original = readFileSync(join(root, 'gmail-apps-script/.env.local'), 'utf8');
  assert.throws(() => prepareGmailMail({ root }), /不一致/);
  assert.equal(readFileSync(join(root, 'gmail-apps-script/.env.local'), 'utf8'), original);
});

test('Gmail setup rejects URL redirects, production origin and overriding dev vars before writing', t => {
  const root = fixture(t);
  for (const url of [endpoint + '?secret=value', endpoint.replace('/exec', '/dev'), endpoint.replace('script.google.com', 'evil.invalid'), 'http://localhost:4174/exec']) {
    assert.throws(() => prepareGmailMail({ root, sender: 'fixture.sender@gmail.com', url }), /部署/);
  }
  writeFileSync(join(root, '.env.local'), 'JUZI_EMAIL_ORIGIN=https://site.invalid\n');
  assert.throws(() => prepareGmailMail({ root, sender: 'fixture.sender@gmail.com', url: endpoint, enable: true }), /本地/);
  assert.equal(read(root, '.env.local').JUZI_EMAIL_ORIGIN, 'https://site.invalid');
  writeFileSync(join(root, '.env.local'), '');
  writeFileSync(join(root, '.dev.vars'), 'UNCHANGED=true\n');
  assert.throws(() => prepareGmailMail({ root, sender: 'fixture.sender@gmail.com', url: endpoint, enable: true }), /覆盖/);
});
