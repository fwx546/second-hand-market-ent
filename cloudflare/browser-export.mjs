// Node-only adapter for a user-downloaded private browser backup. This module
// does not fetch, execute SQL, or write to a database or object store.
import { createHash } from 'node:crypto';
import { lstat, open, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { SOURCE_ORIGIN, MigrationError, sha256, securePrivateRunPath, loadExport } from './migration-data.mjs';

const MIB = 1024 * 1024;
export const BROWSER_EXPORT_LIMITS = Object.freeze({ file: 64 * MIB, snapshot: 10 * MIB, object: 8 * MIB, total: 32 * MIB, objects: 128 });
const HASH = /^[0-9a-f]{64}$/;
const RESERVED = new Set(['sha256', 'file', 'metadataFile', 'metadataSha256']);
const fail = code => { throw new MigrationError(code); };
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jsonBytes(value) {
  try { return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'); }
  catch { fail('INVALID_BROWSER_BUNDLE'); }
}
function keyValid(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(value); }
function validateMetadata(metadata) {
  if (!plain(metadata) || !keyValid(metadata.key) || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > BROWSER_EXPORT_LIMITS.object || Object.keys(metadata).some(key => RESERVED.has(key))) fail('INVALID_BROWSER_OBJECT_METADATA');
  if (metadata.etag !== undefined && metadata.etag !== null && (typeof metadata.etag !== 'string' || metadata.etag.length > 256 || /[\r\n\u0000]/.test(metadata.etag))) fail('INVALID_BROWSER_OBJECT_METADATA');
  if (metadata.httpMetadata !== undefined && !plain(metadata.httpMetadata) || metadata.customMetadata !== undefined && !plain(metadata.customMetadata)) fail('INVALID_BROWSER_OBJECT_METADATA');
  if (jsonBytes(metadata).length > 65536) fail('BROWSER_METADATA_TOO_LARGE');
  return metadata;
}
function imageType(bytes) {
  // Match the existing uploader's binary signature checks. These identify an
  // accepted file type; they do not claim a full pixel/codec decode.
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  fail('INVALID_BROWSER_IMAGE_TYPE');
}
function decodeObject(item) {
  if (!plain(item) || Object.keys(item).some(key => !['metadata', 'sha256', 'base64'].includes(key)) || !HASH.test(item.sha256) || typeof item.base64 !== 'string') fail('INVALID_BROWSER_OBJECT');
  const maximum = 4 * Math.ceil(BROWSER_EXPORT_LIMITS.object / 3);
  if (!item.base64 || item.base64.length > maximum || item.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.base64)) fail('INVALID_BROWSER_BASE64');
  const bytes = Buffer.from(item.base64, 'base64');
  if (bytes.toString('base64') !== item.base64) fail('INVALID_BROWSER_BASE64');
  if (bytes.length !== item.metadata.size || bytes.length > BROWSER_EXPORT_LIMITS.object) fail('BROWSER_OBJECT_SIZE_MISMATCH');
  if (sha256(bytes) !== item.sha256) fail('BROWSER_OBJECT_HASH_MISMATCH');
  if (typeof item.metadata.etag === 'string' && /^[a-fA-F0-9]{32}$/.test(item.metadata.etag) && createHash('md5').update(bytes).digest('hex') !== item.metadata.etag.toLowerCase()) fail('BROWSER_OBJECT_ETAG_MISMATCH');
  const detected = imageType(bytes), declared = item.metadata.contentType || item.metadata.httpMetadata?.contentType;
  if (declared !== detected || item.metadata.contentType && item.metadata.contentType !== detected || item.metadata.httpMetadata?.contentType && item.metadata.httpMetadata.contentType !== detected) fail('BROWSER_IMAGE_TYPE_MISMATCH');
  return bytes;
}
async function writeNew(path, bytes) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('BROWSER_OUTPUT_ALREADY_EXISTS'); throw error; }
}
function prepareBundle(bundle) {
  if (!plain(bundle) || bundle.format !== 'juzi-browser-export-v1' || bundle.sourceOrigin !== SOURCE_ORIGIN || Object.keys(bundle).some(key => !['format', 'sourceOrigin', 'snapshot', 'objects', 'consistency'].includes(key))) fail('INVALID_BROWSER_BUNDLE');
  if (!plain(bundle.snapshot) || bundle.snapshot.version !== 1 || !Array.isArray(bundle.snapshot.tables) || !Array.isArray(bundle.snapshot.schema) || !Array.isArray(bundle.objects)) fail('INVALID_BROWSER_BUNDLE');
  const snapshotBytes = Buffer.from(JSON.stringify(bundle.snapshot) + '\n', 'utf8');
  if (snapshotBytes.length > BROWSER_EXPORT_LIMITS.snapshot) fail('BROWSER_SNAPSHOT_TOO_LARGE');
  if (bundle.objects.length > BROWSER_EXPORT_LIMITS.objects) fail('BROWSER_OBJECT_COUNT_LIMIT');
  const keys = new Set(); let totalBytes = 0;
  for (const item of bundle.objects) {
    if (!plain(item)) fail('INVALID_BROWSER_OBJECT');
    validateMetadata(item.metadata);
    if (keys.has(item.metadata.key)) fail('DUPLICATE_BROWSER_OBJECT_KEY');
    keys.add(item.metadata.key); totalBytes += item.metadata.size;
    if (totalBytes > BROWSER_EXPORT_LIMITS.total) fail('BROWSER_TOTAL_SIZE_LIMIT');
  }
  const objects = bundle.objects.map(item => ({ item, bytes: decodeObject(item) }));
  return { snapshotBytes, objects, totalBytes };
}

