import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { api as browserApi } from '../public/api.js';

// Exercise the shipped browser functions with a small DOM boundary. No service
// configuration, credentials, browser cookies or real authentication is used.
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/await refreshSession\(\);\s*$/, '');

function client(session = { user: null, development: false }, api = {}) {
  const modalRoot = { innerHTML: '', hasChildNodes() { return Boolean(this.innerHTML); } };
  const elements = { '#app': { innerHTML: '' }, '#modal-root': modalRoot, '.modal': { focus() {} }, '#toast': { classList: { add() {}, remove() {} } } };
  const windowEvents = new Map(), navigation = [];
  const context = {
    URL, URLSearchParams, FormData, console, setTimeout, clearTimeout, api, categories: [],
    location: { origin: 'https://campus.test', hash: '#/publish' }, history: { replaceState() {} },
    document: {
      querySelector(selector) { return elements[selector] || null; }, querySelectorAll() { return []; },
      activeElement: null, addEventListener() {}, body: { classList: { add() {}, remove() {} } },
    },
    window: { scrollTo() {}, top: { location: { assign(path) { navigation.push(path); } } }, addEventListener(name, callback) { windowEvents.set(name, callback); } },
  };
  vm.runInNewContext(`${source}\nglobalThis.test={state,safeReturnTo,loginPath,loginPage,authGate,footer,promptLogin,profile,newDraft,loadRoute,confirmLogout,logout,trustedSignOutPath};`, context);
  context.test.state.session = session;
  return { ...context.test, context, modalRoot, navigation, windowEvents, elements };
}

function externalSession(methods = { phone: true, wechat: true }, extra = {}) {
  return { user: null, development: false, authentication: { provider: null, external: { configured: true, methods, startUrl: '/api/auth/start' }, platform: { enabled: true } }, ...extra };
}

test('return destinations stay within existing same-origin hash routes', () => {
  const c = client();
  for (const path of ['/#/', '/#/publish', '/#/publish?edit=abc-123', '/#/profile?tab=favorites', '/#/product/abc-123']) assert.equal(c.safeReturnTo(path), path);
  for (const path of ['https://evil.test/', '//evil.test/', '/api/auth/start', '/#/login', '/signout-with-chatgpt', '/\\evil.test/', '/\n#/publish', '/%2f%2fevil.test/']) assert.equal(c.safeReturnTo(path), '/#/');
  assert.equal(c.safeReturnTo(null), '/#/');
  assert.equal(c.loginPath('/#/publish'), '#/login?return_to=%2F%23%2Fpublish');
});

