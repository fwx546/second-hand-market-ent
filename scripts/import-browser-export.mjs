import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MigrationError } from '../cloudflare/migration-data.mjs';
import { importBrowserExportFile } from '../cloudflare/browser-export.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function main(args = process.argv.slice(2)) {
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--input', '--run'].includes(flag) || !value || value.startsWith('--') || Object.hasOwn(options, flag)) throw new MigrationError('INVALID_BROWSER_IMPORT_ARGUMENTS');
    options[flag] = value;
  }
  if (!options['--input'] || !options['--run']) throw new MigrationError('PRIVATE_BROWSER_INPUT_AND_RUN_REQUIRED');
  const result = await importBrowserExportFile({ inputFile: options['--input'], root: ROOT, run: options['--run'] });
  return { phase: 'import-browser-export', ...result.summary };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await main()) + '\n'); }
  catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error instanceof MigrationError ? error.code : 'BROWSER_IMPORT_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
