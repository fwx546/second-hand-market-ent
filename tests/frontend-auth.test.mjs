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
  vm.runInNewContext(`${source}\nglobalThis.test={state,contactExchangePanel,openContactExchange,updateContactExchange,refreshContactExchange,home,chips,normalizeFilters,signedIn,safeReturnTo,loginPath,loginPage,authGate,footer,promptLogin,profile,settingsPage,detail,newDraft,categoryFields,captureDraft,validateDraft,loadRoute,refreshSession,setLoginEmail,retrySeconds,challengeActive,sendEmailCode,verifyEmailCode,localPreviewLogin,becomeGuest,logout,confirmLogout,authExpired,clearPersonalState,hasUnsavedDraft,editProfile,saveProfile,confirmStatus,changeStatus,card,favorite,contact,discardDraft,publish,saveDraft};`,context);
  context.test.state.session=session;
  return{...context.test,context,elements,modalRoot,events,navigation};
}

function preparedChallenge(c){Object.assign(c.state.emailLogin,{email:'example.student23@student.xjtlu.edu.cn',challengeEmail:'example.student23@student.xjtlu.edu.cn',challengeId:'challenge-test',code:'123456',expiresAt:Date.now()+600000});}

test('category switching retains separate drafts and submits only service parameters',()=>{
  const c=client(schoolSession());
  c.state.draft=c.newDraft({category:'daily',title:'原标题',location:'图书馆',specs:{数量:'一个',使用情况:'正常'}});
  const form={_values:[['category','service'],['title','课程辅导'],['spec-0','小号'],['spec-1','一个'],['spec-2','正常']]};
  c.elements['#publish-form']=form;c.captureDraft();
  assert.equal(c.state.draft.fields.category,'service');assert.equal(c.state.draft.specs.daily['数量'],'一个');
  assert.equal(c.state.draft.specs.service['服务方式'],'线上服务');
  form._values=[['category','daily'],['title','服务标题'],['spec-0','学习辅导'],['spec-1','每小时'],['spec-2','线上服务'],['spec-3','基础讲解'],['spec-4','每次60分钟'],['spec-5','提前一天']];
  c.captureDraft();assert.equal(c.state.draft.fields.title,'课程辅导');
  form._values=[['category','service']];c.captureDraft();assert.equal(c.state.draft.fields.title,'服务标题');
  Object.assign(c.state.draft.fields,{description:'服务内容完整介绍',seller:'测试同学',contactValue:'test_contact',price:'10'});
  c.state.draft.images=[{mediaId:'m1'}];form._values=[['category','service']];form.reportValidity=()=>true;
  const payload=c.validateDraft();
  assert.equal(payload.location,'线上服务');assert.equal(payload.condition,'不适用');assert.equal(payload.originalPrice,0);assert.equal(payload.graduation,false);
  assert(!Object.hasOwn(payload.specs,'数量'));assert(!Object.hasOwn(payload.specs,'自定义单位'));
});

test('service publishing uses service fields and conditional location/custom pricing',()=>{
  const c=client(schoolSession());
  const specs={服务方向:'学习辅导',计价单位:'每小时',服务方式:'线上服务',服务范围:'Python 基础讲解','服务时长／交付周期':'每次60分钟',预约安排:'提前一天'};
  c.state.draft=c.newDraft({category:'service',specs});
  let html=c.publish();
  assert(html.includes('服务标题')); assert(html.includes('服务介绍')); assert(html.includes('作品示例'));
  assert(!html.includes('field-condition')); assert(!html.includes('field-originalPrice')); assert(!html.includes('field-location')); assert(!html.includes('name="graduation"'));
  c.state.draft.specs.service['服务方式']='线下服务';
  c.state.draft.specs.service['计价单位']='自定义';
  html=c.publish(); assert(html.includes('服务地点')); assert(html.includes('自定义单位')); assert(!html.includes('线上沟通方式'));
});

test('publishing explains service availability while the production schema is still old',()=>{
  const session=schoolSession();session.capabilities={servicePublishingReady:false};
  const c=client(session);c.context.categories.push({id:'service',name:'服务类'},{id:'daily',name:'生活用品'});c.state.draft=c.newDraft();
  const html=c.publish();assert.match(html,/<option value="service"[^>]*disabled/);
  assert(html.includes('服务发布暂未开通'));assert(!/<option value="daily"[^>]*disabled/.test(html));
});

