// Private operator tool. Credentials come only from a private env file; never
// pass a token/key as a CLI argument or emit database rows to the terminal.
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createSupabaseBucket } from '../cloudflare/supabase-storage.mjs';
import { MigrationError, exportSource, prepareMigration, loadExport, writePrepared, migrateImages,
  parseWranglerRows, verifyDatabase, assertEmptyDestination, privateRunPath, securePrivateRunPath, LIMITS } from '../cloudflare/migration-data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function failure(code) { throw new MigrationError(code); }
function argumentsOf(args) {
  const command = args.shift();
  if (!['export', 'prepare', 'images', 'verify-db', 'verify-empty'].includes(command)) failure('EXPECTED_MIGRATION_PHASE');
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--env-file', '--run', '--actual-db'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) failure('INVALID_CLI_OPTIONS');
    options[key] = value;
  }
  if (!options['--run']) failure('PRIVATE_RUN_DIRECTORY_REQUIRED');
  return { command, options, directory: privateRunPath(root, options['--run']) };
}
async function privateConfig(options) {
  if (!options['--env-file']) failure('PRIVATE_ENV_FILE_REQUIRED');
  try {
    const bytes = await readFile(resolve(root, options['--env-file']));
    if (bytes.length > 65536) failure('PRIVATE_ENV_FILE_TOO_LARGE');
    return parseEnv(bytes.toString('utf8'));
  } catch (error) { if (error instanceof MigrationError) throw error; failure('PRIVATE_ENV_FILE_UNAVAILABLE'); }
}
async function limitedJson(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > LIMITS.response) failure('PRIVATE_JSON_TOO_LARGE');
  const bytes = await readFile(path);
  if (bytes.length > LIMITS.response) failure('PRIVATE_JSON_TOO_LARGE');
  try { return JSON.parse(bytes); } catch { failure('PRIVATE_JSON_INVALID'); }
}
export async function main(args = process.argv.slice(2)) {
  const { command, options } = argumentsOf([...args]);
  const directory = await securePrivateRunPath(root, options['--run']);
  if (command === 'export') {
    const env = await privateConfig(options);
    // A malicious/accidental origin setting cannot redirect the bearer token.
    const result = await exportSource({ token: env.JUZI_MIGRATION_EXPORT_TOKEN, directory,
      ...(env.JUZI_MIGRATION_SOURCE_ORIGIN === undefined ? {} : { origin: env.JUZI_MIGRATION_SOURCE_ORIGIN }) });
    return { phase: command, ...result.summary };
  }
  if (command === 'prepare') {
    const data = await loadExport(directory);
    const schemaSql = await readFile(join(root, 'cloudflare/migrations/0001_schema.sql'), 'utf8');
    const prepared = prepareMigration({ snapshot: data.snapshot, objects: data.manifest.objects, schemaSql });
    await writePrepared(directory, prepared);
    return { phase: command, ...prepared.summary };
  }
  if (command === 'images') {
    const env = await privateConfig(options), bucket = createSupabaseBucket(env);
    if (!bucket) failure('STORAGE_NOT_CONFIGURED');
    return { phase: command, ...await migrateImages({ directory, bucket }) };
  }
  if (!options['--actual-db']) failure('PRIVATE_ACTUAL_DB_FILE_REQUIRED');
  const expected = await limitedJson(join(directory, 'expected-target.private.json'));
  const actual = parseWranglerRows(await limitedJson(resolve(root, options['--actual-db'])), expected);
  if (command === 'verify-empty') return { phase: command, ...assertEmptyDestination(expected, actual) };
  const result = verifyDatabase(expected, actual);
  if (!result.matches) {
    // Counts and pass/fail only. Neither raw rows nor identity/contact values.
    process.stdout.write(JSON.stringify({ phase: command, ...result }) + '\n');
    failure('DESTINATION_DATABASE_MISMATCH');
  }
  return { phase: command, ...result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await main()) + '\n'); }
  catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error instanceof MigrationError ? error.code : 'MIGRATION_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
