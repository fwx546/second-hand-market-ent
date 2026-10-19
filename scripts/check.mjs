import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const manifest=JSON.parse(await readFile('.openai/hosting.json','utf8'));
assert.equal(manifest.project_id,'appgprj_6ad435c366a881918257d17c988af9a9');
assert.equal(manifest.d1,'DB');
assert.equal(manifest.r2,'BUCKET');
assert(!manifest.static,'Database site must use its server Worker');
for(const file of ['app/route.ts','app/api/[[...path]]/route.ts','server/market.mjs','server/demo-catalog.mjs','server/school-auth.mjs','relay/core.mjs','relay/http.mjs','relay/run.mjs','relay/runtime.mjs','relay/package-lock.json','render.yaml','db/schema.ts','legacy/index.html','public/app.js','public/styles.css','public/data.js','public/assets/hero.svg','public/assets/orange.svg','AUTH_SETUP.md','.env.example']) await access(file);
const app=await readFile('public/app.js','utf8');
assert(app.includes('西交利物浦大学'));
assert(!app.includes('indexedDB.open'),'Live records must not use browser IndexedDB');
assert(!app.includes('seedProducts'),'Live UI must not silently load demo listings');
for(const secretName of ['RESEND_API_KEY','JUZI_EMAIL_AUTH_SECRET','JUZI_EMAIL_RELAY_TOKEN','QQ_SMTP_AUTH_CODE','JUZI_RELAY_TOKEN','JUZI_GMAIL_SCRIPT_SECRET']) assert(!app.includes(secretName),'Mail credentials belong only on the server');
const metadata=await readFile('public/data.js','utf8');
assert(!metadata.includes('seedProducts'),'Public metadata must not ship demo listings');
for(const file of ['public/app.js','public/api.js','public/data.js','server/market.mjs','server/demo-catalog.mjs','server/school-auth.mjs','relay/core.mjs','relay/http.mjs','relay/run.mjs','relay/runtime.mjs','scripts/migrate-local.mjs','scripts/setup-qq-mail.mjs','scripts/setup-gmail-mail.mjs','gmail-apps-script/Code.js','scripts/dev-local.mjs']) {
  const result=spawnSync(process.execPath,['--check',resolve(file)],{stdio:'inherit'});
  assert.equal(result.status,0,`Syntax failed: ${file}`);
}
const migrations=(await readdir('drizzle')).filter(name=>name.endsWith('.sql'));
assert(migrations.length>0,'Generate and commit the schema migration');
for(const name of migrations){
  const sql=await readFile(`drizzle/${name}`,'utf8');
  if(name==='0004_public_demo_catalog.sql') {
    // User explicitly requested this one public, clearly fictional catalog.
    // Keep every other migration schema-only and permit no auth/contact seeds.
    const statements=sql.split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
    assert.equal(statements.length,20,'Demo migration must contain exactly one additive column, one catalog owner and 18 listings');
    assert.equal(statements[0],'ALTER TABLE `products` ADD `is_demo` integer DEFAULT 0 NOT NULL;');
    assert.match(statements[1],/^INSERT OR IGNORE INTO users \(id, display_name, created_at\) VALUES \('juzi_demo_catalog', '示例展示账号', \d+\);$/);
    const ids=new Set();
    for(const seed of statements.slice(2)) {
      assert.match(seed,/^INSERT OR IGNORE INTO products \(id, owner_id, title, category, price_cents, original_price_cents, condition, campus, location, description, specs_json, graduation, seller, status, created_at, updated_at, is_demo\) VALUES \('demo_juzi_(?:0[1-9]|1[0-8])', 'juzi_demo_catalog', /);
      assert.match(seed,/, 'active', \d+, \d+, 1\);$/);
      ids.add(seed.match(/VALUES \('([^']+)'/)[1]);
      assert(!/\b(?:UPDATE|DELETE|DROP|REPLACE|TRUNCATE)\b|\bINSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(?:school_|auth_|private_contacts|media\b|product_media\b)/i.test(seed),'Demo migration may only add public catalog rows');
    }
    assert.equal(ids.size,18,'Every demo listing must have its own stable ID');
  } else {
    const inserts=sql.split('--> statement-breakpoint').map(value=>value.trim()).filter(value=>/^INSERT\b/i.test(value));
    // Rebuilding products to update its CHECK constraint must copy existing rows;
    // only allow that data-preserving INSERT...SELECT, never seed new user/listing rows.
    assert(inserts.every(statement=>/^INSERT INTO `__new_products`\([\s\S]*\) SELECT[\s\S]* FROM `products`;$/i.test(statement)),'Other migrations must not seed product or user records');
  }
}
console.log('PASS: server entry, D1/R2 bindings, database frontend, syntax, additive schema and explicitly requested demo catalog');
