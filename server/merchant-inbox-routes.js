const inbox=require('./services/merchant-inbox'),living=require('./services/living-purchases');const {DomainError}=require('./domain');
module.exports=function(app,{mutate,ai}){
 const context=(s,req)=>{const o=living.objective(s,req.params.id);return {o,c:inbox.get(o,req.params.conversationId)}};
 const active=(s,req)=>{const x=context(s,req);if(x.c.closedAt)throw new DomainError('This conversation is closed.',409);return x};
 app.post('/api/living/:id/inbox/create',mutate((s,req)=>inbox.create(living.objective(s,req.params.id),req.body)));
 app.post('/api/living/:id/inbox/:conversationId/contact',mutate((s,req)=>{const {o,c}=active(s,req);inbox.contact(o,c,req.body)}));
 app.post('/api/living/:id/inbox/:conversationId/draft',mutate((s,req)=>{const {o,c}=active(s,req);inbox.draft(o,c,req.body)}));
 app.post('/api/living/:id/inbox/:conversationId/import',mutate(async(s,req)=>{const {o,c}=active(s,req),msg=inbox.importMessage(o,c,req.body);if(msg.extractionStatus==='complete'||msg.kind==='confirmation')return;try{await inbox.extract(o,c,msg,ai)}catch{msg.extractionStatus='unavailable';msg.extractionError='Could not extract terms. The original message is saved; retry extraction.'}}));
 app.post('/api/living/:id/inbox/:conversationId/extract',mutate(async(s,req)=>{const {o,c}=active(s,req),msg=c.messages.find(x=>x.id===req.body.messageId);if(!msg||msg!==c.messages.at(-1)||msg.extractionStatus==='complete')throw new DomainError('This message cannot be extracted.',409);try{await inbox.extract(o,c,msg,ai)}catch{msg.extractionStatus='unavailable';msg.extractionError='Could not extract terms. The original message is saved; retry extraction.'}}));
 app.post('/api/living/:id/inbox/:conversationId/manual-review',mutate((s,req)=>{const {o,c}=active(s,req),msg=c.messages.find(x=>x.id===req.body.messageId);if(!msg||msg.extractionStatus==='complete')throw new DomainError('This message is already reviewed.',409);inbox.manualQuote(o,c,msg)}));
 app.post('/api/living/:id/inbox/:conversationId/review',mutate((s,req)=>{const {o,c}=active(s,req);inbox.correct(o,c,req.body.quoteId,req.body)}));
 app.post('/api/living/:id/inbox/:conversationId/publish',mutate((s,req)=>{const {o,c}=active(s,req);inbox.publish(o,c,req.body.quoteId,req.body.confirm)}));
 app.post('/api/living/:id/inbox/:conversationId/counter',mutate(async(s,req)=>{const {o,c}=active(s,req);await inbox.counter(o,c,ai)}));
 app.post('/api/living/:id/inbox/:conversationId/cancel-request',mutate((s,req)=>{const {o,c}=context(s,req),item=o.commitments.find(x=>x.id===req.body.commitmentId&&x.merchantId===c.merchantId);if(req.body.confirm!==true||!item||item.status!=='requested')throw new DomainError('This request cannot be canceled.',409);item.status='cancelled';living.touch(o,'buyer','Canceled an unconfirmed external supplier request.');require('./services/merchant-negotiation').createRfqs(o,'automatic')}));
 app.post('/api/living/:id/inbox/:conversationId/confirm',mutate((s,req)=>{const {o,c}=context(s,req);inbox.confirm(o,c,req.body)}));
};
