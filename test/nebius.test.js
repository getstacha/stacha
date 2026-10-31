const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const dotenv=require('dotenv');
const {AIProvider}=require('../server/services/ai-provider');
const sample={goal:'Buy a monitor',products:[{name:'Monitor',quantity:1,specifications:['27 inch']}],preferences:[],compatibility:[],clarifications:[]};
const reply=content=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})});
test('Nemotron uses the requested Nebius API and validates structured output with one retry',async()=>{
 const calls=[];const ai=new AIProvider({key:'test-key',fetcher:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return reply(calls.length===1?'not JSON':JSON.stringify(sample))}});
 const result=await ai.analyze({description:'a monitor'});assert.deepEqual(result,sample);assert.equal(calls.length,2);assert.equal(calls[0].url,'https://api.tokenfactory.nebius.com/v1/chat/completions');assert.equal(calls[0].body.model,'nvidia/Nemotron-3_5-Lightning');assert.equal(calls[0].body.chat_template_kwargs.enable_thinking,false);assert.equal(calls[0].options.headers.Authorization,'Bearer test-key');assert.match(calls[1].body.messages[0].content,/previous answer failed validation/);
});
test('Nemotron rejects invalid plan, authentication errors and truncated output',async()=>{
 let calls=0;const badPlan=new AIProvider({key:'test-key',fetcher:async()=>{calls++;return reply(JSON.stringify({selections:[{requirementIndex:'x',offerId:'offer',reason:'ok'}],compatibility:[],uncertainties:[]}))}});await assert.rejects(()=>badPlan.plan({}),/invalid purchase information/);assert.equal(calls,2);
 const denied=new AIProvider({key:'test-key',fetcher:async()=>({ok:false,status:401})});await assert.rejects(()=>denied.analyze({}),/API key/);
 const truncated=new AIProvider({key:'test-key',fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})})});await assert.rejects(()=>truncated.analyze({}),/incomplete/);
});
test('local key import preserves existing settings, hides the key and refuses to overwrite it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stacha-key-'));
 try{const source=path.join(dir,'source.env'),target=path.join(dir,'.env'),script=path.join(__dirname,'..','scripts','import-nebius-key.js'),secret='fake-test-key-123';fs.writeFileSync(source,`NEBIUS_API_KEY=${secret}\n`);fs.writeFileSync(target,'CHANNEL3_API_KEY=keep-existing\nNEBIUS_API_KEY=\n');const run=()=>spawnSync(process.execPath,[script,source],{cwd:dir,encoding:'utf8'});const first=run();assert.equal(first.status,0);assert.ok(!first.stdout.includes(secret));assert.ok(!first.stderr.includes(secret));const parsed=dotenv.parse(fs.readFileSync(target));assert.equal(parsed.NEBIUS_API_KEY,secret);assert.equal(parsed.CHANNEL3_API_KEY,'keep-existing');assert.equal(fs.statSync(target).mode&0o777,0o600);const before=fs.readFileSync(target,'utf8');const second=run();assert.equal(second.status,1);assert.equal(fs.readFileSync(target,'utf8'),before);assert.ok(!second.stderr.includes(secret));}finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('over-budget AI choices are reduced to actual offers within budget and disclosed',async()=>{
 const ai=new AIProvider({key:'test-key',fetcher:async(_url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);return reply(JSON.stringify({selections:input.offers.map(g=>({requirementIndex:g.requirementIndex,offerId:g.offers[0].id,reason:'Candidate'})),compatibility:[],uncertainties:[]}))}});
 const plan=await ai.plan({offers:[{requirementIndex:0,offers:[{id:'real-expensive',unitCents:800}]},{requirementIndex:1,offers:[{id:'real-affordable',unitCents:300}]}],interpretation:{products:[{quantity:1},{quantity:1}]},remainingBudgetCents:500});
 assert.deepEqual(plan.selections.map(x=>x.offerId),['real-affordable']);assert.match(plan.uncertainties.join(' '),/omitted.*budget/);
});
test('AI plan accepts a null budget without treating it as zero',async()=>{const ai=new AIProvider({key:'test-key',fetcher:async(_url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);return reply(JSON.stringify({selections:[{requirementIndex:0,offerId:input.offers[0].offers[0].id,reason:'Candidate'}],compatibility:[],uncertainties:[]}))}});const plan=await ai.plan({offers:[{requirementIndex:0,offers:[{id:'real',unitCents:5000}]}],interpretation:{products:[{quantity:1}]},remainingBudgetCents:null});assert.equal(plan.selections[0].offerId,'real')});
