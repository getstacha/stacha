const {randomUUID,createHash}=require('node:crypto');
const living=require('./living-purchases');
const neg=require('./merchant-negotiation');
const agents=require('./negotiation-agents');
const bridge=require('./merchant-bridge');
const {DomainError}=require('../domain');
const now=()=>new Date().toISOString();
const event=(j,message,source='Application rule')=>j.events.push({id:randomUUID(),time:now(),source,message});
const terminal=new Set(['completed','canceled','superseded','rejected']);
function stopRun(o,j){const run=o.negotiation?.agentRun;if(run&&run.id===j.agentRunId&&['running','paused'].includes(run.status)){run.status='stopped';run.reason='Recovery job stopped.'}}
function mandate(o,body){
  const mode=body.mode, maxUnitCents=body.maxUnitCents==null||body.maxUnitCents===''?null:Number(body.maxUnitCents), maxAdditionalCents=Number(body.maxAdditionalCents),maxRounds=Number(body.maxRounds);
  if(!['manual','assisted','autopilot'].includes(mode)||!Number.isSafeInteger(maxAdditionalCents)||maxAdditionalCents<1||maxAdditionalCents>o.budgetCents||maxUnitCents!==null&&(!Number.isSafeInteger(maxUnitCents)||maxUnitCents<1)||!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>4||typeof body.allowSplit!=='boolean'||!['cost','delivery','continuity'].includes(body.priority))throw new DomainError('Enter valid recovery limits.',400);
  o.recoveryMandate={mode,maxUnitCents,maxAdditionalCents,maxRounds,allowSplit:body.allowSplit,priority:body.priority,autoResearch:body.autoResearch===true,autoNegotiate:body.autoNegotiate===true,deadline:o.deadline,substitutions:'review_required',updatedAt:now()};
  for(const j of o.recoveryJobs||[])if(!terminal.has(j.status)){stopRun(o,j);j.status='superseded';event(j,'Recovery instructions changed.');}
  living.touch(o,'buyer','Updated recovery instructions. Final commitments and payments require separate approval.');
}
function signature(o){return createHash('sha256').update(JSON.stringify({requirements:o.requirements,deadline:o.deadline,budget:o.budgetCents,excluded:o.excludedMerchants||[],commitments:o.commitments.map(c=>({id:c.id,status:c.status,quantity:c.quantity,failed:c.failedQuantity||0,disputed:c.disputedQuantity||0,amendmentShortfall:c.amendmentShortfall||0,commercialTotal:c.commercialTotalCents,delivered:c.delivered||0,dispatched:c.fulfillment?.dispatched||0,buyerReceipt:c.buyerReceipt||null,payment:c.payment?.status,invoice:c.invoice?{status:c.invoice.status,providerStatus:c.invoice.providerStatus,paymentVerified:c.invoice.paymentVerified}:null,amount:c.unitCents,merchant:c.merchantId})),mandate:o.recoveryMandate})).digest('hex')}
function failureKey(o){return o.commitments.filter(c=>c.status==='failed'||c.failedQuantity>0||c.disputedQuantity>0||c.amendmentShortfall>0).map(c=>`${c.id}:${c.failedQuantity||0}:${c.disputedQuantity||0}:${c.amendmentShortfall||0}:${c.status==='failed'?c.quantity:0}:${c.delivered||0}`).sort().join('|')}
function detect(o){
 const m=o.recoveryMandate,key=failureKey(o);if(!m||m.mode==='manual'||!key||!living.coverage(o).some(x=>x.missing))return null;
 const jobs=o.recoveryJobs||=[];const existing=jobs.find(j=>j.kind!=='preventive'&&j.failureKey===key&&!['superseded'].includes(j.status));if(existing)return existing;
 for(const j of jobs)if(j.kind!=='preventive'&&!terminal.has(j.status)){stopRun(o,j);j.status='superseded';event(j,'A newer supplier disruption replaced this recovery.');}
 const remaining=new Map(living.coverage(o).map(r=>[r.id,r.missing]));const affected=o.commitments.filter(c=>c.status==='failed'||c.failedQuantity>0||c.disputedQuantity>0||c.amendmentShortfall>0).slice().reverse().map(c=>{const raw=(c.failedQuantity||0)+(c.disputedQuantity||0)+(c.amendmentShortfall||0)||(c.status==='failed'?c.quantity:0),unavailable=Math.min(raw,remaining.get(c.requirementId)||0);remaining.set(c.requirementId,Math.max(0,(remaining.get(c.requirementId)||0)-unavailable));return {commitmentId:c.id,passportId:c.dealPassport?.id||null,merchantId:c.merchantId,requirementId:c.requirementId,unavailable,disputed:Math.min(c.disputedQuantity||0,unavailable),delivered:c.delivered||0}}).filter(x=>x.unavailable>0);if(!affected.length)return null;
 const job={id:randomUUID(),failureKey:key,status:m.mode==='autopilot'?'detected':'blocked',reason:m.mode==='assisted'?'Assisted mode: review suggestions and launch negotiations.':null,createdAt:now(),affected,events:[],rfqIds:[],rounds:[],retries:0,mandate:structuredClone(m),signature:signature(o)};
 event(job,affected.some(x=>x.disputed)?'Buyer-reported discrepancy detected. Supplier failure is not established; financial obligations remain reserved.':'Supplier disruption detected. Valid commitments and payment obligations remain unchanged.');jobs.push(job);
 for(const x of affected){const c=o.commitments.find(v=>v.id===x.commitmentId);if(c.dealPassport)(c.dealPassport.recoveryJobIds||=[]).push(job.id)}
 return job;
}
function validateLive(o,j){if(signature(o)!==j.signature){stopRun(o,j);j.status='superseded';event(j,'Requirements, payment obligations, commitments or instructions changed.');return false}return true}
function candidateComparison(o,j){
 const clone=structuredClone(o),m=j.mandate;clone.offers=clone.offers.filter(f=>(!m.maxUnitCents||f.unitCents<=m.maxUnitCents)&&f.deliveryDate<=m.deadline);neg.state(clone).boundaries={maxUnitCents:m.maxUnitCents,priority:m.priority};
 const result=neg.compare(clone),valid=result.arrangements.filter(a=>a.cost<=Math.min(m.maxAdditionalCents,living.money(o).remainingCents)&&(m.allowSplit||a.allocations.every(x=>a.allocations.filter(y=>y.requirementId===x.requirementId).length===1)));
 const pick=fn=>[...valid].sort(fn)[0]?.id||null;
 return {arrangements:valid,best:{cost:pick((a,b)=>a.cost-b.cost),delivery:pick((a,b)=>a.latest.localeCompare(b.latest)||a.cost-b.cost),continuity:pick((a,b)=>a.newSupplierCount-b.newSupplierCount||a.cost-b.cost)}};
}
function prepare(o,j){const result=candidateComparison(o,j);j.comparison=result;j.summary={coverage:living.coverage(o),unresolvedCents:living.money(o).unresolvedCents,remainingCents:living.money(o).remainingCents};const id=result.best[j.mandate.priority]||result.best.cost;j.recommendedId=id;if(!id){j.status='blocked';j.reason='No complete eligible arrangement fits the current limits, deadline, and available budget.';event(j,j.reason);return}j.status='awaiting_buyer';j.proposalRevision=o.revision;j.reason='Ready for buyer review; merchant confirmation and any payment require separate approval.';event(j,'Compared eligible merchant-stated offers and prepared a nonbinding arrangement.');}
async function step(s,o,j,{save,ai,importQuote}){
 if(!validateLive(o,j))return;
 const m=j.mandate,n=neg.state(o);
 if(j.status==='detected'){
  j.status='analyzing';const rfqs=neg.createRfqs(o,'automatic');j.rfqIds=rfqs.map(r=>r.id);j.signature=signature(o);event(j,`Calculated coverage and prepared ${rfqs.length} request(s) for uncovered requirements.`);return;
 }
 if(j.status==='analyzing'){
  if(!m.autoResearch){prepare(o,j);return}
  const r=n.rfqs.find(x=>j.rfqIds.includes(x.id)&&x.status==='open'&&o.requirements.find(y=>y.id===x.requirementId)?.category==='monitor');
  const existing=o.commitments.some(c=>c.merchantId==='STACHA'&&c.requirementId===r?.requirementId&&['accepted','requested'].includes(c.status));
  if(r&&!existing&&!(o.excludedMerchants||[]).includes('STACHA')){j.external={rfqId:r.id,negotiationId:r.externalNegotiationId||randomUUID(),requestId:r.externalRequestId||randomUUID(),counterId:randomUUID(),stage:'rfq'};r.externalNegotiationId=j.external.negotiationId;r.externalRequestId=j.external.requestId;j.status='contacting';event(j,'Preparing a nonbinding request to the independent fictional Stacha merchant.');return}
  j.status='simulated_start';return;
 }
 if(j.status==='contacting'){
  const x=j.external,r=n.rfqs.find(v=>v.id===x.rfqId&&v.status==='open');if(!r){j.status='blocked';j.reason='The recovery request changed.';return}
  const req=o.requirements.find(v=>v.id===r.requirementId);if(!req||neg.missing(o,req)!==r.quantity){j.status='superseded';event(j,'Uncovered quantities changed.');return}
  save(s);try{
    const payload=x.stage==='rfq'?{rfqId:r.id,negotiationId:x.negotiationId,requirementId:r.requirementId,productId:'test-monitor',quantity:r.quantity,deadline:r.deadline,currency:'USD',budgetCents:r.remainingCents,specifications:r.specifications,compatibility:r.compatibility,acceptableSubstitutions:'Buyer review required'}:{rfqId:r.id,negotiationId:x.negotiationId,quantity:r.quantity};
    const result=await bridge.call('POST',x.stage==='rfq'?'/v1/rfqs':'/v1/proposals',payload,x.stage==='rfq'?x.requestId:x.counterId);bridge.validateQuote(result.quote,r);
    const q=result.quote;if(q.unitCents>(m.maxUnitCents||Infinity)||q.quantity*q.unitCents>Math.min(m.maxAdditionalCents,living.money(o).remainingCents)||q.deliveryDate>m.deadline){event(j,'Independent merchant offer was outside the buyer limits.','Merchant service');j.status='simulated_start';return}
    importQuote(o,r,q);j.signature=signature(o);j.retries=0;event(j,`Independent merchant offered ${q.quantity} units at ${q.unitCents} cents each; terms are nonbinding.`,'Merchant service');
    if(x.stage==='rfq'&&m.autoNegotiate&&m.maxRounds>1&&q.quantity<r.quantity){x.stage='counter';j.status='contacting'}else j.status='simulated_start';
  }catch(e){j.retries++;event(j,`Independent merchant request failed or timed out (attempt ${j.retries}).`);if(j.retries>=2){j.status='simulated_start';j.reason='Independent merchant unavailable; other offers will still be considered.'}}
  return;
 }
 if(j.status==='simulated_start'){
  if(!m.autoNegotiate){prepare(o,j);return}
  const r=n.rfqs.find(x=>j.rfqIds.includes(x.id)&&x.status==='open');if(!r){j.status='blocked';j.reason='No open recovery request.';return}
  if(n.agentRun&&['running','paused'].includes(n.agentRun.status)){j.status='blocked';j.reason='Another merchant negotiation is active. Stop it before retrying.';return}
  const ids=living.merchants.map(x=>x.id).filter(id=>id!=='STACHA'&&!(o.excludedMerchants||[]).includes(id)&&!j.affected.some(c=>c.merchantId===id)&&agents.getPolicy(o,id).enabled&&!o.commitments.some(c=>c.merchantId===id&&c.requirementId===r.requirementId&&['requested','accepted'].includes(c.status)));
  if(!ids.length){prepare(o,j);return}
  const available=Math.min(m.maxAdditionalCents,living.money(o).remainingCents);if(available<1){prepare(o,j);return}
  n.boundaries={maxUnitCents:m.maxUnitCents,priority:m.priority};
  agents.start(o,{rfqId:r.id,merchants:ids,maxAdditionalCents:available,maxDelayDays:0,maxRounds:m.maxRounds,allowSubstitutions:false,allowSplit:m.allowSplit});j.agentRunId=n.agentRun.id;j.status='negotiating';j.signature=signature(o);event(j,`Started nonbinding simulated negotiation with ${ids.length} eligible merchant agent(s).`);return;
 }
 if(j.status==='negotiating'){
  const run=n.agentRun;if(!run||run.id!==j.agentRunId||run.status!=='running'){j.status='blocked';j.reason='Negotiation stopped or changed; request another proposal.';return}
  const fallback={price:true,quantity:true,delivery:true,substitution:false,merchantStyle:'brief'};
  const strategist={structured:async(...args)=>{try{const result=await Promise.race([ai.structured(...args),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),8000);timer.unref()})]);if(!result||['price','quantity','delivery','substitution'].some(k=>typeof result[k]!=='boolean')||!['brief','detailed'].includes(result.merchantStyle))throw Error('invalid strategy');return result}catch{j.usedFallback=true;return fallback}}};
  await agents.step(o,strategist);j.signature=signature(o);const round=run.rounds.at(-1);if(round&&!j.rounds.some(x=>x.number===round.number)){j.rounds.push(structuredClone(round));event(j,`Simulated merchant negotiation round ${round.number} completed.`,'Merchant agents')}
  if(run.status==='completed'){j.status='comparing'}else if(run.status!=='running'){j.status='blocked';j.reason=run.reason||'Negotiation paused.'}return;
 }
 if(j.status==='comparing')prepare(o,j);
}
function approve(o,j,id){
 if(j.status!=='awaiting_buyer'||!validateLive(o,j)||o.revision!==j.proposalRevision)throw new DomainError('This recovery proposal is outdated. Request another.',409);
 const fresh=candidateComparison(o,j).arrangements.find(x=>x.id===id);if(!fresh||!j.comparison.arrangements.some(x=>x.id===id))throw new DomainError('The offer changed or expired. Request another proposal.',409);
 o.proposal={id:randomUUID(),revision:o.revision,allocations:fresh.allocations,unfilled:[],additionalCents:fresh.cost,createdAt:now(),explanation:'Buyer reviewed this nonbinding recovery arrangement; seller confirmation and payment remain separate.'};const before=new Set(o.commitments.map(c=>c.id));living.approve(o,o.proposal.id);j.replacementCommitmentIds=o.commitments.filter(c=>!before.has(c.id)).map(c=>c.id);j.status='completed';j.decisionAt=now();event(j,'Buyer approved the arrangement. Supplier commitments are requested, not yet confirmed.','Buyer');
 for(const affected of j.affected){const c=o.commitments.find(x=>x.id===affected.commitmentId);if(c?.dealPassport)(c.dealPassport.recoveryDecisions||=[]).push({jobId:j.id,decision:'approved',replacementCommitmentIds:j.replacementCommitmentIds,at:j.decisionAt})}
}
module.exports={mandate,detect,step,approve,signature,candidateComparison,stopRun};
