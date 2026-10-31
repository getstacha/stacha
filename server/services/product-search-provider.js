const {createHash}=require('node:crypto');
const {DomainError}=require('../domain');
function safeHttps(value){try{const u=new URL(value);return u.protocol==='https:'?u.href:null}catch{return null}}
function normalizeProducts(products){
 if(!Array.isArray(products))throw new DomainError('Channel3 returned an unexpected response.',502);
 const seen=new Set(),offers=[];
 for(const p of products){if(!p?.id||typeof p.title!=='string'||!Array.isArray(p.offers))continue;const image=(Array.isArray(p.images)?p.images:[]).find(x=>x?.is_main_image)||p.images?.[0];const imageUrl=safeHttps(image?.cleaned_url)||safeHttps(image?.url);const brand=Array.isArray(p.brands)?p.brands.map(x=>typeof x?.name==='string'?x.name.trim():'').filter(Boolean).join(', ').slice(0,200):'';
  for(const o of p.offers){const url=safeHttps(o?.url);if(!url)continue;const id=createHash('sha256').update(`${p.id}|${url}`).digest('hex').slice(0,24);if(seen.has(id))continue;seen.add(id);
   const raw=o.price?.price??o.price?.amount,price=raw===null||raw===undefined?NaN:Number(raw),cents=Number.isFinite(price)?Math.round(price*100):null;const unitCents=cents!==null&&cents>0&&cents<=100000000?cents:null;const currency=typeof o.price?.currency==='string'&&/^[A-Z]{3}$/.test(o.price.currency)?o.price.currency:null;
   offers.push({id,productId:String(p.id),name:p.title.slice(0,300),brand,imageUrl,merchant:String(o.domain||new URL(url).hostname).slice(0,200),url,unitCents,currency,availability:['InStock','OutOfStock'].includes(o.availability)?o.availability:'Unknown',condition:typeof o.condition==='string'?o.condition.slice(0,80):null,variants:p.variants||null,attributes:p.structured_attributes||{},features:Array.isArray(p.key_features)?p.key_features.filter(x=>typeof x==='string').slice(0,20):[],description:typeof p.description==='string'?p.description.slice(0,1000):'',source:'Channel3',retrievedAt:new Date().toISOString()});if(offers.length>=60)return offers;
  }
 }
 return offers;
}
class ProductSearchProvider {
 constructor({key=process.env.CHANNEL3_API_KEY,fetcher=fetch}={}){this.key=key;this.fetch=fetcher}
 get configured(){return Boolean(this.key)}
 async lookup(id){if(!this.configured)throw new DomainError('Channel3 is not configured.',503);if(typeof id!=='string'||!id||id.length>200)throw new DomainError('Invalid product ID.');let r;try{r=await this.fetch(`https://api.trychannel3.com/v1/products/${encodeURIComponent(id)}`,{headers:{'x-api-key':this.key},signal:AbortSignal.timeout(30000)})}catch{throw new DomainError('Could not reach Channel3 product lookup.',502)}if(!r.ok)throw new DomainError(`Channel3 product lookup returned HTTP ${r.status}.`,r.status===429?429:502);let data;try{data=await r.json()}catch{throw new DomainError('Channel3 product lookup returned invalid JSON.',502)}if(String(data?.id)!==id)throw new DomainError('Channel3 returned an unexpected product.',502);return normalizeProducts([data])}
 async search(query){if(!this.configured)throw new DomainError('Channel3 is not configured. Add CHANNEL3_API_KEY to .env and restart.',503);if(typeof query!=='string'||!query.trim()||query.length>500)throw new DomainError('Enter a valid product search.');let r;try{r=await this.fetch('https://api.trychannel3.com/v1/search',{method:'POST',headers:{'x-api-key':this.key,'Content-Type':'application/json'},body:JSON.stringify({query,limit:10}),signal:AbortSignal.timeout(30000)})}catch{throw new DomainError('Could not reach Channel3. Check your connection and retry.',502)}if(!r.ok){if(r.status===429)throw new DomainError('Channel3 is rate-limiting requests. Please retry later.',429);if(r.status===401||r.status===403)throw new DomainError('Channel3 rejected its API key. Check your credentials.',502);throw new DomainError(`Channel3 returned HTTP ${r.status}. Please retry.`,502)}let data;try{data=await r.json()}catch{throw new DomainError('Channel3 returned invalid JSON.',502)}return normalizeProducts(data.products)}
}
module.exports={ProductSearchProvider,normalizeProducts};
