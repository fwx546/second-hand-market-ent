import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const readEnv = file => existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const validSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
function secret(value) {
  if (!value) return randomBytes(32).toString('hex');
  if (!validSecret(value)) throw new Error('已有密钥格式无效，本次未改写。');
  return value;
}
function saveEnv(file, values) {
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const managed = new Set(Object.keys(values));
  const lines = original.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !managed.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...lines, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n'), { mode: 0o600 });
}
function deploymentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写已部署的 Apps Script /exec 地址。'); }
  if (url.href !== value || url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/macros\/s\/[A-Za-z0-9_-]{16,256}\/exec$/.test(url.pathname)) {
    throw new Error('请填写已部署的 Apps Script /exec 地址。');
  }
  return value;
}

/** Prepare an ignored handoff; leave the working sender unchanged until explicitly enabled. */
export function prepareGmailMail({ root = ROOT, sender, url, enable = false } = {}) {
  const appPath = resolve(root, '.env.local'), scriptPath = resolve(root, 'gmail-apps-script/.env.local');
  const app = readEnv(appPath), script = readEnv(scriptPath);
  sender = String(sender || script.GMAIL_SENDER || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@gmail\.com$/.test(sender)) throw new Error('请填写自己的 Gmail 发件账号。');
  if (script.GMAIL_SENDER && script.GMAIL_SENDER !== sender) throw new Error('已有发件账号不同，请先核对 Google 项目所属账号；本次未改写。');
  if (app.JUZI_GMAIL_SCRIPT_SECRET && script.JUZI_GMAIL_SCRIPT_SECRET && app.JUZI_GMAIL_SCRIPT_SECRET !== script.JUZI_GMAIL_SCRIPT_SECRET) throw new Error('网站与脚本共享密钥不一致，本次未改写。');
  const sharedSecret = secret(script.JUZI_GMAIL_SCRIPT_SECRET || app.JUZI_GMAIL_SCRIPT_SECRET);
  const endpoint = url || script.JUZI_GMAIL_SCRIPT_URL || '';
  if (endpoint) deploymentUrl(endpoint);
  const daily = script.JUZI_GMAIL_DAILY_LIMIT || '50';
  if (!/^[1-9]\d{0,2}$/.test(daily) || Number(daily) > 100) throw new Error('Gmail 发信上限应为 1–100，本次未改写。');
  let hmacSecret, origin;
  if (enable) {
    if (!endpoint) throw new Error('启用前请先授权并部署 Apps Script，再填写 /exec 地址。');
    if (existsSync(resolve(root, '.dev.vars'))) throw new Error('.dev.vars 会覆盖 .env.local，请先统一本地配置。');
    origin = app.JUZI_EMAIL_ORIGIN || 'http://localhost:4174';
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('本地 Origin 无效，本次未改写。'); }
    if (parsed.origin !== origin || parsed.protocol !== 'http:' || parsed.hostname !== 'localhost') throw new Error('此命令只启用本地 localhost 配置，不改写生产配置。');
    hmacSecret = secret(app.JUZI_EMAIL_AUTH_SECRET);
  }
  saveEnv(scriptPath, {
    GMAIL_SENDER: sender, JUZI_GMAIL_SCRIPT_SECRET: sharedSecret,
    JUZI_GMAIL_SCRIPT_URL: endpoint, JUZI_GMAIL_DAILY_LIMIT: daily,
    ENABLED: script.ENABLED === 'true' ? 'true' : 'false',
  });
  if (enable) saveEnv(appPath, {
    JUZI_EMAIL_PROVIDER: 'gmail_apps_script', JUZI_EMAIL_ENABLED: 'true',
    JUZI_EMAIL_ORIGIN: origin, JUZI_EMAIL_AUTH_SECRET: hmacSecret,
    JUZI_GMAIL_SCRIPT_URL: endpoint, JUZI_GMAIL_SCRIPT_SECRET: sharedSecret,
    JUZI_EMAIL_DAILY_LIMIT: daily,
  });
  return { enabled: enable, appPath, scriptPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let sender, url, enable = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--enable') enable = true;
      else if (args[i] === '--url' && args[i + 1] && !args[i + 1].startsWith('--')) url = args[++i];
      else if (!args[i].startsWith('--') && !sender) sender = args[i];
      else throw new Error('参数无效。');
    }
    const result = prepareGmailMail({ sender, url, enable });
    console.info(result.enabled
      ? '已切换本地发信配置；请确认 Google 项目已授权并启用，重启 npm run dev 后联测。此命令不会部署或发送邮件。'
      : '已准备 gmail-apps-script/.env.local，当前网站发信配置保持原样。请在 Google 授权并部署脚本，不要将私有配置提交或发到聊天。');
  } catch {
    console.error('Gmail 配置未完成。请核对自己的 Gmail、已部署 /exec 地址、共享密钥与 localhost Origin；不会输出私有内容。用法：npm run mail:gmail:setup -- 你的Gmail [--url 部署地址] [--enable]');
    process.exitCode = 1;
  }
}
