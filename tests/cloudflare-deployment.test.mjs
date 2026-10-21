import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloudflare } from '../scripts/build-cloudflare.mjs';
import { configureCloudflare, parseCloudflareArguments } from '../scripts/configure-cloudflare.mjs';
import { cloudflareSchema, CLOUDFLARE_TABLES, generateCloudflareSchema } from '../scripts/generate-cloudflare-schema.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VALID = { accountId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', databaseId: 'd1404ab1-c14a-4d32-9def-ef6829356a0e', supabaseUrl: 'https://testonlyprojectref001.supabase.co' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'juzi-cloudflare-deployment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['cloudflare', 'public/assets', 'legacy', '.openai']) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, '.openai/hosting.json'), '{"project_id":"ORIGINAL_SITE_MUST_STAY"}\n');
  await writeFile(join(root, 'cloudflare/wrangler.example.json'), await readFile(join(ROOT, 'cloudflare/wrangler.example.json')));
  await writeFile(join(root, 'legacy/index.html'), '<!doctype html><html>Campus</html>');
  await writeFile(join(root, 'public/app.js'), 'document.body.dataset.ready="true";');
  await writeFile(join(root, 'public/styles.css'), 'body { color: brown; }');
  await writeFile(join(root, 'public/assets/photo.png'), new Uint8Array([137, 80, 78, 71]));
  await writeFile(join(root, 'public/assets/SOURCES.md'), 'Photo attribution');
  return root;
}

test('schema snapshot exactly matches all migrations and contains only empty business tables', async () => {
  const actual = await readFile(join(ROOT, 'cloudflare/migrations/0001_schema.sql'), 'utf8');
  assert.equal(actual.replace(/\r\n?/g, '\n'), await cloudflareSchema({ root: ROOT, maxMigration: 8 }));
  assert(!/^\s*(?:INSERT|UPDATE|DELETE)\s|demo_juzi_|juzi_demo_catalog/m.test(actual));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON'); db.exec(actual);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, [...CLOUDFLARE_TABLES].sort());
    assert.equal(tables.length, 12);
    for (const table of tables) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n, 0);
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
        assert(tables.includes(fk.table), `${table} references missing ${fk.table}`);
        assert(db.prepare(`PRAGMA table_info("${fk.table}")`).all().some(column => column.name === fk.to));
      }
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const column of ['campus', 'publish_seller', 'publish_contact_type', 'publish_contact_value', 'language', 'phone', 'wechat', 'qq']) {
      assert(db.prepare('PRAGMA table_info(users)').all().some(row => row.name === column), column);
    }
    assert.throws(() => db.prepare('INSERT INTO messages (id,conversation_id,sender_id,body,created_at) VALUES (?,?,?,?,?)').run('m', 'missing-conversation', 'missing-user', 'message', 1), /FOREIGN KEY/);
    db.prepare('INSERT INTO users (id,created_at) VALUES (?,?)').run('u', 1);
    const statement = db.prepare('INSERT INTO products (id,owner_id,title,category,price_cents,original_price_cents,condition,campus,location,description,specs_json,graduation,seller,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const values = ['p', 'u', 'Test', 'appliance', 100, 100, '轻微使用痕迹', 'SIP 校区', 'Library', 'Description', '{}', 0, 'Seller', 'active', 1, 1];
    statement.run(...values);
    assert.throws(() => statement.run(...values.map((value, index) => index === 0 ? 'bad-condition' : index === 6 ? '九成新' : value)), /CHECK/);
  } finally { db.close(); }
});

test('schema generator checks immutable output without rewriting it', async () => {
  const result = await generateCloudflareSchema({ root: ROOT, check: true });
  assert.equal(result.schemaOnly, true); assert.equal(result.tables, 12); assert.equal(result.matches, true);
});

