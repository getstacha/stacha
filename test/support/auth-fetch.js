const crypto=require('node:crypto');
const password='isolated-test-password-987';const salt='0123456789abcdef0123456789abcdef';
process.env.STACHA_OWNER_PASSWORD_HASH=`scrypt$16384$8$1$${salt}$${crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
process.env.STACHA_WEBHOOK_SECRET='test-only-internal-webhook-secret-123456';
const original=global.fetch, sessions=new Map();
async function login(origin){let p=sessions.get(origin);if(!p){p=(async()=>{const r=await original(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})});if(!r.ok)throw Error(`Test login failed: ${r.status}`);const body=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:body.csrfToken}})();sessions.set(origin,p)}return p}
global.fetch=async function(input,options={}){const u=new URL(typeof input==='string'?input:input.url);if(!['127.0.0.1','localhost'].includes(u.hostname))return original(input,options);const h=new Headers(options.headers||{});if(u.pathname==='/api/paypal/webhook'){h.set('x-stacha-webhook-secret',process.env.STACHA_WEBHOOK_SECRET);return original(input,{...options,headers:h})}const session=await login(u.origin);h.set('cookie',session.cookie);h.set('origin',u.origin);h.set('x-csrf-token',session.csrf);return original(input,{...options,headers:h})};
