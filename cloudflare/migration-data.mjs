// Node-only private migration tooling. Never import from a public Worker/client.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, stat, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';

export const SOURCE_ORIGIN = 'https://juzi-campus-market.open-bloom-6517.chatgpt.site';
export const LIMITS = Object.freeze({ response: 10 * 1024 * 1024, object: 8 * 1024 * 1024, total: 900 * 1024 * 1024, objects: 10000 });
export const IMPORT_ORDER = Object.freeze(['users', 'products', 'media', 'school_email_accounts', 'private_contacts', 'product_media', 'favorites', 'conversations', 'messages']);
export const RESET_AUTH = Object.freeze(['auth_flows', 'auth_sessions', 'school_email_challenges']);
const KNOWN = new Set([...IMPORT_ORDER, ...RESET_AUTH]);
const HASH = /^[a-f0-9]{64}$/;
const PLATFORM_MIGRATION_TABLE = '__appgarden_migrations';
const PLATFORM_MIGRATION_DDL = 'CREATE TABLE "__appgarden_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
const PLATFORM_MIGRATION_COLUMNS = [
  { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 2, name: 'applied_at', type: 'TIMESTAMP', notnull: 1, dflt_value: 'CURRENT_TIMESTAMP', pk: 0 },
];
export class MigrationError extends Error {
  constructor(code) { super(code); this.name = 'MigrationError'; this.code = code; }
}
const fail = code => { throw new MigrationError(code); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const size = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
function identifier(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_IDENTIFIER');
  return '"' + value.replace(/"/g, '""') + '"';
}
function keyValid(key) { return typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(key); }
function metadataValid(item) {
  if (!item || !keyValid(item.key) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.object) fail('INVALID_OBJECT_METADATA');
  if (item.etag !== null && item.etag !== undefined && (typeof item.etag !== 'string' || item.etag.length > 256)) fail('INVALID_OBJECT_METADATA');
  const type = item.contentType || item.httpMetadata?.contentType;
  if (type !== undefined && type !== null && (typeof type !== 'string' || type.length > 200 || /[\r\n\u0000]/.test(type))) fail('INVALID_OBJECT_METADATA');
  return item;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}
function blob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'blob' || value.encoding !== 'base64' || typeof value.value !== 'string' || Object.keys(value).sort().join(',') !== 'encoding,type,value') return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.value)) fail('INVALID_BLOB');
  return Buffer.from(value.value, 'base64');
}
function cell(value) {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { type: 'blob', encoding: 'base64', value: bytes.toString('base64') };
  }
  const bytes = blob(value);
  if (bytes) return { type: 'blob', encoding: 'base64', value: bytes.toString('base64') };
  fail('UNSUPPORTED_DATABASE_VALUE');
}
function decode(value) { return blob(value) ?? cell(value); }
function literal(value) {
  const bytes = blob(value);
  if (bytes) return `X'${bytes.toString('hex')}'`;
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value);
  if (typeof value === 'string') return value.includes('\0') ? `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)` : "'" + value.replace(/'/g, "''") + "'";
  fail('UNSUPPORTED_DATABASE_VALUE');
}
async function limitedBody(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel(); fail('RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader(), chunks = []; let count = 0;
  if (!reader) fail('EMPTY_SOURCE_RESPONSE');
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > maximum) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && !response.headers.has('content-encoding') && Number(declared) !== count) fail('SOURCE_LENGTH_MISMATCH');
  return Buffer.concat(chunks, count);
}
async function privateWrite(path, value, { same = false } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !same || sha256(await readFile(path)) !== sha256(bytes)) fail('PRIVATE_OUTPUT_ALREADY_EXISTS');
  }
}
async function privateJson(path, value, options) { return privateWrite(path, JSON.stringify(value, null, 2) + '\n', options); }
async function readLimitedFile(path, maximum) {
  if ((await lstat(path)).isSymbolicLink()) fail('PRIVATE_PATH_SYMLINK');
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) fail('INVALID_PRIVATE_FILE');
  const value = await readFile(path);
  if (value.length > maximum) fail('INVALID_PRIVATE_FILE');
  return value;
}
function sourceUrl(path, origin) {
  if (origin !== SOURCE_ORIGIN) fail('CREDENTIAL_DESTINATION_REJECTED');
  const value = new URL(path, origin);
  if (value.origin !== SOURCE_ORIGIN || value.username || value.password || !value.pathname.startsWith('/api/migration-export/v1/') || value.hash) fail('CREDENTIAL_DESTINATION_REJECTED');
  return value;
}
function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tables) || !Array.isArray(snapshot.schema) || !snapshot.counts || typeof snapshot.counts !== 'object') fail('INVALID_SNAPSHOT');
  const names = new Set();
  for (const table of snapshot.tables) {
    if (!table || typeof table.name !== 'string' || names.has(table.name) || !Array.isArray(table.columns) || !Array.isArray(table.rows) || !Number.isSafeInteger(table.count) || table.count !== table.rows.length || snapshot.counts[table.name] !== table.count) fail('INVALID_SNAPSHOT');
    names.add(table.name);
    const columns = table.columns.map(column => column.name);
    if (!columns.length || new Set(columns).size !== columns.length || columns.some(name => typeof name !== 'string' || !name)) fail('INVALID_SNAPSHOT');
    for (const row of table.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row, column))) fail('INVALID_SNAPSHOT');
      for (const value of Object.values(row)) cell(value);
    }
  }
  for (const name of ['users', 'products', 'media', 'school_email_accounts', 'private_contacts', 'product_media', 'favorites']) if (!names.has(name)) fail('MISSING_SOURCE_TABLE');
  const schemaNames = snapshot.schema.filter(entry => entry.type === 'table' && typeof entry.name === 'string' && !entry.name.startsWith('sqlite_') && entry.name !== '_cf_KV' && !['d1_migrations', '__drizzle_migrations'].includes(entry.name)).map(entry => entry.name);
  if (schemaNames.some(name => !names.has(name)) || [...names].some(name => !schemaNames.includes(name))) fail('MISSING_SOURCE_TABLE');
  return snapshot;
}

