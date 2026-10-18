import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleMarket } from '../server/market.mjs';

export const ORIGIN = 'https://juzi.example';
export const A = { userId: 'school-user-A', provider: 'school_email', emailVerified: true, emailMasked: 'a***1@student.xjtlu.edu.cn' };
export const B = { userId: 'school-user-B', provider: 'school_email', emailVerified: true, emailMasked: 'b***2@student.xjtlu.edu.cn' };
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHKkAAAAASUVORK5CYII=', 'base64');

class D1Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.db, this.sql, values); }
  async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SQLiteD1 {
  constructor(filename = ':memory:', migrate = true) {
    this.sqlite = new DatabaseSync(filename);
    this.batchQueue = Promise.resolve();
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    if (migrate) {
      const folder = new URL('../drizzle/', import.meta.url);
      const migrations = readdirSync(folder).filter(name => name.endsWith('.sql')).sort();
      if (!migrations.length) throw new Error('Generate the real migration first with npm run db:generate.');
      for (const file of migrations) this.sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));
    }
  }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) {
    const operation = this.batchQueue.then(async () => {
      this.sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.batchQueue = operation.catch(() => {});
    return operation;
  }
  close() { this.sqlite.close(); }
}

export class MemoryBucket {
  objects = new Map();
  async put(key, bytes, options) { this.objects.set(key, { bytes: new Uint8Array(bytes), options }); }
  async get(key) {
    const stored = this.objects.get(key);
    return stored ? { body: stored.bytes, size: stored.bytes.length } : null;
  }
  async delete(key) { this.objects.delete(key); }
}

export function fixture(t, options = {}) {
  const env = { DB: new SQLiteD1(options.filename, options.migrate), BUCKET: options.bucket || new MemoryBucket() };
  t.after(() => env.DB.close());
  return env;
}

export async function api(env, path, options = {}) {
  const { method = 'GET', viewer = null, body, origin = ORIGIN } = options;
  const headers = new Headers(options.headers);
  if (method !== 'GET' && origin !== null) headers.set('Origin', origin);
  let content;
  if (body !== undefined) {
    if (body instanceof FormData) content = body;
    else { headers.set('Content-Type', 'application/json'); content = typeof body === 'string' ? body : JSON.stringify(body); }
  }
  const response = await handleMarket(new Request(`${ORIGIN}${path}`, { method, headers, body: content }), env, viewer, options.backendOptions);
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, status: response.status, data };
}

export function productInput(imageIds, extra = {}) {
  return {
    title: '书桌小风扇', category: 'appliance', price: 35.25, originalPrice: 129,
    condition: '九成新', campus: 'SIP 校区', location: '图书馆公共入口',
    description: '使用一学期，运行正常，可面交试用。', specs: { 型号: 'USB桌面风扇', 使用情况: '使用一学期' },
    graduation: false, seller: '小橘同学', contactType: 'wechat', contactValue: 'juzi_test_contact', imageIds, ...extra,
  };
}

export async function upload(env, viewer = A, options = {}) {
  const form = new FormData();
  form.append('file', new Blob([options.bytes || PNG], { type: options.type || 'image/png' }), options.name || 'photo.png');
  return api(env, '/api/media', { method: 'POST', viewer, body: form });
}

export async function publish(env, viewer = A, extra = {}) {
  const uploaded = await upload(env, viewer);
  if (uploaded.status !== 201) throw new Error(`Upload failed: ${JSON.stringify(uploaded.data)}`);
  return api(env, '/api/products', { method: 'POST', viewer, body: productInput([uploaded.data.mediaId], extra) });
}

