import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { localDevPlan, localDevEnvironment, createDevSupervisor } from '../scripts/dev-local.mjs';

const token = 'development-test-token-with-at-least-32-characters';
const app = { JUZI_EMAIL_ENABLED: 'true', JUZI_EMAIL_PROVIDER: 'qq_relay', JUZI_EMAIL_ORIGIN: 'http://localhost:4174', JUZI_EMAIL_RELAY_URL: 'http://127.0.0.1:4180/send', JUZI_EMAIL_RELAY_TOKEN: token };
const relay = { QQ_RELAY_HOST: '127.0.0.1', QQ_RELAY_PORT: '4180', JUZI_RELAY_TOKEN: token };

test('default dev coordinates mail and website on the configured origin without changing secrets', () => {
  const plan = localDevPlan({ app, relay });
  assert.equal(plan.port, 4174); assert.equal(plan.relayPort, 4180); assert.equal(plan.useRelay, true);
  assert.deepEqual(plan.siteArgs, ['--port', '4174']);
  assert(!JSON.stringify(plan).includes(token));
  assert.equal(localDevPlan().port, 4174); assert.equal(localDevPlan().useRelay, false);
  assert.equal(localDevPlan({ app, relay, args: ['--site-only'] }).useRelay, false);
});

test('enabled login refuses a mismatched site origin or relay settings before starting anything', () => {
  for (const args of [['--port', '5173'], ['--port=5173'], ['-p', '0'], ['--hostname', '0.0.0.0'], ['--hostname=example.com']]) assert.throws(() => localDevPlan({ app, relay, args }));
  for (const changes of [{ JUZI_EMAIL_RELAY_TOKEN: 'wrong' }, { JUZI_EMAIL_RELAY_URL: 'https://other.test/send' }, { JUZI_EMAIL_ORIGIN: 'http://127.0.0.1:4174' }, { JUZI_EMAIL_ORIGIN: 'https://public.test' }]) assert.throws(() => localDevPlan({ app: { ...app, ...changes }, relay }));
  for (const changes of [{ QQ_RELAY_PORT: '04180' }, { QQ_RELAY_PORT: '4174' }, { QQ_RELAY_HOST: '0.0.0.0' }, { JUZI_RELAY_TOKEN: 'different' }]) assert.throws(() => localDevPlan({ app, relay: { ...relay, ...changes } }));
});

test('disabled mail permits an explicit dev port while enabled mail accepts only its exact origin', () => {
  assert.equal(localDevPlan({ app: { ...app, JUZI_EMAIL_ENABLED: 'false' }, args: ['--port', '5173'] }).port, 5173);
  assert.equal(localDevPlan({ app, relay, args: ['--port=4174'] }).port, 4174);
  assert.equal(localDevPlan({ app: { ...app, JUZI_EMAIL_ORIGIN: 'http://localhost:4200' }, relay }).port, 4200);
  assert.equal(localDevPlan({ app: { ...app, JUZI_EMAIL_PROVIDER: 'resend' } }).useRelay, false);
  assert.throws(() => localDevPlan({ args: ['--port'] }));
  for (const args of [['-H0.0.0.0'], ['--host', '0.0.0.0'], ['--host=0.0.0.0'], ['-p4174'], ['--hostname']]) assert.throws(() => localDevPlan({ app, relay, args }));
  assert.equal(localDevPlan({ app, relay, args: ['-H', 'localhost', '-p', '4174'] }).port, 4174);
});

test('mail convenience loader has the same supported .env precedence as the Worker', () => {
  const files = { '.env': { JUZI_EMAIL_ENABLED: 'false', OTHER_SETTING: 'base' }, '.env.local': app,
    '.env.development': { NEXT_PUBLIC_LABEL: 'development' }, 'relay/.env.local': relay };
  const result = localDevEnvironment({ files, processEnv: { PATH: 'ordinary-system-path' } });
  assert.equal(result.app.JUZI_EMAIL_ENABLED, 'true');
  assert.equal(result.app.OTHER_SETTING, 'base');
  assert.deepEqual(result.relay, relay);
  assert(!Object.hasOwn(result.app, 'PATH'));
  assert.equal(localDevPlan(result).useRelay, true);
});

test('mail convenience loader refuses exclusive, named and shell overrides without reflecting values', () => {
  const sensitive = 'value-that-must-not-be-printed';
  const conflicts = [
    { devVarFiles: ['.dev.vars'] }, { devVarFiles: ['.dev.vars.staging'] },
    { processEnv: { JUZI_EMAIL_RELAY_TOKEN: sensitive } }, { processEnv: { qq_smtp_auth_code: sensitive } },
    { files: { '.env.development': { JUZI_EMAIL_ENABLED: 'false' } } },
    { files: { '.env.development.local': { RESEND_API_KEY: sensitive } } },
    { files: { '.env.local': { CLOUDFLARE_ENV: 'staging' } } },
    { processEnv: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' } },
    { processEnv: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } },
    { files: { '.env.local': { JUZI_EMAIL_RELAY_TOKEN: '$PRIVATE_REFERENCE' } } },
  ];
  for (const conflict of conflicts) assert.throws(() => localDevEnvironment(conflict), error => {
    assert(!error.message.includes(sensitive)); assert(!error.message.includes('PRIVATE_REFERENCE'));
    assert.match(error.message, /\.env\.local/); return true;
  });
});

