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
  if (!validSecret(value)) throw new Error('已有私有密钥格式不适合自动配置，请手动检查；文件未改写。');
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
  writeFileSync(file, [...lines, ...Object.entries(values).map(([key,value]) => `${key}=${value}`), ''].join('\n'), { mode: 0o600 });
}

/** Prepare only local ignored configuration. Never connects to SMTP or prints credentials. */
export function prepareQQMail({ root = ROOT, sender, enable = false } = {}) {
  if (existsSync(resolve(root, '.dev.vars'))) throw new Error('检测到 .dev.vars 会覆盖 .env.local；请先统一本地配置，本次未改写。');
  const appPath = resolve(root, '.env.local'), relayPath = resolve(root, 'relay/.env.local');
  const app = readEnv(appPath), relay = readEnv(relayPath);
  sender = String(sender || relay.QQ_SMTP_USER || '').trim().toLowerCase();
  if (!/^[1-9][0-9]{4,11}@qq\.com$/.test(sender)) throw new Error('请提供完整的数字 QQ 邮箱地址，或先在 relay/.env.local 填写 QQ_SMTP_USER。');
  if (relay.QQ_SMTP_USER && relay.QQ_SMTP_USER !== sender && relay.QQ_SMTP_AUTH_CODE) throw new Error('发件账号已改变，请先清除旧账号授权码；本次未改写。');
  if (app.JUZI_EMAIL_RELAY_TOKEN && relay.JUZI_RELAY_TOKEN && app.JUZI_EMAIL_RELAY_TOKEN !== relay.JUZI_RELAY_TOKEN) throw new Error('两份本地配置的中继密钥不一致，请手动核对；本次未改写。');
  const token = secret(app.JUZI_EMAIL_RELAY_TOKEN || relay.JUZI_RELAY_TOKEN);
  const hmacSecret = secret(app.JUZI_EMAIL_AUTH_SECRET);
  const authCode = String(relay.QQ_SMTP_AUTH_CODE || '').trim();
  if (enable && !/^[A-Za-z]{16}$/.test(authCode)) throw new Error('请先在 relay/.env.local 填写16位 QQ 客户端授权码，然后重试。');
  const port = String(relay.QQ_RELAY_PORT || '').trim() || '4180';
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('本地中继端口无效，本次未改写。');
  const relayDaily = String(relay.QQ_RELAY_DAILY_LIMIT || '').trim() || '50';
  const appDaily = String(app.JUZI_EMAIL_DAILY_LIMIT || '').trim() || '50';
  if (!/^[1-9]\d{0,3}$/.test(relayDaily) || Number(relayDaily) > 1000 || !/^[1-9]\d{0,4}$/.test(appDaily) || Number(appDaily) > 10000) throw new Error('本地邮件日额度无效，本次未改写。');
  if (relay.QQ_RELAY_HOST && relay.QQ_RELAY_HOST !== '127.0.0.1') throw new Error('本地中继仅允许监听127.0.0.1，本次未改写。');
  const origin = app.JUZI_EMAIL_ORIGIN || 'http://localhost:4174';
  let originUrl;
  try { originUrl = new URL(origin); } catch { throw new Error('本地站点 Origin 无效，本次未改写。'); }
  if (originUrl.origin !== origin || originUrl.protocol !== 'http:' || originUrl.hostname !== 'localhost') throw new Error('此命令仅准备本地 localhost HTTP 配置，不会改写其他环境 Origin。');
  saveEnv(relayPath, {
    QQ_SMTP_USER: sender, QQ_SMTP_AUTH_CODE: authCode,
    JUZI_RELAY_TOKEN: token, QQ_RELAY_DAILY_LIMIT: relayDaily,
    QQ_RELAY_HOST: '127.0.0.1', QQ_RELAY_PORT: port,
  });
  saveEnv(appPath, {
    JUZI_EMAIL_PROVIDER: 'qq_relay', JUZI_EMAIL_ENABLED: enable ? 'true' : 'false',
    JUZI_EMAIL_ORIGIN: origin, JUZI_EMAIL_AUTH_SECRET: hmacSecret,
    JUZI_EMAIL_RELAY_URL: `http://127.0.0.1:${port}/send`, JUZI_EMAIL_RELAY_TOKEN: token,
    JUZI_EMAIL_DAILY_LIMIT: appDaily,
  });
  return { enabled: enable, appPath, relayPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(value => value.startsWith('--') && value !== '--enable') || args.filter(value => !value.startsWith('--')).length > 1) throw new Error('用法：npm run mail:setup -- 你的QQ邮箱 [--enable]');
    const result = prepareQQMail({ sender: args.find(value => !value.startsWith('--')), enable: args.includes('--enable') });
    console.log(result.enabled
      ? '已启用本地邮箱入口。请启动 mail:relay 并重启 dev；授权码有效性和收信需实际联测。'
      : '本地配置已准备，发信保持关闭。请私下填写 relay/.env.local 的 QQ_SMTP_AUTH_CODE，再运行 npm run mail:setup -- --enable。');
  } catch {
    console.error('本地配置未完成。请核对 QQ 地址、relay/.env.local 授权码、两侧中继密钥、localhost Origin 和 .dev.vars 优先级；不输出私有配置内容。');
    process.exitCode = 1;
  }
}
