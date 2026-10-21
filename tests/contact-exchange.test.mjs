import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { A, B, api, fixture, productInput, upload } from './support.mjs';

const C={...A,userId:'unrelated-user'};
async function setup(t,{legacy=false}={}) {
  const env=fixture(t,{migrate:!legacy});
  if(legacy)env.DB.sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_schema.sql',import.meta.url),'utf8'));
  const photo=await upload(env,A),body=productInput([photo.data.mediaId]);delete body.contactValue;delete body.contactType;
  const product=await api(env,'/api/products',{method:'POST',viewer:A,body});
  const created=await api(env,'/api/conversations',{method:'POST',viewer:B,body:{productId:product.data.product.id}});
  return{env,path:`/api/conversations/${created.data.conversationId}/contact-exchange`,conversationId:created.data.conversationId};
}
const offer={action:'request',type:'wechat',value:'private_requester_123',consent:true};
const request=(s,viewer=B,body=offer)=>api(s.env,s.path,{method:'POST',viewer,body});
const read=(s,viewer)=>api(s.env,s.path,{viewer});
const act=(s,viewer,action,id,extra={})=>request(s,viewer,{action,requestId:id,...extra});

test('only explicit mutual consent reveals both selected values, never in messages or previews',async t=>{
  const s=await setup(t),created=await request(s);assert.equal(created.status,201);
  const id=created.data.exchange.id;assert.equal(created.data.exchange.direction,'outgoing');
  for(const viewer of[A,B]){const result=await read(s,viewer);assert.equal(result.data.exchange.status,'pending');assert(!JSON.stringify(result.data).includes(offer.value));}
  assert.equal((await act(s,B,'accept',id,{type:'qq',value:'12345678',consent:true})).status,409);
  assert.equal((await act(s,A,'accept',id,{type:'qq',value:'12345678',consent:false})).status,400);
  const accepted=await act(s,A,'accept',id,{type:'qq',value:'12345678',consent:true});assert.equal(accepted.status,200);
  assert.deepEqual(accepted.data.exchange.contacts,{mine:{type:'qq',value:'12345678'},other:{type:'wechat',value:offer.value}});
  const requester=await read(s,B);assert.equal(requester.data.exchange.contacts.other.value,'12345678');
  const messages=await api(s.env,`/api/conversations/${s.conversationId}/messages`,{viewer:B});
  const list=await api(s.env,'/api/me/conversations',{viewer:B});
  for(const value of[offer.value,'12345678']){assert(!JSON.stringify(messages.data).includes(value));assert(!JSON.stringify(list.data).includes(value));}
  assert.equal((await act(s,A,'revoke',id)).data.exchange.status,'revoked');
  for(const viewer of[A,B])assert(!JSON.stringify((await read(s,viewer)).data).includes(offer.value));
  const stored=s.env.DB.sqlite.prepare('SELECT * FROM contact_exchanges WHERE id=?').get(id);
  assert.equal(stored.requester_value,'');assert.equal(stored.responder_value,null);
});

test('seller can initiate; recipient can decline; sender can cancel without disclosing numbers',async t=>{
  const s=await setup(t),created=await request(s,A);assert.equal(created.status,201);const id=created.data.exchange.id;
  assert.equal((await read(s,B)).data.exchange.direction,'incoming');
  assert.equal((await act(s,A,'decline',id)).status,409);assert.equal((await act(s,B,'cancel',id)).status,409);
  assert.equal((await act(s,A,'cancel',id)).data.exchange.status,'cancelled');
  assert.equal((await act(s,B,'accept',id,{type:'wechat',value:'other_value',consent:true})).status,409);
  const second=await request(s,A);assert.equal(second.status,201);
  assert.equal((await act(s,B,'decline',second.data.exchange.id)).data.exchange.status,'declined');
  assert.equal((await request(s,A)).status,429);assert.equal((await request(s,B)).status,429);
});

test('exchange endpoints enforce identity, participants, Origin, fields, validity and expiry',async t=>{
  const s=await setup(t);
  assert.equal((await read(s,null)).status,401);assert.equal((await read(s,C)).status,404);
  assert.equal((await request(s,C)).status,404);
  assert.equal((await api(s.env,s.path,{method:'POST',viewer:B,body:offer,origin:'https://attacker.example'})).status,403);
  for(const body of[{...offer,consent:false},{...offer,value:'x'},{...offer,value:'line\nbreak'},{...offer,type:'phone',value:'123'},{...offer,type:'qq',value:'abcde'},{...offer,ownerId:A.userId}])assert.equal((await request(s,B,body)).status,400);
  const created=await request(s),id=created.data.exchange.id;
  s.env.DB.sqlite.prepare('UPDATE contact_exchanges SET expires_at=? WHERE id=?').run(Date.now()-1,id);
  assert.equal((await read(s,A)).data.exchange.status,'expired');
  assert.equal((await act(s,A,'accept',id,{type:'wechat',value:'another_value',consent:true})).status,409);
  assert.equal((await request(s)).status,201);
});

test('concurrent crossed requests never imply acceptance; accept/cancel race cannot expose a cancelled grant',async t=>{
  const s=await setup(t),requests=await Promise.all([request(s,A),request(s,B)]);
  assert.deepEqual(requests.map(r=>r.status).sort(),[201,409]);
  const row=s.env.DB.sqlite.prepare("SELECT * FROM contact_exchanges WHERE status='pending'").get();
  const sender=row.requester_id===A.userId?A:B,receiver=sender===A?B:A;
  const results=await Promise.all([act(s,sender,'cancel',row.id),act(s,receiver,'accept',row.id,{type:'wechat',value:'another_value',consent:true})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const latest=(await read(s,receiver)).data.exchange;
  if(latest.status==='cancelled')assert(!latest.contacts);else assert.equal(latest.status,'accepted');
});

test('old production database retains private chat and safely gates exchange until additive migration',async t=>{
  const s=await setup(t,{legacy:true});
  assert.deepEqual((await read(s,A)).data,{enabled:false,exchange:null});assert.equal((await request(s)).status,503);
  assert.equal((await api(s.env,`/api/conversations/${s.conversationId}/messages`,{method:'POST',viewer:B,body:{body:'不交换联系方式也可以沟通'}})).status,201);
  s.env.DB.sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0003_contact_exchanges.sql',import.meta.url),'utf8'));
  assert.equal((await read(s,A)).data.enabled,true);assert.equal((await request(s)).status,201);
  assert.deepEqual(s.env.DB.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
