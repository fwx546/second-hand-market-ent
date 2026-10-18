import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readExecutionProfile } from './execution-profile.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
class LocalDevError extends Error {}
const readEnv = file => existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const portNumber = value => typeof value === 'string' && /^[1-9]\d{0,4}$/.test(value) && Number(value) <= 65535 ? Number(value) : 0;
const mailKey = key => /^(?:JUZI_|QQ_|RESEND_API_KEY$)/i.test(key);

/** Match the Worker's default .env + .env.local sources; refuse ambiguous overrides. */
export function localDevEnvironment({ files = {}, processEnv = {}, devVarFiles = [] } = {}) {
  const instruction = '请将本地邮件配置放入 .env.local 和 relay/.env.local；自定义环境请直接运行 node scripts/run-framework.mjs dev --port 4174，并单独启动邮件中继。';
  if (devVarFiles.length || Object.keys(processEnv).some(mailKey) ||
      ['.env.development', '.env.development.local'].some(file => Object.keys(files[file] || {}).some(mailKey))) {
    throw new LocalDevError(`检测到会覆盖本地邮件配置的环境来源。${instruction}`);
  }
  const loaderSources = [...Object.values(files), processEnv];
  if (loaderSources.some(source => source.CLOUDFLARE_ENV !== undefined ||
      (source.CLOUDFLARE_INCLUDE_PROCESS_ENV !== undefined && source.CLOUDFLARE_INCLUDE_PROCESS_ENV !== 'false') ||
      (source.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV !== undefined && source.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV !== 'true'))) {
    throw new LocalDevError(`检测到自定义 Cloudflare 环境加载设置。${instruction}`);
  }
  const app = { ...files['.env'], ...files['.env.local'] };
  if (Object.entries(app).some(([key, value]) => mailKey(key) && typeof value === 'string' && value.includes('$'))) {
    throw new LocalDevError(`本地邮件配置请直接填写值，不使用变量引用。${instruction}`);
  }
  return { app, relay: { ...files['relay/.env.local'] } };
}

/** Derive listener settings without exposing or rewriting private configuration. */
export function localDevPlan({ app = {}, relay = {}, args = [] } = {}) {
  const siteOnly = args.includes('--site-only'), forwarded = args.filter(value => value !== '--site-only');
  let requestedPort;
  for (let i = 0; i < forwarded.length; i++) {
    if (/^-(?:H|p).+/.test(forwarded[i]) || /^--host(?:=|$)/.test(forwarded[i])) throw new LocalDevError('请使用 --port <端口> 和 --hostname localhost。');
    if (['--port', '-p'].includes(forwarded[i])) {
      requestedPort = forwarded[++i];
      if (!portNumber(requestedPort)) throw new LocalDevError('网站端口无效。');
    }
    else if (forwarded[i].startsWith('--port=')) requestedPort = forwarded[i].slice(7);
    if (['--hostname', '-H'].includes(forwarded[i])) {
      if (forwarded[++i] !== 'localhost') throw new LocalDevError('本地邮件开发请使用 localhost。');
    } else if (forwarded[i]?.startsWith('--hostname=') && forwarded[i] !== '--hostname=localhost') throw new LocalDevError('本地邮件开发请使用 localhost。');
  }
  const mailEnabled = app.JUZI_EMAIL_ENABLED === 'true';
  let origin;
  if (app.JUZI_EMAIL_ORIGIN) {
    try { origin = new URL(app.JUZI_EMAIL_ORIGIN); } catch { throw new LocalDevError('请核对本地邮件 Origin 配置。'); }
    if (origin.origin !== app.JUZI_EMAIL_ORIGIN || origin.protocol !== 'http:' || origin.hostname !== 'localhost') throw new LocalDevError('开发启动只接受 http://localhost 的邮件 Origin。');
  }
  const port = requestedPort === undefined ? (origin ? Number(origin.port || 80) : 4174) : portNumber(requestedPort);
  if (!port) throw new LocalDevError('网站端口无效。');
  if (mailEnabled && (!origin || port !== Number(origin.port || 80))) throw new LocalDevError('网站端口须与 .env.local 中 JUZI_EMAIL_ORIGIN 一致。');
  const useRelay = mailEnabled && app.JUZI_EMAIL_PROVIDER === 'qq_relay' && !siteOnly;
  const relayPort = portNumber(relay.QQ_RELAY_PORT || '4180');
  if (useRelay) {
    if (!relayPort || (relay.QQ_RELAY_HOST && relay.QQ_RELAY_HOST !== '127.0.0.1') || relayPort === port) throw new LocalDevError('请核对本地中继端口与监听地址。');
    if (app.JUZI_EMAIL_RELAY_URL !== `http://127.0.0.1:${relayPort}/send` ||
        typeof app.JUZI_EMAIL_RELAY_TOKEN !== 'string' || app.JUZI_EMAIL_RELAY_TOKEN.length < 32 ||
        app.JUZI_EMAIL_RELAY_TOKEN !== relay.JUZI_RELAY_TOKEN) throw new LocalDevError('网站和中继配置不匹配，请运行 mail:setup 核对私有配置。');
  }
  return { port, relayPort, useRelay, mailEnabled, siteArgs: ['--port', String(port), ...forwarded] };
}

