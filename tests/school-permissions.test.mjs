import test from 'node:test';
import assert from 'node:assert/strict';
import { A, api, fixture, publish } from './support.mjs';

test('legacy platform and OIDC identities cannot acquire school-email permissions',async t=>{
  const env=fixture(t),created=await publish(env),id=created.data.product.id;
  assert.equal(created.status,201);
  for(const viewer of [
    {userId:A.userId,provider:'chatgpt'},
    {userId:A.userId,provider:'external',emailVerified:true},
    {userId:A.userId,provider:'school_email',emailVerified:false},
    {userId:A.userId,provider:'guest',emailVerified:true},
  ]){
    assert.equal((await api(env,`/api/products/${id}/contact`,{viewer})).status,401);
    assert.equal((await api(env,`/api/products/${id}`,{viewer,method:'PATCH',body:{status:'inactive'}})).status,401);
    assert.equal((await api(env,`/api/me/favorites/${id}`,{viewer,method:'PUT'})).status,401);
    assert.equal((await api(env,'/api/me/products',{viewer})).status,401);
    assert.equal((await api(env,`/api/products/${id}`,{viewer})).data.product.mine,false);
  }
});

test('public school-email badge follows persisted owner verification and reveals no mailbox',async t=>{
  const env=fixture(t),created=await publish(env),path=`/api/products/${created.data.product.id}`;
  assert.equal((await api(env,path)).data.product.sellerEmailVerified,false);
  await env.DB.prepare('INSERT INTO school_email_accounts (email_hash,user_id,email_masked,verified_at) VALUES (?,?,?,?)')
    .bind('fixture-private-hash',A.userId,A.emailMasked,Date.now()).run();
  const detail=(await api(env,path)).data.product;
  assert.equal(detail.sellerEmailVerified,true);
  const serialized=JSON.stringify(detail);
  assert(!serialized.includes(A.emailMasked));
  assert(!serialized.includes(A.userId));
  assert(!serialized.includes('fixture-private-hash'));
});
