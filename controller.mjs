import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
const now = () => new Date().toISOString();
export const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const json = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export function write(p, x) {
  fs.mkdirSync(path.dirname(p),{recursive:true});
  const tmp = p+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
  fs.renameSync(tmp,p);
}
export function inside(root, relative) {
  const p = path.resolve(root,relative), r = path.relative(root,p);
  if(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)) throw Error('Path outside project: '+relative);
  // Reject junctions/symlinks escaping the project, including existing parents.
  let parent=p; while(!fs.existsSync(parent)) parent=path.dirname(parent);
  const real=fs.realpathSync(parent), rr=path.relative(fs.realpathSync(root),real);
  if(rr==='..'||rr.startsWith('..'+path.sep)||path.isAbsolute(rr)) throw Error('Symlink outside project');
  return p;
}
const normal = s => s.replace(/\s+/g,' ').trim();
const B=['SUPPORTED','PARTIALLY_SUPPORTED','UNSUPPORTED','CONTRADICTED','UNVERIFIABLE','HUMAN_REVIEW','NOT_SOURCE_DEPENDENT'];
const C=['SURVIVES_CHALLENGE','OVERSTATED','METHODOLOGICAL_MISMATCH','CONTRADICTED','UNVERIFIABLE'];
export function checkResult(result, job, root) {
  if(result.schema_version!=='1.0')throw Error('Invalid schema_version');
  for(const k of ['audit_id','batch_id','role','artifact_sha256','map_sha256']) if(result[k]!==job[k]) throw Error('Result identity mismatch: '+k);
  if(!Array.isArray(result.claims)) throw Error('Missing claims array');
  const seen=new Set(), byID=new Map(job.claims.map(c=>[c.claim_id,c]));
  for(const c of result.claims) {
    const src=byID.get(c.claim_id);
    if(!src||seen.has(c.claim_id)) throw Error('Unexpected/duplicate claim: '+c.claim_id);
    seen.add(c.claim_id);
    for(const k of ['wording','location','information_type','risk','requires_source']) if(c[k]!==src[k]) throw Error('Changed claim '+c.claim_id+': '+k);
    const status=job.role==='B'?c.verifier_status:c.falsifier_status;
    if(!(job.role==='B'?B:C).includes(status)) throw Error('Invalid or unfinished status: '+status);
    if(!Array.isArray(c.evidence)||!Array.isArray(c.limitations)||!Array.isArray(c.finding_codes)||typeof c.notes!=='string') throw Error('Missing claim fields');
    if(!c.evidence.length && !['UNVERIFIABLE','NOT_SOURCE_DEPENDENT'].includes(status)) throw Error('Verdict requires evidence');
    if(!c.evidence.length && !c.notes.trim()) throw Error('Missing explanation of unavailable evidence');
    for(const e of c.evidence) {
      const source=job.sources.find(s=>s.path===e.source_path);
      if(!source||e.markdown_sha256!==source.sha256) throw Error('Source outside scope or wrong hash');
      if(e.access_method!=='MARKDOWN_EXTRACTION') throw Error('Wrong source access method');
      for(const k of ['source_id','locator','exact_excerpt','population_or_material','study_design']) if(typeof e[k]!=='string'||!e[k].trim()) throw Error('Missing evidence field '+k);
      if(typeof e.bibliographic_identity_verified!=='boolean'||!Array.isArray(e.limitations)) throw Error('Invalid evidence fields');
      if(!['PRIMARY','SECONDARY','TERTIARY','AUTHOR_MATERIAL'].includes(e.source_role)||!['DIRECT','PARTIAL','CONTRADICTORY','CONTEXT_ONLY','NONE'].includes(e.support_relation)||!['FULL_TEXT','ABSTRACT_ONLY','METADATA_ONLY','INCOMPLETE_COPY'].includes(e.checked_from)) throw Error('Invalid evidence enum');
      if(e.printed_page!==null&&typeof e.printed_page!=='string') throw Error('Invalid printed_page');
      let text=fs.readFileSync(inside(root,source.path),'utf8');
      if(e.pdf_page!==null) {
        if(!Number.isInteger(e.pdf_page)||e.pdf_page<1) throw Error('Invalid PDF page');
        const marker=new RegExp('<!--\\s*PDF_PAGE:\\s*'+e.pdf_page+'\\s*-->');
        const m=marker.exec(text); if(!m) throw Error('Page marker absent');
        text=text.slice(m.index+m[0].length).split(/<!--\s*PDF_PAGE:/)[0];
      }
      if(e.pdf_page===null&&status==='SUPPORTED') throw Error('Unmapped page cannot be fully supported');
      if(!normal(text).includes(normal(e.exact_excerpt))) throw Error('Quote absent from declared source/page');
    }
  }
  return {completed:[...seen],open:job.claims.filter(c=>!seen.has(c.claim_id)).map(c=>c.claim_id),complete:seen.size===job.claims.length};
}
export function init(configPath) {
  const cfg=json(configPath), root=fs.realpathSync(cfg.project_root);
  const out=inside(root,cfg.output_dir);
  if(!cfg.output_dir.replaceAll('\\','/').startsWith('CODEX_Licencjat/04_ROBOCZE_CODEX/')) throw Error('Output must be under working directory');
  if(fs.existsSync(path.join(out,'registry.json'))) throw Error('Already initialized: use run/status');
  if(!/^[\w.-]+$/.test(cfg.audit_id)) throw Error('Unsafe audit_id');
  const mapPath=inside(root,cfg.map_path), artifact=inside(root,cfg.artifact_path), map=json(mapPath);
  if(map.artifact_sha256 && map.artifact_sha256!==sha(artifact)) throw Error('Artifact differs from frozen map');
  if(!map.artifact_sha256 && !cfg.allow_unbound_map) throw Error('Map is not bound to artifact hash');
  const sourceDir=inside(root,cfg.source_dir);
  const scope=(map.source_scope||[]).map(s=>typeof s==='string'?s:s.path);
  const sources=fs.readdirSync(sourceDir).filter(n=>n.endsWith('.md')).map(n=>{
    const p=path.join(sourceDir,n), text=fs.readFileSync(p,'utf8');
    const hash=/^source_sha256:\s*["']?([a-f0-9]{64})/mi.exec(text)?.[1];
    if(!/<!--\s*PDF_PAGE:\s*1\s*-->/.test(text)||!hash) throw Error('Missing page markers or PDF hash: '+n);
    const original=(map.source_scope||[]).find(s=>typeof s==='object'&&s.sha256===hash);
    const stem=n.slice(0,-3).toLowerCase();
    if(scope.length&&!original&&!scope.some(s=>path.basename(s).replace(/\.pdf$/i,'').toLowerCase()===stem)) return null;
    if(scope.length&&!original&&map.source_scope.some(s=>typeof s==='object')) throw Error('PDF hash differs from scope: '+n);
    return {path:path.relative(root,p).replaceAll('\\','/'),sha256:sha(p),pdf_sha256:hash,source_pdf:original?.path||null};
  }).filter(Boolean);
  if(!sources.length) throw Error('No sources in scope');
  let claims=map.claims.filter(c=>cfg.claim_ids?cfg.claim_ids.includes(c.claim_id):(!cfg.workstream||c.workstream===cfg.workstream));
  if(cfg.claim_ids&&claims.length!==new Set(cfg.claim_ids).size) throw Error('Missing selected claims');
  if(!claims.length||new Set(claims.map(c=>c.claim_id)).size!==claims.length) throw Error('Empty or duplicate claims');
  const max=cfg.max_claims??5;
  if(!Number.isInteger(max)||max<1||max>5) throw Error('max_claims must be 1..5');
  const registry={schema_version:'1.0',audit_id:cfg.audit_id,created_at:now(),config:cfg,inputs:{artifact:{path:cfg.artifact_path,sha256:sha(artifact)},map:{path:cfg.map_path,sha256:sha(mapPath)},sources},historical_independence:map.independence_status||'INDEPENDENCE_NOT_ACHIEVED',batches:[]};
  for(const role of cfg.roles||['B','C']) {
    if(!['B','C'].includes(role)) throw Error('Invalid role');
    const selected=claims.filter(c=>role==='B'||['MEDIUM','HIGH'].includes(c.risk));
    let group=[],blocks=new Set(),count=0;
    const flush=()=>{
      if(!group.length)return;
      const id=`pass-${role.toLowerCase()}-${String(++count).padStart(3,'0')}`;
      const dir=path.join(out,role,id), output=path.join(dir,'result.json');
      const job={schema_version:'1.0',audit_id:cfg.audit_id,batch_id:id,role,artifact_sha256:registry.inputs.artifact.sha256,map_sha256:registry.inputs.map.sha256,historical_independence:registry.historical_independence,sources,claims:group.map(c=>({claim_id:c.claim_id,wording:c.wording,location:c.location,information_type:c.information_type,risk:c.risk,requires_source:c.requires_source,artifact_excerpt_exact:c.artifact_excerpt_exact||'',instruction:c.instruction||''})),output_path:path.relative(root,output).replaceAll('\\','/')};
      write(path.join(dir,'job.json'),job);
      registry.batches.push({id,role,status:'pending',job:path.relative(out,path.join(dir,'job.json')),job_sha256:sha(path.join(dir,'job.json')),result:path.relative(out,output),attempts:[],completed:[],open:group.map(c=>c.claim_id)});
      group=[];blocks=new Set();
    };
    for(const c of selected){const block=c.claim_id.match(/-B\d+/)?.[0]||c.location;if(group.length>=max||(!blocks.has(block)&&blocks.size>=3))flush();group.push(c);blocks.add(block);}flush();
  }
  write(path.join(out,'registry.json'),registry);
  write(path.join(out,'checkpoint.json'),{status:'prepared',next:registry.batches[0]?.id,updated_at:now()});
  return {output:out,batches:registry.batches.length,claims:claims.length};
}
export function verifyInputs(r,root,out) {
  for(const f of [r.inputs.artifact,r.inputs.map,...r.inputs.sources]) if(sha(inside(root,f.path))!==f.sha256) throw Error('INPUT_CHANGED: '+f.path);
  for(const b of r.batches) if(sha(inside(out,b.job))!==b.job_sha256) throw Error('JOB_CHANGED: '+b.id);
}
export class OpenCode {
  constructor(cli,root,model){this.cli=cli||'opencode';this.root=root;this.model=model;}
  async api(operation,body,params={}){
    const args=['api',operation];if(body)args.push('--data',JSON.stringify(body));
    for(const [k,v] of Object.entries(params))args.push('--param',`${k}=${v}`);
    const {stdout}=await exec(this.cli,args,{cwd:this.root,windowsHide:true,timeout:60000,maxBuffer:16*1024*1024});
    return JSON.parse(stdout.trim());
  }
  async create(job,batch){
    const model=/^([^/]+)\/(.+)$/.exec(this.model||'');
    if(!model) throw Error('Set opencode_model to providerID/modelID in the config before initializing');
    const output=inside(this.root,job.output_path),jobPath=inside(this.root,batch.job_path);
    const permissions=packetPermissions(this.root,job,jobPath);
    const res=await this.api('session.create',{title:`${job.audit_id} ${job.batch_id}`,agent:job.role==='B'?'source-verifier':'methodology-falsifier',model:{providerID:model[1],id:model[2]},location:{directory:this.root},permissions});
    return res.data.id;
  }
  async prompt(id,text){await this.api('session.prompt',{text},{sessionID:id});}
  async get(id){return (await this.api('session.get',null,{sessionID:id})).data;}
  async messages(id){return (await this.api('session.message.list',null,{sessionID:id,limit:'30',order:'desc'})).data;}
  async interrupt(id){await this.api('session.interrupt',null,{sessionID:id});}
}
export function packetPermissions(root,job,jobPath){
  const output=inside(root,job.output_path);
  const read=[jobPath,output,...job.sources.map(s=>inside(root,s.path))];
  const variants=p=>[path.relative(root,p).replaceAll('\\','/'),p.replaceAll('\\','/')];
  // Internal paths are Location-relative. grep checks a regex, not its path,
  // so it cannot enforce a per-file corpus and remains denied.
  return [{action:'*',resource:'*',effect:'deny'},...read.flatMap(p=>variants(p).map(resource=>({action:'read',resource,effect:'allow'}))),...variants(output).map(resource=>({action:'edit',resource,effect:'allow'}))];
}
function basePromptFor(job,completed) {
  return `Wykonaj WYŁĄCZNIE kontrolowaną paczkę audytu ${job.batch_id}, rola ${job.role}. To dedykowana sesja niezależnego audytora, nie sesja redakcji; nie czytaj STAN_BIEZACY, historii, innych audytów ani całej mapy. Stałe zasady naukowe obowiązują. Korzystaj wyłącznie z wymienionych Markdownów; PDF, shell, internet, subagenci są zabronione. Dopuszczalne narzędzia: read/grep do źródeł i edit do własnego wyniku. Nie wymagaj szerszych uprawnień. Kontekst pracy jest w artifact_excerpt_exact; wording może być parafrazą mapy. Nie uznawaj niezależności historycznej mapy za osiągniętą.\nZaczynaj od stron wynikających z przypisów w kontekście. Rozszerz odczyt dla sprawdzenia ograniczeń. Numery linii nie są stronami.\nWynik: obiekt JSON z polami schema_version:"1.0",audit_id,batch_id,role,artifact_sha256,map_sha256 oraz claims. Każdy rekord claims zachowuje claim_id,wording,location,information_type,risk,requires_source i dodaje ${job.role==='B'?'verifier_status':'falsifier_status'},evidence[],limitations[],finding_codes[],notes. Dozwolone statusy: ${(job.role==='B'?B:C).join(', ')}. Evidence: source_id,source_path (ścieżka Markdown z zadania),markdown_sha256,access_method:"MARKDOWN_EXTRACTION",bibliographic_identity_verified (boolean),source_role,printed_page (string/null),pdf_page (integer/null),locator,exact_excerpt (krótki dosłowny cytat),support_relation,population_or_material,study_design,limitations[],checked_from. Enums: source_role PRIMARY/SECONDARY/TERTIARY/AUTHOR_MATERIAL; support_relation DIRECT/PARTIAL/CONTRADICTORY/CONTEXT_ONLY/NONE; checked_from FULL_TEXT/ABSTRACT_ONLY/METADATA_ONLY/INCOMPLETE_COPY. Nie wymyślaj dowodu. Brak dostępu => UNVERIFIABLE z notes. NOT_AUDITED nie kończy zadania.\nPo każdym ukończonym twierdzeniu zapisz poprawny wynik częściowy w output_path, zachowując własne poprzednie rekordy. Jeśli zapis narzędziem nie jest możliwy, zwróć JSON wyniku w końcowej odpowiedzi; kontroler zapisze go po walidacji. Odpowiedź końcowa ma zawierać wyłącznie JSON. Nie uruchamiaj kolejnej paczki.\nJuż ukończone własne ID (nie oceniaj ponownie): ${JSON.stringify(completed)}.\nZadanie:\n${JSON.stringify(job)}`;
}
export function promptFor(job,completed){
  return basePromptFor(job,completed).replace('read/grep do źródeł','read do źródeł (grep jest wyłączony)').replace('Numery linii nie są stronami.','Numery linii nie są stronami. Numery drukowane (np. 1907) nie są numerami PDF_PAGE. Najpierw przeczytaj początek Markdown i ustal mapowanie, nie szukaj PDF_PAGE:1907.');
}
function parseAssistant(messages){
  for(const m of messages){if(m.type!=='assistant')continue;const text=(m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');try{const x=JSON.parse(text);if(Array.isArray(x.claims))return x;}catch{}}
  return null;
}
export async function run(registryPath,adapter,options={}) {
  if(!Number.isInteger(options.maxSessions??2)||(options.maxSessions??2)<1||(options.maxSessions??2)>100)throw Error('maxSessions must be 1..100');
  const out=path.dirname(path.resolve(registryPath)),r=json(registryPath),root=fs.realpathSync(r.config.project_root),lock=path.join(out,'controller.lock');
  const priorCheckpoint=path.join(out,'checkpoint.json');
  if(fs.existsSync(priorCheckpoint)){
    const prior=json(priorCheckpoint);
    try{
      const error=JSON.parse(prior.reason||'null');
      if(error?.type?.includes('limit')&&Number.isFinite(error.retryAfterMs)){
        const retry=Date.parse(prior.updated_at)+error.retryAfterMs;
        if(Date.now()<retry&&!options.retryOnce)return {status:'waiting_provider',retry_not_before:new Date(retry).toISOString(),sessions:0};
      }
    }catch{}
  }
  const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,started_at:now()}));fs.closeSync(fd);
  let current=null,active=null;
  const save=()=>write(registryPath,r);
  const checkpoint=(status,reason)=>write(path.join(out,'checkpoint.json'),{audit_id:r.audit_id,status,reason,updated_at:now(),batch:current?.id,session_id:active,completed:current?.completed||[],open:current?.open||[],next_step:'Run status, resolve reported cause, then run controller again. Do not restart init.'});
  let stopped=false;
  const onSignal=()=>{stopped=true;};process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  try {
    if(options.retryOnce){
      r.manual_resumptions??=[];r.manual_resumptions.push({at:now(),reason:'Explicit user request for one controlled retry; provider, model and credentials unchanged.'});save();
      options.maxSessions=1;
    }
    verifyInputs(r,root,out);
    // Interrupted processes can leave a running session. Recover/interrupt it before any new inference.
    for(const batch of r.batches){
      current=batch;
      if(batch.status==='running'){
        const id=batch.attempts.at(-1)?.session_id;
        if(id)await adapter.interrupt(id);
        batch.status='interrupted';save();
      }
      if(fs.existsSync(inside(out,batch.result))){const check=checkResult(json(inside(out,batch.result)),json(inside(out,batch.job)),root);batch.completed=check.completed;batch.open=check.open;if(check.complete)batch.status='completed';}
      else if(batch.status==='completed')throw Error('Completed result missing: '+batch.id);
    }
    save();
    let sessions=0;
    for(const batch of r.batches){
      current=batch;active=null;
      if(batch.status==='completed')continue;
      if(stopped||sessions>=(options.maxSessions??2)){checkpoint('paused','SESSION_CAP_OR_USER_STOP');return {status:'paused',sessions};}
      verifyInputs(r,root,out);
      const job=json(inside(out,batch.job));
      const id=await adapter.create(job,{...batch,job_path:path.relative(root,inside(out,batch.job))});
      active=id;sessions++;
      batch.status='running';batch.attempts.push({session_id:id,started_at:now()});save();checkpoint('running',null);
      console.log(JSON.stringify({event:'session_created',batch:batch.id,session_id:id}));
      await adapter.prompt(id,promptFor(job,batch.completed));
      const started=Date.now();let messages=[],info;
      while(true){
        info=await adapter.get(id);messages=await adapter.messages(id);
        const tokenTotal=(info.tokens?.input||0)+(info.tokens?.cache?.read||0)+(info.tokens?.output||0)+(info.tokens?.reasoning||0);
        if(stopped||Date.now()-started>(options.timeoutMs??600000)||tokenTotal>(options.maxTokens??80000)){
          await adapter.interrupt(id);throw Error(stopped?'USER_STOP':tokenTotal>(options.maxTokens??80000)?'TOKEN_GUARD':'TIMEOUT');
        }
        if(info.outcome&&info.time?.idle>=started-2000)break;
        await new Promise(resolve=>setTimeout(resolve,options.pollMs??2500));
      }
      batch.attempts.at(-1).usage={tokens:info.tokens,cost:info.cost};
      const resultPath=inside(out,batch.result);
      const response=parseAssistant(messages);
      if(response){checkResult(response,job,root);if(!fs.existsSync(resultPath)||response.claims.length>=json(resultPath).claims.length)write(resultPath,response);}
      if(fs.existsSync(resultPath)){const v=checkResult(json(resultPath),job,root);batch.completed=v.completed;batch.open=v.open;}
      verifyInputs(r,root,out);
      const error=messages.find(m=>m.error)?.error;
      if(info.outcome!=='succeeded'||error)throw Error(error?JSON.stringify(error):'SESSION_'+info.outcome);
      if(batch.open.length)throw Error('INCOMPLETE_RESULT');
      batch.status='completed';batch.attempts.at(-1).ended_at=now();active=null;save();checkpoint('batch_completed',null);
    }
    checkpoint('completed','All packet results structurally validated; scientific reconciliation still required.');
    return {status:'completed',sessions};
  } catch(e){
    if(active){try{await adapter.interrupt(active);}catch{}}
    if(current&&current.status!=='completed'){
      try{const p=inside(out,current.result);if(fs.existsSync(p)){const v=checkResult(json(p),json(inside(out,current.job)),root);current.completed=v.completed;current.open=v.open;}}catch{}
      current.status='stopped';current.error=String(e.message);
    }
    save();checkpoint('stopped',String(e.message));throw e;
  } finally {process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);fs.unlinkSync(lock);}
}
export function merge(registryPath){
  const out=path.dirname(path.resolve(registryPath)),r=json(registryPath),root=r.config.project_root;
  verifyInputs(r,root,out);
  if(r.batches.some(b=>b.status!=='completed'))throw Error('Incomplete batches; cannot merge');
  for(const role of ['B','C']){
    const batches=r.batches.filter(b=>b.role===role);if(!batches.length)continue;
    const claims=batches.flatMap(b=>{const result=json(inside(out,b.result));if(!checkResult(result,json(inside(out,b.job)),root).complete)throw Error('Incomplete result');return result.claims;});
    if(new Set(claims.map(c=>c.claim_id)).size!==claims.length)throw Error('Duplicate merged claims');
    write(path.join(out,`merged-pass-${role.toLowerCase()}.json`),{schema_version:'1.0',audit_id:r.audit_id,role,artifact_sha256:r.inputs.artifact.sha256,historical_independence:r.historical_independence,claims,gate:{result:'NOT_RECONCILED',note:'Role-specific ledger, not a final audit or scientific PASS.'}});
  }
  return {status:'merged_not_reconciled'};
}
export async function recover(registryPath,adapter){
  const out=path.dirname(path.resolve(registryPath)),lock=path.join(out,'controller.lock');
  if(!fs.existsSync(lock))return {status:'no_lock'};
  const pid=json(lock).pid;
  if(!Number.isInteger(pid)||pid<1)throw Error('Invalid lock PID; manual review required');
  let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
  if(alive)throw Error('Controller PID still exists; do not remove lock');
  const r=json(registryPath);
  for(const b of r.batches.filter(b=>b.status==='running')){const id=b.attempts.at(-1)?.session_id;if(id)await adapter.interrupt(id);b.status='interrupted';}
  write(registryPath,r);fs.unlinkSync(lock);return {status:'recovered'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,file,...args]=process.argv.slice(2);
  try{
    if(command==='init')console.log(JSON.stringify(init(path.resolve(file))));
    else if(command==='status'){const r=json(file);console.log(JSON.stringify({audit_id:r.audit_id,batches:r.batches.map(b=>({id:b.id,status:b.status,completed:b.completed,open:b.open,error:b.error,attempts:b.attempts})),checkpoint:json(path.join(path.dirname(file),'checkpoint.json'))},null,2));}
    else if(command==='merge')console.log(JSON.stringify(merge(file)));
    else if(command==='preview'){
      const r=json(file),out=path.dirname(path.resolve(file));
      for(const b of r.batches){const job=json(inside(out,b.job));fs.writeFileSync(path.join(path.dirname(inside(out,b.job)),'PROMPT_PREVIEW.txt'),promptFor(job,b.completed),'utf8');}
      console.log('Prompt previews saved; no model called.');
    }
    else if(command==='recover'){const r=json(file);console.log(JSON.stringify(await recover(file,new OpenCode(r.config.opencode_cli,r.config.project_root))));}
    else if(command==='run'){
      const r=json(file);console.log(JSON.stringify(await run(path.resolve(file),new OpenCode(r.config.opencode_cli,r.config.project_root,r.config.opencode_model),{maxSessions:Number(args[0]||2),retryOnce:args.includes('--retry-once')})));
    }else throw Error('Usage: node controller.mjs init config.json | status registry.json | run registry.json [maxSessions=2] | merge registry.json');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
