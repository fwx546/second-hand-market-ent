// Local-only browser acceptance: real UI and business routes, isolated fake users/data.
// No school-email sends, production bindings, credentials or real account sessions.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { handleMarket } from '../server/market.mjs';
import { A, B, SQLiteD1, MemoryBucket, api, productInput, upload } from '../tests/support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = process.env.JUZI_QA_BROWSER || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
if (!executablePath) throw new Error('Set JUZI_QA_BROWSER to an installed Chrome/Chromium executable.');
const output = join(root, 'outputs', 'contact-browser', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const current = { DB: new SQLiteD1(), BUCKET: new MemoryBucket() };
const legacy = { DB: new SQLiteD1(undefined, false), BUCKET: new MemoryBucket() };
legacy.DB.sqlite.exec(await readFile(new URL('../cloudflare/migrations/0001_schema.sql', import.meta.url), 'utf8'));
const servers = [], errors = [], checks = [];
let browser;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function surface(env, viewer) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${server.address().port}`);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await handleMarket(new Request(url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), env, viewer,
          { authentication: { provider: 'school_email', email: { configured: true }, guest: { enabled: true } }, development: false });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const target = url.pathname === '/' ? join(root, 'legacy', 'index.html') : resolve(root, 'public', '.' + url.pathname);
      if (target !== join(root, 'legacy', 'index.html') && !target.startsWith(resolve(root, 'public') + (process.platform === 'win32' ? '\\' : '/'))) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(await readFile(target));
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  servers.push(server); return `http://localhost:${server.address().port}`;
}
async function listing(env, title, withChat = true) {
  const photo = await upload(env, A), body = productInput([photo.data.mediaId], { title }); delete body.contactType; delete body.contactValue;
  const created = await api(env, '/api/products', { method: 'POST', viewer: A, body }); assert.equal(created.status, 201);
  const product = created.data.product;
  if (!withChat) return { product };
  const chat = await api(env, '/api/conversations', { method: 'POST', viewer: B, body: { productId: product.id } });
  return { product, id: chat.data.conversationId };
}
async function shot(page, name) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(output, name + '.png'), fullPage: false, animations: 'disabled' }); }
async function ready(page, name) { await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 20000 }); }
async function noNumbers(page) { const text = await page.locator('body').innerText(); assert(!text.includes('browser_buyer_private')); assert(!text.includes('123456789')); }
async function offer(page, value, accept = false) {
  await page.getByRole('button', { name: accept ? '同意并选择我的联系方式' : '申请交换联系方式', exact: true }).click();
  if (accept) await page.getByLabel('本次分享的方式', { exact: true }).selectOption('qq');
  await page.getByLabel('我的联系方式', { exact: true }).fill(value);
  assert.equal(await page.locator('#exchange-consent').isChecked(), false);
  await page.locator('#exchange-consent').check();
  await page.getByRole('button', { name: accept ? '同意并交换' : '发送申请', exact: true }).click();
}
try {
  const first = await listing(current, '本地浏览器隐私验收', false);
  const sellerOrigin = await surface(current, A), buyerOrigin = await surface(current, B);
  const thirdOrigin = await surface(current, { ...A, userId: 'browser-unrelated-user' });
  const old = await listing(legacy, '旧数据库验收'), oldOrigin = await surface(legacy, B);
  browser = await chromium.launch({ executablePath, headless: true });
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })));
  for (const context of contexts) {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === 'localhost' || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
  }
  const [buyer, seller, third, oldPage] = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of [buyer, seller, third, oldPage]) page.on('pageerror', error => errors.push(error.message));

  // Detail opens chat; neither publishing nor private messages require numbers.
  await buyer.goto(`${buyerOrigin}/#/product/${first.product.id}`);
  await buyer.getByRole('button', { name: '发消息', exact: true }).first().click();
  await ready(buyer, '联系方式由你决定');
  const id = new URL(await buyer.url()).hash.split('/messages/')[1]; assert(id);
  await seller.goto(`${sellerOrigin}/#/messages/${id}`); await ready(seller, '联系方式由你决定');
  const direct = await buyer.request.get(`${buyerOrigin}/api/products/${first.product.id}/contact`); assert.equal(direct.status(), 403);
  await buyer.getByRole('textbox', { name: '私信内容', exact: true }).fill('尚未发送的浏览器草稿');
  await buyer.getByRole('button', { name: '申请交换联系方式', exact: true }).click();
  await buyer.getByLabel('我的联系方式', { exact: true }).fill('browser_buyer_private');
  await buyer.getByRole('button', { name: '发送申请', exact: true }).click();
  assert(await buyer.getByRole('dialog').isVisible());
  assert.equal(current.DB.sqlite.prepare('SELECT count(*) AS n FROM contact_exchanges').get().n, 0);
  await buyer.locator('#exchange-consent').check(); await buyer.getByRole('button', { name: '发送申请', exact: true }).click();
  await ready(buyer, '交换申请已发送'); await ready(seller, '对方申请交换联系方式');
  await noNumbers(seller); await shot(seller, 'pending-desktop');
  await offer(seller, '123456789', true);
  await ready(seller, '双方已同意本次交换'); await ready(buyer, '双方已同意本次交换');
  assert(await seller.locator('#contact-exchange-panel').evaluate(element => element === document.activeElement));
  assert((await buyer.locator('.exchange-contacts').innerText()).includes('123456789'));
  assert((await seller.locator('.exchange-contacts').innerText()).includes('browser_buyer_private'));
  assert.equal(await buyer.getByRole('textbox', { name: '私信内容', exact: true }).inputValue(), '尚未发送的浏览器草稿');
  await shot(buyer, 'accepted-desktop');
  await third.goto(`${thirdOrigin}/#/messages/${id}`); await third.getByText('对话不存在。', { exact: true }).waitFor({ timeout: 10000 });
  await noNumbers(third);
  await buyer.getByRole('button', { name: '停止共享', exact: true }).click();
  await buyer.getByRole('dialog').getByRole('button', { name: '停止共享', exact: true }).click();
  await buyer.getByText('本次共享已停止。', { exact: true }).waitFor(); await seller.getByText('本次共享已停止。', { exact: true }).waitFor({ timeout: 20000 });
  await noNumbers(buyer); await noNumbers(seller);
  await buyer.getByRole('button', { name: '发送', exact: true }).click();
  await seller.locator('.chat-message').filter({ hasText: '尚未发送的浏览器草稿' }).waitFor({ timeout: 20000 });
  checks.push('detail-to-chat', 'explicit-mutual-consent', 'no-pending-disclosure', 'third-party-denial', 'revoke-both-sides', 'composer-preserved', 'chat-after-revoke');

  // Seller-initiated requests are optional for the buyer, too.
  const second = await listing(current, '卖家申请与买家拒绝');
  await Promise.all([buyer.goto(`${buyerOrigin}/#/messages/${second.id}`), seller.goto(`${sellerOrigin}/#/messages/${second.id}`)]);
  await ready(seller, '联系方式由你决定'); await offer(seller, 'seller_offer_fixture');
  await ready(buyer, '对方申请交换联系方式'); await buyer.getByRole('button', { name: '暂不交换', exact: true }).click();
  await buyer.getByText('本次申请未被接受。', { exact: true }).waitFor(); await seller.getByText('本次申请未被接受。', { exact: true }).waitFor({ timeout: 20000 });
  assert(!((await buyer.locator('body').innerText()).includes('seller_offer_fixture'))); checks.push('seller-initiates', 'recipient-declines');

  // An acceptance modal open before cancellation cannot approve the stale request.
  const thirdChat = await listing(current, '撤回与过时同意');
  await Promise.all([buyer.goto(`${buyerOrigin}/#/messages/${thirdChat.id}`), seller.goto(`${sellerOrigin}/#/messages/${thirdChat.id}`)]);
  await ready(buyer, '联系方式由你决定'); await offer(buyer, 'cancel_fixture'); await ready(seller, '对方申请交换联系方式');
  await seller.getByRole('button', { name: '同意并选择我的联系方式', exact: true }).click();
  await seller.getByLabel('我的联系方式', { exact: true }).fill('seller_cancel_fixture'); await seller.locator('#exchange-consent').check();
  await buyer.getByRole('button', { name: '撤回申请', exact: true }).click();
  await seller.getByRole('button', { name: '同意并交换', exact: true }).click();
  await seller.locator('#exchange-feedback').filter({ hasText: '申请状态已变化' }).waitFor(); await seller.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  checks.push('cancel-request', 'stale-accept-rejected');

  // Form modal, focus trap and all responsive layouts.
  const responsive = await listing(current, '响应式与键盘验收');
  await buyer.goto(`${buyerOrigin}/#/messages/${responsive.id}`); await ready(buyer, '联系方式由你决定');
  for (const width of [320, 390, 1440]) {
    await buyer.setViewportSize({ width, height: 900 });
    assert(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await buyer.getByRole('button', { name: '申请交换联系方式', exact: true }).click();
    // A real periodic refresh while the dialog is open must preserve its return target.
    await buyer.waitForResponse(response => response.url().includes('/contact-exchange') && response.request().method() === 'GET', { timeout: 15000 });
    for (let i = 0; i < 10; i++) { await buyer.keyboard.press('Tab'); assert(await buyer.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]')))); }
    await shot(buyer, `request-dialog-${width}`); await buyer.keyboard.press('Escape'); assert.equal(await buyer.getByRole('dialog').count(), 0);
    assert(await buyer.getByRole('button', { name: '申请交换联系方式', exact: true }).evaluate(element => element === document.activeElement));
    await shot(buyer, `chat-${width}`);
  }
  checks.push('responsive-320-390-1440', 'keyboard-focus-trap', 'escape-to-dismiss');

  // Old database: no exchange table, but messaging is still usable.
  await oldPage.goto(`${oldOrigin}/#/messages/${old.id}`); await ready(oldPage, '安心站内沟通');
  await oldPage.getByRole('textbox', { name: '私信内容', exact: true }).fill('旧库仍可私信'); await oldPage.getByRole('button', { name: '发送', exact: true }).click();
  await oldPage.locator('.chat-message').filter({ hasText: '旧库仍可私信' }).waitFor(); checks.push('legacy-schema-chat');

  // An actual image upload and publication with no contact fields.
  await buyer.setViewportSize({ width: 1440, height: 1000 }); await buyer.goto(`${buyerOrigin}/#/publish`);
  await buyer.getByRole('textbox', { name: '商品标题 *', exact: true }).fill('无需联系方式的浏览器发布');
  await buyer.getByRole('spinbutton', { name: '转让价格（元） *', exact: true }).fill('25');
  await buyer.getByRole('textbox', { name: '面交地点 *', exact: true }).fill('校园公共区域');
  await buyer.getByRole('textbox', { name: '好物故事 *', exact: true }).fill('仅用于本地浏览器验收，不是真实交易。');
  await buyer.getByRole('textbox', { name: '型号 *', exact: true }).fill('本地验收型号'); await buyer.getByRole('textbox', { name: '使用情况 *', exact: true }).fill('正常使用');
  assert.equal(await buyer.locator('#field-contactValue').count(), 0);
  await buyer.locator('#photo-input').setInputFiles(join(root, 'public', 'assets', 'yoga.jpg'));
  await buyer.locator('.uploaded-item').waitFor(); await buyer.locator('[name="consent"]').check(); await buyer.getByRole('button', { name: '发布我的闲置', exact: true }).click();
  await buyer.waitForURL('**/#/profile'); await buyer.getByRole('heading', { name: '无需联系方式的浏览器发布', exact: true }).waitFor();
  const published = current.DB.sqlite.prepare('SELECT id FROM products WHERE title=?').get('无需联系方式的浏览器发布'); assert(published);
  assert.equal(current.DB.sqlite.prepare('SELECT count(*) AS n FROM private_contacts WHERE product_id=?').get(published.id).n, 0);
  await buyer.reload(); await buyer.getByRole('heading', { name: '无需联系方式的浏览器发布', exact: true }).waitFor(); checks.push('image-upload-publish-without-contacts', 'publication-survives-reload');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, mockSchoolIdentities: true, productionTouched: false, checks, output }));
} catch (error) {
  console.error('Contact browser acceptance failed:', error.message); throw error;
} finally {
  await browser?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  current.DB.close(); legacy.DB.close();
}
