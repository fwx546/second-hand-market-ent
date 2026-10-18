import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareQQMail } from '../scripts/setup-qq-mail.mjs';

function fixture(t) { const root=mkdtempSync(join(tmpdir(),'qq-local-setup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root; }
const read=(root,path)=>parseEnv(readFileSync(join(root,path),'utf8'));
test('QQ setup creates matching private local credentials without enabling or losing other configuration',t=>{
  const root=fixture(t);writeFileSync(join(root,'.env.local'),'UNRELATED=keep\n# local notes\n');
  prepareQQMail({root,sender:'555555555@qq.com'});
  const app=read(root,'.env.local'), relay=read(root,'relay/.env.local');
  assert.equal(app.UNRELATED,'keep');assert.equal(app.JUZI_EMAIL_ENABLED,'false');assert.equal(app.JUZI_EMAIL_PROVIDER,'qq_relay');
  assert.equal(app.JUZI_EMAIL_RELAY_TOKEN,relay.JUZI_RELAY_TOKEN);assert.match(app.JUZI_EMAIL_AUTH_SECRET,/^[0-9a-f]{64}$/);
  assert.notEqual(app.JUZI_EMAIL_AUTH_SECRET,relay.JUZI_RELAY_TOKEN);assert.equal(relay.QQ_SMTP_AUTH_CODE,'');
  assert.equal(app.JUZI_EMAIL_RELAY_URL,'http://127.0.0.1:4180/send');
  prepareQQMail({root});assert.equal(read(root,'.env.local').JUZI_EMAIL_AUTH_SECRET,app.JUZI_EMAIL_AUTH_SECRET);
  assert.throws(()=>prepareQQMail({root,enable:true}),/授权码/);assert.equal(read(root,'.env.local').JUZI_EMAIL_ENABLED,'false');
});
test('QQ setup enables only after a code is filled, keeps credentials and refuses account/code mismatches',t=>{
  const root=fixture(t);prepareQQMail({root,sender:'555555555@qq.com'});
  const path=join(root,'relay/.env.local');writeFileSync(path,readFileSync(path,'utf8').replace('QQ_SMTP_AUTH_CODE=','QQ_SMTP_AUTH_CODE=abcdefghijklmnop'));
  const before=read(root,'.env.local');prepareQQMail({root,enable:true});const after=read(root,'.env.local');
  assert.equal(after.JUZI_EMAIL_ENABLED,'true');assert.equal(after.JUZI_EMAIL_AUTH_SECRET,before.JUZI_EMAIL_AUTH_SECRET);
  assert.throws(()=>prepareQQMail({root,sender:'555555556@qq.com'}),/发件账号/);
  writeFileSync(join(root,'.dev.vars'),'UNRELATED=do-not-read\n');assert.throws(()=>prepareQQMail({root}),/覆盖/);
  assert.equal(read(root,'.env.local').JUZI_EMAIL_ENABLED,'true');
});
test('QQ setup refuses production Origin and mismatched relay credentials before writing',t=>{
  const root=fixture(t);writeFileSync(join(root,'.env.local'),'JUZI_EMAIL_ORIGIN=https://site.invalid\n');
  assert.throws(()=>prepareQQMail({root,sender:'555555555@qq.com'}),/本地/);
  assert.equal(read(root,'.env.local').JUZI_EMAIL_ORIGIN,'https://site.invalid');
  writeFileSync(join(root,'.env.local'),'');prepareQQMail({root,sender:'555555555@qq.com'});
  const appPath=join(root,'.env.local');const before=readFileSync(appPath,'utf8');
  writeFileSync(appPath,before.replace(/JUZI_EMAIL_RELAY_TOKEN=[^\n]+/,'JUZI_EMAIL_RELAY_TOKEN=other-token-do-not-replace-01234567890123456789'));
  assert.throws(()=>prepareQQMail({root}),/不一致/);
});
test('QQ setup rejects incompatible port and quota values before enabling or rewriting files',t=>{
  for(const [key,value]of [['QQ_RELAY_PORT','04180'],['QQ_RELAY_DAILY_LIMIT','0'],['QQ_RELAY_DAILY_LIMIT','1001']]){
    const root=fixture(t);prepareQQMail({root,sender:'555555555@qq.com'});
    const path=join(root,'relay/.env.local');let text=readFileSync(path,'utf8').replace('QQ_SMTP_AUTH_CODE=','QQ_SMTP_AUTH_CODE=abcdefghijklmnop');
    text=text.replace(new RegExp(`${key}=[^\\n]+`),`${key}=${value}`);writeFileSync(path,text);
    const before=readFileSync(join(root,'.env.local'),'utf8');
    assert.throws(()=>prepareQQMail({root,enable:true}));assert.equal(readFileSync(join(root,'.env.local'),'utf8'),before);
    assert.equal(readFileSync(path,'utf8'),text);
  }
});
