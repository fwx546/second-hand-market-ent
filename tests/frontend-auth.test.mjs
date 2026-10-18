import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { api as browserApi, request } from '../public/api.js';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/await refreshSession\(\);\s*$/,'');
const guestSession=(configured=true)=>({user:null,development:false,authentication:{provider:'guest',email:{configured,domain:'student.xjtlu.edu.cn'},guest:{enabled:true}}});
const schoolSession=(id='school_1')=>({user:{id,emailVerified:true,schoolVerified:false,emailMasked:'e***3@student.xjtlu.edu.cn'},development:false,authentication:{provider:'school_email',email:{configured:true},guest:{enabled:true}}});

function client(session=guestSession(),api={}){
  const modalRoot={innerHTML:'',hasChildNodes(){return Boolean(this.innerHTML);}};
  const elements={'#app':{innerHTML:''},'#modal-root':modalRoot,'.modal':{focus(){}},'#toast':{classList:{add(){},remove(){}}}};
  const events=new Map(),navigation=[];
  const location={origin:'https://campus.test',hash:'#/login?return_to=%2F%23%2Fpublish'};
  class TestFormData extends FormData{constructor(form){super();for(const[key,value]of form?._values||[])this.set(key,value);}}
  const context={URL,URLSearchParams,FormData:TestFormData,console,api,categories:[],location,history:{replaceState(_a,_b,hash){location.hash=hash;}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},
    document:{querySelector:s=>elements[s]||null,querySelectorAll:()=>[],activeElement:null,addEventListener(){},body:{classList:{add(){},remove(){}}}},
    window:{scrollTo(){},top:{location:{assign(path){navigation.push(path);}}},addEventListener(name,fn){events.set(name,fn);}}};
  vm.runInNewContext(`${source}\nglobalThis.test={state,signedIn,safeReturnTo,loginPath,loginPage,authGate,footer,promptLogin,profile,detail,newDraft,loadRoute,refreshSession,setLoginEmail,retrySeconds,challengeActive,sendEmailCode,verifyEmailCode,becomeGuest,logout,confirmLogout,authExpired,clearPersonalState,hasUnsavedDraft,editProfile,saveProfile,confirmStatus,changeStatus,card,favorite,contact,discardDraft,publish,saveDraft};`,context);
  context.test.state.session=session;
  return{...context.test,context,elements,modalRoot,events,navigation};
}

function preparedChallenge(c){Object.assign(c.state.emailLogin,{email:'example.student23@student.xjtlu.edu.cn',challengeEmail:'example.student23@student.xjtlu.edu.cn',challengeId:'challenge-test',code:'123456',expiresAt:Date.now()+600000});}

test('only school-email verification establishes business identity, including in development',()=>{
  assert(client(schoolSession()).signedIn());
  assert(!client(guestSession()).signedIn());
  assert(!client({user:{id:'local_seedy'},development:true,authentication:{provider:'chatgpt'}}).signedIn());
  assert(!client({user:{id:'legacy'},authentication:{provider:'external'}}).signedIn());
});

test('login exposes school email and guest only; unavailable mail is not fake delivery',()=>{
  const c=client(guestSession(false)),html=c.loginPage(new URLSearchParams());
  assert(html.includes('Example.Student23@student.xjtlu.edu.cn'));
  assert(html.includes('验证码邮件服务尚未开通，暂不能发送'));
  assert.match(html,/<button[^>]*id="send-email-button"[^>]*disabled>/);
  assert(html.includes('以访客身份浏览'));
  assert(html.includes('每次验证成功后，公开昵称自动设为邮箱前缀并去除数字'));
  for(const old of ['ChatGPT','Seedy','OIDC','Authing','手机号登录','微信登录','/api/auth/start'])assert(!html.includes(old));
  assert(!html.includes('验证码已发送'));
});

test('safe destinations remain existing same-origin hash routes',()=>{
  const c=client();
  for(const path of ['/#/','/#/publish','/#/publish?edit=abc-123','/#/profile?tab=favorites','/#/product/abc-123'])assert.equal(c.safeReturnTo(path),path);
  for(const path of ['https://evil.test/','//evil.test/','/api/auth/guest','/#/login','/\\evil.test/','/\n#/publish'])assert.equal(c.safeReturnTo(path),'/#/');
});

