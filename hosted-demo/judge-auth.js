'use strict';
// Judge sessions are server-side; the opaque cookie is never exposed to JavaScript.
const express=require('express');
const COOKIE='__Host-stacha_judge';
// Browsers limit persistent cookies. Refresh on authenticated requests.
const COOKIE_MAX_AGE=400*24*60*60;
const sessionCookie=token=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
function sameOrigin(req){try{const u=new URL(req.get('Origin'));return u.host===req.get('Host')&&(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))&&req.get('Sec-Fetch-Site')!=='cross-site'}catch{return false}}
function cookie(req){const matches=String(req.get('Cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));if(matches.length!==1)return null;const value=matches[0].slice(COOKIE.length+1);return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null}
function makeJudgeAuth(store){
 const router=express.Router();
 router.post('/redeem',async(req,res)=>{if(!sameOrigin(req))return res.status(403).json({error:'Request origin is not allowed.'});try{const redeemed=await store.redeemInvitation(req.body?.invitation);if(!redeemed)return res.status(401).json({error:'Invitation is invalid or expired.'});res.set('Set-Cookie',sessionCookie(redeemed.token));return res.json({signedIn:true})}catch{return res.status(401).json({error:'Invitation is invalid or expired.'})}});
 router.get('/me',requireJudge,(req,res)=>res.json({signedIn:true}));
 router.post('/logout',async(req,res)=>{if(!sameOrigin(req))return res.status(403).json({error:'Request origin is not allowed.'});try{const token=cookie(req);if(token)await store.revokeSession(token);res.set('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);return res.json({signedIn:false})}catch{return res.status(503).json({error:'Sign out is unavailable.'})}});
 async function requireJudge(req,res,next){if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!sameOrigin(req))return res.status(403).json({error:'Request origin is not allowed.'});try{const token=cookie(req),judgeId=await store.authenticate(token);if(!judgeId)return res.status(401).json({error:'Judge sign-in required.'});res.set('Set-Cookie',sessionCookie(token));req.judgeId=judgeId;next()}catch{return res.status(503).json({error:'Judge access is unavailable.'})}}
 return {router,requireJudge};
}
module.exports={makeJudgeAuth};