function fakeProcesses() {
  const calls = [], failures = [], kills = [], timers = [];
  let nextPid = 201;
  const spawnProcess = (executable, argv, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.kill = signal => { kills.push([child.pid, signal]); return true; };
    calls.push({ executable, argv, options, child });
    return child;
  };
  const options = { spawnProcess, executable: 'owned-node.exe', root: 'project-root', reportFailure: code => failures.push(code),
    killProcess: (pid, signal) => kills.push([pid, signal]), setTimer: callback => { timers.push(callback); return { unref() {} }; } };
  return { calls, failures, kills, timers, options };
}

test('Windows shutdown terminates only captured live child PID trees with hidden taskkill processes', async () => {
  const fake = fakeProcesses();
  const supervisor = createDevSupervisor({ ...fake.options, platform: 'win32' });
  const relayChild = supervisor.start(['relay/run.mjs']).child;
  const siteChild = supervisor.start(['scripts/run-framework.mjs', 'dev']).child;
  const stopping = supervisor.stop();
  assert.deepEqual(fake.calls.slice(2).map(call => [call.executable, call.argv]), [
    ['taskkill.exe', ['/PID', '201', '/T', '/F']], ['taskkill.exe', ['/PID', '202', '/T', '/F']],
  ]);
  for (const call of fake.calls) assert.equal(call.options.windowsHide, true);
  relayChild.emit('exit', null, 'SIGTERM'); siteChild.emit('exit', null, 'SIGTERM');
  for (const call of fake.calls.slice(2)) call.child.emit('exit', 0);
  await stopping;
  assert.deepEqual(fake.failures, []);
  assert.throws(() => supervisor.start(['another-child']), /正在停止/);
  assert.equal(fake.calls.length, 4);
});

test('unexpected child signal is failure and shuts down the remaining owned sibling', async () => {
  const fake = fakeProcesses();
  const supervisor = createDevSupervisor({ ...fake.options, platform: 'win32' });
  const first = supervisor.start(['first']).child;
  const second = supervisor.start(['second']).child;
  first.emit('exit', null, 'SIGKILL');
  assert.deepEqual(fake.failures, [1]);
  assert.deepEqual(fake.calls[2].argv, ['/PID', String(second.pid), '/T', '/F']);
  assert.equal(fake.calls.length, 3);
  second.emit('exit', null, 'SIGTERM'); fake.calls[2].child.emit('exit', 0);
  await supervisor.stop();
});

test('successful migrations can finish without stopping services; unexpected normal service exit is failure', async () => {
  const fake = fakeProcesses();
  const supervisor = createDevSupervisor({ ...fake.options, platform: 'win32' });
  const migration = supervisor.start(['migration'], { persistent: false });
  migration.child.emit('exit', 0, null);
  assert.equal((await migration.done).code, 0); assert.equal(supervisor.stopping, false);
  assert.deepEqual(fake.failures, []);
  supervisor.start(['service']).child.emit('exit', 0, null);
  assert.deepEqual(fake.failures, [1]); assert.equal(supervisor.stopping, true);
});

test('spawn failures and unknown PIDs never become taskkill targets or expose process errors', async () => {
  const fake = fakeProcesses();
  const supervisor = createDevSupervisor({ ...fake.options, platform: 'win32' });
  const service = supervisor.start(['service']);
  service.child.emit('error', new Error('private-detail-do-not-log'));
  assert.equal((await service.done).code, 1); assert.deepEqual(fake.failures, [1]);
  assert.equal(fake.calls.length, 1);
  const invalid = fakeProcesses();
  const invalidSupervisor = createDevSupervisor({ ...invalid.options, platform: 'win32' });
  const invalidChild = invalidSupervisor.start(['service']).child;
  invalidChild.pid = undefined; // The supervisor already captured the original owned PID.
  const stopping = invalidSupervisor.stop();
  assert.deepEqual(invalid.calls[1].argv, ['/PID', '201', '/T', '/F']);
  invalidChild.emit('exit', null, 'SIGTERM'); invalid.calls[1].child.emit('exit', 0);
  await stopping;
  const noPid = fakeProcesses();
  const noPidSupervisor = createDevSupervisor({ ...noPid.options, platform: 'win32', spawnProcess(...args) {
    const child = noPid.options.spawnProcess(...args); child.pid = undefined; return child;
  } });
  const noPidChild = noPidSupervisor.start(['unspawned']).child;
  await noPidSupervisor.stop();
  noPidChild.emit('error', new Error('spawn failed'));
  assert.equal(noPid.calls.length, 1); assert.deepEqual(noPid.kills, []);
});

test('Unix shutdown signals the owned process groups and does not escalate after children exit', async () => {
  const fake = fakeProcesses();
  const supervisor = createDevSupervisor({ ...fake.options, platform: 'linux' });
  const service = supervisor.start(['service']);
  assert.equal(fake.calls[0].options.detached, true);
  const stopping = supervisor.stop();
  assert.deepEqual(fake.kills, [[-201, 'SIGTERM']]);
  service.child.emit('exit', null, 'SIGTERM'); await stopping;
  fake.timers[0]();
  assert.deepEqual(fake.kills, [[-201, 'SIGTERM']]);
  assert.deepEqual(fake.failures, []);
});
