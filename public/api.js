export class ApiError extends Error {
  constructor(message, status = 0, code = '', retryAfter = 0) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' }, options = { method, credentials:'same-origin', cache:'no-store', headers, signal };
  if (body instanceof FormData) options.body=body;
  else if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let response;
  try { response=await fetch(path,options); }
  catch(error){if(error.name==='AbortError')throw error;throw new ApiError('网络暂时没有连接上，请稍后重试。');}
  if(response.status===204)return {};
  let data;try{data=await response.json();}catch{throw new ApiError(response.ok?'服务器返回了无法读取的数据，请稍后重试。':`请求未完成（${response.status}），请稍后重试。`,response.status);}
  if(!response.ok){const msg=typeof data.error==='string'?data.error:data.error?.message||data.message;const retryHeader=response.headers.get('Retry-After');const retryAfter=retryHeader&&/^\d+$/.test(retryHeader)?Math.min(Number(retryHeader),86400):0;throw new ApiError(msg||(response.status===401?'请先登录，再继续这个操作。':'操作未完成，请稍后重试。'),response.status,data.error?.code||'',retryAfter);}
  return data;
}
const productPath=id=>`/api/products/${encodeURIComponent(id)}`;
async function itemList(path){const data=await request(path);if(!Array.isArray(data.items))throw new ApiError('商品列表格式不完整，请稍后重试。');return data;}
export const api={
  session:async()=>{const data=await request('/api/me');if(!data||!Object.hasOwn(data,'user'))throw new ApiError('登录状态暂时无法读取，请稍后重试。');return data;},
  logout:()=>request('/api/auth/logout',{method:'POST',body:{}}),
  guest:()=>request('/api/auth/guest',{method:'POST',body:{}}),
  sendEmail:email=>request('/api/auth/email/send',{method:'POST',body:{email}}),
  verifyEmail:body=>request('/api/auth/email/verify',{method:'POST',body}),
  products:async(filters,page=1)=>{const params=new URLSearchParams({page:String(page),pageSize:'24'});for(const [key,value]of Object.entries(filters))if(value!==''&&value!==false)params.set(key,value===true?'1':String(value));const data=await itemList(`/api/products?${params}`);if(!Number.isFinite(data.total)||!data.categoryCounts)throw new ApiError('商品统计格式不完整，请稍后重试。');return data;},
  product:id=>request(productPath(id)),contact:id=>request(`${productPath(id)}/contact`),
  mine:()=>itemList('/api/me/products'),favorites:()=>itemList('/api/me/favorites'),
  favorite:(id,liked)=>request(`/api/me/favorites/${encodeURIComponent(id)}`,{method:liked?'PUT':'DELETE'}),
  save:(id,body)=>request(id?productPath(id):'/api/products',{method:id?'PATCH':'POST',body}),
  upload:blob=>{const body=new FormData();body.append('file',blob,'campus-photo.jpg');return request('/api/media',{method:'POST',body});},
};