test('email validation accepts ordinary school aliases and rejects other domains and invalid dots',async()=>{
  let sent;
  const c=client(guestSession(),{sendEmail:async email=>{sent=email;return{challengeId:'new-challenge',expiresIn:600,retryAfter:60,emailMasked:'e***3@student.xjtlu.edu.cn'};}});
  c.state.emailLogin.email='  Example.Student23@STUDENT.XJTLU.EDU.CN  ';
  await c.sendEmailCode();assert.equal(sent,'example.student23@student.xjtlu.edu.cn');assert.equal(c.state.emailLogin.email,'Example.Student23@STUDENT.XJTLU.EDU.CN');assert(c.challengeActive());assert(c.retrySeconds()>0&&c.retrySeconds()<=60);assert(c.state.emailLogin.notice.includes('验证码已发送'));
  for(const value of ['x@example.com','x@student.xjtlu.edu.cn.evil.test','.x@student.xjtlu.edu.cn','x.@student.xjtlu.edu.cn','x..y@student.xjtlu.edu.cn',`${'x'.repeat(65)}@student.xjtlu.edu.cn`]){
    sent=null;const bad=client(guestSession(),{sendEmail:async()=>{sent='called';}});bad.state.emailLogin.email=value;await bad.sendEmailCode();assert.equal(sent,null);assert(!bad.state.emailLogin.challengeId);
  }
});

test('verification preserves typed email case for display name while challenge identity stays normalized',async()=>{
  let submitted;
  const c=client(guestSession(),{verifyEmail:async value=>{submitted=value;return{ok:true};},session:async()=>schoolSession(),favorites:async()=>({items:[]})});
  preparedChallenge(c);c.setLoginEmail('  Example.Student23@STUDENT.XJTLU.EDU.CN  ');
  assert(c.challengeActive());assert.equal(c.state.emailLogin.challengeEmail,'example.student23@student.xjtlu.edu.cn');
  await c.verifyEmailCode();assert.equal(submitted.email,'Example.Student23@STUDENT.XJTLU.EDU.CN');assert(c.signedIn());
});

test('changing email invalidates a challenge, code, notice and the old-email countdown',()=>{
  const c=client();preparedChallenge(c);Object.assign(c.state.emailLogin,{requestEmail:c.state.emailLogin.email,retryEmail:c.state.emailLogin.email,retryAt:Date.now()+60000,notice:'sent'});
  c.setLoginEmail('another.student@student.xjtlu.edu.cn');assert.equal(c.state.emailLogin.challengeId,'');assert.equal(c.state.emailLogin.code,'');assert.equal(c.state.emailLogin.notice,'');assert.equal(c.retrySeconds(),0);
});

test('delivery failure creates neither challenge nor success countdown; rate limits use server retry seconds',async()=>{
  const c=client(guestSession(),{sendEmail:async()=>{throw Object.assign(new Error('邮件未能送达'),{status:503,code:'EMAIL_DELIVERY_FAILED'});}});c.state.emailLogin.email='example.student23@student.xjtlu.edu.cn';await c.sendEmailCode();assert.equal(c.state.emailLogin.challengeId,'');assert.equal(c.retrySeconds(),0);assert.equal(c.state.emailLogin.notice,'');
  const limited=client(guestSession(),{sendEmail:async()=>{throw Object.assign(new Error('稍后重试'),{status:429,retryAfter:31});}});limited.state.emailLogin.email='example.student23@student.xjtlu.edu.cn';await limited.sendEmailCode();assert(limited.retrySeconds()>0&&limited.retrySeconds()<=31);assert.equal(limited.state.emailLogin.notice,'');
});

test('an obsolete send response cannot bind a code to a newly edited email',async()=>{
  let resolve;
  const c=client(guestSession(),{sendEmail:()=>new Promise(done=>{resolve=done;})});c.state.emailLogin.email='example.student23@student.xjtlu.edu.cn';const pending=c.sendEmailCode();c.setLoginEmail('different@student.xjtlu.edu.cn');resolve({challengeId:'old',expiresIn:600,retryAfter:60,emailMasked:'e***3@student.xjtlu.edu.cn'});await pending;assert.equal(c.state.emailLogin.challengeId,'');assert.equal(c.state.emailLogin.notice,'');
});

test('verify ok alone does not manufacture a login; session confirmation can be retried without reusing the code',async()=>{
  let verifications=0,confirmations=0;
  const c=client(guestSession(),{verifyEmail:async()=>{verifications++;return{ok:true};},session:async()=>{confirmations++;return confirmations===1?guestSession():schoolSession();},favorites:async()=>({items:[]})});preparedChallenge(c);
  await c.verifyEmailCode();assert(!c.signedIn());assert(c.state.emailLogin.verifiedPending);assert.equal(c.context.location.hash,'#/login?return_to=%2F%23%2Fpublish');
  await c.verifyEmailCode();assert(c.signedIn());assert.equal(verifications,1);assert.equal(c.context.location.hash,'/publish');assert.equal(c.navigation.length,0);assert.equal(c.state.emailLogin.code,'');
});