/** Adapter interface for an audited browser UI's downloaded JSON object. */
export async function importBrowserBundle({ bundle, root, run }) {
  const prepared = prepareBundle(bundle);
  const directory = await securePrivateRunPath(root, run);
  if ((await readdir(directory)).length !== 0) fail('BROWSER_RUN_NOT_EMPTY');
  await mkdir(join(directory, 'objects'), { mode: 0o700 });
  await writeNew(join(directory, 'snapshot.private.json'), prepared.snapshotBytes);
  const objects = [], written = new Set();
  for (const { item, bytes } of prepared.objects) {
    const digest = sha256(bytes), file = `objects/${digest}.bin`, metadataFile = `objects/${sha256(item.metadata.key)}.metadata.private.json`;
    if (!written.has(digest)) { await writeNew(join(directory, file), bytes); written.add(digest); }
    // The browser UI checks the original listing against the original download
    // header. The bundle carries their equal metadata once; no source schema,
    // row, key, MIME or timestamp is manufactured by this local adapter.
    const metadataBytes = jsonBytes({ listed: item.metadata, downloaded: item.metadata, sha256: digest,
      transport: 'browser: original listing and header equality checked by the exporter UI' });
    await writeNew(join(directory, metadataFile), metadataBytes);
    objects.push({ ...item.metadata, sha256: digest, file, metadataFile, metadataSha256: sha256(metadataBytes) });
  }
  const manifest = { version: 1, sourceOrigin: SOURCE_ORIGIN, exportedAt: bundle.snapshot.capturedAt,
    importedAt: new Date().toISOString(), sourceTransport: 'browser-assisted',
    snapshot: { file: 'snapshot.private.json', sha256: sha256(prepared.snapshotBytes) }, objects, totalBytes: prepared.totalBytes,
    metadataLimitations: ['Original HTTP/custom metadata remains in private backup. Destination transport currently guarantees contentType only.'],
  };
  if (Object.hasOwn(bundle, 'consistency')) {
    // Optional records are preserved as evidence, never trusted as a success
    // flag and never used instead of the checks above or loadExport below.
    const evidence = jsonBytes(bundle.consistency);
    if (evidence.length > BROWSER_EXPORT_LIMITS.snapshot) fail('BROWSER_EVIDENCE_TOO_LARGE');
    await writeNew(join(directory, 'browser-consistency.private.json'), evidence);
    manifest.browserConsistency = { file: 'browser-consistency.private.json', sha256: sha256(evidence) };
  }
  const manifestBytes = jsonBytes(manifest);
  if (manifestBytes.length > BROWSER_EXPORT_LIMITS.snapshot) fail('BROWSER_MANIFEST_TOO_LARGE');
  await writeNew(join(directory, 'source-manifest.private.json'), manifestBytes);
  await writeNew(join(directory, 'source-manifest.sha256'), sha256(manifestBytes) + '\n');
  const checked = await loadExport(directory);
  return { directory, summary: { sourceTables: checked.snapshot.tables.length,
    sourceCounts: Object.fromEntries(checked.snapshot.tables.map(table => [table.name, table.count])),
    objectCount: checked.manifest.objects.length, totalBytes: prepared.totalBytes,
    manifestSha256: sha256(manifestBytes), locallyVerified: true } };
}

/** Stop a growing input at maximum + 1 bytes instead of readFile's unbounded read. */
export async function readBoundedBrowserFile(file, maximum = BROWSER_EXPORT_LIMITS.file) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail('INVALID_BROWSER_INPUT_LIMIT');
  const chunks = []; let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) fail('BROWSER_INPUT_CHANGED');
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) fail('BROWSER_INPUT_TOO_LARGE');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/** Read only a regular local JSON file, rejecting symlink/junction ancestors. */
export async function importBrowserExportFile({ inputFile, root, run }) {
  if (typeof inputFile !== 'string' || !inputFile || /^[a-z][a-z0-9+.-]*:\/\//i.test(inputFile)) fail('LOCAL_BROWSER_JSON_REQUIRED');
  const filename = resolve(root, inputFile), name = basename(filename);
  if (!name || extname(name).toLowerCase() !== '.json' || name.startsWith('.')) fail('LOCAL_BROWSER_JSON_REQUIRED');
  const anchor = parse(filename).root;
  if (!isAbsolute(filename)) fail('LOCAL_BROWSER_JSON_REQUIRED');
  let current = anchor;
  const parts = relative(anchor, filename).split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory() || index === parts.length - 1 && !info.isFile()) fail('BROWSER_INPUT_SYMLINK_OR_NOT_FILE');
  }
  const before = await lstat(filename, { bigint: true });
  if (before.size > BigInt(BROWSER_EXPORT_LIMITS.file)) fail('BROWSER_INPUT_TOO_LARGE');
  const file = await open(filename, 'r'); let bytes;
  try {
    const info = await file.stat({ bigint: true });
    // Windows lstat reports dev=0 while fstat can report the real volume ID.
    // Compare the exact 64-bit file ID and size there; compare dev on POSIX.
    if (!info.isFile() || info.size > BigInt(BROWSER_EXPORT_LIMITS.file) || info.ino !== before.ino || info.size !== before.size || process.platform !== 'win32' && info.dev !== before.dev) fail('BROWSER_INPUT_CHANGED');
    bytes = await readBoundedBrowserFile(file);
    const after = await file.stat({ bigint: true });
    if (after.size !== info.size || after.mtimeNs !== info.mtimeNs) fail('BROWSER_INPUT_CHANGED');
  } finally { await file.close(); }
  let bundle;
  try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_BROWSER_JSON'); }
  return importBrowserBundle({ bundle, root, run });
}