/** Export only from the exact old site. Credentials never enter files or URLs. */
export async function exportSource({ token, directory, origin = SOURCE_ORIGIN, fetch: fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(token)) fail('INVALID_EXPORT_CREDENTIAL');
  sourceUrl('/api/migration-export/v1/snapshot', origin);
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try { await stat(join(target, 'source-manifest.private.json')); fail('PRIVATE_OUTPUT_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const request = async (path, consume) => {
    const url = sourceUrl(path, origin), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, application/octet-stream' } });
      if (response.redirected || response.status !== 200) { await response.body?.cancel(); fail('SOURCE_REQUEST_REJECTED'); }
      return await consume(response);
    } catch (error) { if (error instanceof MigrationError) throw error; fail('SOURCE_REQUEST_FAILED'); }
    finally { clearTimeout(timer); }
  };
  const snapshotBytes = await request('/api/migration-export/v1/snapshot', async response => {
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('INVALID_SOURCE_TYPE');
    return limitedBody(response, LIMITS.response);
  });
  let snapshot; try { snapshot = validateSnapshot(JSON.parse(snapshotBytes)); } catch (error) { if (error instanceof MigrationError) throw error; fail('INVALID_SNAPSHOT'); }
  await privateWrite(join(target, 'snapshot.private.json'), snapshotBytes);
  const objects = [], keys = new Set(), cursors = new Set(); let cursor = null, totalBytes = 0, directoryBytes = 0;
  for (;;) {
    const page = await request('/api/migration-export/v1/objects' + (cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)), async response => {
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('INVALID_SOURCE_TYPE');
      try { return JSON.parse(await limitedBody(response, LIMITS.response)); } catch (error) { if (error instanceof MigrationError) throw error; fail('INVALID_OBJECT_DIRECTORY'); }
    });
    if (page.version !== 1 || !Array.isArray(page.objects) || page.objects.length > 100 || typeof page.truncated !== 'boolean') fail('INVALID_OBJECT_DIRECTORY');
    for (const item of page.objects) {
      metadataValid(item);
      if (keys.has(item.key)) fail('DUPLICATE_OBJECT_KEY');
      keys.add(item.key); totalBytes += item.size; directoryBytes += size(item) + 2; objects.push(item);
      if (totalBytes > LIMITS.total || objects.length > LIMITS.objects || directoryBytes > LIMITS.response) fail('FREE_STORAGE_LIMIT_EXCEEDED');
    }
    if (!page.truncated) { if (page.cursor !== null && page.cursor !== undefined) fail('INVALID_OBJECT_DIRECTORY'); break; }
    if (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 4096 || /[\u0000-\u001f\u007f]/.test(page.cursor) || cursors.has(page.cursor)) fail('OBJECT_CURSOR_LOOP');
    cursors.add(page.cursor); cursor = page.cursor;
    if (cursors.size > LIMITS.objects) fail('FREE_STORAGE_LIMIT_EXCEEDED');
  }
  await mkdir(join(target, 'objects'), { recursive: true, mode: 0o700 });
  const downloaded = [];
  for (const listed of objects) {
    const item = await request('/api/migration-export/v1/object?key=' + encodeURIComponent(listed.key), async response => {
      if (!/^application\/octet-stream(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('INVALID_SOURCE_TYPE');
      const header = response.headers.get('x-juzi-export-metadata'); let metadata;
      if (!header || header.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) fail('INVALID_OBJECT_METADATA');
      try { metadata = metadataValid(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))); } catch (error) { if (error instanceof MigrationError) throw error; fail('INVALID_OBJECT_METADATA'); }
      if (metadata.key !== listed.key || metadata.size !== listed.size || (listed.etag ?? null) !== (metadata.etag ?? null)) fail('SOURCE_OBJECT_CHANGED');
      const bytes = await limitedBody(response, LIMITS.object);
      if (bytes.length !== metadata.size) fail('SOURCE_OBJECT_SIZE_MISMATCH');
      if (typeof listed.etag === 'string' && /^[a-fA-F0-9]{32}$/.test(listed.etag) && createHash('md5').update(bytes).digest('hex') !== listed.etag.toLowerCase()) fail('SOURCE_OBJECT_ETAG_MISMATCH');
      const digest = sha256(bytes), file = `objects/${digest}.bin`, metadataFile = `objects/${sha256(listed.key)}.metadata.private.json`;
      await privateWrite(join(target, file), bytes, { same: true });
      const metadataBytes = Buffer.from(JSON.stringify({ listed, downloaded: metadata, sha256: digest }, null, 2) + '\n');
      await privateWrite(join(target, metadataFile), metadataBytes);
      return { ...metadata, sha256: digest, file, metadataFile, metadataSha256: sha256(metadataBytes) };
    });
    downloaded.push(item);
  }
  validateMediaObjects(snapshot, downloaded);
  const manifest = { version: 1, sourceOrigin: SOURCE_ORIGIN, exportedAt: new Date().toISOString(), snapshot: { file: 'snapshot.private.json', sha256: sha256(snapshotBytes) }, objects: downloaded, totalBytes,
    metadataLimitations: ['Original HTTP/custom metadata remains in private backup. Destination transport currently guarantees contentType only.'] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > LIMITS.response) fail('PRIVATE_MANIFEST_TOO_LARGE');
  await privateWrite(join(target, 'source-manifest.private.json'), manifestBytes);
  await privateWrite(join(target, 'source-manifest.sha256'), sha256(manifestBytes) + '\n');
  return { manifest, snapshot, summary: { sourceTables: snapshot.tables.length, sourceCounts: Object.fromEntries(snapshot.tables.map(table => [table.name, table.count])), objectCount: downloaded.length, totalBytes, manifestSha256: sha256(manifestBytes) } };
}

