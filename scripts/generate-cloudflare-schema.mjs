import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLOUDFLARE_TABLES = Object.freeze(['auth_flows', 'auth_sessions', 'conversations', 'favorites', 'media', 'messages', 'private_contacts', 'product_media', 'products', 'school_email_accounts', 'school_email_challenges', 'users']);
const canonicalLf = sql => sql.replace(/\r\n?/g, '\n');
// The applied initial snapshot recorded a mixed LF/CRLF checkout checksum.
// Preserve that immutable header only for this exact canonical migration set;
// any content/filename change still gets its own checksum and fails the check.
const INITIAL_CANONICAL_SOURCE_SHA256 = '9325ed2bc852843a61862d795c24c70ae9bccdd1b5b727c43c95ea0ec9c278bd';
const INITIAL_RECORDED_SOURCE_SHA256 = '8139501b2574811e407abfda82cd527370830517f7b5ff92a3dea76a907d3a2b';

export async function cloudflareSchema({ root = ROOT } = {}) {
  const db = new DatabaseSync(':memory:');
  try {
    const files = (await readdir(join(root, 'drizzle'))).filter(file => /^\d+_[A-Za-z0-9_]+\.sql$/.test(file)).sort();
    if (!files.length) throw new Error('No source schema migrations found.');
    const digest = createHash('sha256');
    for (const file of files) {
      const sql = canonicalLf(await readFile(join(root, 'drizzle', file), 'utf8'));
      digest.update(file).update('\0').update(sql).update('\0');
      db.exec(sql);
    }
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '__drizzle%' ORDER BY type DESC, name").all();
    if (rows.some(row => !['table', 'index'].includes(row.type))) throw new Error('Review new schema object types before exporting.');
    const tables = rows.filter(row => row.type === 'table'), names = tables.map(row => row.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...CLOUDFLARE_TABLES].sort())) throw new Error('Business table list changed; review every table before exporting.');
    const pending = new Map(tables.map(row => [row.name, row])), ordered = [], created = new Set();
    while (pending.size) {
      let progressed = false;
      for (const [name, row] of pending) {
        const dependencies = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map(key => key.table).filter(table => table !== name);
        if (!dependencies.every(table => created.has(table))) continue;
        ordered.push(row); pending.delete(name); created.add(name); progressed = true;
      }
      if (!progressed) throw new Error('Review cyclic or unresolved schema foreign keys before exporting.');
    }
    const ddl = [...ordered, ...rows.filter(row => row.type === 'index')].map(row => `${row.sql.replace(/;\s*$/, '')};`).join('\n\n');
    if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|OR|users\b|products\b)/i.test(ddl)) throw new Error('Schema export must not contain data writes.');
    const sourceDigest = digest.digest('hex');
    const recordedDigest = sourceDigest === INITIAL_CANONICAL_SOURCE_SHA256 ? INITIAL_RECORDED_SOURCE_SHA256 : sourceDigest;
    return `-- Independent Cloudflare D1 schema, with no user, product or demo rows.\n-- Source migrations SHA-256: ${recordedDigest}\n-- Regenerate/check with scripts/generate-cloudflare-schema.mjs.\n\n${ddl}\n`;
  } finally { db.close(); }
}

export async function generateCloudflareSchema({ root = ROOT, check = false } = {}) {
  const sql = await cloudflareSchema({ root }), target = join(root, 'cloudflare', 'migrations', '0001_schema.sql');
  let existing;
  try { existing = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== undefined && canonicalLf(existing) !== sql) throw new Error('Initial schema snapshot differs. Add a reviewed new migration after deployment; do not rewrite applied history.');
  if (check && existing === undefined) throw new Error('Cloudflare schema snapshot is missing.');
  if (!check && existing === undefined) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, sql, 'utf8'); }
  return { path: target, tables: CLOUDFLARE_TABLES.length, schemaOnly: true, matches: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--check') || process.argv.slice(2).length > 1) throw new Error('Usage: node scripts/generate-cloudflare-schema.mjs [--check]');
    console.log(JSON.stringify(await generateCloudflareSchema({ check: process.argv.includes('--check') })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