test('unconfigured methods are unavailable and old sessions retain ChatGPT fallback', () => {
  const c = client();
  const html = c.loginPage(new URLSearchParams('return_to=%2F%23%2Fpublish'));
  assert.equal((html.match(/<article class="login-method /g) || []).length, 2);
  assert.match(html, /<button[^>]*disabled>手机号和微信登录尚未开通/);
  assert(!html.includes('href="/api/auth/start'));
  assert.match(html, /href="\/signin-with-chatgpt\?return_to=%2F%23%2Fpublish" target="_top"/);
  assert(!html.includes('<input') && !html.includes('<iframe'));
});

test('enabled external methods expose one hosted-login link with the actual method label', () => {
  for (const [methods, label] of [[{ phone: true, wechat: true }, '手机号 / 微信'], [{ phone: true, wechat: false }, '手机号'], [{ phone: false, wechat: true }, '微信']]) {
    const c = client(externalSession(methods));
    const html = c.loginPage(new URLSearchParams('return_to=%2F%23%2Fprofile'));
    assert.equal((html.match(/href="\/api\/auth\/start\?/g) || []).length, 1);
    assert(html.includes(`前往${label}登录`));
    assert.match(html, /href="\/api\/auth\/start\?return_to=%2F%23%2Fprofile" target="_top"/);
  }
});

test('callback errors use fixed messages and never echo unknown provider data', () => {
  const c = client(externalSession());
  assert(c.loginPage(new URLSearchParams({ auth_error: 'expired_flow' })).includes('登录已超时，请重新开始。'));
  for (const code of ['<img src=x onerror=alert(1)>', '__proto__', 'https://private.test/token-secret']) {
    const html = c.loginPage(new URLSearchParams({ auth_error: code, error_description: 'sensitive-provider-detail' }));
    assert(html.includes('登录未完成，请重新选择可用方式。'));
    assert(!html.includes(code) && !html.includes('sensitive-provider-detail'));
  }
});

test('gates, modal prompts and footer enter the same internal login selection page', () => {
  const c = client();
  for (const html of [c.authGate(), c.footer()]) {
    assert(html.includes('href="#/login?return_to=%2F%23%2Fpublish"'));
    assert(!html.includes('href="/signin-with-chatgpt'));
  }
  c.promptLogin();
  assert(c.modalRoot.innerHTML.includes('href="#/login?return_to=%2F%23%2Fpublish"'));
});

test('profile identity distinguishes external accounts and local platform simulation', () => {
  const external = client(externalSession(undefined, { user: { id: 'ext_1' }, authentication: { provider: 'external', external: { configured: true, methods: { phone: true, wechat: true } }, platform: { enabled: true } } }));
  assert(external.profile().includes('手机号 / 微信账号 已登录'));
  const local = client({ user: { id: 'local_seedy' }, development: true });
  assert(local.profile().includes('本地模拟账号 Seedy 已登录'));
  assert(local.loginPage(new URLSearchParams()).includes('本地模拟 ChatGPT 登录'));
  assert(!local.profile().includes('ChatGPT 已登录'));
});

test('draft warning survives the intermediate login page and retains beforeunload protection', async () => {
  const c = client();
  c.state.draft = c.newDraft(); c.state.draft.fields.title = 'Unsaved title';
  c.context.location.hash = '#/login?return_to=%2F%23%2Fpublish';
  await c.loadRoute();
  assert(c.elements['#app'].innerHTML.includes('跳转到登录服务会清空未保存的表单和照片'));
  let prevented = false;
  c.windowEvents.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert(prevented); assert.equal(c.state.draft.fields.title, 'Unsaved title');
});

test('logout requires confirmation and a successful API result before trusted top-level navigation', async () => {
  let calls = 0;
  const c = client({ user: { id: 'user1' } }, { logout: async () => { calls++; return { redirectTo: '/signout-with-chatgpt?return_to=%2F' }; } });
  c.confirmLogout(); assert.equal(calls, 0); assert(c.modalRoot.innerHTML.includes('确认退出'));
  await c.logout(); assert.equal(calls, 1); assert.deepEqual(c.navigation, ['/signout-with-chatgpt?return_to=%2F%23%2F']);
  assert.equal(c.state.session.user.id, 'user1'); // UI does not manufacture an anonymous session.
});

test('failed logout and untrusted redirects never claim successful logout or navigate', async () => {
  for (const response of [{ redirectTo: '//evil.test/' }, { redirectTo: '/api/products' }, null]) {
    const c = client({ user: { id: 'user1' } }, { logout: async () => { if (!response) throw new Error('Network unavailable'); return response; } });
    await c.logout(); assert.equal(c.navigation.length, 0); assert(c.modalRoot.innerHTML.includes('尚未完成退出'));
    assert.equal(c.state.session.user.id, 'user1');
  }
});

test('browser logout uses a same-origin POST with JSON and credentials', async t => {
  let call;
  t.mock.method(globalThis, 'fetch', async (path, options) => { call = { path, options }; return Response.json({ redirectTo: '/signout-with-chatgpt?return_to=%2F' }); });
  await browserApi.logout();
  assert.equal(call.path, '/api/auth/logout'); assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.headers['Content-Type'], 'application/json');
});
