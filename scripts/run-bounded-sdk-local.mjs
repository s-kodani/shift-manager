// Explicit real local SDK/Queues/browser runtime. This starts no computation
// until the user/test operates the product. SIGTERM drains only owned resources.
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import {startBoundedDockerGate,SDK_PROXY_IMAGE} from './bounded-docker-gate.mjs';

const args=process.argv.slice(2);
assert(args.every(a=>/^--staff=[0-9]+$/.test(a)||a==='--stop-fault'||a==='--direct'||a==='--proxy'||a==='--process-profile'||a==='--fallback-profile'||a==='--final-acceptance'||a==='--final-recovery'),'UNKNOWN_LOCAL_OPTION');
assert(args.filter(a=>a.startsWith('--staff=')).length<=1&&args.filter(a=>a==='--stop-fault').length<=1&&args.filter(a=>a==='--direct').length<=1&&args.filter(a=>a==='--proxy').length<=1&&!(args.includes('--direct')&&args.includes('--proxy')),'DUPLICATE_LOCAL_OPTION');
const staffCount=Number(args.find(a=>a.startsWith('--staff='))?.slice(8)??500),stopFault=args.includes('--stop-fault'),direct=!args.includes('--proxy');
const fallbackProfile=args.includes('--fallback-profile');assert(args.filter(a=>a==='--fallback-profile').length<=1&&!(fallbackProfile&&args.includes('--process-profile')),'DUPLICATE_LOCAL_OPTION');
const processProfile=args.includes('--process-profile');assert(args.filter(a=>a==='--process-profile').length<=1,'DUPLICATE_LOCAL_OPTION');
const finalRecovery=args.includes('--final-recovery');assert(args.filter(a=>a==='--final-recovery').length<=1);const finalAcceptance=args.includes('--final-acceptance')||finalRecovery;assert(args.filter(a=>a==='--final-acceptance'||a==='--final-recovery').length<=1&&(!finalAcceptance||(staffCount===101&&direct&&!processProfile&&!stopFault)),'FINAL_LOCAL_101_DIRECT_REQUIRED');
assert([101,500].includes(staffCount)||(staffCount===1&&processProfile&&!stopFault),'INVALID_LOCAL_STAFF_COUNT');
const id=randomUUID(),owner='shift-planner-bounded-sdk-'+id.replaceAll('-','').slice(0,12);
const root=path.resolve('.cache/bounded-sdk',id),artifact=path.resolve('artifacts/bounded-sdk',id),socketPath='/tmp/shift-sdk-'+id+'.sock';
const stopFaultFile=stopFault?root+'/stop-fault.json':undefined;
function docker(args){const r=spawnSync('docker',['--host','unix:///var/run/docker.sock',...args],{encoding:'utf8',timeout:30000,maxBuffer:20_000_000});assert.equal(r.status,0,'LOCAL_DOCKER_FAILED');return r.stdout.trim();}
function run(args,logFile){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let data='';child.stdout.on('data',b=>data+=b);child.stderr.on('data',b=>data+=b);child.on('error',reject);child.on('exit',async code=>{await writeFile(logFile,data);code===0?resolve():reject(Error('LOCAL_SETUP_FAILED'));});});}
await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:8787});socket.on('connect',()=>{socket.destroy();reject(Error('LOCAL_PORT_IN_USE'));});socket.on('error',e=>e.code==='ECONNREFUSED'?resolve():reject(e));});
await mkdir(root,{recursive:true,mode:0o700});await mkdir(artifact,{recursive:true});
assert.equal(docker(['ps','-a','--filter','name=workerd-'+owner,'--format','{{.ID}}']),'','OWNED_PREFIX_NOT_FRESH');
// Rebuild the current pinned sources under a fresh owned tag. A cached older
// native tag must not authorize a different image built by Wrangler.
const optimizerImage=owner+'-optimizer';
docker(['build','--platform','linux/amd64','--tag',optimizerImage,'--file','services/optimizer/Dockerfile','.']);
const optimizerImageId=docker(['image','inspect',optimizerImage,'--format','{{.Id}}']);
const proxyImageId=docker(['image','inspect',SDK_PROXY_IMAGE,'--format','{{.Id}}']);
const cfg=JSON.parse(await readFile('infra/wrangler.jsonc','utf8'));delete cfg.env;delete cfg.account_id;delete cfg.$schema;
cfg.name=owner;cfg.main=path.resolve(finalAcceptance?'apps/api/src/poc-worker.ts':'apps/api/src/local-ui-worker.ts');cfg.assets.directory=path.resolve('infra',cfg.assets.directory);
cfg.vars={...cfg.vars,AUTH_BASE_URL:'http://localhost:8787',ENVIRONMENT:finalAcceptance?'poc':'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',OPTIMIZER_SOLVE_PROFILE:processProfile?'mvp-joint-process-budget-v1':'mvp-joint-calendar-fallback-v1'};
cfg.dev={container_engine:'unix://'+socketPath};
cfg.containers=cfg.containers.map(c=>({...c,image:path.resolve('infra',c.image),image_build_context:path.resolve('infra',c.image_build_context)}));
cfg.d1_databases=[{binding:'DB',database_name:owner,database_id:randomUUID(),migrations_dir:path.resolve('infra/migrations')}];
cfg.r2_buckets=[{binding:'INPUTS',bucket_name:owner}];cfg.queues.producers[0].queue=owner+'-compute';cfg.queues.consumers[0].queue=owner+'-compute';
if(finalRecovery){cfg.vars.LOCAL_FINAL_RECOVERY=id;cfg.d1_databases[0].database_id='00000000-0000-0000-0000-000000000000';cfg.r2_buckets[0].bucket_name='shift-planner-inputs-local';}
const secrets={BETTER_AUTH_SECRET:randomUUID()+randomUUID(),POC_TOKEN:randomUUID()+randomUUID(),RESEND_API_KEY:'disabled-local-only'};
if(finalRecovery)secrets.OPERATOR_TOKEN=randomUUID()+randomUUID();
await writeFile(root+'/.dev.vars',Object.entries(secrets).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600,flag:'wx'});
const persist=root+(finalRecovery?'/.wrangler/state':'/state'),config=root+'/app.jsonc';await writeFile(config,JSON.stringify(cfg,null,2)+'\n',{mode:0o600,flag:'wx'});
if(finalRecovery){await writeFile(root+'/secrets.json',JSON.stringify(secrets),{mode:0o600,flag:'wx'});await writeFile(root+'/operator.jsonc',JSON.stringify({name:owner+'-operator',main:path.resolve('apps/operations/src/operator-worker.ts'),compatibility_date:cfg.compatibility_date,compatibility_flags:cfg.compatibility_flags,vars:{OPERATOR_PRINCIPAL:'local-recovery-operator',RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:cfg.d1_databases[0].database_id},d1_databases:cfg.d1_databases,durable_objects:{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:owner}]},secrets:{required:['OPERATOR_TOKEN']}},null,2)+'\n',{mode:0o600,flag:'wx'});}
const info={id,startedAt:Date.now(),pid:process.pid,owner,root,artifact,config,socketPath,optimizerImage,optimizerImageId,proxyImageId,staffCount,finalAcceptance,finalRecovery,stopFaultFile,mode:'local',route:direct?'local-user-worker-direct':'wrangler-proxy',persist,quota:{nanoCpus:1e9,memoryBytes:6*1024**3,memorySwapBytes:6*1024**3},cloudflareDeployments:0,cloudflareCalculations:0};
await writeFile(root+'/runtime.json',JSON.stringify(info,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(info));
await run(['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local','--config',config,'--persist-to',persist],artifact+'/migrations.log');
const source=staffCount===1?'null':docker(['run','--rm','--platform','linux/amd64','--entrypoint','python',optimizerImageId,'-m','optimizer.checker_fixture','--staff',String(staffCount)]);
await writeFile(artifact+'/source.json',source+'\n');
const gate=await startBoundedDockerGate({socketPath,upstreamSocket:'/var/run/docker.sock',owner,optimizerImageId,proxyImageId,evidenceFile:artifact+'/gate.json',stopFaultFile});
const workerArgs=direct?['scripts/local-direct-worker.mjs',config,persist,'8787',finalRecovery?'--final-recovery':finalAcceptance?'--final-acceptance':'--bounded-sdk']:['node_modules/wrangler/bin/wrangler.js','dev','--local','--config',config,'--persist-to',persist,'--ip','127.0.0.1','--port','8787'];
const worker=spawn(process.execPath,workerArgs,{stdio:['ignore','pipe','pipe']});let log='';
worker.stdout.on('data',b=>{log+=b;});worker.stderr.on('data',b=>{log+=b;});
let fixture=null,ending=false,startupError=null;
async function local(action,body){const r=await fetch('http://localhost:8787/__local/'+action,{method:'POST',headers:{authorization:'Bearer '+secrets.POC_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});assert.equal(r.status,200,'LOCAL_CONTROL_FAILED');return r.json();}
async function finish(){
 if(ending)return;ending=true;let error=null;
 try{
  if(finalAcceptance){
   const f=await readFile(root+'/acceptance/fixtures.json','utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(f){
    for(const owned of Object.values(f)){
     const r=await fetch('http://localhost:8787/__poc/final-control',{method:'POST',headers:{authorization:'Bearer '+secrets.POC_TOKEN,'content-type':'application/json'},body:JSON.stringify({ownerId:owned.ownerId,action:'status'}),signal:AbortSignal.timeout(30000)});
     assert.equal(r.status,200);const s=await r.json();
     assert(s.cleaned&&Object.values(s.credentials).every(n=>n===0)&&s.jobs.every(j=>!['QUEUED','RUNNING','CANCELLING'].includes(j.state))&&(!s.execution||(!s.execution.activeRpc&&!s.execution.persistedFence&&!s.execution.persistedCheckFence&&!s.execution.processRunning)),'FINAL_OWNER_NOT_CLOSED');
    }
   }
  }
  if(fixture){const state=await local('status',{fixtureId:fixture.fixtureId});await writeFile(artifact+'/sdk-state-before-cleanup.json',JSON.stringify(state,null,2));assert(state.executions.every(e=>!e.activeRpc&&!e.persistedFence&&!e.persistedCheckFence&&!e.processRunning),'OWNED_SDK_STILL_ACTIVE');await local('cleanup',{fixtureId:fixture.fixtureId});}
 }catch(e){error=e.message;}
 worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null)resolve();else worker.once('exit',resolve);});
 for(const record of gate.records){const current=docker(['ps','-a','--filter','id='+record.id,'--format','{{.ID}}']);if(current){docker(['stop','--time','1',record.id]);docker(['rm',record.id]);}}
 await gate.close();await writeFile(artifact+'/worker.log',log);
 let credentialsDisabled=false;
 if(finalAcceptance)try{
  const proof=artifact+'/final-credential-counts.json';
  await run(['node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config',config,'--persist-to',persist,'--json','--command','SELECT (SELECT count(*) FROM access_state) credentials,(SELECT count(*) FROM access_state WHERE enabled<>0) enabled,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM account WHERE password IS NOT NULL) passwords'],proof);
  const counts=JSON.parse(await readFile(proof,'utf8'))[0].results[0];assert.equal(counts.enabled+counts.sessions+counts.passwords,0);credentialsDisabled=true;
 }catch{error='FINAL_CREDENTIAL_CLEANUP_UNCONFIRMED';}
 if(fixture)try{
  const proof=artifact+'/credential-counts.json';
  await run(['node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config',config,'--persist-to',persist,'--json','--command',
   'SELECT (SELECT count(*) FROM access_state) credentials,(SELECT count(*) FROM access_state WHERE enabled<>0) enabled,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM account WHERE password IS NOT NULL) passwords'],proof);
  const counts=JSON.parse(await readFile(proof,'utf8'))[0].results[0];
  assert.deepEqual(counts,{credentials:staffCount+1,enabled:0,sessions:0,passwords:0});credentialsDisabled=true;
 }catch{error='CREDENTIAL_CLEANUP_UNCONFIRMED';}
 if(!finalAcceptance||credentialsDisabled)for(const name of ['.dev.vars',...(finalRecovery?['secrets.json']:[]),'fixture.json','sessions.json','stop-fault.json'])await unlink(root+'/'+name).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const remaining=docker(['ps','-a','--filter','name=workerd-'+owner,'--format','{{.ID}}']);
 await writeFile(artifact+'/runtime.json',JSON.stringify({...info,startupError,cleanupError:error,ownedContainersRemoved:remaining==='',workerStopped:true,gateErrors:gate.errors.length,stopFaults:gate.faults.length,fixtureCredentialsDisabled:credentialsDisabled},null,2)+'\n');
 if(error||remaining||gate.errors.length)process.exitCode=1;
}
process.on('SIGTERM',()=>{void finish();});process.on('SIGINT',()=>{void finish();});
try{
 let ready=false;for(let n=0;n<120;n++){if(worker.exitCode!==null)throw Error('LOCAL_WORKER_EXIT_'+worker.exitCode);try{const r=await fetch('http://localhost:8787/app',{headers:finalAcceptance?{authorization:'Bearer '+secrets.POC_TOKEN}:{},signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 assert(ready,'LOCAL_WORKER_NOT_READY');
 if(finalAcceptance){console.log(JSON.stringify({ready:true,id,staffCount,finalAcceptance:true,sourceFile:artifact+'/source.json',note:'Local private PoC runtime only; fixture and four jobs are dispatched separately.'}));}
 else{
 fixture=staffCount===1?{...await local('fixture',{profile:'configured'}),staffCount:1}:await local('operational-fixture',JSON.parse(source));await writeFile(root+'/fixture.json',JSON.stringify(fixture),{mode:0o600,flag:'wx'});
 if(stopFaultFile)await writeFile(stopFaultFile,JSON.stringify({owner,mode:'reject-owned-stop'})+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({ready:true,id,staffCount:fixture.staffCount,requiredHistoryCount:fixture.requiredHistoryCount,credentialsFile:root+'/fixture.json',note:'Real local SDK; no computation dispatched by startup. Stop after owned SDK is idle.'}));
 }
}catch(e){startupError=e.message;process.exitCode=1;console.error(e.message);await finish();}
