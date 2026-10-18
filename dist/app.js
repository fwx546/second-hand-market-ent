import { categories, seedProducts } from './data.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
 search:'<circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4.5 4.5"/>',
 heart:'<path d="M20.8 4.7a5.4 5.4 0 0 0-7.7 0L12 5.8l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.6a5.4 5.4 0 0 0 0-7.7Z"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 pin:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
 arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
 chevron:'<path d="m8 4 8 8-8 8"/>',
 down:'<path d="m6 9 6 6 6-6"/>',
 home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',
 upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 filter:'<path d="M4 7h16M7 12h10M10 17h4"/>',
 leaf:'<path d="M20 3C10 2 2 6 4 15c2 8 17 8 16-12ZM4 21l11-12"/>',
 shield:'<path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
 bag:'<path d="M4 7h16l1 14H3ZM8 8V6a4 4 0 0 1 8 0v2"/>',
 edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
 refresh:'<path d="M20 7A9 9 0 1 0 21 15M20 2v6h-6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
 fan:'<circle cx="12" cy="9" r="7"/><circle cx="12" cy="9" r="1"/><path d="M12 16v5M7 22h10M12 8c-7-5-6 5-1 2m2-1c7-5-4-7-2-1m1 2c0 8 8 0 1-1"/>',
 bike:'<circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/><path d="m5 17 5-10h5l4 10M8 12h9M8 7H5m7-4h5l2 4"/>',
 cup:'<path d="M4 8h13v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5ZM17 8h2a3 3 0 0 1 0 6h-2M7 2v3m5-3v3"/>'
};
const icon = (name, className='') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.bag}</svg>`;
const money = value => Number(value).toLocaleString('zh-CN', {maximumFractionDigits:2});
const state = { products:[], favorites:[], filters:{query:'', category:'all', campus:'', condition:'', cheap:false, fresh:false, graduation:false, sort:'newest'}, tab:'published', db:null, storageFailed:false };
let lastRoute = '', toastTimer, draftImages = [], modalFocus, saving = false, uploading = false;
const app = $('#app');

async function openStorage() {
  const db = await new Promise((resolve,reject) => {
    const request = indexedDB.open('juzi-campus-demo',1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('存储被另一个页面占用'));
  });
  state.db = db;
  db.onversionchange = () => db.close();
  const stored = await new Promise((resolve,reject) => {
    const request = db.transaction('state').objectStore('state').get('market');
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
  state.products = stored?.products || structuredClone(seedProducts);
  // Keep browser-local demo records compatible with the updated university brief.
  state.products = state.products.map(p=>({...p,campus:p.campus==='主校区'?'SIP 校区':p.campus==='东校区'?'太仓校区':p.campus,location:p.location.replaceAll('主校区','SIP 校区').replaceAll('东校区','太仓校区')}));
  state.favorites = stored?.favorites || [];
  if(!stored) await persist();
}
async function persist() {
  if(!state.db) throw new Error('浏览器存储不可用');
  const data = structuredClone({products:state.products,favorites:state.favorites});
  await new Promise((resolve,reject) => {
    const transaction=state.db.transaction('state','readwrite');
    transaction.objectStore('state').put(data,'market');
    transaction.oncomplete=resolve;
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error || new Error('保存中断'));
  });
}
function toast(message) {
  const target=$('#toast'); target.textContent=message; target.classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>target.classList.remove('visible'),3200);
}
function routeInfo() {
  const hash=location.hash.slice(1) || '/'; const [path,search='']=hash.split('?');
  return {path,params:new URLSearchParams(search)};
}
function navigate(route) { closeModal(); if(location.hash === '#'+route) render(); else location.hash=route; }
function timeAgo(timestamp) {
  const hours=Math.max(0,Math.floor((Date.now()-timestamp)/3600000));
  if(hours<1) return '刚刚发布'; if(hours<24) return `${hours} 小时前`; if(hours<48) return '昨天发布'; return `${Math.floor(hours/24)} 天前`;
}
function categoryName(id) { return categories.find(c=>c.id===id)?.name || '生活用品'; }
function decodeId(value) { try{return decodeURIComponent(value);}catch{return '';} }
function activeProducts() { return state.products.filter(p=>p.status==='active'); }
function header() {
  return `<a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="demo-strip"><span>${icon('sun')} 一点闲置，一点新的可能。</span><span>校园交易演示 <span class="demo-dot"></span> 数据仅保存在本机</span></div>
  <header class="site-header"><div class="container header-inner">
    <a class="brand" href="#/" aria-label="橘子集首页"><img src="assets/orange.svg" width="42" height="42" alt=""><span>橘子集<small>JUZI CAMPUS</small></span></a>
    <button class="location-button" data-action="campus">${icon('pin')}<span>西交利物浦大学<small>${state.filters.campus || '全部校区'}</small></span>${icon('down')}</button>
    <form class="search-form" role="search"><label class="sr-only" for="global-search">搜索校园闲置</label>${icon('search')}<input id="global-search" name="query" placeholder="搜搜好物，让心动有回音" value="${esc(state.filters.query)}" autocomplete="off"><button type="submit" aria-label="搜索">搜索</button></form>
    <div class="header-actions"><a class="header-favorite" href="#/profile?tab=favorites">${icon('heart')}<span>我的收藏</span></a><a class="button primary" href="#/publish">${icon('plus')}<span>发布闲置</span></a><a class="header-avatar" href="#/profile" aria-label="我的个人中心">🍊</a></div>
  </div></header>`;
}
function footer() {
  return `<footer class="site-footer container"><div><a class="brand" href="#/"><img src="assets/orange.svg" alt="" width="32" height="32"><span>橘子集</span></a><p>让每一件好物，都有下一段校园故事。</p></div><div class="footer-links"><span>同校发现 · 友好面交 · 循环生活</span><button class="text-button" data-action="about">关于演示</button><button class="text-button" data-action="reset">重置演示</button></div><p class="footer-note">这是交互演示，商品及联系方式均为示例。你的发布与收藏仅对当前浏览器可见。</p></footer>`;
}
function mobileNav(path) {
  const profile=path.startsWith('/profile'), publishing=path.startsWith('/publish');
  return `<nav class="mobile-nav" aria-label="手机导航"><a href="#/" class="${path==='/'?'active':''}">${icon('home')}<span>逛一逛</span></a><a href="#/profile?tab=favorites" class="${profile && state.tab==='favorites'?'active':''}">${icon('heart')}<span>收藏</span></a><a href="#/publish" class="mobile-publish ${publishing?'active':''}">${icon('plus')}<span>发布</span></a><a href="#/profile" class="${profile && state.tab!=='favorites'?'active':''}">${icon('user')}<span>我的</span></a></nav>`;
}
function card(product,{manage=false}={}) {
  const liked=state.favorites.includes(product.id);
  return `<article class="product-card ${product.status==='inactive'?'is-inactive':''}" data-product-id="${esc(product.id)}">
  <div class="image-wrap"><a href="#/product/${encodeURIComponent(product.id)}" tabindex="-1" aria-hidden="true"><img class="card-image" src="${esc(product.images[0])}" alt="${esc(product.title)}" loading="lazy" width="500" height="400"></a>${product.graduation?'<span class="image-badge">🎓 毕业转让</span>':''}<button class="favorite-button ${liked?'is-favorite':''}" data-action="favorite" data-id="${esc(product.id)}" aria-label="${liked?'取消收藏':'收藏'}${esc(product.title)}" aria-pressed="${liked}">${icon('heart')}</button>${product.status==='inactive'?'<span class="inactive-label">已下架</span>':''}</div>
  <div class="product-body"><div class="card-tags"><span class="condition-tag">${esc(product.condition)}</span><span class="campus-tag">${esc(product.campus)}</span></div><h3 class="product-title"><a href="#/product/${encodeURIComponent(product.id)}">${esc(product.title)}</a></h3><div class="price-row"><span class="price"><small>¥</small>${money(product.price)}</span><span class="old-price">¥${money(product.originalPrice)}</span><span class="negotiable">可小刀</span></div><div class="seller-line"><span><span class="seller-avatar">${esc(product.avatar)}</span>${esc(product.seller)}</span><time datetime="${new Date(product.createdAt).toISOString()}">${timeAgo(product.createdAt)}</time></div>${manage?`<div class="manage-actions"><a class="button secondary small" href="#/publish?edit=${encodeURIComponent(product.id)}">${icon('edit')}编辑</a><button class="button ghost small" data-action="status" data-id="${esc(product.id)}">${product.status==='active'?'下架':'重新上架'}</button></div>`:''}</div></article>`;
}
function filteredProducts() {
  const f=state.filters;
  return activeProducts().filter(p=>(f.category==='all'||p.category===f.category)&&(!f.query||`${p.title} ${p.description} ${categoryName(p.category)}`.toLowerCase().includes(f.query.toLowerCase()))&&(!f.campus||p.campus===f.campus)&&(!f.condition||p.condition===f.condition)&&(!f.cheap||p.price<=100)&&(!f.fresh||p.condition==='几乎全新')&&(!f.graduation||p.graduation)).sort((a,b)=>f.sort==='price-asc'?a.price-b.price:f.sort==='price-desc'?b.price-a.price:b.createdAt-a.createdAt);
}
function chips() {
  return [['cheap','💰','百元以内'],['fresh','✨','几乎全新'],['graduation','🎓','毕业转让']].map(([id,emoji,label])=>`<button class="chip ${state.filters[id]?'active':''}" data-action="chip" data-filter="${id}" aria-pressed="${state.filters[id]}">${emoji} ${label}${state.filters[id]?icon('check'):''}</button>`).join('');
}
function home() {
  const f=state.filters, products=filteredProducts();
  return `<section class="home-hero" aria-labelledby="hero-title"><div class="hero-copy"><span class="eyebrow"><span></span>同校好物 · 快乐接力</span><h1 class="hero-title" id="hero-title">闲置转个弯，<br>好物<span>遇同学<svg viewBox="0 0 200 16" aria-hidden="true"><path d="M4 10Q95 0 195 9" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/></svg></span></h1><p class="hero-subtitle">用不上的闲置，刚刚好的心动。<br>给好物一个新的校园故事。</p><div class="hero-actions"><a class="button primary" href="#/publish">${icon('plus')}让闲置发光${icon('arrow')}</a><a class="hero-secondary" href="#discover">先逛逛好物 ${icon('down')}</a></div><div class="hero-trust"><span>${icon('pin')}同校面交</span><span>${icon('leaf')}循环生活</span><span>✦ 闲置也可爱</span></div></div><div class="hero-art"><img src="assets/hero.svg" alt="可爱的橘子同学和小风扇、电瓶车一起开启闲置好物的新故事" width="600" height="400"><span class="floating-sticker sticker-top">旧物新生，快乐加倍 ✨</span><span class="floating-sticker sticker-bottom">HELLO, NEW STORY!</span></div></section>
  <section class="category-section" aria-label="好物分类"><div class="category-grid">${categories.filter(c=>c.id!=='all').map(c=>`<button class="category-card category-${esc(c.id)} ${f.category===c.id?'selected':''}" data-action="category" data-category="${esc(c.id)}" aria-pressed="${f.category===c.id}"><span class="cat-icon">${icon(c.id==='appliance'?'fan':c.id==='ebike'?'bike':'cup')}</span><span class="cat-copy"><strong>${esc(c.name)}</strong><small>${esc(c.subtitle || '')}</small></span><span class="category-count">${activeProducts().filter(p=>p.category===c.id).length} 件好物 ${icon('arrow')}</span></button>`).join('')}</div></section>
  <section id="discover" class="discover-section" aria-labelledby="discover-title"><div class="section-head"><div><span class="section-eyebrow">GOOD FINDS, GOOD VIBES</span><h2 id="discover-title">今天，也有好物在等你<span>✦</span></h2></div><span class="section-note">淘一点喜欢，省一点生活费。</span></div><div class="discover-layout"><aside class="filters-sidebar"><div class="sidebar-title">${icon('filter')}挑挑你的心头好</div><h3>好物分类</h3><div class="sidebar-categories">${categories.map(c=>`<button class="sidebar-category ${f.category===c.id?'active':''}" data-action="category" data-category="${esc(c.id)}"><span>${c.id==='all'?'所有闲置':esc(c.name)}</span><span>${activeProducts().filter(p=>c.id==='all'||p.category===c.id).length}</span></button>`).join('')}</div><label for="campus-filter">交易校区</label><select id="campus-filter" data-filter="campus"><option value="">全部校区</option>${['SIP 校区','太仓校区'].map(c=>`<option ${f.campus===c?'selected':''}>${c}</option>`).join('')}</select><label for="condition-filter">商品成色</label><select id="condition-filter" data-filter="condition"><option value="">不限成色</option>${['几乎全新','九成新','八成新'].map(c=>`<option ${f.condition===c?'selected':''}>${c}</option>`).join('')}</select><div class="sidebar-note">🍊<strong>好物不闲着</strong><p>用一次小小的转让，<br>接住下一份喜欢。</p></div></aside><div class="catalog"><div class="filter-row">${chips()}<button class="text-button clear-filter" data-action="clear-filters">重置筛选</button></div><div class="results-toolbar"><p>${f.query?`“${esc(f.query)}”的搜索结果 · `:''}发现 <strong>${products.length}</strong> 件${f.category==='all'?'校园好物':esc(categoryName(f.category))}</p><label class="sort-label">排序<select class="sort-select" data-filter="sort" aria-label="商品排序"><option value="newest" ${f.sort==='newest'?'selected':''}>最新发布</option><option value="price-asc" ${f.sort==='price-asc'?'selected':''}>价格从低到高</option><option value="price-desc" ${f.sort==='price-desc'?'selected':''}>价格从高到低</option></select></label><button class="mobile-filter-button icon-button" data-action="mobile-filters" aria-label="校区和成色筛选">${icon('filter')}</button></div>${products.length?`<div class="product-grid">${products.map(p=>card(p)).join('')}</div><div class="catalog-end"><span>🍊</span>好物都在这里啦，喜欢就别错过。</div>`:`<div class="empty-state"><span class="empty-emoji">🔎</span><h3>这份心动，还在路上</h3><p>换个关键词，或放宽一点筛选试试。</p><button class="button secondary" data-action="clear-filters">看看全部好物</button></div>`}</div></div></section>`;
}
function detail(id) {
  const p=state.products.find(p=>p.id===id);
  if(!p) return notFound();
  const liked=state.favorites.includes(p.id), related=activeProducts().filter(other=>other.category===p.category&&other.id!==p.id).slice(0,4);
  return `<nav class="breadcrumbs" aria-label="面包屑"><a href="#/">首页</a>${icon('chevron')}<a href="#/" data-action="category" data-category="${esc(p.category)}">${esc(categoryName(p.category))}</a>${icon('chevron')}<span>好物详情</span></nav><section class="detail-layout"><div class="detail-gallery"><img class="main-product-image" src="${esc(p.images[0])}" alt="${esc(p.title)}" id="detail-photo" width="800" height="640"><div class="thumb-row">${p.images.map((src,index)=>`<button class="thumbnail ${index===0?'selected':''}" data-action="photo" data-src="${esc(src)}" aria-label="查看第 ${index+1} 张商品照片" aria-pressed="${index===0}"><img src="${esc(src)}" alt="商品照片 ${index+1}"></button>`).join('')}</div><p class="photo-note">图片为演示商品示意 · 面交时请现场确认实物</p></div><div class="detail-info"><div class="detail-tags"><span class="badge mint">${esc(categoryName(p.category))}</span><span class="badge">${esc(p.condition)}</span>${p.graduation?'<span class="badge">🎓 毕业转让</span>':''}${p.status==='inactive'?'<span class="badge">已下架</span>':''}</div><h1>${esc(p.title)}</h1><p class="detail-subtitle">喜欢的好物，值得再被喜欢一次。</p><div class="detail-price"><span class="price"><small>¥</small>${money(p.price)}</span><span class="old-price">购入价 ¥${money(p.originalPrice)}</span><span class="badge">可小刀</span></div><div class="detail-location">${icon('pin')}<span>西交利物浦大学 · ${esc(p.campus)}<strong>${esc(p.location)}</strong></span><span class="badge mint">同校面交</span></div><dl class="spec-grid">${Object.entries(p.specs||{}).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><div class="detail-actions"><button class="button primary" data-action="contact" data-id="${esc(p.id)}" ${p.status==='inactive'?'disabled':''}>${icon('user')}联系卖家${icon('arrow')}</button><button class="button secondary ${liked?'is-favorite':''}" data-action="favorite" data-id="${esc(p.id)}" aria-pressed="${liked}">${icon('heart')}${liked?'已收藏':'收藏好物'}</button></div><div class="seller-panel"><span class="profile-avatar">${esc(p.avatar)}</span><div><strong>${esc(p.seller)}</strong><p>西交利物浦大学的橘子同学 · 示例卖家</p></div><span class="muted">${timeAgo(p.createdAt)}</span></div></div></section><section class="detail-description"><h2>关于这件好物 <span>✦</span></h2><p>${esc(p.description).replace(/\n/g,'<br>')}</p><div class="meetup-note">${icon('shield')}约在校园公共场所面交，先看实物，再决定是否带走。</div></section><section class="related-section"><div class="section-head"><h2>同类好物，再逛逛</h2><a href="#/" data-action="category" data-category="${esc(p.category)}">查看全部 ${icon('arrow')}</a></div><div class="product-grid">${related.map(item=>card(item)).join('')}</div></section><div class="sticky-detail-actions"><span class="price"><small>¥</small>${money(p.price)}</span><button class="icon-button ${liked?'is-favorite':''}" data-action="favorite" data-id="${esc(p.id)}" aria-label="${liked?'取消收藏':'收藏商品'}" aria-pressed="${liked}">${icon('heart')}</button><button class="button primary" data-action="contact" data-id="${esc(p.id)}" ${p.status==='inactive'?'disabled':''}>联系卖家 ${icon('arrow')}</button></div>`;
}
function field(label,name,value='',options={}) {
  const {type='text',required=true,placeholder='',full=false,min,max,step}=options;
  return `<div class="form-field ${full?'field-full':''}"><label for="field-${name}">${label}${required?'<span class="required"> *</span>':''}</label><input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${min!==undefined?`min="${min}"`:''} ${max!==undefined?`max="${max}"`:''} ${step?`step="${step}"`:''} ${type==='text'?'maxlength="100"':''} placeholder="${placeholder}"></div>`;
}
function categoryFields(category, specs={}) {
  const defs=category==='ebike'?[['购入时间','2024 年 9 月'],['电池情况','例如：48V 锂电池，正常使用'],['卖家自述续航','例如：约 35 公里，仅作参考']]:category==='daily'?[['尺寸','例如：40 × 30 cm'],['数量','例如：1 件'],['使用情况','例如：使用一学期，无明显磨损']]:[['型号','例如：美的 USB 小风扇'],['使用情况','例如：功能正常，使用一学期']];
  return defs.map(([label,hint],i)=>field(label,`spec-${i}`,specs[label]||'',{placeholder:hint})).join('');
}
function publish(editId) {
  const p=editId?state.products.find(p=>p.id===editId&&p.mine):null;
  if(editId&&!p) return notFound();
  draftImages=p?[...p.images]:[];
  return `<div class="page-heading"><span class="eyebrow">PASS ON THE GOOD STUFF</span><h1>${p?'再打扮一下你的好物':'让闲置，遇见新同学'} <span>✦</span></h1><p>${p?'更新信息，让下一份喜欢来得更快。':'拍张照片，写下它的故事。下一份心动，就从这里开始。'}</p></div><form id="publish-form" data-edit-id="${esc(p?.id||'')}"><div class="publish-layout"><section class="upload-panel"><div class="panel-heading"><h2>给好物拍个照</h2><span>最多 6 张</span></div><label class="upload-zone" for="photo-input">${icon('upload')}<strong>点击选择商品照片</strong><span>第一张将成为封面，清晰实拍更加分</span><small>JPG / PNG / WebP，每张不超过 8 MB</small></label><input class="sr-only" id="photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple><div class="uploaded-grid" id="uploaded-images">${uploadPreview()}</div><p class="field-hint" id="photo-error" role="alert"></p><div class="photo-tips"><strong>🍊 橘子小贴士</strong><p>找个亮一点的地方，拍下正面和细节。<br>小小的使用痕迹，也请诚实记录哦。</p></div></section><section class="form-panel"><h2>说说这件好物</h2><div class="form-grid">${field('商品标题','title',p?.title||'',{full:true,placeholder:'例如：陪我度过夏天的美的小风扇'})}<div class="form-field field-full"><label for="field-category">好物分类 <span class="required">*</span></label><select id="field-category" name="category">${categories.filter(c=>c.id!=='all').map(c=>`<option value="${esc(c.id)}" ${p?.category===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>${field('转让价格（元）','price',p?.price??'',{type:'number',min:0.01,max:100000,step:'0.01',placeholder:'希望以多少转让？'})}${field('购入价格（元）','originalPrice',p?.originalPrice??'',{type:'number',min:0,max:100000,step:'0.01'})}<div class="form-field"><label for="field-condition">商品成色</label><select id="field-condition" name="condition">${['几乎全新','九成新','八成新'].map(c=>`<option ${p?.condition===c?'selected':''}>${c}</option>`).join('')}</select></div><div class="form-field"><label for="field-campus">交易校区</label><select id="field-campus" name="campus">${['SIP 校区','太仓校区'].map(c=>`<option ${p?.campus===c?'selected':''}>${c}</option>`).join('')}</select></div>${field('面交地点','location',p?.location||'',{full:true,placeholder:'例如：图书馆正门 / 东区食堂门口'})}<div class="form-field field-full"><label for="field-description">好物故事 <span class="required">*</span></label><textarea id="field-description" name="description" required minlength="5" maxlength="2000" rows="4" placeholder="买了多久、使用感受、为什么转让，还有需要说明的小细节…">${esc(p?.description||'')}</textarea></div><div id="category-fields" class="form-grid field-full">${categoryFields(p?.category||'appliance',p?.specs)}</div><label class="checkbox-field field-full"><input name="graduation" type="checkbox" ${p?.graduation?'checked':''}>这是一次毕业转让 🎓</label><div class="publish-demo-note field-full">${icon('shield')}这是演示发布，无需提供真实联系方式。发布后会自动生成虚构的示例联系信息。</div></div></section></div><div class="form-actions"><span>✨ 保存到当前浏览器，好物信息由你掌握。</span><button class="button secondary" type="button" data-action="preview">预览好物</button><button class="button primary" type="submit">${p?'保存修改':'发布我的闲置'}${icon('arrow')}</button></div></form>`;
}
function uploadPreview() {
  return draftImages.map((src,i)=>`<div class="uploaded-item"><img src="${esc(src)}" alt="已选照片 ${i+1}">${i===0?'<span>封面</span>':''}<button type="button" data-action="remove-photo" data-index="${i}" aria-label="移除第 ${i+1} 张照片">${icon('close')}</button></div>`).join('')+(draftImages.length<6?'<button type="button" class="button secondary sample-photo" data-action="sample-photo">用示例照片试一试</button>':'');
}
function profile(params) {
  state.tab=params.get('tab')==='favorites'?'favorites':'published';
  const mine=state.products.filter(p=>p.mine), favorites=state.products.filter(p=>state.favorites.includes(p.id));
  const products=state.tab==='favorites'?favorites:mine;
  return `<section class="profile-banner"><span class="profile-avatar">🍊</span><div class="profile-summary"><span class="eyebrow">MY LITTLE CORNER</span><h1>你好，橘子同学！</h1><p>西交利物浦大学 · 认真生活，也认真分享喜欢。</p><span class="badge">演示体验账号</span></div><div class="profile-stats"><div><strong>${mine.length}</strong><span>我的发布</span></div><div><strong>${favorites.length}</strong><span>心动收藏</span></div></div></section><div class="profile-section"><div class="tabs" role="tablist" aria-label="个人商品"><a href="#/profile" role="tab" aria-selected="${state.tab==='published'}" class="${state.tab==='published'?'active':''}">我的发布 <span>${mine.length}</span></a><a href="#/profile?tab=favorites" role="tab" aria-selected="${state.tab==='favorites'}" class="${state.tab==='favorites'?'active':''}">我的收藏 <span>${favorites.length}</span></a></div><div class="profile-notice">${icon('shield')}这里是你的浏览器专属小角落。发布与收藏不会同步给其他同学。</div>${products.length?`<div class="product-grid">${products.map(p=>card(p,{manage:state.tab==='published'})).join('')}</div>`:`<div class="empty-state"><span class="empty-emoji">${state.tab==='published'?'📦':'🍊'}</span><h2>${state.tab==='published'?'你的第一件好物，准备好了吗？':'喜欢的好物，都值得被记住'}</h2><p>${state.tab==='published'?'让闲置继续发光，也给宿舍腾出一点空间。':'逛一逛，点下爱心，把小小的心动收藏起来。'}</p><a class="button primary" href="${state.tab==='published'?'#/publish':'#/'}">${state.tab==='published'?'发布第一件闲置':'去逛逛好物'}${icon('arrow')}</a></div>`}</div>`;
}
function notFound() { return `<div class="empty-state"><span class="empty-emoji">🍊</span><h1>这件好物暂时找不到啦</h1><p>它可能已经离开演示集市，去发现别的心动吧。</p><a class="button primary" href="#/">回到首页</a></div>`; }
function render() {
  const {path,params}=routeInfo();
  document.body.className=path.startsWith('/product/')?'page-detail':path.startsWith('/publish')?'page-publish':path.startsWith('/profile')?'page-profile':'page-home';
  const content=path==='/'?home():path.startsWith('/product/')?detail(decodeId(path.slice(9))):path==='/publish'?publish(params.get('edit')):path==='/profile'?profile(params):notFound();
  const title=path==='/'?'同校好物，快乐接力':path.startsWith('/product/')?'好物详情':path==='/publish'?'发布闲置':'我的小角落';
  document.title=`${title} · 橘子集`;
  app.innerHTML=header()+`<main class="container" id="main-content">${content}</main>`+footer()+mobileNav(path);
  if(path+params.toString()!==lastRoute){window.scrollTo({top:0,behavior:'instant'});lastRoute=path+params.toString();}
  if(state.storageFailed&&!$('.storage-alert')) {const alert=document.createElement('div');alert.className='storage-alert';alert.setAttribute('role','alert');alert.textContent='浏览器本地存储不可用，当前只能临时浏览。请允许网站存储后刷新，才能保存收藏和发布。';app.prepend(alert);}
}
function showModal(content,{label='提示',large=false}={}) {
  closeModal(); modalFocus=document.activeElement;
  $('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${large?'modal-large':''}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"><button class="modal-close icon-button" data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button>${content}</section></div>`;
  document.body.classList.add('modal-open');
  $('.modal').focus();
}
function closeModal() {
  if(!$('#modal-root').hasChildNodes())return;
  $('#modal-root').innerHTML=''; document.body.classList.remove('modal-open');
  if(modalFocus?.isConnected)modalFocus.focus(); modalFocus=null;
}
async function favorite(id) {
  if(saving)return;
  if(state.storageFailed){toast('请允许浏览器本地存储后，再收藏好物');return;}
  const previous=[...state.favorites],liked=previous.includes(id);
  state.favorites=liked?previous.filter(x=>x!==id):[...previous,id]; saving=true;
  try{await persist();render();toast(liked?'已取消收藏':'收藏好啦，去「我的」随时找它 ♥');}catch{state.favorites=previous;toast('收藏未能保存，请检查浏览器存储空间');}finally{saving=false;}
}
function contact(id) {
  const p=state.products.find(p=>p.id===id); if(!p||p.status!=='active')return;
  showModal(`<span class="modal-emoji">🍊</span><span class="eyebrow">SAY HELLO TO A GOOD FIND</span><h2>和好物的主人打个招呼</h2><p>以下均为虚构示例，无法联系真实卖家。</p><div class="contact-card"><span class="profile-avatar">${esc(p.avatar)}</span><strong>${esc(p.seller)}</strong><dl><div><dt>示例联系号</dt><dd>${esc(p.contact)}</dd></div><div><dt>校内面交</dt><dd>${esc(p.campus)} · ${esc(p.location)}</dd></div></dl></div><div class="meetup-note">${icon('shield')}真实使用时，建议在校园公共区域面交并现场验货。</div><div class="modal-actions"><button class="button primary" data-action="close-modal">知道啦 ${icon('check')}</button></div>`,{label:'联系卖家（演示）'});
}
function readPublishForm() {
  if(uploading){toast('照片正在准备中，请稍等一下');return null;}
  const form=$('#publish-form');
  if(!form.reportValidity())return null;
  if(!draftImages.length){$('#photo-error').textContent='先给好物添加至少一张照片吧。';$('#photo-input').focus();return null;}
  const values=new FormData(form); const category=values.get('category');
  const labels=category==='ebike'?['购入时间','电池情况','卖家自述续航']:category==='daily'?['尺寸','数量','使用情况']:['型号','使用情况'];
  const title=values.get('title').trim(),description=values.get('description').trim(),locationText=values.get('location').trim();
  if(!title||description.length<5||!locationText||labels.some((_,i)=>!String(values.get(`spec-${i}`)||'').trim())){toast('请填写完整信息，描述至少 5 个字');return null;}
  return {title,category,price:Number(values.get('price')),originalPrice:Number(values.get('originalPrice')),condition:values.get('condition'),campus:values.get('campus'),location:locationText,description,images:[...draftImages],graduation:values.get('graduation')==='on',specs:Object.fromEntries(labels.map((label,i)=>[label,String(values.get(`spec-${i}`)).trim()]))};
}
async function submitProduct() {
  if(saving)return;
  const values=readPublishForm();if(!values)return;
  if(state.storageFailed){toast('浏览器存储不可用，暂时无法保存发布');return;}
  const editId=$('#publish-form').dataset.editId, existing=state.products.find(p=>p.id===editId&&p.mine);
  const product={...(existing||{id:crypto.randomUUID(),seller:'橘子同学',avatar:'🍊',createdAt:Date.now(),status:'active',mine:true,contact:'DEMO_JUZI_ME'}),...values};
  const previous=state.products;
  state.products=existing?previous.map(p=>p.id===existing.id?product:p):[product,...previous];saving=true;
  const button=$('#publish-form [type="submit"]');button.disabled=true;button.textContent='正在保存…';
  try{await persist();navigate('/profile');toast(existing?'修改已保存':'发布成功！已保存到你的浏览器');}catch{state.products=previous;button.disabled=false;button.textContent='重新保存';toast('保存失败，请检查浏览器存储空间后重试');}finally{saving=false;}
}
async function compressPhoto(file) {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WebP 照片');
  if(file.size>8*1024*1024)throw new Error('单张照片不能超过 8 MB');
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('照片无法读取，请换一张'));image.src=url;});
    const scale=Math.min(1,1400/Math.max(img.width,img.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
    const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',0.84);
  }finally{URL.revokeObjectURL(url);}
}
document.addEventListener('submit',event=>{
  if(event.target.matches('.search-form')){event.preventDefault();state.filters.query=new FormData(event.target).get('query').trim();navigate('/');requestAnimationFrame(()=>$('#discover')?.scrollIntoView({behavior:'smooth',block:'start'}));}
  if(event.target.id==='publish-form'){event.preventDefault();submitProduct();}
});
document.addEventListener('change',async event=>{
  const target=event.target;
  if(target.matches('[data-filter]')){state.filters[target.dataset.filter]=target.value;render();}
  if(target.id==='field-category')$('#category-fields').innerHTML=categoryFields(target.value);
  if(target.id==='photo-input'){
    const files=[...target.files];const count=6-draftImages.length;
    if(files.length>count)toast(`还可以添加 ${count} 张照片，已取前 ${count} 张`);
    target.disabled=true;uploading=true;
    for(const file of files.slice(0,count)){try{const photo=await compressPhoto(file);if(!target.isConnected)break;draftImages.push(photo);}catch(error){toast(error.message);}}
    target.disabled=false;target.value='';uploading=false;
    if(target.isConnected){$('#uploaded-images').innerHTML=uploadPreview();$('#photo-error').textContent='';}
  }
});
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();const main=$('#main-content');main.setAttribute('tabindex','-1');main.focus();main.scrollIntoView();return;}
  if(event.target.closest('a[href="#discover"]')){event.preventDefault();$('#discover')?.scrollIntoView({behavior:'smooth'});return;}
  const button=event.target.closest('[data-action]');
  if(!button){if(event.target.classList.contains('modal-backdrop'))closeModal();return;}
  const {action,id}=button.dataset;
  if(action==='category'){event.preventDefault();state.filters.category=button.dataset.category;navigate('/');requestAnimationFrame(()=>$('#discover')?.scrollIntoView({behavior:'smooth',block:'start'}));}
  if(action==='chip'){state.filters[button.dataset.filter]=!state.filters[button.dataset.filter];render();}
  if(action==='clear-filters'){state.filters={query:'',category:'all',campus:'',condition:'',cheap:false,fresh:false,graduation:false,sort:'newest'};render();}
  if(action==='favorite')favorite(id);
  if(action==='contact')contact(id);
  if(action==='close-modal')closeModal();
  if(action==='photo'){const src=button.dataset.src;$('#detail-photo').src=src;document.querySelectorAll('.thumbnail').forEach(thumb=>{thumb.classList.toggle('selected',thumb===button);thumb.setAttribute('aria-pressed',String(thumb===button));});}
  if(action==='remove-photo'){draftImages.splice(Number(button.dataset.index),1);$('#uploaded-images').innerHTML=uploadPreview();}
  if(action==='sample-photo'){
    const category=$('#field-category').value;
    const sample=seedProducts.find(p=>p.category===category&&!draftImages.includes(p.images[0]));
    if(sample&&draftImages.length<6){draftImages.push(sample.images[0]);$('#uploaded-images').innerHTML=uploadPreview();$('#photo-error').textContent='';toast('已加入示例照片，你也可以换成自己的实拍');}
  }
  if(action==='status'){
    const p=state.products.find(p=>p.id===id&&p.mine);if(!p||saving)return;const old=p.status;p.status=old==='active'?'inactive':'active';saving=true;
    try{await persist();render();toast(p.status==='inactive'?'好物已下架，随时可以重新上架':'好物重新上架啦');}catch{p.status=old;toast('未能保存状态，请稍后重试');}finally{saving=false;}
  }
  if(action==='preview'){
    const values=readPublishForm();if(!values)return;
    showModal(`<span class="eyebrow">YOUR GOOD FIND</span><h2>发布前，最后看一眼</h2><img class="preview-photo" src="${esc(values.images[0])}" alt="${esc(values.title)}"><h3>${esc(values.title)}</h3><span class="price"><small>¥</small>${money(values.price)}</span><p>${esc(values.condition)} · ${esc(values.campus)} · ${esc(values.location)}</p><p>${esc(values.description).replace(/\n/g,'<br>')}</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">继续编辑</button><button class="button primary" data-action="confirm-publish">确认发布 ${icon('arrow')}</button></div>`,{label:'商品发布预览'});
  }
  if(action==='confirm-publish'){closeModal();submitProduct();}
  if(action==='campus')showModal(`<span class="modal-emoji">🏫</span><h2>好物，就在你身边</h2><p>西交利物浦大学 · 选择你的交易校区</p><div class="campus-options">${['','SIP 校区','太仓校区'].map(c=>`<button class="button ${state.filters.campus===c?'primary':'secondary'}" data-action="select-campus" data-campus="${c}">${icon('pin')}${c||'全部校区'}</button>`).join('')}</div>`,{label:'选择校区'});
  if(action==='select-campus'){state.filters.campus=button.dataset.campus;navigate('/');}
  if(action==='mobile-filters')showModal(`<h2>挑挑心头好</h2><div class="form-field"><label for="modal-campus">交易校区</label><select id="modal-campus"><option value="">全部校区</option>${['SIP 校区','太仓校区'].map(c=>`<option ${state.filters.campus===c?'selected':''}>${c}</option>`).join('')}</select></div><div class="form-field"><label for="modal-condition">商品成色</label><select id="modal-condition"><option value="">不限成色</option>${['几乎全新','九成新','八成新'].map(c=>`<option ${state.filters.condition===c?'selected':''}>${c}</option>`).join('')}</select></div><div class="modal-actions"><button class="button primary" data-action="apply-mobile-filters">看看好物 ${icon('arrow')}</button></div>`,{label:'校区和成色筛选'});
  if(action==='apply-mobile-filters'){state.filters.campus=$('#modal-campus').value;state.filters.condition=$('#modal-condition').value;closeModal();render();}
  if(action==='about')showModal(`<span class="modal-emoji">🍊</span><h2>欢迎来到橘子集</h2><p>这是一个校园二手交易交互演示，主打小电器、电瓶车和生活用品。</p><p>商品、卖家及联系方式均为虚构示例。你可以尝试收藏、发布、编辑和下架；数据只保存在当前浏览器，不会分享给其他同学。</p><p>本版没有真实登录、站内聊天、订单或支付。</p><button class="button primary" data-action="close-modal">开始发现好物 ${icon('arrow')}</button>`,{label:'关于橘子集演示'});
  if(action==='reset')showModal(`<span class="modal-emoji">🌱</span><h2>让集市回到最初的样子？</h2><p>这会清除当前浏览器中的模拟发布和收藏，恢复 18 件示例商品。</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">保留我的好物</button><button class="button primary" data-action="confirm-reset">重置演示</button></div>`,{label:'确认重置演示'});
  if(action==='confirm-reset'){
    if(saving)return;const previous={products:state.products,favorites:state.favorites};state.products=structuredClone(seedProducts);state.favorites=[];saving=true;
    try{await persist();state.filters={query:'',category:'all',campus:'',condition:'',cheap:false,fresh:false,graduation:false,sort:'newest'};navigate('/');toast('新的橘子集，重新出发 🍊');}catch{Object.assign(state,previous);toast('重置失败，请稍后重试');}finally{saving=false;}
  }
});
document.addEventListener('keydown',event=>{
  const modal=$('.modal');if(!modal)return;
  if(event.key==='Escape'){closeModal();return;}
  if(event.key==='Tab'){
    const focusable=[...modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]')];
    const first=focusable[0],last=focusable.at(-1);
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===modal)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===modal)){event.preventDefault();first.focus();}
  }
});
window.addEventListener('hashchange',()=>{closeModal();render();});
try{await openStorage();}catch(error){console.warn('Local storage unavailable:',error.name);state.storageFailed=true;state.products=structuredClone(seedProducts);}
render();
