import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { A, B, api as serverApi, fixture, productInput, upload } from './support.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/await refreshSession\(\);\s*$/,'');
async function setup(t){
  const env=fixture(t),photo=await upload(env,A),input=productInput([photo.data.mediaId]);delete input.contactValue;delete input.contactType;
  const item=await serverApi(env,'/api/products',{method:'POST',viewer:A,body:input});
  const chat=await serverApi(env,'/api/conversations',{method:'POST',viewer:B,body:{productId:item.data.product.id}});
  return {env,id:chat.data.conversationId};
}
function client(s,viewer){
  const modal={innerHTML:'',hasChildNodes(){return Boolean(this.innerHTML);}},compose={value:'尚未发送的私信内容'};
  const elements={'#app':{innerHTML:''},'#modal-root':modal,'.modal':{focus(){}},'#toast':{classList:{add(){},remove(){}}},'#exchange-feedback':{textContent:''},'#contact-exchange-panel':{innerHTML:''},'#message-compose':compose};
  class TestFormData extends FormData{constructor(form){super();for(const [key,value] of form?._values||[])this.set(key,value);}}
  const call=async(method,body)=>{const result=await serverApi(s.env,`/api/conversations/${s.id}/contact-exchange`,{method,viewer,body});if(result.status>=400){const error=new Error(result.data.error.message);error.status=result.status;throw error;}return result.data;};
  const context={URL,URLSearchParams,FormData:TestFormData,console,categories:[],location:{origin:'https://juzi.example',hash:`#/messages/${s.id}`},history:{replaceState(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},api:{contactExchange:()=>call('GET'),exchangeContact:(_id,body)=>call('POST',body)},document:{querySelector:key=>elements[key]||null,querySelectorAll:()=>[],activeElement:null,addEventListener(){},body:{classList:{add(){},remove(){}}}},window:{scrollTo(){},addEventListener(){}}};
  vm.runInNewContext(`${source}\nglobalThis.qa={state,contactExchangePanel,openContactExchange,submitContactExchange,updateContactExchange,refreshContactExchange,safeContactExchange};`,context);
  const qa=context.qa;qa.state.session={user:{id:viewer.userId,emailVerified:true},authentication:{provider:'school_email'}};qa.state.activeConversation={id:s.id,otherName:'本地测试对方'};
  return{...qa,elements,modal,compose,context};
}
function form(s,action,requestId,type,value,consent=true){return{reportValidity:()=>true,dataset:{conversationId:s.id,exchangeAction:action,requestId},_values:[['type',type],['value',value],...(consent?[['consent','on']]:[])]};}

test('actual frontend submission and backend transition complete mutual exchange without contact prerequisites',async t=>{
  const s=await setup(t),seller=client(s,A),buyer=client(s,B);
  await Promise.all([seller.refreshContactExchange(s.id),buyer.refreshContactExchange(s.id)]);
  buyer.openContactExchange('request');assert(buyer.modal.innerHTML.includes('exchange-consent'));
  await buyer.submitContactExchange(form(s,'request','','wechat','buyer_private',false));
  assert.equal(s.env.DB.sqlite.prepare('SELECT count(*) AS n FROM contact_exchanges').get().n,0);
  assert(buyer.elements['#exchange-feedback'].textContent.includes('确认本次分享'));
  await buyer.submitContactExchange(form(s,'request','','wechat','buyer_private'));
  assert.equal(buyer.state.contactExchange.exchange.status,'pending');assert(!buyer.contactExchangePanel().includes('buyer_private'));
  await seller.refreshContactExchange(s.id);assert(seller.contactExchangePanel().includes('同意并选择我的联系方式'));
  assert(!seller.contactExchangePanel().includes('buyer_private'));
  const id=seller.state.contactExchange.exchange.id;seller.openContactExchange('accept');
  await seller.submitContactExchange(form(s,'accept',id,'qq','123456789'));
  await buyer.refreshContactExchange(s.id);
  for(const c of [seller,buyer]){assert(c.contactExchangePanel().includes('buyer_private'));assert(c.contactExchangePanel().includes('123456789'));assert.equal(c.compose.value,'尚未发送的私信内容');}
  await seller.updateContactExchange('revoke',id);await buyer.refreshContactExchange(s.id);
  for(const c of [seller,buyer]){assert.equal(c.state.contactExchange.exchange.status,'revoked');assert(!c.contactExchangePanel().includes('buyer_private'));assert(!c.contactExchangePanel().includes('123456789'));}
});

test('frontend strips accidental contacts on pending responses and refuses incomplete accepted responses',async t=>{
  const s=await setup(t),c=client(s,A);
  const pending=c.safeContactExchange({enabled:true,exchange:{id:'exchange_test',status:'pending',direction:'incoming',contacts:{other:{type:'wechat',value:'must_never_show'}}}});
  assert(!JSON.stringify(pending).includes('must_never_show'));
  assert.throws(()=>c.safeContactExchange({enabled:true,exchange:{id:'exchange_test',status:'accepted',direction:'incoming'}}));
});

test('late polling cannot restore contact values after a successful revoke',async t=>{
  const s=await setup(t),c=client(s,A);let finish;
  c.context.api.contactExchange=()=>new Promise(resolve=>{finish=resolve;});
  const polling=c.refreshContactExchange(s.id);
  c.context.api.exchangeContact=async()=>({enabled:true,exchange:{id:'exchange_test',status:'revoked',direction:'outgoing',updatedAt:Date.now()}});
  await c.updateContactExchange('revoke','exchange_test');
  finish({enabled:true,exchange:{id:'exchange_test',status:'accepted',direction:'outgoing',contacts:{mine:{type:'wechat',value:'old_private'},other:{type:'qq',value:'123456789'}}}});
  await polling;assert.equal(c.state.contactExchange.exchange.status,'revoked');assert(!c.contactExchangePanel().includes('old_private'));
});
