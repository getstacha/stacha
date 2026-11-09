const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const COOKIE='stacha_session';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function hashPassword(password){if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>1024)throw Error('Use a password of at least 12 characters (maximum 1024 bytes).');const salt=crypto.randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return `scrypt$16384$8$1$${salt}$${hash.toString('hex')}`}
async function verifyPassword(password,encoded){if(typeof password!=='string'||Buffer.byteLength(password)>1024||typeof encoded!=='string')return false;const p=encoded.split('$');if(p.length!==6||p[0]!=='scrypt'||p[1]!=='16384'||p[2]!=='8'||p[3]!=='1'||!/^[a-f0-9]{32}$/.test(p[4])||!/^[a-f0-9]{128}$/.test(p[5]))return false;const v=await scrypt(password,p[4],64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return crypto.timingSafeEqual(v,Buffer.from(p[5],'hex'))}
function safeFile(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('Unsafe sensitive file.');return st}
function configPath(){return process.env.STACHA_AUTH_FILE||path.join(__dirname,'..','data','owner-auth.json')}
function configuredHash(){if(process.env.STACHA_OWNER_PASSWORD_HASH)return process.env.STACHA_OWNER_PASSWORD_HASH;try{const f=configPath();safeFile(f);const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{return JSON.parse(fs.readFileSync(fd,'utf8')).passwordHash}catch{return null}finally{fs.closeSync(fd)}}catch(e){if(e.code==='ENOENT')return null;throw e}}
function createSecurity({passwordHash,internalSecret=process.env.STACHA_WEBHOOK_SECRET,sessionMs=8*60*60*1000,now=Date.now}={}){
 const sessions=new Map(),failures=new Map();
 const bad=(res,status,msg)=>res.status(status).json({error:msg});
 const cookie=(req,value,maxAge)=>`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.socket.encrypted?'; Secure':''}`;
 const localHost=req=>{try{const h=req.headers.host;if(typeof h!=='string'||/[\s@/\\]/.test(h))return false;const u=new URL(`http://${h}`);return ['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&Number(u.port||80)===req.socket.localPort}catch{return false}};
 const sameOrigin=req=>{if(!localHost(req))return false;const origin=req.headers.origin,referer=req.headers.referer;let v=origin||referer;if(!v||v==='null')return false;try{const u=new URL(v);if(origin&&(u.origin!==origin||u.pathname!=='/'))return false;return u.origin===`${req.socket.encrypted?'https':'http'}://${req.headers.host}`}catch{return false}};
 const validMutation=(req,res,next)=>{if(!sameOrigin(req)||['cross-site','same-site','none'].includes(req.headers['sec-fetch-site']))return bad(res,403,'Request origin is not allowed.');if(!req.is('application/json'))return bad(res,415,'Expected application/json.');next()};
 const parseCookie=req=>{const h=req.headers.cookie||'';const values=h.split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));return values.length===1?values[0].slice(COOKIE.length+1):null};
 const getSession=req=>{const id=parseCookie(req),s=id&&sessions.get(id);if(!s)return null;if(s.expires<=now()){sessions.delete(id);return null}return s};
 const auth=(req,res,next)=>{if(!localHost(req))return bad(res,403,'Request host is not allowed.');const site=req.headers['sec-fetch-site'];if(site&&site!=='same-origin'&&site!=='none')return bad(res,403,'Request origin is not allowed.');const s=getSession(req);if(!s)return bad(res,401,'Please sign in to continue.');req.owner={id:'owner'};req.session=s;next()};
 const csrf=(req,res,next)=>{if(!equal(req.headers['x-csrf-token'],req.session.csrf))return bad(res,403,'Your session could not be verified. Please refresh and try again.');next()};
 const protect=(req,res,next)=>auth(req,res,()=>['GET','HEAD','OPTIONS'].includes(req.method)?next():validMutation(req,res,()=>csrf(req,res,next)));
 const internal=(req,res,next)=>{if(!internalSecret||internalSecret.length<32||!equal(req.headers['x-stacha-webhook-secret'],internalSecret))return bad(res,401,'Unauthorized.');next()};
 const login=async(req,res)=>{const ip=req.socket.remoteAddress||'local',item=failures.get(ip),time=now();if(item&&item.until>time)return bad(res,429,'Too many attempts. Try again later.');let hash;try{hash=passwordHash||configuredHash()}catch{return bad(res,503,'Sign-in setup is unavailable.')}if(!hash)return bad(res,503,'Set up the owner password before signing in.');let valid=false;try{valid=await verifyPassword(req.body?.password,hash)}catch{}if(!valid){let f=failures.get(ip);if(!f||time-f.start>15*60*1000)f={start:time,count:0,until:0};if(++f.count>=5)f.until=time+15*60*1000;failures.set(ip,f);return bad(res,401,'Incorrect password.')}failures.delete(ip);const previous=parseCookie(req);if(previous)sessions.delete(previous);const id=crypto.randomBytes(32).toString('base64url'),csrfToken=crypto.randomBytes(32).toString('base64url');sessions.set(id,{csrf:csrfToken,expires:time+sessionMs,ownerId:'owner'});res.setHeader('Set-Cookie',cookie(req,id,Math.ceil(sessionMs/1000)));res.setHeader('Cache-Control','no-store');res.json({csrfToken})};
 const logout=(req,res)=>{sessions.delete(parseCookie(req));res.setHeader('Set-Cookie',cookie(req,'',0));res.setHeader('Cache-Control','no-store');res.json({ok:true})};
 return {protect,auth,csrf,validMutation,internal,login,logout};
}
module.exports={createSecurity,hashPassword,verifyPassword,safeFile,configPath};