test('LF, CRLF and mixed migration checkouts produce the same schema without rewriting applied history', async t => {
  const files = (await readdir(join(ROOT, 'drizzle'))).filter(file => /^\d+_[A-Za-z0-9_]+\.sql$/.test(file) && Number(file.split('_')[0]) <= 8).sort();
  const expected = await cloudflareSchema({ root: ROOT, maxMigration: 8 });
  const appliedBefore = await readFile(join(ROOT, 'cloudflare/migrations/0001_schema.sql'));
  for (const style of ['lf', 'crlf', 'mixed']) {
    const root = await fixture(t);
    await mkdir(join(root, 'drizzle'));
    await mkdir(join(root, 'cloudflare/migrations'));
    for (let index = 0; index < files.length; index++) {
      const sql = (await readFile(join(ROOT, 'drizzle', files[index]), 'utf8')).replace(/\r\n?/g, '\n');
      await writeFile(join(root, 'drizzle', files[index]), style === 'crlf' || style === 'mixed' && index % 2 ? sql.replace(/\n/g, '\r\n') : sql);
    }
    assert.equal(await cloudflareSchema({ root }), expected);
    assert(!expected.includes('\r'));
    const snapshot = join(root, 'cloudflare/migrations/0001_schema.sql');
    const initialBytes = Buffer.from(style === 'crlf' ? expected.replace(/\n/g, '\r\n') : expected);
    await writeFile(snapshot, initialBytes);
    assert.equal((await generateCloudflareSchema({ root, check: true })).matches, true);
    assert.deepEqual(await readFile(snapshot), initialBytes);
    // A real new index must still fail, including when its source uses CRLF.
    const last = join(root, 'drizzle', files.at(-1));
    await writeFile(last, (await readFile(last, 'utf8')) + '\r\nCREATE INDEX ci_snapshot_regression ON users(created_at);\r\n');
    await assert.rejects(generateCloudflareSchema({ root, check: true }), /Initial schema snapshot differs/);
    assert.deepEqual(await readFile(snapshot), initialBytes);
  }
  assert.deepEqual(await readFile(join(ROOT, 'cloudflare/migrations/0001_schema.sql')), appliedBefore);
});

test('static build includes only public UI and attribution, never environment or database backups', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env.local'), 'ROOT_PRIVATE_VALUE');
  await writeFile(join(root, 'public/.env.local'), 'PUBLIC_DIRECTORY_PRIVATE_VALUE');
  await writeFile(join(root, 'public/secrets.json'), '{"private":"SECRET"}');
  await writeFile(join(root, 'public/database.sqlite'), 'DATABASE_PRIVATE_VALUE');
  await mkdir(join(root, 'public/backup'), { recursive: true });
  await writeFile(join(root, 'public/backup/users.json'), 'USERS_PRIVATE_VALUE');
  await mkdir(join(root, 'cloudflare/.output/public'), { recursive: true });
  await writeFile(join(root, 'cloudflare/.output/public/stale.html'), 'stale');
  const result = await buildCloudflare({ root });
  assert.equal(result.output, resolve(await realpath(root), 'cloudflare/.output/public'));
  const files = (await readdir(result.output, { recursive: true })).map(value => value.replaceAll('\\', '/'));
  for (const expected of ['index.html', 'app.js', 'styles.css', 'assets/photo.png', 'assets/SOURCES.md', '_headers']) assert(files.includes(expected), expected);
  for (const excluded of ['.env.local', 'secrets.json', 'database.sqlite', 'backup', 'stale.html', '.openai', 'hosting.json']) assert(!files.includes(excluded), excluded);
  for (const file of files.filter(name => !['assets', 'assets/photo.png'].includes(name))) {
    const contents = await readFile(join(result.output, file), 'utf8');
    for (const privateValue of ['ROOT_PRIVATE_VALUE', 'PUBLIC_DIRECTORY_PRIVATE_VALUE', 'DATABASE_PRIVATE_VALUE', 'USERS_PRIVATE_VALUE']) assert(!contents.includes(privateValue));
  }
  const headers = await readFile(join(result.output, '_headers'), 'utf8');
  assert(headers.includes('X-Content-Type-Options: nosniff'));
  assert(headers.includes("connect-src 'self'"));
  assert.equal(await readFile(join(root, '.openai/hosting.json'), 'utf8'), '{"project_id":"ORIGINAL_SITE_MUST_STAY"}\n');
});

test('static build refuses credential-bearing public code before cleaning the existing output', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'cloudflare/.output/public'), { recursive: true });
  await writeFile(join(root, 'cloudflare/.output/public/keep.txt'), 'unchanged');
  await writeFile(join(root, 'public/unsafe.js'), 'const key="sb_secret_TEST_ONLY_INVALID_0123456789";');
  await assert.rejects(buildCloudflare({ root }), /credential/);
  assert.equal(await readFile(join(root, 'cloudflare/.output/public/keep.txt'), 'utf8'), 'unchanged');
});

