import assert from 'node:assert/strict';
import { access,readFile } from 'node:fs/promises';
import { resolve,sep } from 'node:path';
import { seedProducts,categories } from '../dist/data.js';
const root=resolve('dist');
assert.equal(seedProducts.length,18,'Expected 18 demo products');
assert.equal(new Set(seedProducts.map(p=>p.id)).size,18,'Product IDs must be unique');
for(const category of ['appliance','ebike','daily'])assert.equal(seedProducts.filter(p=>p.category===category).length,6);
assert.deepEqual(categories.map(c=>c.id),['all','appliance','ebike','daily']);
for(const p of seedProducts){
  assert(['SIP 校区','太仓校区'].includes(p.campus),'Unexpected campus');
  assert(Number.isFinite(p.price)&&p.price>0&&Number.isFinite(p.originalPrice));
  assert(p.contact.startsWith('DEMO_JUZI_')&&!p.mine&&p.status==='active');
  assert(p.description.includes('演示')&&Object.keys(p.specs).length>=2);
  for(const src of p.images){const file=resolve(root,src);assert(file.startsWith(root+sep));await access(file);}
}
for(const asset of ['index.html','styles.css','app.js','data.js','assets/hero.svg','assets/orange.svg'])await access(resolve(root,asset));
const manifest=JSON.parse(await readFile('.openai/hosting.json','utf8'));
assert.equal(manifest.static.directory,'dist');assert(manifest.project_id);
const app=await readFile('dist/app.js','utf8');
assert(app.includes('西交利物浦大学')&&app.includes('indexedDB.open'));
assert(!app.includes('fetch('),'Demo must not send visitor records to a backend');
console.log('PASS: 18 products, 3 categories, 2 campuses, assets, local-only data contract, hosting manifest');
