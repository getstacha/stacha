const {randomUUID}=require('node:crypto');
const DAY=86400000;
function assess(o,c,time=Date.now()){
 const cfg=o.guardianSettings||{},riskDays=cfg.riskDays??3,staleHours=cfg.staleHours??48,supplierDelivered=c.delivered||0,buyerReceived=c.buyerReceipt?.usable||0,delivered=Math.max(supplierDelivered,buyerReceived),failed=c.failedQuantity||0,remaining=Math.max(0,c.quantity-delivered-failed),promised=c.deliveryDate||o.deadline;
 const due=Date.parse(`${promised}T23:59:59.999Z`),deadline=Date.parse(`${o.deadline}T23:59:59.999Z`),limit=Math.min(due||Infinity,deadline||Infinity),last=Date.parse(c.fulfillment?.updatedAt||c.externalConfirmation?.updatedAt||c.updatedAt||c.createdAt||'');
 let state='on_track',reason='No current risk signal.';
 if(c.status==='failed'||failed>0){state='confirmed_failure';reason=`Merchant reported ${failed||c.quantity} unavailable.`}
 else if(c.disputedQuantity>0||c.buyerReceipt?.discrepancy>0){state='at_risk';reason='Buyer reported a disputed quantity; supplier failure is not established.'}
 else if(c.status==='accepted'&&remaining===0){state='completed';reason=buyerReceived>=c.quantity?'Buyer reported all committed units received.':'Merchant reported all committed units delivered.'}
 else if(c.status==='requested'){state='needs_confirmation';reason='Merchant acceptance is pending.'}
 else if(c.status==='accepted'&&time>limit){state='deadline_missed';reason='The stated deadline has passed; supplier failure is not confirmed.'}
 else if(c.status==='accepted'&&(promised>o.deadline||c.fulfillment?.status==='delayed'||limit-time<=riskDays*DAY&&(c.fulfillment?.dispatched||0)<c.quantity-failed)){state='at_risk';reason='The delivery promise, reported delay, or lack of dispatch needs attention.'}
 else if(c.status==='accepted'&&((Number.isFinite(last)&&time-last>staleHours*3600000)||c.dealPassport?.reservation?.status==='expired')){state='needs_confirmation';reason='The latest merchant update or reservation needs confirmation.'}
 return {state,reason,remaining,promisedDate:promised,objectiveDeadline:o.deadline,latestUpdate:Number.isFinite(last)?new Date(last).toISOString():null,assessedAt:new Date(time).toISOString(),basis:'deterministic; merchant updates are not independently verified'};
}
function update(o,time=Date.now()){
 let changed=false;for(const c of o.commitments||[]){if(!['accepted','requested','failed'].includes(c.status))continue;const a=assess(o,c,time),prior=c.riskAssessment;if(prior?.state===a.state&&prior?.reason===a.reason&&prior?.remaining===a.remaining&&prior?.promisedDate===a.promisedDate&&prior?.objectiveDeadline===a.objectiveDeadline)continue;c.riskAssessment=a;changed=true;if(c.dealPassport){(c.dealPassport.riskHistory||=[]).push({id:randomUUID(),...a});c.dealPassport.version++}}
 return changed;
}
module.exports={assess,update};
