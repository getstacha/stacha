const {DomainError}=require('../domain');
// A server-controlled read-only adapter. IDs come only from a stored attempt, never model input.
// This is not the official PayPal Agent Toolkit or a model-driven tool-calling implementation.
function createPayPalAgentTools(paypal){
 async function read(tool,attempt){
  if(!attempt||attempt.mode!=='CONNECTED_TEST_CATALOG'||!attempt.orderId)throw new DomainError('Recovery is unavailable.',409);
  if(!['get_order','get_authorization','get_capture','get_refund'].includes(tool))throw new DomainError('Recovery is unavailable.',409);
  const order=await paypal.get(attempt.orderId),verified=paypal.verify(order,attempt);
  if(tool==='get_order')return Object.freeze({status:verified.status,completed:verified.completed,authorizationId:verified.authorizationId,captureId:verified.captureId});
  if(tool==='get_authorization'){
   if(!attempt.authorizationId||verified.authorizationId!==attempt.authorizationId)throw new DomainError('Authorization status is unresolved.',409);
   const auth=await paypal.getAuthorization(attempt.authorizationId),status=paypal.verifyAuthorization(auth,attempt);
   return Object.freeze({status,expirationTime:auth.expiration_time||null});
  }
  if(tool==='get_capture'){
   if(!verified.completed||verified.captureId!==attempt.captureId)throw new DomainError('PayPal capture could not be verified.',409);
   const capture=await paypal.getCapture(attempt.captureId);
   if(capture.id!==attempt.captureId||capture.status!=='COMPLETED'||capture.amount?.currency_code!==attempt.currency||Number(capture.amount?.value)!==attempt.amountCents/100)throw new DomainError('PayPal capture could not be verified.',409);
   return Object.freeze({status:capture.status,amountCents:attempt.amountCents,currency:attempt.currency});
  }
  if(!attempt.refund?.id||!attempt.captureId)throw new DomainError('Recovery is unavailable.',409);
  return Object.freeze(paypal.verifyRefund(await paypal.getRefund(attempt.refund.id),attempt));
 }
 async function inspect(attempt){
  let payment,availableAction;
  if(attempt?.status==='authorized'){const auth=await read('get_authorization',attempt);if(auth.status!=='CREATED'||!auth.expirationTime||!Number.isFinite(Date.parse(auth.expirationTime))||Date.parse(auth.expirationTime)<=Date.now())throw new DomainError('Authorization status is unresolved.',409);payment='authorized';availableAction='void authorization with user approval'}
  else{await read('get_capture',attempt);payment='completed';availableAction='request full refund with user approval'}
  return Object.freeze({item:attempt.items[0].name,issue:attempt.recovery.reason,payment,amountCents:attempt.amountCents,currency:attempt.currency,availableAction});
 }
 return Object.freeze({read,inspect});
}
module.exports={createPayPalAgentTools};