test('service detail and cards replace physical labels and show units; management pauses bookings',()=>{
  const c=client(schoolSession()),p={id:'service1',category:'service',title:'Python 辅导',price:10,originalPrice:100,condition:'不适用',campus:'SIP 校区',location:'线上服务',description:'Python 基础辅导服务',status:'active',seller:'测试同学',images:[],specs:{服务方向:'学习辅导',计价单位:'每小时',服务方式:'线上服务',服务范围:'基础知识','服务时长／交付周期':'60分钟',预约安排:'提前一天'}};
  const detail=c.detail(p),card=c.card(p,{manage:true});
  for(const text of ['关于这项服务','线上服务','学习辅导','／小时','发消息'])assert(detail.includes(text),text);
  for(const text of ['线下面交','不适用','购入价','关于这件好物'])assert(!detail.includes(text),text);
  assert(card.includes('暂停接单'));assert(!card.includes('标记售出'));assert(!card.includes('不适用'));
  p.status='inactive';assert(c.card(p,{manage:true}).includes('恢复接单'));
});

test('only school-email verification establishes business identity, including in development',()=>{
  assert(client(schoolSession()).signedIn());
  assert(!client(guestSession()).signedIn());
  assert(!client({user:{id:'local_seedy'},development:true,authentication:{provider:'chatgpt'}}).signedIn());
  assert(!client({user:{id:'legacy'},authentication:{provider:'external'}}).signedIn());
});

test('local preview entry opens the private profile without claiming email verification',async()=>{
  const initial=guestSession(false);initial.development=true;initial.authentication.preview={enabled:true};
  const preview={...initial,user:{id:'local_preview',displayName:'本地体验账号',campus:'',preview:true,emailVerified:false,emailMasked:null},authentication:{...initial.authentication,provider:'local_preview'}};
  const c=client(initial,{preview:async()=>({ok:true}),session:async()=>preview});
  c.context.location.hash='#/login?return_to=%2F%23%2Fprofile';
  assert(c.loginPage(new URLSearchParams()).includes('进入本地体验账号'));
  await c.localPreviewLogin();
  assert(c.signedIn());
  assert.equal(c.context.location.hash,'/profile');
  assert(c.profile().includes('本地模拟登录 · 未验证学校邮箱'));
  c.editProfile();
  assert(c.modalRoot.innerHTML.includes('本地体验账号的资料只保存在本机'));
  assert(!c.modalRoot.innerHTML.includes('下次邮箱验证码登录成功后'));
});

