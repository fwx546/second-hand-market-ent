import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, symlink, open } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importBrowserBundle, importBrowserExportFile, readBoundedBrowserFile, BROWSER_EXPORT_LIMITS } from '../cloudflare/browser-export.mjs';
import { SOURCE_ORIGIN, sha256, loadExport, prepareMigration } from '../cloudflare/migration-data.mjs';
import { main } from '../scripts/import-browser-export.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHKkAAAAASUVORK5CYII=', 'base64');
const q = value => '"' + value.replace(/"/g, '""') + '"';
function fixture(bytes = PNG, type = 'image/png') {
  const db = new DatabaseSync(':memory:');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(folder).filter(name => /^000[0-4]_.*\.sql$/.test(name)).sort()) db.exec(readFileSync(new URL(file, folder), 'utf8'));
  db.prepare('INSERT INTO users(id,display_name,campus,created_at) VALUES(?,?,?,?)').run('school_browser_fixture', 'Browser.Test', 'SIP 校区', 123);
  db.prepare('INSERT INTO school_email_accounts(email_hash,user_id,email_masked,verified_at) VALUES(?,?,?,?)').run('fake-digest','school_browser_fixture','br***@student.xjtlu.edu.cn',124);
  const key = 'market/照片-"点点..';
  db.prepare('INSERT INTO media(id,owner_id,object_key,content_type,size,created_at) VALUES(?,?,?,?,?,?)').run('browser_media_fixture','school_browser_fixture',key,type,bytes.length,125);
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const tables = schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => {
    const columns = db.prepare(`PRAGMA table_info(${q(row.name)})`).all(), rows = db.prepare(`SELECT * FROM ${q(row.name)}`).all();
    return { name:row.name,columns,count:rows.length,rows };
  });
  db.close();
  const digest = createHash('md5').update(bytes).digest('hex');
  return { format:'juzi-browser-export-v1',sourceOrigin:SOURCE_ORIGIN,
    snapshot:{version:1,capturedAt:'2031-01-01T00:00:00.000Z',schema,tables,counts:Object.fromEntries(tables.map(table=>[table.name,table.count])),metadata:{migrationTables:[],internalTables:[]}},
    objects:[{metadata:{key,size:bytes.length,contentType:type,etag:digest,httpEtag:`"${digest}"`,uploaded:'2031-01-01T00:00:00.000Z',httpMetadata:{contentType:type,cacheControl:'private'},customMetadata:{说明:'保留原始中文'},storageClass:'Standard'},sha256:sha256(bytes),base64:bytes.toString('base64')}] };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(),'juzi-browser-import-'));
  t.after(async()=>{assert(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  return root;
}
const importTo = (root,bundle,run='.migration-staging/run') => importBrowserBundle({bundle,root,run});

test('browser bundle becomes the exact private export layout and passes loadExport plus trusted-target preparation',async t=>{
  const root=await temporary(t),bundle=fixture(),snapshot=structuredClone(bundle.snapshot);
  const result=await importTo(root,bundle);
  assert.equal(result.summary.locallyVerified,true);assert.equal(result.summary.objectCount,1);assert.equal(result.summary.totalBytes,PNG.length);
  assert(!JSON.stringify(result.summary).includes('Browser.Test'));assert(!JSON.stringify(result.summary).includes('fake-digest'));
  const loaded=await loadExport(result.directory);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.snapshot)),JSON.parse(JSON.stringify(snapshot)));
  const object=loaded.manifest.objects[0];
  assert.equal(object.file,`objects/${sha256(PNG)}.bin`);assert.deepEqual(await readFile(join(result.directory,object.file)),PNG);
  const metadataBytes=await readFile(join(result.directory,object.metadataFile));
  assert.equal(sha256(metadataBytes),object.metadataSha256);
  assert.deepEqual(JSON.parse(metadataBytes).downloaded,bundle.objects[0].metadata);
  const prepared=prepareMigration({snapshot:loaded.snapshot,objects:loaded.manifest.objects,schemaSql:readFileSync(new URL('../cloudflare/migrations/0001_schema.sql',import.meta.url),'utf8')});
  assert.equal(prepared.expected.tables.find(table=>table.name==='media').rows[0].object_key,bundle.objects[0].metadata.key);
  assert.equal(prepared.expected.tables.find(table=>table.name==='users').rows.find(row=>row.id==='school_browser_fixture').display_name,'Browser.Test');
});

test('local JSON file import parses normal download basenames without exposing private filenames',async t=>{
  const root=await temporary(t),path=join(root,'juzi-browser-export (1).JSON');
  await writeFile(path,JSON.stringify(fixture()));
  const result=await importBrowserExportFile({inputFile:path,root,run:'.migration-staging/file-run'});
  assert.equal(result.summary.objectCount,1);
  if(process.platform!=='win32') assert.equal((await stat(join(result.directory,'snapshot.private.json'))).mode&0o777,0o600);
});