/** Own only the subprocesses created here; tests inject inert process handles. */
export function createDevSupervisor({ spawnProcess = spawn, platform = process.platform, executable = process.execPath,
  root = ROOT, killProcess = process.kill.bind(process), reportFailure = () => {}, setTimer = setTimeout } = {}) {
  const children = new Set();
  let stopping = false, stopPromise;
  const childOptions = { cwd: root, stdio: 'inherit', windowsHide: true, ...(platform === 'win32' ? {} : { detached: true }) };
  const fail = code => { reportFailure(Number.isInteger(code) && code > 0 ? code : 1); void stop(); };
  function stop() {
    if (stopping) return stopPromise || Promise.resolve();
    stopping = true;
    const active = [...children];
    stopPromise = Promise.all(active.map(entry => {
      const { child, pid, done } = entry;
      // A PID is captured immediately after our own spawn, and never used after exit.
      if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
      if (platform === 'win32') return new Promise(resolveStop => {
        let killer;
        try { killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { cwd: root, stdio: 'ignore', windowsHide: true }); }
        catch { reportFailure(1); if (children.has(entry)) child.kill('SIGTERM'); resolveStop(); return; }
        killer.once('error', () => { reportFailure(1); if (children.has(entry)) child.kill('SIGTERM'); resolveStop(); });
        killer.once('exit', code => { if (code && children.has(entry)) reportFailure(1); resolveStop(); });
      });
      try { killProcess(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      const timer = setTimer(() => {
        if (!children.has(entry)) return;
        try { killProcess(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, 5000);
      timer?.unref?.();
      return done;
    })).then(() => undefined);
    return stopPromise;
  }
  function start(argv, { persistent = true } = {}) {
    if (stopping) throw new LocalDevError('本地开发正在停止，请重新启动。');
    let child;
    try { child = spawnProcess(executable, argv, childOptions); }
    catch { fail(1); return { done: Promise.resolve({ code: 1, signal: null }), child: null }; }
    let settle;
    const done = new Promise(resolveDone => { settle = resolveDone; });
    const entry = { child, pid: child.pid, done };
    children.add(entry);
    child.once('error', () => {
      children.delete(entry); settle({ code: 1, signal: null });
      if (!stopping) fail(1);
    });
    child.once('exit', (code, signal) => {
      children.delete(entry); settle({ code, signal });
      if (!stopping && (persistent || code !== 0 || signal)) fail(code);
    });
    return { child, done };
  }
  return { start, stop, get stopping() { return stopping; } };
}

async function assertPortFree(port, host, label) {
  const listener = createServer();
  await new Promise((accept, reject) => {
    listener.once('error', () => reject(new LocalDevError(`${label}端口 ${port} 已被占用，请先停止对应服务。单独启动网站可用 npm run dev:site。`)));
    listener.listen(port, host, accept);
  });
  await new Promise(accept => listener.close(accept));
}

async function main() {
  process.chdir(ROOT);
  const args = process.argv.slice(2);
  if (readExecutionProfile() === 'managed-linux') {
    process.argv = [process.execPath, resolve(ROOT, 'scripts/run-framework.mjs'), 'dev', ...args];
    await import('./run-framework.mjs');
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.info('用法：npm run dev [-- --port <端口>]；默认端口取本地邮件 Origin，未配置时为 4174。');
    console.info('npm run dev:site 仅启动网站。支持 --hostname localhost；Ctrl+C 停止本次启动的网站与邮件中继。');
    return;
  }
  const files = Object.fromEntries(['.env', '.env.local', '.env.development', '.env.development.local', 'relay/.env.local'].map(file => [file, readEnv(file)]));
  const { app, relay } = localDevEnvironment({ files, processEnv: process.env, devVarFiles: readdirSync(ROOT).filter(file => file === '.dev.vars' || file.startsWith('.dev.vars.')) });
  const plan = localDevPlan({ app, relay, args });
  if (plan.useRelay) {
    const { readRelayConfig } = await import('../relay/core.mjs');
    try { readRelayConfig(relay); } catch { throw new LocalDevError('QQ 发信配置尚未填好，请检查 relay/.env.local 的授权码。'); }
    if (!existsSync('relay/node_modules/nodemailer/package.json')) throw new LocalDevError('请先运行 npm --prefix relay ci。');
    await assertPortFree(plan.relayPort, '127.0.0.1', '邮件中继');
  }
  await assertPortFree(plan.port, '127.0.0.1', '网站');
  if (!existsSync('dist/server/wrangler.json')) throw new LocalDevError('首次启动请先运行 npm run build。');

  let failureReported = false;
  const supervisor = createDevSupervisor({ reportFailure(code) {
    process.exitCode = code;
    if (!failureReported) console.error('本地开发进程已停止，请核对依赖、端口与运行权限。');
    failureReported = true;
  } });
  process.once('SIGINT', () => { void supervisor.stop(); });
  process.once('SIGTERM', () => { void supervisor.stop(); });
  // Apply only the project's local emulator migrations, retaining existing records.
  const migration = supervisor.start(['scripts/migrate-local.mjs'], { persistent: false });
  const { code: migrationCode } = await migration.done;
  if (migrationCode !== 0 || supervisor.stopping) { if (!supervisor.stopping) process.exitCode = 1; return; }
  if (plan.useRelay) supervisor.start(['--env-file=relay/.env.local', 'relay/run.mjs']);
  if (supervisor.stopping) return;
  console.info(`橘子集本地开发：http://localhost:${plan.port}/`);
  console.info(plan.useRelay ? '已同时启动 QQ 邮件中继；Ctrl+C 停止网站与中继。启动不会发送验证码邮件。' : '仅启动网站；邮件中继需单独运行（如使用 QQ 发信）。');
  supervisor.start(['scripts/run-framework.mjs', 'dev', ...plan.siteArgs]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Configuration errors above contain instructions only, never private values.
  console.error(error instanceof LocalDevError ? error.message : '本地启动失败，请检查本地配置、依赖与运行权限。');
  process.exitCode = 1;
});