test('profile settings move logout below language and private contact controls',()=>{
  const session=schoolSession();Object.assign(session.user,{displayName:'小橘',language:'zh',phone:'13800138000',wechat:'Orange_123',qq:'12345678'});
  const c=client(session),profile=c.profile(),settings=c.settingsPage();
  assert(profile.includes('href="#/settings"'));
  assert(!profile.includes('profile-logout'));
  assert(settings.indexOf('语言')<settings.indexOf('信息管理'));
  assert(settings.indexOf('信息管理')<settings.indexOf('data-action="logout"'));
  for(const field of ['phone','wechat','qq'])assert(settings.includes(`name="${field}"`));
  session.user.language='en';
  assert(c.settingsPage().includes('Contact information'));
  assert(c.settingsPage().includes('Log out'));
  assert.equal(c.safeReturnTo('/#/settings'),'/#/settings');
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

test('new publication uses saved contact defaults while editing keeps the listing contact',()=>{
  const session=schoolSession();Object.assign(session.user,{displayName:'账号昵称',publishSeller:'常用卖家',publishContactType:'qq',publishContactValue:'123456789'});
  const c=client(session),draft=c.newDraft();
  assert.equal(draft.fields.seller,'常用卖家');
  assert.equal(draft.fields.contactType,'qq');
  assert.equal(draft.fields.contactValue,'123456789');
  draft.fields.contactValue='可修改';
  assert.equal(c.newDraft().fields.contactValue,'123456789');
  const edited=c.newDraft({id:'own-listing',category:'appliance',seller:'商品卖家',images:[]},{type:'wechat',value:'listing_wechat'});
  assert.equal(edited.fields.seller,'商品卖家');
  assert.equal(edited.fields.contactType,'wechat');
  assert.equal(edited.fields.contactValue,'listing_wechat');
  c.state.draft=draft;
  assert(c.publish().includes('下次发布自动填入，仍可修改'));
});

test('daily goods size has no required marker and is omitted when empty',()=>{
  const c=client(schoolSession());
  const draft=c.newDraft();c.state.draft=draft;
  Object.assign(draft.fields,{title:'生活用品',category:'daily',price:'20',description:'使用情况良好',location:'图书馆门口',seller:'卖家',contactValue:'seller_wechat'});
  draft.specs.daily={尺寸:'',数量:'一个',使用情况:'正常'};
  draft.images=[{url:'/api/media/photo',mediaId:'photo'}];
  c.elements['#publish-form']={reportValidity:()=>true,_values:[]};
  assert.match(c.categoryFields(draft),/<label for="field-spec-0">尺寸<\/label><input[^>]*name="spec-0"[^>]*>/);
  assert(!c.categoryFields(draft).match(/name="spec-0"[^>]*required/));
  assert.deepEqual(Object.keys(c.validateDraft().specs),['数量','使用情况']);
  draft.specs.daily.尺寸='小号';
  assert.equal(c.validateDraft().specs.尺寸,'小号');
  draft.fields.contactValue='legacy_private_number';
  const payload=c.validateDraft();assert(!Object.hasOwn(payload,'contactValue'));assert(!Object.hasOwn(payload,'contactType'));
  const form=c.publish();assert(!form.includes('id="field-contactValue"'));assert(!form.includes('legacy_private_number'));assert(form.includes('无需填写微信'));
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

test('switching to service filters removes physical filters and exposes matching service options',()=>{
  const c=client(schoolSession());
  Object.assign(c.state.filters,{category:'service',condition:'全新',fresh:true,graduation:true});c.normalizeFilters();
  assert.equal(c.state.filters.condition,'');assert.equal(c.state.filters.fresh,false);assert.equal(c.state.filters.graduation,false);
  let html=c.home();assert(html.includes('service-direction-filter'));assert(html.includes('service-mode-filter'));
  assert(!html.includes('id="condition-filter"'));assert(!c.chips().includes('毕业转让'));assert(html.includes('按标价排序'));
  Object.assign(c.state.filters,{category:'daily',serviceDirection:'学习辅导',serviceMode:'线上服务'});c.normalizeFilters();
  assert.equal(c.state.filters.serviceDirection,'');assert.equal(c.state.filters.serviceMode,'');assert(c.home().includes('id="condition-filter"'));
});

test('chat exchange cards show no numbers before mutual consent and hide them after revocation',()=>{
  const c=client(schoolSession());c.state.activeConversation={id:'conversation',otherName:'对方'};
  c.state.contactExchange={enabled:true,exchange:{id:'exchange_test',status:'pending',direction:'incoming',offeredType:'wechat'}};
  let html=c.contactExchangePanel();assert(html.includes('同意并选择我的联系方式'));assert(html.includes('暂不交换'));assert(!html.includes('exchange-contacts'));
  c.openContactExchange('accept');assert(c.modalRoot.innerHTML.includes('exchange-consent'));assert(!c.modalRoot.innerHTML.includes('checked'));
  assert(c.modalRoot.innerHTML.includes('取消'));assert(c.modalRoot.innerHTML.includes('本次愿意分享的微信号'));
  c.state.contactExchange.exchange={id:'exchange_test',status:'accepted',contacts:{mine:{type:'qq',value:'12345678'},other:{type:'wechat',value:'private_hello<test>'}}};
  html=c.contactExchangePanel();assert(html.includes('12345678'));assert(html.includes('private_hello&lt;test&gt;'));assert(html.includes('停止共享'));
  c.state.contactExchange.exchange={id:'exchange_test',status:'revoked',updatedAt:Date.now()};
  html=c.contactExchangePanel();assert(!html.includes('private_hello'));assert(!html.includes('12345678'));assert(html.includes('24 小时'));
  c.state.contactExchange={enabled:false,exchange:null};html=c.contactExchangePanel();assert(html.includes('仍可正常私信'));assert(!html.includes('data-action="exchange-request"'));
});

test('exchange updates clear private state on logout and ignore a late response from another identity',async()=>{
  let finish;const c=client(schoolSession('first'),{exchangeContact:()=>new Promise(resolve=>{finish=resolve;})});
  c.state.activeConversation={id:'conversation'};c.state.contactExchange={enabled:true,exchange:null};
  const pending=c.updateContactExchange('request','',{type:'wechat',value:'private_first',consent:true});
  c.clearPersonalState();c.state.session=schoolSession('second');c.state.activeConversation={id:'conversation'};
  finish({enabled:true,exchange:{id:'exchange_first',status:'accepted',contacts:{mine:{type:'wechat',value:'private_first'},other:{type:'qq',value:'12345678'}}}});
  await pending;assert.equal(c.state.contactExchange,null);assert(!c.elements['#app'].innerHTML.includes('private_first'));
});

test('network timeout and caller cancellation abort requests without pretending a successful write',async t=>{
  t.mock.method(globalThis,'fetch',async(_path,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})),{once:true})));
  await assert.rejects(()=>request('/api/products',{method:'POST',body:{},timeoutMs:5}),error=>error.code==='REQUEST_TIMEOUT'&&error.status===0);
  const controller=new AbortController(),pending=request('/api/me',{signal:controller.signal,timeoutMs:1000});controller.abort();await assert.rejects(()=>pending,error=>error.name==='AbortError');
});


