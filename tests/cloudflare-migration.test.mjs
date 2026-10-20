import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportSource, prepareMigration, sha256, SOURCE_ORIGIN, LIMITS, loadExport, writePrepared,
  migrateImages, verifyDatabase, tableDigest, parseWranglerRows, assertEmptyDestination, validateMediaObjects, privateRunPath, securePrivateRunPath } from '../cloudflare/migration-data.mjs';

// Public fake fixtures, never deployed secrets or real identities.
const TOKEN = '0123456789abcdef'.repeat(4);
const BYTES = Buffer.from([137, 80, 78, 71, 0, 255, 10, 128]);
const SCHEMA = readFileSync(new URL('../cloudflare/migrations/0001_schema.sql', import.meta.url), 'utf8');
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const wire = value => ArrayBuffer.isView(value) ? { type: 'blob', encoding: 'base64', value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') } : value;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => /^000[0-4]_.*\.sql$/.test(name)).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8'));
  db.prepare('INSERT INTO users(id, display_name, campus, created_at) VALUES (?,?,?,?)').run('school_fixture', 'Example.User', 'SIP 校区', 100);
  db.prepare('INSERT INTO school_email_accounts(email_hash, user_id, email_masked, verified_at) VALUES (?,?,?,?)').run('fake-email-digest', 'school_fixture', 'ex***@student.xjtlu.edu.cn', 101);
  db.prepare('INSERT INTO media(id,owner_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').run('media_fixture', 'school_fixture', 'market/fixture', 'image/png', BYTES.length, 102);
  db.prepare(`INSERT INTO products(id,owner_id,title,category,price_cents,original_price_cents,condition,campus,location,description,specs_json,graduation,is_demo,seller,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('product_fixture','school_fixture',"校园 '杯子'; DROP TABLE users; -- ☕",'daily',3500,8000,'九成新','SIP 校区','公共入口','完整保留 Unicode 和引号','{"数量":"1","使用情况":"功能正常"}',0,0,'Example.User','active',103,103);
  db.prepare('INSERT INTO product_media(product_id,media_id,position) VALUES (?,?,?)').run('product_fixture','media_fixture',0);
  db.prepare('INSERT INTO private_contacts(product_id,type,value) VALUES (?,?,?)').run('product_fixture','wechat','fixture_contact');
  db.prepare('INSERT INTO favorites(user_id,product_id,created_at) VALUES (?,?,?)').run('school_fixture','product_fixture',104);
  db.prepare('INSERT INTO auth_sessions(session_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run('fake-session-digest','school_fixture',9999,100);
  db.prepare('INSERT INTO school_email_challenges(id,email_hash,binding_hash,code_hash,email_masked,created_at,expires_at,attempts,consumed_at,delivery_status) VALUES (?,?,?,?,?,?,?,?,?,?)').run('challenge_fixture','fake-email-digest','fake-binding','fake-code','ex***@student.xjtlu.edu.cn',100,9999,0,null,'sent');
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const tables = schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => {
    const columns = db.prepare(`PRAGMA table_info(${quote(row.name)})`).all();
    const rows = db.prepare(`SELECT * FROM ${quote(row.name)}`).all().map(row => Object.fromEntries(Object.entries(row).map(([name,value]) => [name,wire(value)])));
    return { name:row.name, columns, count:rows.length, rows };
  });
  db.close();
  const snapshot = { version:1,capturedAt:'2031-01-01T00:00:00.000Z',schema,tables,counts:Object.fromEntries(tables.map(table=>[table.name,table.count])),metadata:{migrationTables:[],internalTables:[]} };
  const object = { key:'market/fixture',size:BYTES.length,etag:createHash('md5').update(BYTES).digest('hex'),httpEtag:'"fixture"',uploaded:'2031-01-01T00:00:00.000Z',contentType:'image/png',httpMetadata:{contentType:'image/png',cacheControl:'private'},customMetadata:{说明:'完整私有备份'},storageClass:'Standard' };
  return { snapshot, objects:[{...object,sha256:sha256(BYTES)}], object };
}
function addPlatformMigrationMetadata(data) {
  const db = new DatabaseSync(':memory:');
  try {
    // Trusted test DDL for the one actual platform table, never a source SQL execution path.
    db.exec('CREATE TABLE "__appgarden_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (let index = 0; index < 5; index++) db.prepare('INSERT INTO __appgarden_migrations(name,applied_at) VALUES(?,?)').run(`fixture-platform-${index}`,'2031-01-01 00:00:00');
    const name = '__appgarden_migrations', rows = db.prepare('SELECT * FROM __appgarden_migrations').all();
    data.snapshot.schema.push(...db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name=?').all(name));
    data.snapshot.tables.push({name,columns:db.prepare('PRAGMA table_info("__appgarden_migrations")').all(),rows,count:rows.length});
    data.snapshot.counts[name]=rows.length;
  } finally { db.close(); }
  return data;
}
async function temporary(t) {
  const folder = await mkdtemp(join(tmpdir(),'juzi-private-migration-'));
  t.after(async()=> { assert(resolve(folder).startsWith(resolve(tmpdir()))); await rm(folder,{recursive:true,force:true}); });
  return folder;
}
function transport(data, { pages, binary=BYTES, responseMetadata=data.object }={}) {
  const calls=[];
  const fetch=async(url,options)=>{
    calls.push({url,options}); const parsed=new URL(url);
    assert.equal(parsed.origin,SOURCE_ORIGIN); assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);
    if(parsed.pathname.endsWith('/snapshot')) return Response.json(data.snapshot);
    if(parsed.pathname.endsWith('/objects')) {
      if(pages) return Response.json(pages(parsed.searchParams.get('cursor')));
      return Response.json({version:1,objects:[data.object],truncated:false,cursor:null});
    }
    assert.equal(parsed.pathname,'/api/migration-export/v1/object'); assert.equal(parsed.searchParams.get('key'),data.object.key);
    return new Response(binary,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(binary.length),'X-Juzi-Export-Metadata':Buffer.from(JSON.stringify(responseMetadata)).toString('base64')}});
  };
  return { fetch,calls };
}

test('export snapshots once, copies complete bytes and orphan objects, and writes private hashes without credentials',async t=>{
  const directory=await temporary(t),data=fixture(),mock=transport(data);
  const result=await exportSource({token:TOKEN,directory,fetch:mock.fetch});
  assert.equal(mock.calls.filter(call=>new URL(call.url).pathname.endsWith('/snapshot')).length,1);
  assert.equal(result.summary.objectCount,1); assert.equal(result.summary.totalBytes,BYTES.length);
  assert.deepEqual(await readFile(join(directory,result.manifest.objects[0].file)),BYTES);
  const manifest=await readFile(join(directory,'source-manifest.private.json'),'utf8');
  assert(!manifest.includes(TOKEN)); assert(!manifest.includes('Authorization'));
  assert.equal((await loadExport(directory)).snapshot.counts.users,2);
  const prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  await writePrepared(directory,prepared);
  assert.equal(JSON.parse(await readFile(join(directory,'expected-target.private.json'),'utf8')).tables.find(table=>table.name==='users').count,2);
});

test('export follows every cursor and refuses duplicate keys and multistep cursor loops',async t=>{
  const data=fixture(),directory=await temporary(t);
  const mock=transport(data,{pages:cursor=>cursor===null?{version:1,objects:[],truncated:true,cursor:'first'}:cursor==='first'?{version:1,objects:[],truncated:true,cursor:'second'}:{version:1,objects:[data.object],truncated:false,cursor:null}});
  await exportSource({token:TOKEN,directory,fetch:mock.fetch});
  assert.deepEqual(mock.calls.filter(call=>new URL(call.url).pathname.endsWith('/objects')).map(call=>new URL(call.url).searchParams.get('cursor')),[null,'first','second']);
  const loop=transport(data,{pages:cursor=>({version:1,objects:[],truncated:true,cursor:cursor==='first'?'second':'first'})});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:loop.fetch}),{code:'OBJECT_CURSOR_LOOP'});
  const duplicate=transport(data,{pages:cursor=>({version:1,objects:[data.object],truncated:cursor===null,cursor:cursor===null?'next':null})});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:duplicate.fetch}),{code:'DUPLICATE_OBJECT_KEY'});
});

test('export credential is fixed to exact old HTTPS origin and never follows redirects',async t=>{
  for(const origin of ['https://attacker.example',SOURCE_ORIGIN+'/',SOURCE_ORIGIN+'/path','http://juzi-campus-market.open-bloom-6517.chatgpt.site',SOURCE_ORIGIN+'@attacker.example']) {
    let called=false;
    await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),origin,fetch:async()=>{called=true;}}),{code:'CREDENTIAL_DESTINATION_REJECTED'});
    assert.equal(called,false);
  }
  let calls=0;
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://attacker.example/steal'}});}}),{code:'SOURCE_REQUEST_REJECTED'});
  assert.equal(calls,1);
});

test('export detects altered metadata, ETag/body mismatch and oversized images before accepting backup',async t=>{
  const data=fixture();
  const changed=transport(data,{responseMetadata:{...data.object,key:'market/changed'}});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:changed.fetch}),{code:'SOURCE_OBJECT_CHANGED'});
  const corrupt=transport(data,{binary:Buffer.alloc(BYTES.length,1)});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:corrupt.fetch}),{code:'SOURCE_OBJECT_ETAG_MISMATCH'});
  const large=transport(data,{pages:()=>({version:1,objects:[{...data.object,size:LIMITS.object+1}],truncated:false,cursor:null})});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:large.fetch}),{code:'INVALID_OBJECT_METADATA'});
  assert.equal(large.calls.filter(call=>new URL(call.url).pathname.endsWith('/object')).length,0);
});

test('export refuses aggregate storage and response limits before any object download',async t=>{
  const data=fixture();
  const quota=transport(data,{pages:cursor=>({version:1,objects:Array.from({length:cursor===null?100:13},(_,index)=>({...data.object,key:`market/${cursor===null?'first':'second'}-${index}`,size:LIMITS.object})),truncated:cursor===null,cursor:cursor===null?'next':null})});
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:quota.fetch}),{code:'FREE_STORAGE_LIMIT_EXCEEDED'});
  assert.equal(quota.calls.filter(call=>new URL(call.url).pathname.endsWith('/object')).length,0);
  await assert.rejects(exportSource({token:TOKEN,directory:await temporary(t),fetch:async()=>new Response('',{headers:{'Content-Type':'application/json','Content-Length':String(LIMITS.response+1)}})}),{code:'RESPONSE_TOO_LARGE'});
});

test('unreferenced source objects are copied too, including full private original metadata',async t=>{
  const data=fixture(),orphan={...data.object,key:'market/orphan',customMetadata:{status:'unassociated'}},directory=await temporary(t);
  const fetch=async(url)=>{
    const parsed=new URL(url);
    if(parsed.pathname.endsWith('/snapshot')) return Response.json(data.snapshot);
    if(parsed.pathname.endsWith('/objects')) return Response.json({version:1,objects:[data.object,orphan],truncated:false,cursor:null});
    const metadata=parsed.searchParams.get('key')===orphan.key?orphan:data.object;
    return new Response(BYTES,{headers:{'Content-Type':'application/octet-stream','X-Juzi-Export-Metadata':Buffer.from(JSON.stringify(metadata)).toString('base64')}});
  };
  const exported=await exportSource({token:TOKEN,directory,fetch});
  assert.equal(exported.manifest.objects.length,2);
  const stored=await loadExport(directory);
  assert.equal(stored.manifest.objects[1].key,'market/orphan');
  const original=JSON.parse(await readFile(join(directory,stored.manifest.objects[1].metadataFile),'utf8'));
  assert.equal(original.downloaded.customMetadata.status,'unassociated');
});

test('prepare imports exact stable identities, mapped conditions and default profile fields while resetting login state',()=>{
  const data=fixture(),prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  const user=prepared.expected.tables.find(table=>table.name==='users').rows.find(row=>row.id==='school_fixture');
  assert.equal(user.display_name,'Example.User'); assert.equal(user.language,'zh'); assert.equal(user.publish_contact_value,''); assert.equal(user.qq,'');
  assert.equal(prepared.expected.tables.find(table=>table.name==='school_email_accounts').rows[0].user_id,'school_fixture');
  assert.equal(prepared.expected.tables.find(table=>table.name==='products').rows.find(row=>row.id==='product_fixture').condition,'轻微使用痕迹');
  assert.equal(prepared.expected.tables.find(table=>table.name==='auth_sessions').count,0);
  assert.equal(prepared.expected.tables.find(table=>table.name==='school_email_challenges').count,0);
  assert.equal(prepared.summary.resetAuthCounts.auth_sessions,1);
  assert(!JSON.stringify(prepared.summary).includes('Example.User'));
  const target=new DatabaseSync(':memory:');
  try {
    target.exec('PRAGMA foreign_keys=ON'); target.exec(SCHEMA); target.exec(prepared.sql);
    assert.equal(target.prepare('SELECT count(*) AS n FROM users').get().n,2);
    assert.equal(target.prepare('SELECT title FROM products WHERE id=?').get('product_fixture').title,"校园 '杯子'; DROP TABLE users; -- ☕");
    assert.equal(target.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.throws(()=>target.exec(prepared.sql));
  } finally { target.close(); }
});

test('prepared SQL itself refuses any nonempty app/auth target before importing even nonconflicting IDs',()=>{
  const data=fixture(),prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  for(const existing of ["INSERT INTO users(id,display_name,created_at) VALUES('unrelated-owner','Keep existing',123)",
    "INSERT INTO auth_flows(state_hash,binding_hash,code_verifier,nonce,issuer,client_id,redirect_uri,return_to,expires_at,created_at) VALUES('state','binding','verifier','nonce','issuer','client','redirect','/',999,123)"]) {
    const target=new DatabaseSync(':memory:');
    try {
      target.exec(SCHEMA); target.exec(existing);
      const before=target.prepare("SELECT count(*) AS n FROM users").get().n;
      assert.throws(()=>target.exec(prepared.sql),/NOT NULL/);
      assert.equal(target.prepare('SELECT count(*) AS n FROM users').get().n,before);
      assert.equal(target.prepare('SELECT count(*) AS n FROM products').get().n,0);
      assert.equal(target.prepare('SELECT count(*) AS n FROM media').get().n,0);
    } finally { target.close(); }
  }
});

test('prepare does not seed missing demonstrations and rejects unknown business tables/columns',()=>{
  const data=fixture(),products=data.snapshot.tables.find(table=>table.name==='products');
  products.rows=products.rows.filter(row=>row.id!=='demo_juzi_01'); products.count--; data.snapshot.counts.products--;
  const prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  assert(!prepared.expected.tables.find(table=>table.name==='products').rows.some(row=>row.id==='demo_juzi_01'));
  const bad=fixture();
  bad.snapshot.tables.find(table=>table.name==='users').columns.push({name:'unrecognized_private_field',type:'TEXT'});
  for(const row of bad.snapshot.tables.find(table=>table.name==='users').rows) row.unrecognized_private_field='must not disappear';
  assert.throws(()=>prepareMigration({snapshot:bad.snapshot,objects:bad.objects,schemaSql:SCHEMA}),{code:'UNKNOWN_SOURCE_COLUMN'});
  const unknown=fixture();
  unknown.snapshot.schema.push({type:'table',name:'future_orders',tbl_name:'future_orders',sql:'CREATE TABLE future_orders(id TEXT)'});
  unknown.snapshot.tables.push({name:'future_orders',columns:[{name:'id',type:'TEXT'}],count:0,rows:[]}); unknown.snapshot.counts.future_orders=0;
  assert.throws(()=>prepareMigration({snapshot:unknown.snapshot,objects:unknown.objects,schemaSql:SCHEMA}),{code:'UNKNOWN_SOURCE_TABLE'});
});

test('the exact platform migration table stays unchanged in the hashed private source snapshot and is explicitly excluded only from business import',async t=>{
  const data=addPlatformMigrationMetadata(fixture()),directory=await temporary(t);
  const original=JSON.stringify(data.snapshot),originalHash=sha256(original);
  await exportSource({token:TOKEN,directory,fetch:transport(data).fetch});
  const loaded=await loadExport(directory);
  assert.equal(JSON.stringify(loaded.snapshot),original);
  const prepared=prepareMigration({snapshot:loaded.snapshot,objects:loaded.manifest.objects,schemaSql:SCHEMA});
  assert.deepEqual(prepared.summary.sourceMigrationMetadataCounts,{__appgarden_migrations:5});
  assert.equal(prepared.expected.tables.length,12);
  assert(!prepared.expected.tables.some(table=>table.name==='__appgarden_migrations'));
  assert(!prepared.sql.includes('__appgarden_migrations'));assert(!prepared.sql.includes('fixture-platform-'));
  assert.equal(sha256(JSON.stringify(data.snapshot)),originalHash);
  assert.equal(sha256(JSON.stringify(loaded.snapshot)),originalHash);
  assert.equal(loaded.snapshot.tables.find(table=>table.name==='__appgarden_migrations').count,5);
});

test('a same-name platform table with business columns or changed constraints is refused rather than dropped',()=>{
  for(const alter of [
    data=>{const table=data.snapshot.tables.find(table=>table.name==='__appgarden_migrations');table.columns.push({cid:3,name:'private_contact',type:'TEXT',notnull:0,dflt_value:null,pk:0});for(const row of table.rows)row.private_contact='preserve-me';},
    data=>{data.snapshot.schema.find(entry=>entry.type==='table'&&entry.name==='__appgarden_migrations').sql=data.snapshot.schema.find(entry=>entry.type==='table'&&entry.name==='__appgarden_migrations').sql.replace('TEXT UNIQUE','TEXT');},
    data=>{data.snapshot.tables.find(table=>table.name==='__appgarden_migrations').columns[2].dflt_value=null;},
  ]) {
    const data=addPlatformMigrationMetadata(fixture());alter(data);
    assert.throws(()=>prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA}),{code:'INVALID_SOURCE_MIGRATION_METADATA'});
  }
  const data=fixture(),name='__appgarden_future_business';
  data.snapshot.schema.push({type:'table',name,tbl_name:name,sql:`CREATE TABLE ${name}(id TEXT)`});
  data.snapshot.tables.push({name,columns:[{name:'id',type:'TEXT'}],rows:[],count:0});data.snapshot.counts[name]=0;
  assert.throws(()=>prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA}),{code:'UNKNOWN_SOURCE_TABLE'});
});

test('future conversations and messages retain membership, sender and exact private contents',()=>{
  const data=fixture(),db=new DatabaseSync(':memory:');
  const users=data.snapshot.tables.find(table=>table.name==='users');
  users.rows.push({id:'school_buyer',display_name:'Buyer',campus:'太仓校区',created_at:105});users.count++;data.snapshot.counts.users++;
  try {
    db.exec(SCHEMA);
    for(const name of ['conversations','messages']) {
      const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const rows=name==='conversations'?[{id:'conv_fixture',product_id:'product_fixture',buyer_id:'school_buyer',seller_id:'school_fixture',created_at:106,updated_at:107}]:[{id:'msg_fixture',conversation_id:'conv_fixture',sender_id:'school_buyer',body:"你好，'杯子'还在吗？",created_at:107}];
      data.snapshot.schema.push(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type=? AND name=?').get('table',name));
      data.snapshot.tables.push({name,columns,count:rows.length,rows});data.snapshot.counts[name]=rows.length;
    }
  } finally { db.close(); }
  const prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  assert.equal(prepared.expected.tables.find(table=>table.name==='conversations').rows[0].buyer_id,'school_buyer');
  assert.equal(prepared.expected.tables.find(table=>table.name==='messages').rows[0].body,"你好，'杯子'还在吗？");
});

test('prepare refuses broken ownership/image foreign keys and missing R2 objects instead of partial migration',()=>{
  const data=fixture();
  data.snapshot.tables.find(table=>table.name==='product_media').rows[0].media_id='missing';
  assert.throws(()=>prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA}),{code:'SOURCE_DATA_CONSTRAINT_FAILED'});
  const missing=fixture();
  assert.throws(()=>prepareMigration({snapshot:missing.snapshot,objects:[],schemaSql:SCHEMA}),{code:'MEDIA_OBJECT_MISSING_OR_CHANGED'});
  assert.throws(()=>validateMediaObjects(missing.snapshot,[...missing.objects,...missing.objects]),{code:'DUPLICATE_OBJECT_KEY'});
});

test('typed table digests are order independent but detect numeric/string changes and binary corruption',()=>{
  const columns=[{name:'id',pk:1},{name:'price',pk:0}],a=[{id:'b',price:10},{id:'a',price:20}];
  assert.equal(tableDigest(columns,a),tableDigest(columns,[...a].reverse()));
  assert.notEqual(tableDigest(columns,a),tableDigest(columns,[{id:'b',price:'10'},a[1]]));
  const binary=[{name:'id',pk:1},{name:'payload',pk:0}];
  assert.equal(tableDigest(binary,[{id:'a',payload:new Uint8Array([0,255])}]),tableDigest(binary,[{id:'a',payload:{type:'blob',encoding:'base64',value:'AP8='}}]));
  assert.notEqual(tableDigest(binary,[{id:'a',payload:new Uint8Array([0,255])}]),tableDigest(binary,[{id:'a',payload:new Uint8Array([0,254])}]));
});

test('verification validates complete exact rows, zero auth state and empty-destination precondition',()=>{
  const data=fixture(),prepared=prepareMigration({snapshot:data.snapshot,objects:data.objects,schemaSql:SCHEMA});
  const actual=Object.fromEntries(prepared.expected.tables.map(table=>[table.name,structuredClone(table.rows)]));
  assert.equal(verifyDatabase(prepared.expected,actual).matches,true);
  actual.users[0].display_name='changed'; assert.equal(verifyDatabase(prepared.expected,actual).matches,false);
  assert.throws(()=>assertEmptyDestination(prepared.expected,actual),{code:'DESTINATION_NOT_EMPTY'});
  const empty=Object.fromEntries(prepared.expected.tables.map(table=>[table.name,[]]));
  assert.equal(assertEmptyDestination(prepared.expected,empty).empty,true);
  const parsed=parseWranglerRows(prepared.expected.tables.map(table=>({success:true,results:table.rows})),prepared.expected);
  assert.equal(verifyDatabase(prepared.expected,parsed).matches,true);
  assert.throws(()=>verifyDatabase(prepared.expected,{...parsed,unknown:[]}),{code:'DESTINATION_TABLE_MISMATCH'});
});

test('images preserves identical bytes/type, resumes safely, records metadata limitations, and refuses conflicts',async t=>{
  const directory=await temporary(t),data=fixture();
  await exportSource({token:TOKEN,directory,fetch:transport(data).fetch});
  const stored=new Map(); let writes=0;
  const bucket={async get(key){const item=stored.get(key);return item?{key,size:item.bytes.length,httpMetadata:{contentType:item.type},arrayBuffer:async()=>item.bytes}:null;},async put(key,bytes,options){assert.equal(options.preventOverwrite,true);assert(!stored.has(key));writes++;stored.set(key,{bytes:Buffer.from(bytes),type:options.httpMetadata.contentType});}};
  const first=await migrateImages({directory,bucket});
  assert.equal(first.uploaded,1); assert.equal(first.verifiedObjects,1); assert(first.metadataLimitations[0].includes('contentType only'));
  const second=await migrateImages({directory,bucket}); assert.equal(second.skipped,1); assert.equal(writes,1);
  assert.equal(JSON.parse(await readFile(join(directory,'images-progress.private.json'),'utf8')).verified[0].sha256,sha256(BYTES));
  stored.set(data.object.key,{bytes:Buffer.alloc(BYTES.length),type:'image/png'});
  await assert.rejects(migrateImages({directory,bucket}),{code:'DESTINATION_OBJECT_CONFLICT'}); assert.equal(writes,1);
});

test('local object tampering is detected before upload and public run directories are refused',async t=>{
  const directory=await temporary(t),data=fixture();
  const exported=await exportSource({token:TOKEN,directory,fetch:transport(data).fetch});
  await writeFile(join(directory,exported.manifest.objects[0].file),Buffer.alloc(BYTES.length));
  await assert.rejects(loadExport(directory),{code:'OBJECT_FILE_HASH_MISMATCH'});
  const metadataRun=await temporary(t),metadataExport=await exportSource({token:TOKEN,directory:metadataRun,fetch:transport(data).fetch});
  const metadataPath=join(metadataRun,metadataExport.manifest.objects[0].metadataFile);
  const metadata=JSON.parse(await readFile(metadataPath,'utf8'));metadata.listed.customMetadata.说明='unexpected edit';
  await writeFile(metadataPath,JSON.stringify(metadata));
  await assert.rejects(loadExport(metadataRun),{code:'OBJECT_METADATA_HASH_MISMATCH'});
  const root=resolve('.');
  for(const path of ['public/migration','artifacts/migration','.migration-staging','.migration-staging/../public']) assert.throws(()=>privateRunPath(root,path),{code:'PRIVATE_DIRECTORY_REQUIRED'});
  assert.equal(privateRunPath(root,'.migration-staging/run-1'),join(root,'.migration-staging','run-1'));
});

test('CLI private runs reject a symlink or Windows junction into a public directory',async t=>{
  const directory=await temporary(t),root=join(directory,'project'),publicDir=join(root,'public');
  await mkdir(publicDir,{recursive:true});await mkdir(join(root,'.migration-staging'),{recursive:true});
  await symlink(publicDir,join(root,'.migration-staging','link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(securePrivateRunPath(root,'.migration-staging/link/run'),{code:'PRIVATE_PATH_SYMLINK'});
  assert.equal(await securePrivateRunPath(root,'.migration-staging/real-run'),join(root,'.migration-staging','real-run'));
});