export function validateMediaObjects(snapshot, objects) {
  const map = new Map(); let total = 0;
  for (const object of objects) {
    metadataValid(object);
    if (map.has(object.key)) fail('DUPLICATE_OBJECT_KEY');
    if (object.sha256 !== undefined && !HASH.test(object.sha256)) fail('INVALID_OBJECT_HASH');
    map.set(object.key, object); total += object.size;
  }
  if (total > LIMITS.total || map.size > LIMITS.objects) fail('FREE_STORAGE_LIMIT_EXCEEDED');
  const media = snapshot.tables.find(table => table.name === 'media');
  for (const row of media?.rows || []) {
    const object = map.get(row.object_key);
    if (!object || row.size !== object.size) fail('MEDIA_OBJECT_MISSING_OR_CHANGED');
    const type = object.contentType || object.httpMetadata?.contentType;
    if (type && type !== row.content_type) fail('MEDIA_CONTENT_TYPE_MISMATCH');
  }
  return { objectCount: map.size, referencedObjects: new Set((media?.rows || []).map(row => row.object_key)).size, totalBytes: total };
}
export function tableDigest(columns, rows) {
  const names = columns.map(column => typeof column === 'string' ? column : column.name);
  const primary = columns.filter(column => typeof column !== 'string' && column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => names.indexOf(column.name));
  const normalized = rows.map(row => {
    if (!row || Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) fail('DATABASE_COLUMN_MISMATCH');
    return names.map(name => cell(row[name]));
  });
  normalized.sort((a, b) => {
    const left = JSON.stringify(primary.length ? primary.map(index => a[index]) : stable(a)), right = JSON.stringify(primary.length ? primary.map(index => b[index]) : stable(b));
    return left < right ? -1 : left > right ? 1 : JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b)), 'en');
  });
  return sha256(JSON.stringify({ columns: names, rows: normalized.map(stable) }));
}

