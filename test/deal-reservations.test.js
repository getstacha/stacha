const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMerchant}=require('../merchant-service/server');
const bridge=require('../server/services/merchant-bridge');

test('reservations persist, prevent double allocation, expire before checkout, and retain uncertain checkouts',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stacha-reservations-'));
  const file=path.join(dir,'merchant.json'),keyFile=path.join(dir,'key'),key='isolated-test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
  fs.writeFileSync(keyFile,key,{mode:0o600});
  const oldPort=process.env.MERCHANT_BRIDGE_PORT,oldKey=process.env.MERCHANT_BRIDGE_KEY_FILE;
  process.env.MERCHANT_BRIDGE_KEY_FILE=keyFile;
  let server;
  const start=async()=>{server=createMerchant({key,stateFile:file,uiEnabled:false}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));process.env.MERCHANT_BRIDGE_PORT=String(server.address().port)};
  const stop=()=>new Promise(r=>server.close(r));
  try{
    await start();
    const request=async suffix=>{const rfqId=`rfq-${suffix}`,negotiationId=`neg-${suffix}`,requirementId=`requirement-${suffix}`;let x=await bridge.call('POST','/v1/rfqs',{rfqId,negotiationId,requirementId,quantity:4,deadline:'2099-01-01'});x=await bridge.call('POST','/v1/proposals',{rfqId,negotiationId,quantity:4});const q=x.quote;return {rfqId,quoteId:q.quoteId,quoteRevision:q.revision,requirementId,quantity:q.quantity,unitCents:q.unitCents,currency:q.currency,productId:q.productId,localCommitmentId:`local-${suffix}`,buyerApproved:true}};
    const a=await request('a'),b=await request('b');
    const first=await bridge.call('POST','/v1/commitments/confirm',a,'reservation-a');
    assert.equal(first.commitment.reservation.status,'reserved');
    assert.equal((await bridge.call('POST','/v1/commitments/confirm',a,'reservation-a')).commitment.id,first.commitment.id);
    await assert.rejects(()=>bridge.call('POST','/v1/commitments/confirm',b));
    await stop();await start();
    assert.equal((await bridge.call('GET','/v1/capabilities')).availability.quantity,0);
    let disk=JSON.parse(fs.readFileSync(file));disk.commitments[0].reservation.expiresAt='2000-01-01T00:00:00.000Z';fs.writeFileSync(file,JSON.stringify(disk));
    assert.equal((await bridge.call('GET','/v1/capabilities')).availability.quantity,4);
    assert.equal((await bridge.call('GET',`/v1/commitments/${first.commitment.id}`)).commitment.status,'expired');
    const c=await request('c'),second=await bridge.call('POST','/v1/commitments/confirm',c);
    await bridge.call('POST','/v1/commitments/checkout',{commitmentId:second.commitment.id});
    disk=JSON.parse(fs.readFileSync(file));disk.commitments.find(x=>x.id===second.commitment.id).reservation.expiresAt='2000-01-01T00:00:00.000Z';fs.writeFileSync(file,JSON.stringify(disk));
    assert.equal((await bridge.call('GET','/v1/capabilities')).availability.quantity,0);
    assert.equal((await bridge.call('GET',`/v1/commitments/${second.commitment.id}`)).commitment.reservation.status,'checkout_pending');
  }finally{if(server?.listening)await stop();if(oldPort===undefined)delete process.env.MERCHANT_BRIDGE_PORT;else process.env.MERCHANT_BRIDGE_PORT=oldPort;if(oldKey===undefined)delete process.env.MERCHANT_BRIDGE_KEY_FILE;else process.env.MERCHANT_BRIDGE_KEY_FILE=oldKey;fs.rmSync(dir,{recursive:true,force:true})}
});