test('expired and exhausted codes require a new challenge',async()=>{
  for(const code of ['CODE_EXPIRED','CODE_ATTEMPTS_EXCEEDED']){
    const c=client(guestSession(),{verifyEmail:async()=>{throw Object.assign(new Error('请重新发送'),{status:code==='CODE_EXPIRED'?410:429,code});}});preparedChallenge(c);await c.verifyEmailCode();assert.equal(c.state.emailLogin.challengeId,'');assert.equal(c.state.emailLogin.code,'');assert(!c.signedIn());
  }
});

test('a possible account switch blocks the old identity until the new session is confirmed',async()=>{
  const c=client(schoolSession('old'),{verifyEmail:async()=>({ok:true}),session:async()=>{throw new Error('Session confirmation unavailable');}});c.state.draft=c.newDraft();c.state.draft.fields.title='Old account draft';preparedChallenge(c);await c.verifyEmailCode();assert(!c.signedIn());assert(c.state.identityUnconfirmed);c.setLoginEmail('other@student.xjtlu.edu.cn');assert(!c.signedIn());assert.equal(c.state.emailLogin.priorUserId,'old');
});

test('email login preserves anonymous/same-account drafts and clears drafts from a different account',async()=>{
  for(const prior of [guestSession(),schoolSession('same'),schoolSession('other')]){
    const c=client(prior,{verifyEmail:async()=>({ok:true}),session:async()=>schoolSession('same'),favorites:async()=>({items:[]})});c.state.draft=c.newDraft();c.state.draft.fields.title='Unsaved goods';preparedChallenge(c);await c.verifyEmailCode();
    if(prior.user?.id==='other')assert.equal(c.state.draft,null);else assert.equal(c.state.draft.fields.title,'Unsaved goods');
  }
});

test('guest entry actually posts and confirms anonymous session, clears private caches and goes home',async()=>{
  let posts=0;const c=client(schoolSession(),{guest:async()=>{posts++;return{ok:true};},session:async()=>guestSession()});c.state.favorites=[{id:'private'}];c.state.published=[{id:'mine'}];c.state.detail={mine:true};await c.becomeGuest();assert.equal(posts,1);assert.equal(c.state.session.user,null);assert.equal(c.state.favorites.length,0);assert.equal(c.state.published.length,0);assert.equal(c.state.detail,null);assert.equal(c.context.location.hash,'/');
});

test('guest mode asks before clearing a draft; failure never invents an anonymous session',async()=>{
  let calls=0;const c=client(schoolSession(),{guest:async()=>{calls++;throw new Error('Network unavailable');}});c.state.draft=c.newDraft();c.state.draft.fields.title='Keep';await c.becomeGuest();assert.equal(calls,0);assert(c.modalRoot.innerHTML.includes('清除草稿，进入访客'));
  await c.becomeGuest('guest',true);assert.equal(calls,1);assert(c.signedIn());assert.equal(c.state.draft.fields.title,'Keep');assert(c.state.guestError);
});

test('logout requires server success and a confirmed guest session; never performs external navigation',async()=>{
  let calls=0;const c=client(schoolSession(),{logout:async()=>{calls++;return{ok:true};},session:async()=>guestSession()});c.confirmLogout();assert.equal(calls,0);await c.logout();assert.equal(calls,1);assert(!c.signedIn());assert.equal(c.navigation.length,0);assert.equal(c.context.location.hash,'/');
});

test('a later session refresh resolves uncertain identity and drops the old-account draft',async()=>{
  const c=client(schoolSession('old'),{session:async()=>guestSession()});c.state.identityUnconfirmed=true;c.state.draft=c.newDraft();c.state.draft.fields.title='Old private draft';await c.refreshSession();assert.equal(c.state.session.user,null);assert.equal(c.state.identityUnconfirmed,false);assert.equal(c.state.draft,null);
});

test('public seller badge uses server boolean and own profile shows only masked email',()=>{
  const c=client(schoolSession()),p={id:'abc',images:[],title:'Fan',price:20,status:'active',specs:{},seller:'Student',sellerEmailVerified:true};assert(c.detail(p).includes('学校邮箱已验证'));assert(c.detail({...p,sellerEmailVerified:false}).includes('学校邮箱未核验'));assert(c.profile().includes('e***3@student.xjtlu.edu.cn'));assert(c.profile().includes('未核验在读学籍'));
});