function sourceMigrationMetadata(snapshot, source) {
  const table = source.get(PLATFORM_MIGRATION_TABLE);
  if (!table) return {};
  // This single known platform bookkeeping table remains in the original
  // private snapshot. Never execute source DDL or broadly skip unknown tables.
  const entries = snapshot.schema.filter(entry => entry.type === 'table' && entry.name === PLATFORM_MIGRATION_TABLE);
  const normalizeDdl = sql => typeof sql === 'string' ? sql.trim().replace(/;$/, '').trim().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').toLowerCase() : null;
  if (entries.length !== 1 || entries[0].tbl_name !== PLATFORM_MIGRATION_TABLE
    || normalizeDdl(entries[0].sql) !== normalizeDdl(PLATFORM_MIGRATION_DDL)
    || JSON.stringify(stable(table.columns)) !== JSON.stringify(stable(PLATFORM_MIGRATION_COLUMNS))) fail('INVALID_SOURCE_MIGRATION_METADATA');
  source.delete(PLATFORM_MIGRATION_TABLE);
  return { [PLATFORM_MIGRATION_TABLE]: table.count };
}

/** Trusted target DDL only. Source SQL is never executed. */
export function prepareMigration({ snapshot, objects, schemaSql }) {
  validateSnapshot(snapshot); validateMediaObjects(snapshot, objects);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON'); db.exec(schemaSql);
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (names.some(name => !KNOWN.has(name)) || [...KNOWN].some(name => !names.includes(name))) fail('UNEXPECTED_TARGET_SCHEMA');
    const source = new Map(snapshot.tables.map(table => [table.name, table]));
    const sourceMigrationMetadataCounts = sourceMigrationMetadata(snapshot, source);
    if ([...source.keys()].some(name => !KNOWN.has(name))) fail('UNKNOWN_SOURCE_TABLE');
    const columns = Object.fromEntries(names.map(name => [name, db.prepare(`PRAGMA table_info(${identifier(name)})`).all()]));
    for (const table of source.values()) {
      const target = new Set(columns[table.name].map(column => column.name));
      if (table.columns.some(column => !target.has(column.name))) fail('UNKNOWN_SOURCE_COLUMN');
    }
    // First statement asserts that *every* app/auth table is empty. It inserts
    // zero rows on an empty destination; otherwise users.id's NOT NULL fails
    // before any source record can be imported, even if IDs do not conflict.
    const emptyGuard = `INSERT INTO "users" ("id", "display_name", "created_at") SELECT NULL, '', 0 WHERE ${names.map(name => `EXISTS (SELECT 1 FROM ${identifier(name)})`).join(' OR ')};`;
    const inserts = [emptyGuard];
    db.exec('BEGIN');
    try {
      db.exec(emptyGuard);
      for (const name of IMPORT_ORDER) {
        const table = source.get(name); if (!table) continue;
        const fieldNames = table.columns.map(column => column.name);
        const sql = `INSERT INTO ${identifier(name)} (${fieldNames.map(identifier).join(', ')}) VALUES (${fieldNames.map(() => '?').join(', ')});`;
        const stmt = db.prepare(sql);
        for (const original of table.rows) {
          const row = { ...original };
          if (name === 'products') row.condition = ({ 九成新: '轻微使用痕迹', 八成新: '明显使用痕迹' })[row.condition] || row.condition;
          const values = fieldNames.map(field => decode(row[field]));
          stmt.run(...values);
          inserts.push(`INSERT INTO ${identifier(name)} (${fieldNames.map(identifier).join(', ')}) VALUES (${fieldNames.map(field => literal(cell(row[field]))).join(', ')});`);
        }
      }
      db.exec('COMMIT');
    } catch { try { db.exec('ROLLBACK'); } catch {} fail('SOURCE_DATA_CONSTRAINT_FAILED'); }
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('SOURCE_FOREIGN_KEY_FAILED');
    const expected = { version: 1, schemaSha256: sha256(schemaSql), tables: names.map(name => {
      const rows = db.prepare(`SELECT * FROM ${identifier(name)}`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])));
      return { name, columns: columns[name], count: rows.length, rows, sha256: tableDigest(columns[name], rows) };
    }) };
    const sql = '-- PRIVATE migrated application data. Do not commit or print.\n-- REQUIREMENT: all destination business/auth tables must be empty before execution.\n' + inserts.join('\n') + '\n';
    return { sql, expected, summary: { tableCounts: Object.fromEntries(expected.tables.map(table => [table.name, table.count])), resetAuthCounts: Object.fromEntries(RESET_AUTH.map(name => [name, source.get(name)?.count || 0])), sourceMigrationMetadataCounts, sqlSha256: sha256(sql), foreignKeysValid: true } };
  } finally { db.close(); }
}

