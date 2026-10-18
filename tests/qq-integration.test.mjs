import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/core.mjs';
import { createRelayHttpServer } from '../relay/http.mjs';
import { handleSchoolAuth, resolveSchoolViewer } from '../server/school-auth.mjs';
import { handleMarket } from '../server/market.mjs';
import { fixture } from './support.mjs';

// All SMTP operations below are injected. Only loopback HTTP is used; no email is sent.
const origin='http://localhost:4174';
const token='TEST_ONLY_QQ_INTEGRATION_RELAY_TOKEN_0123456789';
const email='qq.integration.fixture@student.xjtlu.edu.cn';
async function setup(t,{accepted=true,limit='50'}={}) {
  const messages=[];
  const relay=createRelay({env:{JUZI_RELAY_TOKEN:token,QQ_SMTP_USER:'555555555@qq.com',QQ_SMTP_AUTH_CODE:'abcdefghijklmnop',QQ_RELAY_DAILY_LIMIT:limit},filename:':memory:',
    sendMail:async message=>{messages.push(message);return{accepted:accepted?message.envelope.to:[],rejected:accepted?[]:message.envelope.to,response:accepted?'250 accepted':'550 refused'};}});
  const server=createRelayHttpServer(relay);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await relay.close();});
  const env=Object.assign(fixture(t),{JUZI_EMAIL_ENABLED:'true',JUZI_EMAIL_PROVIDER:'qq_relay',JUZI_EMAIL_ORIGIN:origin,
    JUZI_EMAIL_RELAY_URL:`http://127.0.0.1:${server.address().port}/send`,JUZI_EMAIL_RELAY_TOKEN:token,
    JUZI_EMAIL_AUTH_SECRET:'TEST_ONLY_QQ_INTEGRATION_HMAC_SECRET_0123456789'});
  const post=async(path,body,cookie='')=>{
    const response=await handleSchoolAuth(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}),env,{development:true});
    return{response,status:response.status,data:await response.json(),cookie:response.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ')};
  };
  return{env,messages,post};
}

test('local school-auth HTTP adapter reaches QQ relay and establishes a verified session after mock SMTP acceptance',async t=>{
  const state=await setup(t), sent=await state.post('/api/auth/email/send',{email});
  assert.equal(sent.status,200);assert.equal(state.messages.length,1);
  const message=state.messages[0],code=message.text.match(/验证码：(\d{6})/)[1];
  assert.equal(message.from.address,'555555555@qq.com');assert.deepEqual(message.envelope.to,[email]);
  assert(!JSON.stringify(sent.data).includes(email));assert(!Object.hasOwn(sent.data,'code'));
  const verified=await state.post('/api/auth/email/verify',{email,challengeId:sent.data.challengeId,code},sent.cookie);
  assert.equal(verified.status,200);
  const request=new Request(origin+'/api/me',{headers:{Cookie:sent.cookie+'; '+verified.cookie}});
  const viewer=await resolveSchoolViewer(request,state.env,{development:true});
  assert.equal(viewer.provider,'school_email');assert.equal(viewer.emailVerified,true);
  const me=await(await handleMarket(request,state.env,viewer)).json();
  assert.equal(me.user.emailVerified,true);assert.equal(me.user.schoolVerified,false);
  assert.equal(state.messages.length,1);
});
test('unconfirmed QQ SMTP response crosses the HTTP boundary as a failed challenge and cannot create a login',async t=>{
  const state=await setup(t,{accepted:false}),sent=await state.post('/api/auth/email/send',{email});
  assert.equal(sent.status,503);assert.equal(sent.data.error.code,'EMAIL_DELIVERY_FAILED');
  assert.equal(state.messages.length,1);assert.equal(sent.data.challengeId,undefined);
  const row=state.env.DB.sqlite.prepare('SELECT id,delivery_status FROM school_email_challenges').get();
  assert.equal(row.delivery_status,'failed');
  const code=state.messages[0].text.match(/验证码：(\d{6})/)[1];
  const verified=await state.post('/api/auth/email/verify',{email,challengeId:row.id,code},sent.cookie);
  assert.equal(verified.status,400);
  assert.equal(state.env.DB.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,0);
});
