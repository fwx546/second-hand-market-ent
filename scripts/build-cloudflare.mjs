import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.md', '.json', '.webmanifest']);
const TEXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.txt', '.md', '.json', '.webmanifest']);
const DENIED_NAME = /(?:^\.|secret|credential|token|backup|dump|private|(?:^|[._-])(?:env|config)(?:$|[._-]))/i;
const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
`;

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function within(root, target) {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(target).startsWith('\\\\');
}
async function ordinary(path, type) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (type === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Static build refuses symbolic links and non-regular input.');
  }
}
async function checkPublicFile(path) {
  if (!TEXT.has(extname(path).toLowerCase())) return;
  const value = await readFile(path, 'utf8');
  if (/sb_secret_[A-Za-z0-9_-]{10,}|\b(?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|JUZI_EMAIL_AUTH_SECRET|JUZI_GMAIL_SCRIPT_SECRET|QQ_SMTP_AUTH_CODE)\b/.test(value)) {
    throw new Error('Static build refuses server credential content.');
  }
}

/** Copies only reviewed public assets, never the repository or its config. */
export async function buildCloudflare({ root = ROOT } = {}) {
  const workspace = await realpath(resolve(root)), cloudflare = join(workspace, 'cloudflare');
  await ordinary(cloudflare, 'directory');
  const stage = join(cloudflare, '.output'), output = join(stage, 'public');
  if (!within(workspace, output) || output !== resolve(workspace, 'cloudflare', '.output', 'public')) {
    throw new Error('Static output must stay inside this workspace/cloudflare/.output/public.');
  }
  if (await exists(stage)) await ordinary(stage, 'directory');
  if (await exists(output)) await ordinary(output, 'directory');
  const source = join(workspace, 'public');
  await ordinary(source, 'directory');
  const plan = [], skipped = [];
  const visit = async (folder, prefix = '') => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = join(prefix, entry.name), from = join(folder, entry.name);
      if (DENIED_NAME.test(entry.name)) { skipped.push(name); continue; }
      if (entry.isSymbolicLink()) throw new Error('Static build refuses symbolic links.');
      if (entry.isDirectory()) { await ordinary(from, 'directory'); await visit(from, name); }
      else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        await ordinary(from, 'file'); await checkPublicFile(from);
        plan.push({ from, name });
      } else skipped.push(name);
    }
  };
  await visit(source);
  const index = join(workspace, 'legacy', 'index.html');
  await ordinary(join(workspace, 'legacy'), 'directory');
  await ordinary(index, 'file'); await checkPublicFile(index);
  // All source and destination checks finish before this one recursive delete.
  // No user-supplied output path can target the old Sites manifest or source.
  if (await exists(output)) await rm(output, { recursive: true, force: false });
  await mkdir(output, { recursive: true });
  for (const file of plan) {
    const target = join(output, file.name);
    if (!within(output, target)) throw new Error('Invalid static asset path.');
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.from, target);
  }
  await copyFile(index, join(output, 'index.html'));
  await writeFile(join(output, '_headers'), HEADERS, 'utf8');
  return { output, files: plan.length + 2, skipped: skipped.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/build-cloudflare.mjs');
    console.log(JSON.stringify(await buildCloudflare()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