test('wrong source origin, envelope format, injected credential fields or malformed JSON never become successful backups',async t=>{
  const root=await temporary(t);
  for(const alter of [bundle=>{bundle.sourceOrigin='https://attacker.example';},bundle=>{bundle.format='other';},bundle=>{bundle.exportToken='should-never-be-written';}]) {
    const bundle=fixture();alter(bundle);
    await assert.rejects(importTo(root,bundle),{code:'INVALID_BROWSER_BUNDLE'});
  }
  const path=join(root,'invalid.json');await writeFile(path,'{"not valid');
  await assert.rejects(importBrowserExportFile({inputFile:path,root,run:'.migration-staging/bad-json'}),{code:'INVALID_BROWSER_JSON'});
});

test('duplicate R2 keys are refused but equal image bytes at distinct original keys deduplicate only the binary file',async t=>{
  const root=await temporary(t),duplicate=fixture();duplicate.objects.push(structuredClone(duplicate.objects[0]));
  await assert.rejects(importTo(root,duplicate),{code:'DUPLICATE_BROWSER_OBJECT_KEY'});
  const orphan=fixture();orphan.objects.push({...structuredClone(orphan.objects[0]),metadata:{...orphan.objects[0].metadata,key:'market/orphan'}});
  const result=await importTo(root,orphan,'.migration-staging/orphan');
  const loaded=await loadExport(result.directory);
  assert.equal(loaded.manifest.objects.length,2);assert.equal(loaded.manifest.objects[0].file,loaded.manifest.objects[1].file);
  assert.notEqual(loaded.manifest.objects[0].metadataFile,loaded.manifest.objects[1].metadataFile);
});

test('Node recomputes size, canonical base64, SHA256 and source ETag MD5 rather than trusting browser assertions',async t=>{
  const root=await temporary(t);
  const cases=[
    [item=>{item.metadata.size++;},'BROWSER_OBJECT_SIZE_MISMATCH'],
    [item=>{item.sha256='f'.repeat(64);},'BROWSER_OBJECT_HASH_MISMATCH'],
    [item=>{item.metadata.etag='0'.repeat(32);},'BROWSER_OBJECT_ETAG_MISMATCH'],
    [item=>{item.base64+='\n';},'INVALID_BROWSER_BASE64'],
    [item=>{item.base64='AP==';item.metadata.size=1;},'INVALID_BROWSER_BASE64'],
  ];
  for(const [alter,code] of cases) {
    const bundle=fixture();bundle.consistency={allVerified:true};alter(bundle.objects[0]);
    await assert.rejects(importTo(root,bundle),{code});
  }
});

test('HTML and mismatching declared image types are rejected; original PNG/JPEG/WebP signatures are accepted',async t=>{
  const root=await temporary(t),html=Buffer.from('<script>bad()</script>');
  await assert.rejects(importTo(root,fixture(html,'image/png')),{code:'INVALID_BROWSER_IMAGE_TYPE'});
  await assert.rejects(importTo(root,fixture(PNG,'image/jpeg')),{code:'BROWSER_IMAGE_TYPE_MISMATCH'});
  const conflict=fixture();conflict.objects[0].metadata.httpMetadata.contentType='image/webp';
  await assert.rejects(importTo(root,conflict),{code:'BROWSER_IMAGE_TYPE_MISMATCH'});
  for(const [bytes,type,index] of [[Buffer.from([255,216,255,224,255,217]),'image/jpeg',1],[Buffer.from('RIFF0000WEBP','ascii'),'image/webp',2]]) {
    const result=await importTo(root,fixture(bytes,type),`.migration-staging/type-${index}`);
    assert.equal(result.summary.locallyVerified,true);
  }
});

test('object, count, snapshot and total image limits fail before files are written',async t=>{
  const root=await temporary(t),tooLarge=fixture();tooLarge.objects[0].metadata.size=BROWSER_EXPORT_LIMITS.object+1;
  await assert.rejects(importTo(root,tooLarge),{code:'INVALID_BROWSER_OBJECT_METADATA'});
  const tooMany=fixture();tooMany.objects=Array.from({length:129},(_,index)=>({...tooMany.objects[0],metadata:{...tooMany.objects[0].metadata,key:`market/${index}`}}));
  await assert.rejects(importTo(root,tooMany),{code:'BROWSER_OBJECT_COUNT_LIMIT'});
  const total=fixture();total.objects=Array.from({length:5},(_,index)=>({...total.objects[0],metadata:{...total.objects[0].metadata,key:`market/${index}`,size:BROWSER_EXPORT_LIMITS.object}}));
  await assert.rejects(importTo(root,total),{code:'BROWSER_TOTAL_SIZE_LIMIT'});
  const snapshot=fixture();snapshot.snapshot.padding='x'.repeat(BROWSER_EXPORT_LIMITS.snapshot);
  await assert.rejects(importTo(root,snapshot),{code:'BROWSER_SNAPSHOT_TOO_LARGE'});
  await assert.rejects(stat(join(root,'.migration-staging')),error=>error.code==='ENOENT');
});