export async function loadExport(directory) {
  const target = resolve(directory), manifestBytes = await readLimitedFile(join(target, 'source-manifest.private.json'), LIMITS.response);
  if ((await readLimitedFile(join(target, 'source-manifest.sha256'), 100)).toString().trim() !== sha256(manifestBytes)) fail('MANIFEST_HASH_MISMATCH');
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch { fail('INVALID_PRIVATE_MANIFEST'); }
  if (manifest.version !== 1 || manifest.sourceOrigin !== SOURCE_ORIGIN || manifest.snapshot?.file !== 'snapshot.private.json' || !HASH.test(manifest.snapshot.sha256) || !Array.isArray(manifest.objects)) fail('INVALID_PRIVATE_MANIFEST');
  const snapshotBytes = await readLimitedFile(join(target, 'snapshot.private.json'), LIMITS.response);
  if (sha256(snapshotBytes) !== manifest.snapshot.sha256) fail('SNAPSHOT_HASH_MISMATCH');
  let snapshot; try { snapshot = validateSnapshot(JSON.parse(snapshotBytes)); } catch (error) { if (error instanceof MigrationError) throw error; fail('INVALID_SNAPSHOT'); }
  if (validateMediaObjects(snapshot, manifest.objects).totalBytes !== manifest.totalBytes) fail('INVALID_PRIVATE_MANIFEST');
  for (const item of manifest.objects) {
    if (!HASH.test(item.sha256) || !HASH.test(item.metadataSha256) || item.file !== `objects/${item.sha256}.bin` || item.metadataFile !== `objects/${sha256(item.key)}.metadata.private.json`) fail('INVALID_PRIVATE_MANIFEST');
    const bytes = await readLimitedFile(join(target, item.file), LIMITS.object);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) fail('OBJECT_FILE_HASH_MISMATCH');
    const metadataBytes = await readLimitedFile(join(target, item.metadataFile), 65536); let metadata;
    if (sha256(metadataBytes) !== item.metadataSha256) fail('OBJECT_METADATA_HASH_MISMATCH');
    try { metadata = JSON.parse(metadataBytes); } catch { fail('INVALID_OBJECT_METADATA'); }
    if (metadata.sha256 !== item.sha256 || metadata.downloaded?.key !== item.key || metadata.downloaded?.size !== item.size || JSON.stringify(stable(metadata.downloaded)) !== JSON.stringify(stable(Object.fromEntries(Object.entries(item).filter(([key]) => !['sha256', 'file', 'metadataFile', 'metadataSha256'].includes(key)))))) fail('OBJECT_METADATA_MISMATCH');
  }
  return { directory: target, manifest, snapshot };
}
export async function writePrepared(directory, prepared) {
  await privateWrite(join(directory, 'prepared.private.sql'), prepared.sql, { same: true });
  await privateJson(join(directory, 'expected-target.private.json'), prepared.expected, { same: true });
  await privateJson(join(directory, 'prepare-summary.json'), prepared.summary, { same: true });
}

