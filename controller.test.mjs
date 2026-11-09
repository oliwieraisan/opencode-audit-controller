import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init,run,merge,sha,json,write,checkResult,inside,recover,packetPermissions} from './controller.mjs';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-controller-test-'));
 const source='CODEX_Licencjat/02_ZRODLA/2.1/Markdown/source.md';
 fs.mkdirSync(path.dirname(path.join(root,source)),{recursive:true});
 fs.writeFileSync(path.join(root,source),`---\nsource_sha256: ${'a'.repeat(64)}\n---\n<!-- PDF_PAGE: 1 -->\nExact evidence for the claim.\n`);
 const artifact='CODEX_Licencjat/04_ROBOCZE_CODEX/text.md';
 fs.mkdirSync(path.dirname(path.join(root,artifact)),{recursive:true});fs.writeFileSync(path.join(root,artifact),'Frozen thesis text');
 const claims=[1,2].map(n=>({claim_id:`2.1-B01-C00${n}`,wording:'Claim '+n,location:'paragraph 1',information_type:'MECHANISM',risk:'HIGH',requires_source:true,artifact_excerpt_exact:'Frozen thesis text'}));
 const map='CODEX_Licencjat/04_ROBOCZE_CODEX/map.json';
 write(path.join(root,map),{artifact_sha256:sha(path.join(root,artifact)),independence_status:'INDEPENDENCE_NOT_ACHIEVED',source_scope:[{path:'source.pdf',sha256:'a'.repeat(64)}],claims});
 const config=path.join(root,'config.json');
 write(config,{project_root:root,audit_id:'TEST',artifact_path:artifact,map_path:map,source_dir:path.dirname(source),output_dir:'CODEX_Licencjat/04_ROBOCZE_CODEX/RUN_TEST',roles:['B'],max_claims:1});
 const result=init(config);return {root,registry:path.join(result.output,'registry.json')};
}
function resultFor(job){return {schema_version:'1.0',audit_id:job.audit_id,batch_id:job.batch_id,role:job.role,artifact_sha256:job.artifact_sha256,map_sha256:job.map_sha256,claims:job.claims.map(c=>({...c,verifier_status:'SUPPORTED',evidence:[{source_id:'SRC',source_path:job.sources[0].path,markdown_sha256:job.sources[0].sha256,access_method:'MARKDOWN_EXTRACTION',bibliographic_identity_verified:true,source_role:'PRIMARY',printed_page:'1',pdf_page:1,locator:'paragraph 1',exact_excerpt:'Exact evidence for the claim.',support_relation:'DIRECT',population_or_material:'test population',study_design:'test design',limitations:[],checked_from:'FULL_TEXT'}],limitations:[],finding_codes:[],notes:''}))};}
class Mock {
 constructor(root,failOn=0){this.root=root;this.failOn=failOn;this.created=[];this.responses=new Map();this.jobs=new Map();this.interrupted=[];}
 async create(job){const id='session-'+(this.created.length+1);this.created.push(id);this.jobs.set(id,job);return id;}
 async prompt(id){const job=this.jobs.get(id);if(this.created.length!==this.failOn){const result=resultFor(job);write(path.join(this.root,job.output_path),result);this.responses.set(id,[{type:'assistant',content:[{type:'text',text:JSON.stringify(result)}]}]);}else this.responses.set(id,[{type:'idle',error:{type:'provider.free-limit',message:'Free limit reached',status:429}}]);}
 async get(id){return {id,outcome:this.created.length===this.failOn?'failed':'succeeded',time:{idle:Date.now()},tokens:{input:100,output:50},cost:0};}
 async messages(id){return this.responses.get(id)||[];}
 async interrupt(id){this.interrupted.push(id);}
}
test('two batches use fresh sessions, merge retains historical independence',async()=>{
 const f=fixture(),m=new Mock(f.root);assert.equal((await run(f.registry,m)).status,'completed');assert.equal(new Set(m.created).size,2);
 merge(f.registry);const ledger=json(path.join(path.dirname(f.registry),'merged-pass-b.json'));assert.equal(ledger.claims.length,2);assert.equal(ledger.historical_independence,'INDEPENDENCE_NOT_ACHIEVED');assert.equal(ledger.gate.result,'NOT_RECONCILED');
});
test('limit stops, checkpoints, resume skips completed first batch',async()=>{
 const f=fixture(),m=new Mock(f.root,2);await assert.rejects(run(f.registry,m),/free-limit/);let r=json(f.registry);assert.equal(r.batches[0].status,'completed');assert.equal(r.batches[1].status,'stopped');assert.equal(json(path.join(path.dirname(f.registry),'checkpoint.json')).status,'stopped');
 const before=sha(path.join(path.dirname(f.registry),r.batches[0].result));const resumed=new Mock(f.root);await run(f.registry,resumed);assert.equal(resumed.created.length,1);assert.equal(sha(path.join(path.dirname(f.registry),r.batches[0].result)),before);
});
test('changed source blocks new inference',async()=>{
 const f=fixture(),r=json(f.registry);fs.appendFileSync(path.join(f.root,r.inputs.sources[0].path),'changed');const m=new Mock(f.root);await assert.rejects(run(f.registry,m),/INPUT_CHANGED/);assert.equal(m.created.length,0);
});
test('missing, duplicate, wrong quote and wrong role results cannot advance',()=>{
 const f=fixture(),r=json(f.registry),job=json(path.join(path.dirname(f.registry),r.batches[0].job));
 const missing=resultFor(job);missing.claims=[];assert.equal(checkResult(missing,job,f.root).complete,false);
 const duplicate=resultFor(job);duplicate.claims.push(duplicate.claims[0]);assert.throws(()=>checkResult(duplicate,job,f.root),/duplicate/);
 const quote=resultFor(job);quote.claims[0].evidence[0].exact_excerpt='Invented quote';assert.throws(()=>checkResult(quote,job,f.root),/Quote absent/);
 const wrong=resultFor(job);wrong.role='C';assert.throws(()=>checkResult(wrong,job,f.root),/identity/);
});
test('one session cap pauses safely; second run completes',async()=>{
 const f=fixture(),m=new Mock(f.root);assert.equal((await run(f.registry,m,{maxSessions:1})).status,'paused');assert.equal(m.created.length,1);await run(f.registry,m);assert.equal(m.created.length,2);
});
test('simultaneous controller rejected and path traversal rejected',async()=>{
 const f=fixture();fs.writeFileSync(path.join(path.dirname(f.registry),'controller.lock'),'lock');await assert.rejects(run(f.registry,new Mock(f.root)),/EEXIST/);assert.throws(()=>inside(f.root,'../escape'),/outside/);
});
test('incomplete output stops before second session',async()=>{
 const f=fixture(),m=new Mock(f.root);m.prompt=async function(id){const job=this.jobs.get(id);const partial=resultFor(job);partial.claims=[];write(path.join(this.root,job.output_path),partial);this.responses.set(id,[]);};await assert.rejects(run(f.registry,m),/INCOMPLETE/);assert.equal(m.created.length,1);
});
test('recover refuses to release a live controller lock',async()=>{
 const f=fixture(),lock=path.join(path.dirname(f.registry),'controller.lock');write(lock,{pid:process.pid});await assert.rejects(recover(f.registry,new Mock(f.root)),/still exists/);assert.ok(fs.existsSync(lock));
});
test('partial result is preserved and omitted from work on resumed session',async()=>{
 const f=fixture(),r=json(f.registry),out=path.dirname(f.registry),jobPath=path.join(out,r.batches[0].job),job=json(jobPath);
 job.claims.push({...job.claims[0],claim_id:'2.1-B01-C099',wording:'Claim extra'});write(jobPath,job);r.batches[0].job_sha256=sha(jobPath);write(f.registry,r);
 const partial=resultFor(job);partial.claims=partial.claims.slice(0,1);write(path.join(out,r.batches[0].result),partial);
 const m=new Mock(f.root),prompts=[];const original=m.prompt.bind(m);m.prompt=async(id,text)=>{prompts.push(text);await original(id);};await run(f.registry,m);
 assert.match(prompts[0],/Już ukończone własne ID.*2\.1-B01-C001/);assert.equal(json(path.join(out,r.batches[0].result)).claims.length,2);
});
test('permissions include Location-relative read/edit and keep grep denied',()=>{
 const f=fixture(),r=json(f.registry),jobPath=path.join(path.dirname(f.registry),r.batches[0].job),job=json(jobPath),rules=packetPermissions(f.root,job,jobPath);
 assert.ok(rules.some(p=>p.action==='read'&&p.resource===job.sources[0].path&&p.effect==='allow'));
 assert.ok(rules.some(p=>p.action==='edit'&&p.resource===job.output_path&&p.effect==='allow'));
 assert.ok(!rules.some(p=>p.action==='grep'&&p.effect==='allow'));
});
test('provider retryAfter blocks another inference before reset',async()=>{
 const f=fixture();write(path.join(path.dirname(f.registry),'checkpoint.json'),{updated_at:new Date().toISOString(),reason:JSON.stringify({type:'provider.free-limit',retryAfterMs:60000})});const m=new Mock(f.root);assert.equal((await run(f.registry,m)).status,'waiting_provider');assert.equal(m.created.length,0);
});
test('explicit manual retry is limited to one session and remains logged',async()=>{
 const f=fixture();write(path.join(path.dirname(f.registry),'checkpoint.json'),{updated_at:new Date().toISOString(),reason:JSON.stringify({type:'provider.free-limit',retryAfterMs:60000})});const m=new Mock(f.root);await run(f.registry,m,{retryOnce:true});assert.equal(m.created.length,1);assert.equal(json(f.registry).manual_resumptions.length,1);
});