test('auth requests use same-origin JSON POST and numeric bounded retry metadata',async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json({ok:true});});await browserApi.sendEmail('example.student23@student.xjtlu.edu.cn');await browserApi.verifyEmail({email:'example.student23@student.xjtlu.edu.cn',challengeId:'test',code:'123456'});await browserApi.guest();await browserApi.logout();for(const call of calls){assert.equal(call.options.method,'POST');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.headers['Content-Type'],'application/json');assert(!call.path.includes('123456'));}
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'RATE_LIMITED',message:'Wait'}},{status:429,headers:{'Retry-After':'60'}}));await assert.rejects(()=>request('/api/auth/email/send'),error=>error.retryAfter===60&&typeof error.retryAfter==='number');
});

test('no browser persistence or URL parameter holds the email code; draft beforeunload remains',()=>{
  assert(!source.includes('localStorage')&&!source.includes('sessionStorage')&&!source.includes('console.log('));const c=client();c.state.draft=c.newDraft();c.state.draft.fields.title='Keep';let prevented=false;c.events.get('beforeunload')({preventDefault(){prevented=true;}});assert(prevented);
});

test('profile defaults populate a clean new draft and profile edits do not mutate an existing draft',async()=>{
  const session=schoolSession();Object.assign(session.user,{displayName:'小橘子',campus:'太仓校区'});
  const updated={...session.user,displayName:'新昵称',campus:'SIP 校区'};let body;
  const c=client(session,{profile:async value=>{body=value;return{user:updated};}});c.state.draft=c.newDraft();
  assert.equal(c.state.draft.fields.seller,'小橘子');assert.equal(c.state.draft.fields.campus,'太仓校区');assert(!c.hasUnsavedDraft());
  c.editProfile();assert(c.modalRoot.innerHTML.includes('不会修改已有商品'));assert(c.modalRoot.innerHTML.includes('邮箱前缀去除数字重新设置'));assert(c.modalRoot.innerHTML.includes('maxlength="20"'));
  const form={reportValidity:()=>true,elements:[{disabled:false}],_values:[['displayName',' 新昵称 '],['campus','SIP 校区']]};
  await c.saveProfile(form);assert.equal(body.displayName,'新昵称');assert.equal(body.campus,'SIP 校区');assert.equal(c.state.session.user.displayName,'新昵称');
  assert.equal(c.state.draft.fields.seller,'小橘子');assert.equal(c.state.draft.fields.campus,'太仓校区');assert(c.profile().includes('你好，新昵称！'));
});

test('401 discards private caches but preserves account-bound draft for same-account reauthentication',async()=>{
  for(const nextId of ['old','different']){
    const c=client(schoolSession('old'),{verifyEmail:async()=>({ok:true}),session:async()=>schoolSession(nextId),favorites:async()=>({items:[]})});
    c.state.draft=c.newDraft();c.state.draft.fields.title='私人物品草稿';c.state.published=[{id:'private'}];c.state.favorites=[{id:'saved'}];
    assert(c.authExpired({status:401},false));assert(!c.signedIn());assert.equal(c.state.published.length,0);assert.equal(c.state.favorites.length,0);assert.equal(c.state.emailLogin.priorUserId,'old');assert.equal(c.state.draft.fields.title,'私人物品草稿');
    preparedChallenge(c);await c.verifyEmailCode();
    if(nextId==='old')assert.equal(c.state.draft.fields.title,'私人物品草稿');else assert.equal(c.state.draft,null);
  }
});

test('profile 401 replaces old account content with login gate instead of endless retry',async()=>{
  const c=client(schoolSession(),{mine:async()=>{throw Object.assign(new Error('Expired'),{status:401});},favorites:async()=>({items:[]})});
  c.context.location.hash='#/profile';c.state.published=[{id:'private'}];await c.loadRoute();
  assert(!c.signedIn());assert.equal(c.state.published.length,0);assert(c.elements['#app'].innerHTML.includes('学校邮箱 / 访客登录'));assert(!c.elements['#app'].innerHTML.includes('Expired'));
});

