// Public hackathon demo: isolated, in-memory fictional data only.
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const living = require('../server/services/living-purchases');
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '2kb'}));
const sessions = new Map(), TTL = 60 * 60 * 1000, MAX = 1000;
function initial() {
  const state = {livingPurchases: []};
  const o = living.demo(state);
  const proposal = living.plan(o);
  living.approve(o, proposal.id);
  for (const c of o.commitments) living.merchantCommit(o, c.id, c.merchantId, 'accept', {});
  const b = o.commitments.find(c => c.merchantId === 'B');
  living.simulatePayment(o, b.id, 'authorize', true);
  return o;
}
function storyEntry(kind, title, detail) { return {kind, title, detail, at: new Date().toISOString()}; }
function reset(s) {
  s.o = initial();
  s.story = [storyEntry('secured', 'Purchase plan established', 'All required equipment has fictional supplier commitments.'), storyEntry('authorization', 'Simulated authorization recorded', 'Supplier B has a fictional $540 authorization. No PayPal transaction occurred.')];
}
function cleanup() { const now = Date.now(); for (const [id,s] of sessions) if (now-s.last>TTL) sessions.delete(id); }
function session(req,res) {
  cleanup();
  const match=(req.headers.cookie||'').match(/(?:^|;\s*)demo_session=([a-f0-9]{48})(?:;|$)/), existing=match&&sessions.get(match[1]);
  if(existing){existing.last=Date.now();return existing}
  if(sessions.size>=MAX){res.status(503).json({error:'The demo is busy. Please try again later.'});return null}
  const id=crypto.randomBytes(24).toString('hex'),s={last:Date.now(),requests:[]};reset(s);sessions.set(id,s);
  res.append('Set-Cookie',`demo_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${process.env.NODE_ENV==='production'?'; Secure':''}`);return s;
}
app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});next()});
app.get('/health',(_req,res)=>res.json({ok:true,mode:'fictional-demo'}));
app.get('/api/demo',(req,res)=>{const s=session(req,res);if(s)res.json(view(s))});
function view(s) {
  const o=s.o, monitor=o.requirements.find(r=>r.category==='monitor');
  const b=o.commitments.find(c=>c.merchantId==='B'&&c.requirementId===monitor.id);
  const coverage=living.coverage(o), money=living.money(o);
  const proposal=o.proposal?{id:o.proposal.id,additionalCents:o.proposal.additionalCents,allocations:o.proposal.allocations.map(a=>({merchant:a.merchantId,quantity:a.quantity,unitCents:a.unitCents,requirementId:a.requirementId})),unfilled:o.proposal.unfilled}:null;
  const complete=b.status==='failed'&&coverage.every(r=>r.missing===0);
  return {
    deadline:o.deadline,
    coverage:coverage.map(r=>({id:r.id,name:r.name,quantity:r.quantity,committed:r.committed,missing:r.missing})),
    budgetCents:o.budgetCents,money,
    commitments:o.commitments.map(c=>({merchant:c.merchantId,requirementId:c.requirementId,quantity:c.quantity,name:o.requirements.find(r=>r.id===c.requirementId).name,status:c.status,payment:c.payment.status,unitCents:c.unitCents})),
    offers:o.offers.map(f=>({merchant:f.merchantId,requirementId:f.requirementId,quantity:f.quantity,unitCents:f.unitCents,status:f.status,deliveryDate:f.deliveryDate})),
    proposal,events:o.events.map(e=>({time:e.time,source:e.source,message:e.message})),timeline:s.story,
    can:{authorize:b.status==='accepted'&&b.payment.status==='not_paid',fail:b.status==='accepted',void:b.payment.status==='authorized',plan:b.status==='failed'&&!complete,approve:!!proposal?.allocations.length},
    paymentStatus:b.payment.status,originalAuthorizationCents:b.quantity*b.unitCents,supplierStatus:b.status,complete
  };
}
app.post('/api/demo/:action',(req,res)=>{
  let valid=false;try{const u=new URL(req.get('Origin'));valid=u.host===req.get('Host')&&['http:','https:'].includes(u.protocol)}catch{}
  if(!valid||req.get('Sec-Fetch-Site')==='cross-site')return res.status(403).json({error:'Request origin rejected.'});
  const s=session(req,res);if(!s)return;
  const now=Date.now();s.requests=s.requests.filter(t=>now-t<60000);if(s.requests.length>=60)return res.status(429).json({error:'Please wait before trying again.'});s.requests.push(now);
  try{
    // Apply each action to a copy so a failed transition cannot partially change a session.
    const working={o:structuredClone(s.o),story:[...s.story]};
    const o=working.o,b=o.commitments.find(c=>c.merchantId==='B'&&o.requirements.find(r=>r.id===c.requirementId)?.category==='monitor');
    switch(req.params.action){
      case 'reset':reset(working);break;
      case 'authorize':living.simulatePayment(o,b.id,'authorize',true);working.story.push(storyEntry('authorization','Simulated authorization recorded','The fictional authorization is included in the reserved budget.'));break;
      case 'failure':living.merchantCommit(o,b.id,'B','withdraw',{});working.story.push(storyEntry('failure','Supplier disruption reported',`${b.quantity} monitors became uncovered. Other commitments remain unchanged.`));break;
      case 'plan':{const p=living.plan(o);const allocated=p.allocations.reduce((n,a)=>n+a.quantity,0);working.story.push(storyEntry('proposal','Recovery arrangement prepared',`${allocated} replacement units proposed for buyer review. The offers are fictional.`));break;}
      case 'void':{const hadProposal=!!o.proposal;living.simulatePayment(o,b.id,'void',true);working.story.push(storyEntry('void','Simulated authorization released','The fictional payment obligation is resolved in this simulation. No PayPal transaction occurred.'));if(hadProposal){const p=living.plan(o);working.story.push(storyEntry('proposal','Recovery arrangement recalculated',`${p.allocations.reduce((n,a)=>n+a.quantity,0)} replacement units proposed after the financial state changed.`));}break;}
      case 'approve':{living.approve(o,o.proposal?.id);for(const c of o.commitments.filter(x=>x.status==='requested'))living.merchantCommit(o,c.id,c.merchantId,'accept',{});working.story.push(storyEntry('approved','Replacement plan approved','The buyer approved the fictional arrangement; simulated suppliers accepted the replacement commitments.'));break;}
      default:return res.status(404).json({error:'Unknown action.'});
    }
    s.o=working.o;s.story=working.story;res.json(view(s));
  }catch(e){res.status(e.status||400).json({error:e.message})}
});
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',fallthrough:false,dotfiles:'deny'}));
app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.status===404?'Not found.':'Request failed.'}));
if(require.main===module){const port=Number(process.env.PORT)||3000;app.listen(port,'0.0.0.0',()=>console.log(`Fictional Stacha demo on port ${port}`))}
module.exports=app;
