'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JudgeStore,digest}=require('../hosted-demo/judge-store');
const db=process.env.STACHA_TEST_DATABASE_URL;
test('PostgreSQL judge access, isolation, persistence, and duplicate operation protection',{skip:!db},async()=>{
 const store=new JudgeStore({connectionString:db});await store.initialize();try{
 const invitation=await store.createInvitation({expiresAt:new Date(Date.now()+60000).toISOString()});
 const results=await Promise.all([store.redeemInvitation(invitation.token),store.redeemInvitation(invitation.token)]);assert.equal(results.filter(Boolean).length,1);const session=results.find(Boolean);assert.equal(await store.authenticate(session.token),session.judgeId);assert.notEqual(digest(session.token),session.token);
 const other=crypto.randomUUID(),project=await store.createProject(session.judgeId,{goal:'monitor'});assert.equal((await store.getProject(session.judgeId,project)).data.goal,'monitor');assert.equal(await store.getProject(other,project),null);assert.equal(await store.updateProject(other,project,1,{goal:'bad'}),null);assert.equal(await store.updateProject(session.judgeId,project,1,{goal:'revised'}),2);assert.equal(await store.updateProject(session.judgeId,project,1,{goal:'stale'}),null);
 const attempt=await store.createAttempt(session.judgeId,project,{amountCents:299,currency:'USD',merchantId:'TESTMERCHANT',catalogSnapshot:[{id:'pencil'}]});
 await assert.rejects(store.createAttempt(session.judgeId,project,{amountCents:299,currency:'USD',merchantId:'TESTMERCHANT',catalogSnapshot:[{id:'pencil'}]}),e=>e.code==='23505');
 const ops=await Promise.allSettled([store.startOperation(session.judgeId,attempt,{operation:'create',expectedState:'creating',pendingState:'creating'}),store.startOperation(session.judgeId,attempt,{operation:'create',expectedState:'creating',pendingState:'creating'})]);assert.equal(ops.filter(x=>x.status==='fulfilled'&&x.value).length,1);const count=await store.pool.query('SELECT count(*)::int AS n FROM judge_payment_operations WHERE attempt_id=$1',[attempt]);assert.equal(count.rows[0].n,1);
 await store.close();const restarted=new JudgeStore({connectionString:db});try{assert.equal(await restarted.authenticate(session.token),session.judgeId);assert.equal((await restarted.getProject(session.judgeId,project)).data.goal,'revised');await restarted.revokeSession(session.token);assert.equal(await restarted.authenticate(session.token),null)}finally{await restarted.close()}
 }finally{if(!store.pool.ending)await store.close()}
});

test('isolated judge authentication rejects cross-origin access and scopes secure sessions',{skip:!db},async()=>{
 const express=require('express'),{makeJudgeAuth}=require('../hosted-demo/judge-auth');const store=new JudgeStore({connectionString:db});await store.initialize();const app=express();app.use(express.json());const {router,requireJudge}=makeJudgeAuth(store);app.use('/judge',router);app.post('/protected',requireJudge,(req,res)=>res.json({judgeId:req.judgeId}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`,invite=await store.createInvitation({expiresAt:new Date(Date.now()+60000).toISOString()});try{
 const request=(path,origin,body,auth)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{}),...(auth?{cookie:auth}:{})},body:JSON.stringify(body)});
 assert.equal((await request('/judge/redeem','https://evil.example',{invitation:invite.token})).status,403);const login=await request('/judge/redeem',base,{invitation:invite.token});assert.equal(login.status,200);const header=login.headers.get('set-cookie');assert.match(header,/HttpOnly; Secure; SameSite=Strict/);const cookie=header.split(';')[0];assert.equal((await request('/judge/redeem',base,{invitation:invite.token})).status,401);assert.equal((await request('/protected',base,{},cookie)).status,200);assert.equal((await request('/protected','https://evil.example',{},cookie)).status,403);assert.equal((await request('/protected',base,{})).status,401);assert.equal((await request('/judge/logout',base,{},cookie)).status,200);assert.equal((await request('/protected',base,{},cookie)).status,401);
 }finally{await new Promise(r=>server.close(r));await store.close()}
});
