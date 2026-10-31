require('dotenv').config({quiet:true});
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('./domain');
const {attachIntegrations} = require('./integrations');
const {AIProvider,validateInterpretation} = require('./services/ai-provider');
const buy = require('./buy');
const catalog = require('./services/catalog-purchasing');
const {assess}=require('./services/plan-quality');
const {publicError} = require('./public-errors');
const {randomUUID} = require('node:crypto');
const {queue:writeLedger}=require('./webhook-gateway');

const root = path.join(__dirname, '..');

const statePath = process.env.PLANPATCH_STATE_FILE || path.join(root, 'data', 'state.json');
const clone = obj => JSON.parse(JSON.stringify(obj));
function initialState() { return { ...buy.seedProjects(), schemaVersion: 3, sandboxPayments: [] }; }
function load() {
  if (!fs.existsSync(statePath)) return initialState();
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!Array.isArray(state.projects)) {
    const backup = `${statePath}.before-buy-projects.backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(statePath, backup);
    Object.assign(state, buy.seedProjects()); state.schemaVersion = 3; save(state);
  }
  state.sandboxPayments ||= [];
  return state;
}
function save(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(tmp, statePath);
}
function createApp(options = {}) {
  const app = express(); app.use('/api/paypal/webhook',express.raw({type:'application/json',limit:'256kb'})); app.use(express.json({ limit: '32kb' }));
  // Fixtures only run in an explicitly opted-in, separate local data environment.
  const explicitState=Boolean(process.env.PLANPATCH_STATE_FILE);
  let isolatedState=false;
  if(explicitState){try{const temp=fs.realpathSync(require('node:os').tmpdir()),target=fs.existsSync(statePath)?fs.realpathSync(statePath):path.join(fs.realpathSync(path.dirname(statePath)),path.basename(statePath)),relative=path.relative(temp,target);isolatedState=!!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)}catch{isolatedState=false}}
  const developerFixtures=(options.developerFixtures===true||process.env.STACHA_DEVELOPER_FIXTURES==='true')&&isolatedState&&process.env.NODE_ENV!=='production';
  const devOnly=(req,res,next)=>developerFixtures?next():res.status(404).json({error:'Not found.',code:'NOT_FOUND'});
  const devPaths=[/^\/api\/reset$/, /^\/api\/buy\/payment-profile\//, /^\/api\/buy\/projects\/[^/]+\/(?:draft|review|reopen|payment|commitments|next-cycle|cycles\/[^/]+\/open|price-change)(?:\/|$)/, /^\/api\/buy\/projects\/[^/]+\/lines\//];
  app.use((req,res,next)=>devPaths.some(pattern=>pattern.test(req.path))?devOnly(req,res,next):next());
  const providers={...options.providers}; providers.ai ||= new AIProvider();
  const analyze = async input => { const clean=buy.parseInput({...input,name:input.name||'New project'}); return validateInterpretation(await providers.ai.analyze({description:clean.requirements,budgetCents:clean.budgetCents,needBy:clean.needBy})); };
  const generatedName = goal => goal.replace(/\s+/g,' ').trim().slice(0,100) || 'New project';
  const respond = (res, state) => {
    const {cases,activeCaseId,nextCaseNumber,paymentProfile,paypalWebhookEvents,...visible}=state;
    if(developerFixtures)return res.json({...visible,paymentProfile,projects:state.projects.map(p=>({...p,summary:buy.summary(p)}))});
    const allowedActivity=new Set(['Buy Project created','Project created','Project updated','Purchase plan updated','External purchase reported','Purchase report corrected','Quantity updated','Product selected','Item removed','Test catalog payment verified','Schedule paused','Schedule resumed']);
    const projects=state.projects.map(p=>{const {offers,requirements,category,cycles,activity,...rest}=p;const f=p.liveCycle?catalog.accounts(state,p,p.liveCycle):{externalCents:0,paidCents:0,pendingCents:0,accounted:[]};const committed=f.externalCents+f.paidCents+f.pendingCents;return {...rest,testCatalog:catalog.options(state,p,integrations.capabilities().paypalMerchant),financial:{budgetCents:p.budgetCents,externalCents:f.externalCents,paidCents:f.paidCents,pendingCents:f.pendingCents,remainingCents:p.budgetCents===null?null:p.budgetCents-committed,coveredIndices:f.accounted.map(x=>x.requirementIndex)},cycles:cycles.map(({id,number,needBy,status})=>({id,number,needBy,status})),activity:activity.filter(a=>allowedActivity.has(a.title)).map(a=>({...a,detail:/simulat|fixture/i.test(a.detail)?'':a.detail})),...(p.liveCycle?{liveCycle:{...p.liveCycle,plan:p.liveCycle.plan?{...p.liveCycle.plan,quality:assess({...p,coveredIndices:f.accounted.map(x=>x.requirementIndex)},p.liveCycle.plan)}:p.liveCycle.plan,monitorError:p.liveCycle.monitorError?publicError({message:p.liveCycle.monitorError}).message:null}}:{})}});
    const sandboxPayments=(visible.sandboxPayments||[]).map(({id,projectId,projectName,cycleId,quoteId,merchant,items,mode,amountCents,currency,status,orderStatus,fulfillmentStatus,obligationStatus,orderId,captureId,createdAt,completedAt,checkedAt,paypalStatus,refundedAt,refund,recovery,intent,authorizationId,authorizationExpiresAt,monitor})=>({id,projectId,projectName,cycleId,quoteId,merchant,items,mode,amountCents,currency,status,orderStatus,fulfillmentStatus,obligationStatus,orderId,captureId,createdAt,completedAt,checkedAt,paypalStatus,refundedAt,intent,authorizationId,authorizationExpiresAt,monitor,refund:refund?{id:refund.id,status:refund.status,amountCents:refund.amountCents,createdAt:refund.createdAt,completedAt:refund.completedAt}:undefined,recovery}));
    res.json({...visible,projects,sandboxPayments});
  };
  let queue=Promise.resolve(); const locked = fn => { const job=queue.then(fn); queue=job.catch(()=>{}); return job; };
  const mutate = action => (req, res, next) => { locked(async()=>{ const state = load(); await action(state, req); save(state); respond(res, state); }).catch(next); };
  app.get('/api/state', (req, res, next) => { try { respond(res, load()); } catch (e) { next(e); } });
  app.post('/api/reset', mutate(state => { if(state.sandboxPayments?.length)throw new domain.DomainError('Sandbox payment records cannot be reset.',409); Object.assign(state, buy.seedProjects()); }));
  app.post('/api/buy/projects', mutate(async (state, req) => { const input={...req.body}; delete input.interpretation; if(input.mode==='demo'&&!developerFixtures)throw new domain.DomainError('Not found.',404); if(input.mode!=='demo')input.interpretation=await analyze(input); if(!input.name)input.name=input.interpretation?generatedName(input.interpretation.goal):'New project'; buy.createProject(state,input); }));
  app.post('/api/buy/projects/:id/archive', mutate((state, req) => {const p=buy.getProject(state,req.params.id);if((state.sandboxPayments||[]).some(x=>x.projectId===p.id&&['creating','created','approved','capture_pending','unknown','authorizing','authorized','authorization_capture_pending','void_pending'].includes(x.status)))throw new domain.DomainError('Resolve pending sandbox payments before archiving.',409);p.archivedAt=new Date().toISOString();if(state.activeProjectId===p.id)state.activeProjectId=state.projects.find(x=>!x.archivedAt)?.id||null;}));
  app.post('/api/buy/projects/:id/restore', mutate((state, req) => {const p=buy.getProject(state,req.params.id);delete p.archivedAt;}));
  app.post('/api/buy/projects/:id/open', mutate((state, req) => { buy.getProject(state, req.params.id); state.activeProjectId = req.params.id; }));
  app.patch('/api/buy/projects/:id', mutate(async (state, req) => {const p=buy.getProject(state,req.params.id),input={...req.body};delete input.interpretation;if(input.mode==='demo'&&!developerFixtures)throw new domain.DomainError('Not found.',404);const changed=String(input.requirements||'').trim()!==p.requirementsText;const autoName=!input.name;input.name=input.name||p.name;const clean=buy.parseInput(input);for(const c of [...(p.liveHistory||[]),...(p.liveCycle?[p.liveCycle]:[])]){const f=catalog.accounts(state,p,c);if(clean.budgetCents!==null&&clean.budgetCents<f.externalCents+f.paidCents+f.pendingCents)throw new domain.DomainError('The selected products exceed the remaining budget.',409);if(changed&&c===p.liveCycle&&(f.paid.length||f.pending.length))throw new domain.DomainError('Cannot change requirements after recorded or pending test purchases.',409)}if(changed&&p.liveCycle?.externalPurchases?.some(x=>x.status!=='RETRACTED'))throw new domain.DomainError('Cannot change requirements after recording purchases in this cycle.',409);if(input.mode!=='demo'&&(changed||!p.interpretation)){input.interpretation=await analyze(input);if(autoName&&changed)input.name=generatedName(input.interpretation.goal)}buy.editProject(p,input);}));
  app.post('/api/buy/projects/:id/draft', mutate((state, req) => buy.prepareDraft(buy.getProject(state, req.params.id))));
  app.patch('/api/buy/projects/:id/lines/:lineId', mutate((state, req) => buy.editLine(buy.getProject(state, req.params.id), req.params.lineId, req.body)));
  app.post('/api/buy/projects/:id/lines/:lineId/offer/:offerId', mutate((state, req) => buy.replaceOffer(buy.getProject(state, req.params.id), req.params.lineId, req.params.offerId))); 
  app.post('/api/buy/projects/:id/lines/:lineId/quote/:action', mutate((state, req) => buy.quote(buy.getProject(state, req.params.id), req.params.lineId, req.params.action)));
  app.post('/api/buy/projects/:id/review', mutate((state, req) => buy.review(buy.getProject(state, req.params.id))));
  app.post('/api/buy/projects/:id/reopen', mutate((state, req) => buy.reopen(buy.getProject(state, req.params.id))));
  app.post('/api/buy/projects/:id/payment/:action', mutate((state, req) => buy.payment(state, buy.getProject(state, req.params.id), req.params.action)));
  app.post('/api/buy/projects/:id/commitments/:commitmentId/fail', mutate((state, req) => buy.failLine(buy.getProject(state, req.params.id), req.params.commitmentId)));
  app.post('/api/buy/projects/:id/commitments/:commitmentId/fulfill', mutate((state, req) => buy.fulfil(buy.getProject(state, req.params.id), req.params.commitmentId)));
  app.post('/api/buy/projects/:id/schedule/:action', mutate((state, req) => { if(!['pause','resume'].includes(req.params.action))throw new domain.DomainError('Invalid schedule action.');buy.pause(buy.getProject(state, req.params.id), req.params.action==='pause'); }));
  app.post('/api/buy/projects/:id/next-cycle', mutate((state, req) => buy.prepareNext(buy.getProject(state, req.params.id), req.body.afterCycleId)));
  app.post('/api/buy/projects/:id/cycles/:cycleId/open', mutate((state, req) => buy.setCycle(buy.getProject(state, req.params.id), req.params.cycleId)));
  app.post('/api/buy/projects/:id/price-change', mutate((state, req) => buy.priceChange(buy.getProject(state, req.params.id))));
  app.post('/api/buy/payment-profile/:action', mutate((state, req) => { if(!['enable','disable'].includes(req.params.action))throw new domain.DomainError('Invalid payment profile action.');state.paymentProfile.enabled=req.params.action==='enable'; }));


  const ledger=(kind,a,reference)=>writeLedger(process.env.PAYPAL_FINANCIAL_LEDGER||`${statePath}.ledger.sqlite3`,'ledger',{key:`${kind}:${reference}`,kind,projectId:a.projectId,orderId:a.orderId,reference,amountCents:a.amountCents,currency:a.currency,verifiedAt:new Date().toISOString()});
  const integrations=attachIntegrations(app,{load,save,respond,buy,locked,providers,developerFixtures,ledger});
  app.locals.integrations=integrations;
  if(options.scheduler!==false && process.env.SCHEDULER_ENABLED!=='false')integrations.scheduler.start();
  app.use(express.static(path.join(root, 'public')));
  app.use((err, req, res, next) => { const requestId=randomUUID(),safe=publicError(err); console.error(`Request ${requestId}: ${safe.code}`);res.status(err.status || 500).json({error:safe.message,code:safe.code,requestId}); });
  return app;
}
if (require.main === module) { const port = Number(process.env.PORT) || 3000; createApp().listen(port, '127.0.0.1', () => console.log(`stacha is running at http://localhost:${port}`)); }
module.exports = { createApp };
