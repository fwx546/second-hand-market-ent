import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { categories } from '../public/data.js';
import { DEMO_CATALOG } from '../server/demo-catalog.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/await refreshSession\(\);\s*$/,'');
const guest={user:null,development:false,authentication:{provider:'guest',email:{configured:true}}};
const member={user:{id:'school_test',emailVerified:true,displayName:'测试同学'},authentication:{provider:'school_email',email:{configured:true}}};
const sample={id:Object.keys(DEMO_CATALOG)[0],isDemo:true,title:'示例小风扇',seller:'橘子集示例角色',price:35,originalPrice:79,status:'active',campus:'SIP 校区',category:'appliance',condition:'轻微使用痕迹',location:'示例地点',description:'此内容为虚构示例。',images:[Object.values(DEMO_CATALOG)[0]],specs:{型号:'示例型号'},createdAt:Date.now()};

function client(session=guest,api={}){
  const modal={innerHTML:'',hasChildNodes(){return Boolean(this.innerHTML);}};
  const toast={textContent:'',classList:{add(){},remove(){}}};
  const elements={'#app':{innerHTML:''},'#modal-root':modal,'.modal':{focus(){}},'#toast':toast};
  const context={URL,URLSearchParams,FormData,api,categories,location:{origin:'https://campus.test',hash:'#/'},history:{replaceState(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},
    document:{querySelector:s=>elements[s]||null,querySelectorAll:()=>[],activeElement:null,addEventListener(){},body:{classList:{add(){},remove(){}}}},window:{addEventListener(){},scrollTo(){}}};
  vm.runInNewContext(`${source}\nglobalThis.test={state,home,loadHome,card,detail,profile,contact,favorite,imageUrl,productImage,demoImages,loadConversations,loadConversation,messagesPage,sendGreeting,sendProductCard};`,context);
  context.test.state.session=session;
  return{...context.test,context,elements,modal,toast};
}

test('demo stock photos require the explicit demo flag and a known local filename',()=>{
  const c=client();
  assert.deepEqual([...new Set(Object.values(DEMO_CATALOG))].sort(),[...c.demoImages].sort());
  for(const path of Object.values(DEMO_CATALOG)){
    assert.equal(c.imageUrl(path,true),path);
    assert.equal(c.imageUrl(path,false),'');
    assert.equal(c.imageUrl(path),'');
  }
  for(const path of ['https://outside.test/fan.jpg','//outside.test/fan.jpg','/assets/not-a-demo.jpg','/assets/../fan.jpg','/assets/fan.jpg?token=private','/assets/fan.jpg#part'])assert.equal(c.imageUrl(path,true),'');
  assert.equal(c.imageUrl('/api/media/uploaded-photo'),'/api/media/uploaded-photo');
  assert(c.card(sample).includes(`src="${sample.images[0]}"`));
  assert(!c.card({...sample,isDemo:false}).includes(`src="${sample.images[0]}"`));
});

test('example cards and both detail contact controls identify fiction in guest and member views',()=>{
  for(const session of [guest,member]){
    const c=client(session),html=c.detail(sample),card=c.card(sample);
    assert(card.includes('示例商品'));assert(card.includes('轻微使用痕迹'));assert(card.includes('示例展示'));
    assert(html.includes('虚构示例，仅供浏览与收藏，不可交易。'));
    assert(html.includes('虚构示例角色 · 不是真实卖家'));
    assert(html.includes('示例配图 · 商品信息均为虚构'));
    const contacts=[...html.matchAll(/<button[^>]*data-action="contact"[^>]*>[^<]*(?:<[^>]+>[^<]*<\/[^>]+>[^<]*)*<\/button>/g)].map(m=>m[0]);
    assert.equal(contacts.length,2);
    for(const button of contacts){assert(button.includes('disabled'));assert(button.includes('示例商品不可联系'));}
    assert(!c.detail({...sample,isDemo:false}).includes('示例商品不可联系'));
    assert(!c.card({...sample,isDemo:false}).includes('demo-product-tag'));
  }
});

test('known examples bypass login prompts and never request contact data',async()=>{
  for(const session of [guest,member]){
    let calls=0;const c=client(session,{contact:async()=>{calls++;},product:async()=>{calls++;}});
    c.state.detail=sample;await c.contact(sample.id);
    assert.equal(calls,0);assert.equal(c.modal.innerHTML,'');assert(c.toast.textContent.includes('不可交易'));
  }
  let contactCalls=0;const unknown=client(member,{startConversation:async()=>{throw new Error('不可交易');},contact:async()=>{contactCalls++;}});
  await unknown.contact(sample.id);assert.equal(contactCalls,0);assert.equal(unknown.modal.innerHTML,'');assert(unknown.toast.textContent.includes('不可交易'));
});

test('local preview opens a fictional demo chat without creating or sending real conversations',async()=>{
  const preview={...guest,development:true};let realCalls=0;
  const c=client(preview,{product:async()=>({product:sample}),conversations:async()=>{realCalls++;throw new Error('real inbox called');},startConversation:async()=>{realCalls++;throw new Error('real conversation called');},sendMessage:async()=>{realCalls++;throw new Error('real message called');}});
  c.state.detail=sample;
  const html=c.detail(sample);
  assert(html.includes('模拟发消息'));
  assert(!html.includes('data-action="contact" data-id="'+sample.id+'" disabled'));
  await c.contact(sample.id);
  assert.equal(c.context.location.hash,`/messages/preview_${sample.id}?from=product`);
  c.context.location.hash=`#${c.context.location.hash}`;
  await c.loadConversation(`preview_${sample.id}`);
  assert(c.messagesPage().includes('本地模拟对话'));
  assert(c.messagesPage().includes('了解交换联系方式'));
  assert(c.messagesPage().includes('product-card-prompt'));
  await c.sendGreeting();
  assert.equal(c.state.messages.at(-1).body,'你好呀，商品还在吗？');
  await c.sendProductCard();
  assert.equal(c.state.messages.at(-1).kind,'product_card');
  c.context.location.hash='#/messages';
  await c.loadConversations();
  assert(c.messagesPage().includes('示例小风扇'));
  assert.equal(realCalls,0);
});

test('real listings retain school-login contact behavior',async()=>{
  const real={...sample,isDemo:false,images:['/api/media/user-photo']};
  let reads=0;const visitor=client(guest,{contact:async()=>{reads++;}});visitor.state.detail=real;await visitor.contact(real.id);
  assert.equal(reads,0);assert(visitor.modal.innerHTML.includes('学校邮箱'));
  const owner=client(member,{startConversation:async()=>{reads++;return{conversationId:'conversation_fixture'};},contact:async()=>{throw new Error('Private endpoint must not be read');}});owner.state.detail=real;await owner.contact(real.id);
  assert.equal(reads,1);assert.equal(owner.context.location.hash,'/messages/conversation_fixture?from=product');assert(!owner.modal.innerHTML.includes('fixture_contact'));
});

test('filtered catalog counts come from the server through initial load and pagination',async()=>{
  let call=0;const c=client(guest,{products:async()=>++call===1?{items:[sample],total:19,realTotal:1,demoTotal:18,categoryCounts:{all:19,appliance:7,ebike:6,daily:6},page:1,hasMore:true}:{items:[{...sample,id:'second-demo'}],total:19,realTotal:1,demoTotal:18,categoryCounts:{all:19,appliance:7,ebike:6,daily:6},page:2,hasMore:false}});
  await c.loadHome();assert.equal(c.state.home.items.length,1);assert.equal(c.state.home.realTotal,1);assert.equal(c.state.home.demoTotal,18);
  assert(c.home().includes('真实发布 1 件 · 示例 18 件'));assert(c.home().includes('分类数量包含示例'));
  await c.loadHome(true);assert.equal(c.state.home.items.length,2);assert.equal(c.state.home.demoTotal,18);assert.equal(c.state.home.page,2);
  c.context.api.products=async()=>({items:[],total:0,realTotal:0,demoTotal:0,categoryCounts:{},page:1,hasMore:false});c.state.filters.query='没有这个商品';
  await c.loadHome();assert.equal(c.state.home.items.length,0);assert.equal(c.state.home.demoTotal,0);assert(!c.home().includes('demo-catalog-notice'));assert(c.home().includes('暂时没有符合筛选的商品'));
});

test('favorite examples use the account API and remain marked in the personal collection',async()=>{
  const changes=[],c=client(member,{favorite:async(...args)=>{changes.push(args);return{ok:true};}});
  c.state.home.items=[sample];await c.favorite(sample.id);assert.deepEqual(changes,[[sample.id,true]]);assert(c.state.favoriteIds.has(sample.id));
  c.state.tab='favorites';c.state.favorites=[sample];const html=c.profile();assert(html.includes('示例商品'));assert(html.includes('aria-pressed="true"'));
  await c.favorite(sample.id);assert.deepEqual(changes[1],[sample.id,false]);assert.equal(c.state.favorites.length,0);
});
