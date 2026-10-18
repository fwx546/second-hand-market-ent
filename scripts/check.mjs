import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const manifest=JSON.parse(await readFile('.openai/hosting.json','utf8'));
assert.equal(manifest.project_id,'appgprj_6ad435c366a881918257d17c988af9a9');
assert.equal(manifest.d1,'DB');
assert.equal(manifest.r2,'BUCKET');
assert(!manifest.static,'Database site must use its server Worker');
for(const file of ['app/route.ts','app/api/[[...path]]/route.ts','server/market.mjs','server/school-auth.mjs','db/schema.ts','legacy/index.html','public/app.js','public/styles.css','public/data.js','public/assets/hero.svg','public/assets/orange.svg','AUTH_SETUP.md','.env.example']) await access(file);
const app=await readFile('public/app.js','utf8');
assert(app.includes('西交利物浦大学'));
assert(!app.includes('indexedDB.open'),'Live records must not use browser IndexedDB');
assert(!app.includes('seedProducts'),'Live UI must not silently load demo listings');
for(const secretName of ['RESEND_API_KEY','JUZI_EMAIL_AUTH_SECRET']) assert(!app.includes(secretName),'Mail credentials belong only on the server');
const metadata=await readFile('public/data.js','utf8');
assert(!metadata.includes('seedProducts'),'Public metadata must not ship demo listings');
for(const file of ['public/app.js','public/api.js','public/data.js','server/market.mjs','server/school-auth.mjs','scripts/migrate-local.mjs']) {
  const result=spawnSync(process.execPath,['--check',resolve(file)],{stdio:'inherit'});
  assert.equal(result.status,0,`Syntax failed: ${file}`);
}
const migrations=(await readdir('drizzle')).filter(name=>name.endsWith('.sql'));
assert(migrations.length>0,'Generate and commit the schema migration');
for(const name of migrations){
  const sql=await readFile(`drizzle/${name}`,'utf8');
  assert(!/\bINSERT\s+INTO\b/i.test(sql),'Migrations must not seed product or user records');
}
console.log('PASS: server entry, D1/R2 bindings, live-only frontend, syntax, schema-only migrations');