/** Copy once, never overwrite mismatching objects. Re-runs reverify every byte. */
export async function migrateImages({ directory, bucket }) {
  if (!bucket?.get || !bucket.put) fail('STORAGE_NOT_CONFIGURED');
  const data = await loadExport(directory), progress = { version: 1, sourceManifestSha256: sha256(await readFile(join(directory, 'source-manifest.private.json'))), verified: [], metadataLimitations: data.manifest.metadataLimitations };
  let uploaded = 0, skipped = 0;
  const checkpoint = async () => {
    const temporary = join(directory, 'images-progress.private.tmp');
    for (const path of [temporary, join(directory, 'images-progress.private.json')]) {
      try { if ((await lstat(path)).isSymbolicLink()) fail('PRIVATE_PATH_SYMLINK'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeFile(temporary, JSON.stringify(progress, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, join(directory, 'images-progress.private.json'));
  };
  const verify = async (object, expected) => {
    if (!object) return false;
    const bytes = object.arrayBuffer ? Buffer.from(await object.arrayBuffer()) : await limitedBody(new Response(object.body), LIMITS.object);
    const type = expected.contentType || expected.httpMetadata?.contentType || 'application/octet-stream';
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256 || object.httpMetadata?.contentType !== type) fail('DESTINATION_OBJECT_CONFLICT');
    return true;
  };
  try {
    await checkpoint();
    for (const item of data.manifest.objects) {
      if (await verify(await bucket.get(item.key), item)) skipped++;
      else {
        const bytes = await readLimitedFile(join(directory, item.file), LIMITS.object);
        if (sha256(bytes) !== item.sha256) fail('OBJECT_FILE_HASH_MISMATCH');
        let wrote = false;
        try { await bucket.put(item.key, bytes, { preventOverwrite: true, httpMetadata: { contentType: item.contentType || item.httpMetadata?.contentType || 'application/octet-stream' } }); wrote = true; }
        catch { if (!(await verify(await bucket.get(item.key), item))) fail('IMAGE_UPLOAD_FAILED'); }
        if (!(await verify(await bucket.get(item.key), item))) fail('IMAGE_UPLOAD_UNCONFIRMED');
        if (wrote) uploaded++; else skipped++;
      }
      progress.verified.push({ key: item.key, size: item.size, sha256: item.sha256 });
      await checkpoint();
    }
  } catch (error) { if (error instanceof MigrationError) throw error; fail('IMAGE_STORAGE_FAILED'); }
  return { verifiedObjects: progress.verified.length, uploaded, skipped, totalBytes: data.manifest.totalBytes, metadataLimitations: progress.metadataLimitations };
}

export function parseWranglerRows(value, expected) {
  const map = Object.create(null);
  if (Array.isArray(value)) {
    if (value.every(item => item && typeof (item.table || item.name) === 'string')) {
      for (const item of value) {
        const name = item.table || item.name;
        if (Object.hasOwn(map, name)) fail('DUPLICATE_DESTINATION_TABLE');
        map[name] = item.rows || item.results;
      }
    } else {
      if (value.length !== expected.tables.length) fail('DESTINATION_TABLE_MISMATCH');
      for (let index = 0; index < value.length; index++) {
        if (value[index].success !== true || !Array.isArray(value[index].results)) fail('INVALID_WRANGLER_RESULT');
        map[expected.tables[index].name] = value[index].results;
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [name, result] of Object.entries(value)) {
      if (result?.success === false) fail('INVALID_WRANGLER_RESULT');
      map[name] = Array.isArray(result) ? result : result?.rows || result?.results;
    }
  } else fail('INVALID_WRANGLER_RESULT');
  if (Object.values(map).some(rows => !Array.isArray(rows))) fail('INVALID_WRANGLER_RESULT');
  return map;
}
export function verifyDatabase(expected, actual) {
  if (!expected || expected.version !== 1 || !Array.isArray(expected.tables)) fail('INVALID_EXPECTED_DATABASE');
  const names = expected.tables.map(table => table.name);
  if (Object.keys(actual).some(name => !names.includes(name)) || names.some(name => !Object.hasOwn(actual, name))) fail('DESTINATION_TABLE_MISMATCH');
  const tables = expected.tables.map(table => {
    if (table.sha256 !== tableDigest(table.columns, table.rows) || table.rows.length !== table.count) fail('EXPECTED_DATABASE_HASH_MISMATCH');
    const actualHash = tableDigest(table.columns, actual[table.name]);
    return { name: table.name, expectedCount: table.count, actualCount: actual[table.name].length, hashMatches: actualHash === table.sha256 };
  });
  return { matches: tables.every(table => table.expectedCount === table.actualCount && table.hashMatches), tables };
}
export function assertEmptyDestination(expected, actual) {
  const names = expected.tables.map(table => table.name);
  if (Object.keys(actual).some(name => !names.includes(name)) || names.some(name => !Array.isArray(actual[name]) || actual[name].length)) fail('DESTINATION_NOT_EMPTY');
  return { empty: true, tableCount: names.length };
}

/** CLI destination containment: private exports stay outside Git/public assets. */
export function privateRunPath(root, value) {
  const staging = resolve(root, '.migration-staging'), target = resolve(root, value), rel = relative(staging, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('PRIVATE_DIRECTORY_REQUIRED');
  return target;
}

/** Reject Windows junctions/symlinks before creating or using a CLI run dir. */
export async function securePrivateRunPath(root, value) {
  const target = privateRunPath(root, value), base = resolve(root), actualBase = await realpath(base);
  const inspect = async () => {
    let current = base;
    for (const part of relative(base, target).split(sep)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) fail('PRIVATE_PATH_SYMLINK');
        const actual = await realpath(current), inside = relative(actualBase, actual);
        if (!inside || inside.startsWith('..') || isAbsolute(inside)) fail('PRIVATE_PATH_SYMLINK');
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
  };
  await inspect();
  await mkdir(target, { recursive: true, mode: 0o700 });
  await inspect();
  return target;
}