test('publish 401 preserves entered goods and uploaded images with a reauthentication link',async()=>{
  const c=client(schoolSession('old'),{save:async()=>{throw Object.assign(new Error('登录已失效'),{status:401});}}),submit={};
  c.context.location.hash='#/publish';c.state.draft=c.newDraft();const draft=c.state.draft;
  Object.assign(draft.fields,{title:'小风扇',description:'使用情况良好，毕业转让',seller:'测试昵称',location:'图书馆正门',contactValue:'test_contact',price:'30'});draft.specs.appliance={型号:'测试风扇',使用情况:'正常使用'};draft.images=[{url:'/api/media/photo',mediaId:'photo'}];
  c.elements['#publish-form']={reportValidity:()=>true,elements:[submit],querySelector:()=>submit};c.elements['#publish-feedback']={innerHTML:'',scrollIntoView(){}};
  await c.saveDraft();assert(!c.signedIn());assert.equal(c.state.emailLogin.priorUserId,'old');assert.equal(c.state.draft,draft);assert.equal(draft.images[0].mediaId,'photo');assert.equal(draft.fields.title,'小风扇');assert(c.elements['#publish-feedback'].innerHTML.includes('学校邮箱重新登录'));assert.equal(submit.disabled,false);
});

test('a delayed favorite result cannot contaminate another account or guest caches',async()=>{
  let resolve;const c=client(schoolSession('old'),{favorite:()=>new Promise(done=>{resolve=done;})});
  const operation=c.favorite('old-product');c.clearPersonalState();c.state.session=schoolSession('new');resolve({ok:true});await operation;
  assert.equal(c.state.favoriteIds.size,0);assert.equal(c.state.favorites.length,0);
});

test('changing edited product requires confirmation and cancellation retains the original draft',async()=>{
  let reads=0;const c=client(schoolSession(),{product:async()=>{reads++;throw new Error('Should not read before confirmation');}});
  c.state.draft=c.newDraft();c.state.draft.fields.title='尚未保存';c.context.location.hash='#/publish?edit=another';await c.loadRoute();
  assert.equal(reads,0);assert.equal(c.context.location.hash,'#/publish');assert(c.modalRoot.innerHTML.includes('保留当前草稿'));assert.equal(c.state.draft.fields.title,'尚未保存');
  c.discardDraft();assert.equal(c.state.draft,null);assert.equal(c.context.location.hash,'/publish?edit=another');
});

test('management shows distinct sold/deleted states and uses DELETE then inactive restore',async()=>{
  const calls=[];const c=client(schoolSession(),{remove:async id=>{calls.push(['DELETE',id]);return{product:{id,status:'deleted'}};},save:async(id,body)=>{calls.push(['PATCH',id,body.status]);return{product:{id,status:body.status}};}});
  const p={id:'goods',status:'active',title:'小风扇',images:[]};c.state.published=[p];
  c.confirmStatus('goods','deleted');assert(c.modalRoot.innerHTML.includes('恢复为已下架'));await c.changeStatus('goods','deleted');assert.equal(calls[0][0],'DELETE');
  p.status='deleted';const deleted=c.card(p,{manage:true});assert(deleted.includes('已删除'));assert(deleted.includes('恢复到已下架'));assert(!deleted.includes('标记售出'));assert(!deleted.includes('编辑</a>'));
  await c.changeStatus('goods','inactive');assert.equal(calls[1][2],'inactive');p.status='sold';assert(c.card(p,{manage:true}).includes('已售出'));
  c.state.managementStatus='sold';const html=c.profile();assert(html.includes('发布状态'));assert(html.includes('已售出'));assert(!html.includes('恢复到已下架'));
});

test('QQ contact editor and contact modal include bounded value and meetup context',async()=>{
  const c=client(schoolSession(),{contact:async()=>({type:'qq',value:'123456789'})});c.state.draft=c.newDraft();c.state.draft.fields.contactType='qq';
  const form=c.publish();assert(form.includes('value="qq" selected'));assert.match(form,/<input id="field-contactValue"[^>]*maxlength="80"/);assert(form.includes('QQ 号'));
  c.state.detail={id:'goods',campus:'太仓校区',location:'图书馆正门',seller:'橘子同学'};await c.contact('goods');
  assert(c.modalRoot.innerHTML.includes('QQ 号'));assert(c.modalRoot.innerHTML.includes('123456789'));assert(c.modalRoot.innerHTML.includes('太仓校区'));assert(c.modalRoot.innerHTML.includes('图书馆正门'));
});

test('network timeout and caller cancellation abort requests without pretending a successful write',async t=>{
  t.mock.method(globalThis,'fetch',async(_path,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})),{once:true})));
  await assert.rejects(()=>request('/api/products',{method:'POST',body:{},timeoutMs:5}),error=>error.code==='REQUEST_TIMEOUT'&&error.status===0);
  const controller=new AbortController(),pending=request('/api/me',{signal:controller.signal,timeoutMs:1000});controller.abort();await assert.rejects(()=>pending,error=>error.name==='AbortError');
});
