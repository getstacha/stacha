const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const buy=require('../server/buy');
const datePlus=n=>{const d=new Date();d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const create=(state,input={})=>buy.createProject(state,{name:'Gaming PC project',requirements:'Gaming PC with compatible components',budget:2000,needBy:datePlus(7),...input});
function prepareAndPay(state,p){buy.prepareDraft(p);buy.review(p);state.paymentProfile.enabled=true;return buy.payment(state,p,'approve')}
test('gaming PC replacement keeps purchased components and unresolved payment in the cycle budget',()=>{
 const state=buy.seedProjects(),p=create(state),cycle=buy.getCycle(p);buy.prepareDraft(p);assert.equal(cycle.draft.lines.length,8);buy.review(p);assert.throws(()=>buy.payment(state,p,'approve'),/profile/);state.paymentProfile.enabled=true;
 const order=buy.payment(state,p,'approve');assert.equal(order.mode,'SIMULATED');assert.equal(order.status,'captured');assert.equal(cycle.commitments.length,8);assert.equal(buy.spent(cycle),122000);
 const gpu=cycle.commitments.find(x=>x.key==='gpu');buy.failLine(p,gpu.id);assert.equal(gpu.obligation,'unresolved');assert.equal(buy.summary(p).remainingItems,1);assert.equal(buy.summary(p).unresolvedCents,50000);
 buy.prepareDraft(p);assert.equal(cycle.draft.lines.length,1);assert.equal(cycle.draft.lines[0].offerId,'pc-gpu-alt');buy.review(p);buy.payment(state,p,'approve');assert.equal(buy.spent(cycle),177000);assert.equal(buy.summary(p).remainingItems,0);assert.equal(cycle.commitments.filter(x=>x.key!=='gpu').length,7);assert.equal(buy.summary(p).unresolvedCents,50000);assert.throws(()=>buy.payment(state,p,'approve'),/Review/);
});
test('repeat cycles require approval, remain separate, and reject duplicate retries',()=>{
 const s=buy.seedProjects(),p=create(s,{name:'Office supplies',requirements:'Coffee, cups and lids',budget:300,repeating:true,intervalDays:4});prepareAndPay(s,p);const first=buy.getCycle(p);assert.equal(first.transactions.length,1);assert.ok(p.schedule.nextRunAt);
 const next=buy.prepareNext(p,first.id);assert.equal(next.number,2);assert.equal(next.draft.status,'draft');assert.equal(next.transactions.length,0);assert.equal(buy.prepareNext(p,first.id).id,next.id);assert.equal(p.cycles.length,2);
 buy.pause(p,true);assert.throws(()=>buy.prepareNext(p,next.id),/Resume/);assert.equal(next.status,'open');buy.pause(p,false);buy.review(p);buy.payment(s,p,'fail');assert.equal(next.transactions[0].status,'failed');assert.equal(next.commitments.length,0);buy.payment(s,p,'approve');assert.equal(next.transactions.length,2);assert.equal(next.transactions[1].status,'captured');assert.equal(first.transactions.length,1);
});
test('rejects over-budget drafts, incompatible parts, late supplies and duplicate lines',()=>{
 const s=buy.seedProjects(),p=create(s),c=buy.getCycle(p);buy.prepareDraft(p);const gpu=c.draft.lines.find(x=>x.key==='gpu');buy.editLine(p,gpu.id,{name:gpu.name,quantity:1,price:2500});assert.throws(()=>buy.review(p),/budget/);assert.equal(c.transactions.length,0);
 gpu.unitCents=50000;const ram=c.draft.lines.find(x=>x.key==='memory');ram.spec.memory='DDR4';assert.throws(()=>buy.review(p),/compatible/);ram.spec.memory='DDR5';c.draft.lines.push({...structuredClone(ram),id:'duplicate'});assert.throws(()=>buy.review(p),/capacity|exactly/);
 const late=create(s,{name:'Urgent PC',needBy:datePlus(1)});assert.throws(()=>buy.prepareDraft(late),/deadline/);
});
test('event chairs source multiple suppliers and replace only the failed 50',()=>{
 const s=buy.seedProjects(),p=create(s,{name:'120 chairs',requirements:'Black event chairs',budget:1100});const c=buy.getCycle(p);prepareAndPay(s,p);assert.deepEqual(c.commitments.map(x=>x.quantity),[70,50]);buy.failLine(p,c.commitments[1].id);buy.prepareDraft(p);assert.equal(c.draft.lines.length,1);assert.equal(c.draft.lines[0].quantity,50);assert.equal(c.draft.lines[0].offerId,'chairs-backup70');buy.review(p);buy.payment(s,p,'approve');assert.equal(buy.summary(p).spentCents,97000);assert.equal(buy.summary(p).unresolvedCents,35000);
});
test('custom fixture is explicitly generic and quote states gate approval',()=>{
 const s=buy.seedProjects(),p=create(s,{name:'Custom purchase',requirements:'A specialized instrument',budget:100}),c=buy.getCycle(p);buy.prepareDraft(p);const l=c.draft.lines[0];assert.equal(l.generic,true);assert.equal(l.quantity,1);buy.editLine(p,l.id,{name:'Sample instrument',quantity:2,price:20});assert.equal(p.requirements[0].quantity,2);buy.quote(p,l.id,'request');assert.throws(()=>buy.review(p),/Confirm/);buy.quote(p,l.id,'confirm');buy.review(p);assert.equal(c.draft.status,'review');
});

test('natural language project creation does not depend on removed inputs',()=>{
 const s=buy.seedProjects(),p=buy.createProject(s,{name:'Lab equipment',requirements:'Three precision instruments for the research lab',budget:250,needBy:datePlus(7),repeating:true,intervalDays:12,category:'not-a-fixture',quantity:0});
 assert.equal(p.category,'generic');assert.equal(p.requirements[0].quantity,1);assert.equal(p.requirementsText,'Three precision instruments for the research lab');assert.equal(p.schedule.intervalDays,12);
 buy.prepareDraft(p);const line=buy.getCycle(p).draft.lines[0];buy.editLine(p,line.id,{name:'Precision instrument',quantity:3,price:20});buy.review(p);assert.equal(p.requirements[0].quantity,3);
});
test('project validation checks the remaining fields and purchase frequency',()=>{
 const s=buy.seedProjects();assert.throws(()=>create(s,{requirements:' '}),/requirements/);assert.throws(()=>create(s,{budget:0}),/budget/);assert.throws(()=>create(s,{needBy:'not-a-date'}),/date/);assert.throws(()=>create(s,{repeating:true,intervalDays:0}),/interval/);
 const p=create(s,{name:'Chair purchase',requirements:'A gaming chair',repeating:false});assert.equal(p.category,'event_chairs');
});
let server,url,temp;
before(async()=>{temp=fs.mkdtempSync(path.join(os.tmpdir(),'stacha-buy-'));process.env.PLANPATCH_STATE_FILE=path.join(temp,'state.json');const {createApp}=require('../server/index');server=createApp({developerFixtures:true}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})});
async function req(endpoint,method='GET',body){const r=await fetch(url+endpoint,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}}
test('API creates, reviews, pays, recovers, persists and resets a project',async()=>{
 let r=await req('/api/buy/projects','POST',{name:'My Gaming PC',requirements:'Gaming PC build',budget:2000,needBy:datePlus(7),mode:'demo'});assert.equal(r.status,200);const id=r.data.activeProjectId,root=`/api/buy/projects/${id}`;
 r=await req(`${root}/draft`,'POST');assert.equal(r.data.projects.find(x=>x.id===id).cycles[0].draft.lines.length,8);await req(`${root}/review`,'POST');r=await req(`${root}/payment/approve`,'POST');assert.equal(r.status,409);
 await req('/api/buy/payment-profile/enable','POST');r=await req(`${root}/payment/approve`,'POST');let p=r.data.projects.find(x=>x.id===id),gpu=p.cycles[0].commitments.find(x=>x.key==='gpu');assert.equal(p.summary.spentCents,122000);
 r=await req(`${root}/commitments/${gpu.id}/fail`,'POST');assert.equal(r.data.projects.find(x=>x.id===id).summary.remainingItems,1);r=await req(`${root}/draft`,'POST');p=r.data.projects.find(x=>x.id===id);assert.equal(p.cycles[0].draft.lines.length,1);
 r=await req('/api/state');assert.equal(r.data.projects.find(x=>x.id===id).summary.unresolvedCents,50000);r=await req('/api/reset','POST');assert.equal(r.data.projects.length,3);assert.equal(r.data.paymentProfile.enabled,false);
});
test('alternate supplier selection requires a new quote and rejects incompatible fixtures',()=>{
 const s=buy.seedProjects(),p=create(s),c=buy.getCycle(p);buy.prepareDraft(p);const gpu=c.draft.lines.find(x=>x.key==='gpu');buy.replaceOffer(p,gpu.id,'pc-gpu-alt');assert.equal(gpu.quoteStatus,'discovered');assert.throws(()=>buy.review(p),/Confirm each/);buy.quote(p,gpu.id,'request');buy.quote(p,gpu.id,'confirm');buy.review(p);assert.equal(c.draft.status,'review');
 const chairs=create(s,{name:'Chair order',requirements:'120 black chairs',budget:1100});buy.prepareDraft(chairs);const line=buy.getCycle(chairs).draft.lines[0];assert.throws(()=>buy.replaceOffer(chairs,line.id,'chairs-wrong'),/cannot satisfy/);
});
test('prior cycles are read-only and unresolved payments remain visible across cycles',()=>{
 const s=buy.seedProjects(),p=create(s,{name:'Office supplies',requirements:'Coffee, cups and lids',budget:300,repeating:true});prepareAndPay(s,p);const first=buy.getCycle(p),item=first.commitments[0];buy.failLine(p,item.id);buy.prepareDraft(p);buy.review(p);buy.payment(s,p,'approve');const unresolved=buy.summary(p).unresolvedCents;assert.ok(unresolved>0);
 const second=buy.prepareNext(p,first.id);assert.equal(buy.summary(p).allUnresolvedCents,unresolved);buy.setCycle(p,first.id);assert.throws(()=>buy.failLine(p,first.commitments.find(x=>x.status==='paid').id),/read-only/);assert.throws(()=>buy.priceChange(p),/read-only/);buy.setCycle(p,second.id);
});
test('old event data remains on disk but is not exposed in the workspace',async()=>{
 const statePath=path.join(temp,'state.json');const existing=JSON.parse(fs.readFileSync(statePath));existing.cases=[{name:'Preserved event'}];fs.writeFileSync(statePath,JSON.stringify(existing));const r=await req('/api/state');assert.equal(r.data.cases,undefined);assert.equal(JSON.parse(fs.readFileSync(statePath)).cases[0].name,'Preserved event');assert.ok(r.data.projects.length);
});
