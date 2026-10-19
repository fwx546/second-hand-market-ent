import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS = new Set(['--account-id', '--database-id', '--supabase-url', '--site-origin']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCloudflareArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!OPTIONS.has(flag) || Object.hasOwn(values, flag) || typeof value !== 'string' || value.startsWith('--')) {
      throw new Error('Supply account-id, database-id and supabase-url; site-origin is optional. Unknown, missing or duplicate arguments are refused.');
    }
    values[flag] = value;
  }
  return { accountId: values['--account-id'], databaseId: values['--database-id'], supabaseUrl: values['--supabase-url'], siteOrigin: values['--site-origin'] };
}

function validate({ accountId, databaseId, supabaseUrl, siteOrigin }) {
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(accountId) || /^([0-9a-f])\1{31}$/i.test(accountId)) throw new Error('A real 32-hex Cloudflare account ID is required.');
  if (typeof databaseId !== 'string' || !UUID.test(databaseId)) throw new Error('A real Cloudflare D1 database UUID is required.');
  if (typeof supabaseUrl !== 'string' || !/^https:\/\/[a-z0-9]{10,64}\.supabase\.co\/?$/.test(supabaseUrl)) throw new Error('Use the actual hosted Supabase project HTTPS URL.');
  if (siteOrigin !== undefined) {
    let url;
    try { url = new URL(siteOrigin); } catch { throw new Error('Use the exact deployed HTTPS site origin.'); }
    if (url.protocol !== 'https:' || url.origin !== siteOrigin || url.username || url.password) throw new Error('Use the exact deployed HTTPS site origin without a path.');
  }
}

/** Only writes the independent cloudflare/wrangler.json. Never touches Sites. */
export async function configureCloudflare(options, { root = ROOT } = {}) {
  validate(options);
  const workspace = await realpath(resolve(root)), folder = join(workspace, 'cloudflare');
  const folderStat = await lstat(folder);
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) throw new Error('Cloudflare configuration directory must be a regular workspace directory.');
  const templatePath = join(folder, 'wrangler.example.json');
  const templateStat = await lstat(templatePath);
  if (templateStat.isSymbolicLink() || !templateStat.isFile()) throw new Error('Cloudflare template must be a regular file.');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  if (template.r2_buckets || template.env || template.services || template.kv_namespaces || template.routes || template.unsafe || template.d1_databases?.length) {
    throw new Error('The free deployment template must not contain cloud resource bindings or routes.');
  }
  const allowed = new Set(['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'assets', 'd1_databases', 'vars', 'observability']);
  if (Object.keys(template).some(key => !allowed.has(key)) || template.main !== './worker.mjs' || template.assets?.directory !== './.output/public' || template.assets?.binding !== 'ASSETS') {
    throw new Error('Unexpected deployment template configuration.');
  }
  if (Object.keys(template.vars || {}).some(key => /SECRET|TOKEN|PASSWORD|API_KEY|SERVICE_ROLE/i.test(key))) throw new Error('Store credentials as Cloudflare secrets, never in Wrangler vars.');
  const config = { ...template, account_id: options.accountId.toLowerCase(), d1_databases: [{
    binding: 'DB', database_name: 'juzi-campus-market', database_id: options.databaseId.toLowerCase(), migrations_dir: './migrations',
  }], vars: { ...template.vars, JUZI_SITE_ENABLED: 'false', SUPABASE_URL: options.supabaseUrl.replace(/\/$/, '') } };
  if (options.siteOrigin !== undefined) config.vars.JUZI_EMAIL_ORIGIN = options.siteOrigin;
  const target = join(folder, 'wrangler.json');
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Configuration output must be a regular file.');
    const current = JSON.parse(await readFile(target, 'utf8'));
    if (current.account_id !== config.account_id || current.d1_databases?.[0]?.database_id !== config.d1_databases[0].database_id) {
      throw new Error('Existing deployment points to a different account or database; preserve it and review the intended destination.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { path: target, apiEnabled: false, siteOriginConfigured: options.siteOrigin !== undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await configureCloudflare(parseCloudflareArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