test('build cannot follow a junction outside its intended cleanup directory', async t => {
  const root = await fixture(t), external = await mkdtemp(join(tmpdir(), 'juzi-cloudflare-untouched-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'keep.txt'), 'never remove');
  await mkdir(join(root, 'cloudflare/.output'), { recursive: true });
  await symlink(external, join(root, 'cloudflare/.output/public'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildCloudflare({ root }), /symbolic links/);
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'never remove');
});

test('configuration starts disabled, uses actual IDs only, and leaves original Sites manifest alone', async t => {
  const root = await fixture(t), before = await readFile(join(root, '.openai/hosting.json'), 'utf8');
  const result = await configureCloudflare(VALID, { root });
  assert.equal(result.apiEnabled, false); assert.equal(result.siteOriginConfigured, false);
  const config = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(config.account_id, VALID.accountId);
  assert.equal(config.d1_databases[0].database_id, VALID.databaseId);
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].migrations_dir, './migrations');
  assert.equal(config.vars.JUZI_SITE_ENABLED, 'false');
  assert.equal(config.vars.JUZI_EMAIL_PROVIDER, 'gmail_apps_script');
  assert.equal(config.vars.SUPABASE_URL, VALID.supabaseUrl);
  assert(!Object.hasOwn(config.vars, 'JUZI_EMAIL_ORIGIN'));
  assert(!Object.hasOwn(config, 'r2_buckets'));
  assert.deepEqual(config.assets.run_worker_first, ['/api', '/api/*']);
  assert.equal(await readFile(join(root, '.openai/hosting.json'), 'utf8'), before);
  const updated = await configureCloudflare({ ...VALID, siteOrigin: 'https://campus.account.workers.dev' }, { root });
  assert.equal(updated.siteOriginConfigured, true);
  const withOrigin = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(withOrigin.vars.JUZI_EMAIL_ORIGIN, 'https://campus.account.workers.dev');
  assert.equal(withOrigin.vars.JUZI_SITE_ENABLED, 'false', 'Reconfiguration never silently opens writes.');
});

test('invalid destination arguments and attempts to overwrite another account are rejected without file changes', async t => {
  const root = await fixture(t), original = await readFile(join(root, '.openai/hosting.json'), 'utf8');
  const path = (await configureCloudflare(VALID, { root })).path, before = await readFile(path, 'utf8');
  for (const options of [
    { ...VALID, accountId: '' }, { ...VALID, accountId: '0'.repeat(32) },
    { ...VALID, databaseId: '00000000-0000-0000-0000-000000000000' },
    { ...VALID, supabaseUrl: 'https://attacker.example' },
    { ...VALID, supabaseUrl: `${VALID.supabaseUrl}/rest/v1` },
    { ...VALID, siteOrigin: 'http://localhost:8787' },
    { ...VALID, siteOrigin: 'https://campus.account.workers.dev/' },
    { ...VALID, siteOrigin: 'https://campus.account.workers.dev/#/login' },
    { ...VALID, accountId: '1234567890abcdef1234567890abcdef' },
  ]) await assert.rejects(configureCloudflare(options, { root }));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(root, '.openai/hosting.json'), 'utf8'), original);
  for (const args of [['--output', '../.openai/hosting.json'], ['--account-id'], ['--account-id', 'x', '--account-id', 'y'], ['--secret', 'NEVER_ACCEPT_SECRET_ARG']]) assert.throws(() => parseCloudflareArguments(args));
  assert.deepEqual(parseCloudflareArguments(['--account-id', VALID.accountId, '--database-id', VALID.databaseId, '--supabase-url', VALID.supabaseUrl]), { ...VALID, siteOrigin: undefined });
});

test('configuration rejects paid resource bindings and secrets injected into the example template', async t => {
  const root = await fixture(t), file = join(root, 'cloudflare/wrangler.example.json'), template = JSON.parse(await readFile(file, 'utf8'));
  for (const modified of [
    { ...template, r2_buckets: [{ binding: 'BUCKET', bucket_name: 'paid' }] },
    { ...template, vars: { ...template.vars, SUPABASE_SECRET_KEY: 'TEST_ONLY' } },
    { ...template, assets: { ...template.assets, directory: '../' } },
  ]) {
    await writeFile(file, JSON.stringify(modified));
    await assert.rejects(configureCloudflare(VALID, { root }));
  }
});
