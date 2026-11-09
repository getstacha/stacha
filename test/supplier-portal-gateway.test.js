const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createPortal,parseOrigin}=require('../server/supplier-portal-gateway');
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const close=s=>new Promise(r=>s.close(r));
test('supplier gateway exposes only scoped endpoints and does not forward buyer credentials',async()=>{
 let seen;const core=http.createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{seen={path:req.url,headers:req.headers,body:JSON.parse(body)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}))})});await listen(core);
 const reserve=http.createServer();await listen(reserve);const port=reserve.address().port;await close(reserve);const origin=`http://127.0.0.1:${port}`,gateway=createPortal({origin,corePort:core.address().port}).listen(port,'127.0.0.1');await new Promise(r=>gateway.once('listening',r));
 try{let r=await fetch(origin+'/supplier-order.html');assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal((await fetch(origin+'/api/state')).status,404);assert.equal((await fetch(origin+'/index.html')).status,404);
 const send=(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await send('/api/state',{token:'a'.repeat(43)})).status,404);assert.equal((await send('/api/po-portal/view',{token:'a'.repeat(43)},{origin:'https://attacker.example'})).status,403);assert.equal((await send('/api/po-portal/view',{token:'bad'})).status,400);
 r=await send('/api/po-portal/view',{token:'a'.repeat(43)},{cookie:'buyer=secret',authorization:'Bearer secret'});assert.equal(r.status,200);assert.equal(seen.path,'/api/po-portal/view');assert.equal(seen.headers.cookie,undefined);assert.equal(seen.headers.authorization,undefined);assert.equal(seen.body.token,'a'.repeat(43));
 }finally{await close(gateway);await close(core)}
});
test('public portal origin requires HTTPS and rejects credentials and paths',()=>{assert.equal(parseOrigin('https://supplier.example'), 'https://supplier.example');assert.throws(()=>parseOrigin('http://supplier.example'));assert.throws(()=>parseOrigin('https://u:p@supplier.example'));assert.throws(()=>parseOrigin('https://supplier.example/private'))});