test('file-size cap is checked without reading a large file, and local paths/regular JSON are mandatory',async t=>{
  const root=await temporary(t),path=join(root,'large.json'),file=await open(path,'w');
  await file.truncate(BROWSER_EXPORT_LIMITS.file+1);await file.close();
  await assert.rejects(importBrowserExportFile({inputFile:path,root,run:'.migration-staging/large'}),{code:'BROWSER_INPUT_TOO_LARGE'});
  for(const inputFile of ['https://attacker.example/data.json','file:///tmp/secret.json','backup.zip']) await assert.rejects(importBrowserExportFile({inputFile,root,run:'.migration-staging/no'}),{code:'LOCAL_BROWSER_JSON_REQUIRED'});
});

test('an input growing during the read stops at the limit plus one byte, while exact-limit files finish',async()=>{
  let readCalls=0,totalRead=0;
  const growing={async read(buffer,offset,length,position){
    assert.equal(position,null);readCalls++;
    const bytesRead=Math.min(length,5);buffer.fill(97,offset,offset+bytesRead);totalRead+=bytesRead;
    return {bytesRead};
  }};
  await assert.rejects(readBoundedBrowserFile(growing,8),{code:'BROWSER_INPUT_TOO_LARGE'});
  assert.equal(readCalls,2);assert.equal(totalRead,9);
  let pending=Buffer.from('12345678');
  const exact={async read(buffer,offset,length){const part=pending.subarray(0,length);part.copy(buffer,offset);pending=pending.subarray(part.length);return{bytesRead:part.length};}};
  assert.equal((await readBoundedBrowserFile(exact,8)).toString(),'12345678');
  for(const maximum of [-1,Infinity,0.5]) await assert.rejects(readBoundedBrowserFile(exact,maximum),{code:'INVALID_BROWSER_INPUT_LIMIT'});
});

test('symlink/junction inputs and public/junction output destinations are refused',async t=>{
  const root=await temporary(t),downloads=join(root,'Downloads');await mkdir(downloads);await writeFile(join(downloads,'bundle.json'),JSON.stringify(fixture()));
  await symlink(downloads,join(root,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(importBrowserExportFile({inputFile:join(root,'link','bundle.json'),root,run:'.migration-staging/input-link'}),{code:'BROWSER_INPUT_SYMLINK_OR_NOT_FILE'});
  await assert.rejects(importTo(root,fixture(),'public/backup'),{code:'PRIVATE_DIRECTORY_REQUIRED'});
  await mkdir(join(root,'.migration-staging'),{recursive:true});await symlink(downloads,join(root,'.migration-staging','link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(importTo(root,fixture(),'.migration-staging/link/run'),{code:'PRIVATE_PATH_SYMLINK'});
});

test('existing backup directories are never overwritten',async t=>{
  const root=await temporary(t),first=await importTo(root,fixture()),before=await readFile(join(first.directory,'source-manifest.sha256'),'utf8');
  await assert.rejects(importTo(root,fixture()),{code:'BROWSER_RUN_NOT_EMPTY'});
  assert.equal(await readFile(join(first.directory,'source-manifest.sha256'),'utf8'),before);
});

test('missing media, incomplete source rows and malformed snapshots fail the existing full loadExport validation',async t=>{
  const root=await temporary(t),missing=fixture();missing.objects=[];
  await assert.rejects(importTo(root,missing,'.migration-staging/missing'),{code:'MEDIA_OBJECT_MISSING_OR_CHANGED'});
  const bad=fixture();bad.snapshot.tables.find(table=>table.name==='users').rows[0].invented='bad';
  await assert.rejects(importTo(root,bad,'.migration-staging/bad-snapshot'),{code:'INVALID_SNAPSHOT'});
});

test('optional consistency records are retained privately but cannot override checksum validation',async t=>{
  const root=await temporary(t),bundle=fixture();bundle.consistency={beforeAfterBusinessMatches:true};
  const result=await importTo(root,bundle),loaded=await loadExport(result.directory);
  const evidence=await readFile(join(result.directory,loaded.manifest.browserConsistency.file));
  assert.equal(sha256(evidence),loaded.manifest.browserConsistency.sha256);
  const corrupt=fixture();corrupt.consistency={beforeAfterBusinessMatches:true};corrupt.objects[0].sha256='0'.repeat(64);
  await assert.rejects(importTo(root,corrupt,'.migration-staging/corrupt-evidence'),{code:'BROWSER_OBJECT_HASH_MISMATCH'});
});

test('CLI accepts only input/run paths and never treats a token or URL as a transport credential',async()=>{
  for(const args of [[],['--input'],['--input','a.json','--token','private'],['--run','one','--run','two']]) await assert.rejects(main(args),error=>['INVALID_BROWSER_IMPORT_ARGUMENTS','PRIVATE_BROWSER_INPUT_AND_RUN_REQUIRED'].includes(error.code));
});
