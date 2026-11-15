import {requireDeploymentTarget} from './deployment-target.mjs';
import {targetFetch} from './deployment-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
// Final-session resource allocation only. No deployment, solve, approval or
// release freeze. POSTs are single-shot; an uncertain owner is never replayed.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,lstat,realpath,open,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyPlannedCohort} from './final-cohort-plan.mjs';
import {assertFinalQualityEvidence} from './final-release-policy.mjs';
import {currentLocalCheckSource,verifyLocalCheckFiles} from './final-local-check-proof.mjs';
import {recordedFinalResources} from './final-resource-bindings.mjs';
import {boundedJson} from './operator-client.mjs';
import {save} from './backup-lib.mjs';
import {verifyFinalSnapshotImage} from './final-snapshot-image.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const ACCOUNT=deploymentTarget.accountId,PREFIX='/client/v4/accounts/'+ACCOUNT,ORIGIN='https://api.cloudflare.com';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function privateBytes(file){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<2_000_000);return readFile(file);}
export async function verifyFinalAllocationReadiness(arg,{inspectSource=currentLocalCheckSource}={}){
 const root=path.resolve(arg),plan=await verifyPlannedCohort(root),source=await inspectSource();
 assert.equal(plan.candidateCommit,source.sourceCommit,'FINAL_ALLOCATION_SOURCE_CHANGED');assert.equal(plan.sourceSha256,source.sourceSha256,'FINAL_ALLOCATION_SOURCE_CHANGED');
 const release=JSON.parse(await privateBytes(root+'/release.json'));assert.equal(release.schema,'cloudflare-final-release-v1');
 assertFinalQualityEvidence(release,source.sourceCommit);
 assert(release.localChecks,'FINAL_ALLOCATION_LOCAL_CHECKS_REQUIRED');
 const checks=await verifyLocalCheckFiles(root+'/local-checks',source.sourceCommit,{expectedSha256:release.localChecks.evidenceSha256});assert.equal(checks.value.sourceSha256,source.sourceSha256);
 await verifyFinalSnapshotImage(root,plan,checks.value);
 const review=await privateBytes(root+'/independent-review.md');assert(review.toString('utf8').trim().length>0);assert.equal(sha(review),release.independentReview.evidenceSha256,'FINAL_ALLOCATION_REVIEW_CHANGED');
 assert.equal(release.cohort?.planSha256,sha(await privateBytes(root+'/cohort/plan.json')),'FINAL_ALLOCATION_PLAN_CHANGED');
 // A name in a mutable plan must never select an existing source resource.
 const rid=plan.target.rehearsalId;assert(UUID.test(rid));const name='shift-planner-restore-'+rid.replaceAll('-','').slice(0,12);
 assert.equal(plan.resources.database.name,name);assert.equal(plan.resources.bucket.name,name);assert.equal(plan.resources.queue.name,name+'-compute');
 assert.deepEqual(plan.resources.workers.names,[deploymentTarget.workerName,deploymentTarget.operatorWorkerName,name,name+'-operator']);
 return {root,plan,source,releaseSha256:sha(await privateBytes(root+'/release.json'))};
}
export async function wranglerToken(){
 requireDeploymentTarget();
 // Piped stdout is secret: never echo or persist it, even when the child fails.
 let output;try{output=await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{timeout:30_000,maxBuffer:64_000,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});}catch{throw Error('FINAL_ALLOCATION_AUTH_UNAVAILABLE');}
 let value;try{value=JSON.parse(output.stdout);}catch{throw Error('FINAL_ALLOCATION_AUTH_UNAVAILABLE');}
 assert(['oauth','api_token'].includes(value.type));assert(typeof value.token==='string'&&value.token.length>=20);return value.token;
}
export async function inspectFinalResourceAllocation(arg){
 const root=path.resolve(arg),id=path.basename(root);assert(UUID.test(id));assert.equal(root,path.resolve('.cache/final-cloudflare',id));
 assert.equal(await realpath(root),root);assert.equal((await lstat(root)).mode&0o077,0);
 const value=JSON.parse(await privateBytes(root+'/resources/allocation.json'));assert.equal(value.schema,'final-resource-allocation-v1');assert.equal(value.cohortId,id);assert(Array.isArray(value.requests)&&value.requests.length<=29);return value;
}
export async function allocateFinalResources(arg,{inspectSource=currentLocalCheckSource,getToken=wranglerToken,request=targetFetch}={}){
 const ready=await verifyFinalAllocationReadiness(arg,{inspectSource}),{root,plan,source}=ready,dir=root+'/resources';
 // mkdir is exclusive, including an old uncertain owner or manually recorded
 // observations. An existing directory cannot be repurposed for a new POST.
 await mkdir(dir,{mode:0o700});const lock=await open(dir+'/allocation.lock','wx',0o600);
 const state={schema:'final-resource-allocation-v1',cohortId:plan.cohortId,sourceCommit:source.sourceCommit,sourceSha256:source.sourceSha256,releaseSha256:ready.releaseSha256,state:'PREPARING',startedAt:Date.now(),requests:[],created:{},deployments:0,solverStarts:0};
 const persist=()=>save(dir+'/allocation.json',state);const deadline=state.startedAt+5*60_000;
 async function unchanged(){const now=await verifyFinalAllocationReadiness(root,{inspectSource});assert.deepEqual(now.source,source,'FINAL_ALLOCATION_SOURCE_CHANGED');assert.equal(now.releaseSha256,ready.releaseSha256,'FINAL_ALLOCATION_GATES_CHANGED');}
 let token;
 async function call(method,suffix,body){
  assert(['GET','POST'].includes(method));assert(suffix.startsWith('/')&&!suffix.includes('..'));assert(state.requests.length<29&&Date.now()<deadline,'FINAL_ALLOCATION_BUDGET_EXHAUSTED');await unchanged();
  const pathname=PREFIX+suffix,entry={method,path:pathname,body:body??null,stage:'DISPATCHED',at:Date.now()};state.requests.push(entry);await persist();
  const response=await request(ORIGIN+pathname,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(Math.min(30_000,Math.max(1,deadline-Date.now())))});
  const v={request:{method,origin:ORIGIN,path:pathname},status:response.status,response:await boundedJson(response,1_000_000)};
  const file='response-'+String(state.requests.length).padStart(2,'0')+'.json';await writeFile(dir+'/'+file,JSON.stringify(v)+'\n',{mode:0o600,flag:'wx'});
  entry.stage='RESPONSE_RECORDED';entry.status=v.status;entry.file=file;entry.sha256=sha(await privateBytes(dir+'/'+file));await persist();return v;
 }
 function success(v){assert.equal(v.status,200);assert.equal(v.response.success,true);assert(!v.response.errors?.length);return v.response.result;}
 async function absentInventory(kind,suffix,name){
  let total=null,seen=0;const ids=new Set();for(let page=1;page<=10;page++){
   const v=await call('GET',suffix+'?page='+page+(kind==='database'?'&per_page=100':'')),rows=success(v),i=v.response.result_info;
   assert(Array.isArray(rows)&&i&&i.page===page&&Number.isSafeInteger(i.total_count)&&i.total_count>=0&&Number.isSafeInteger(i.per_page)&&i.per_page>0);
   assert(rows.length<=i.per_page&&(!('count'in i)||i.count===rows.length));if(total===null)total=i.total_count;assert.equal(i.total_count,total,'FINAL_ALLOCATION_INVENTORY_CHANGED');
   for(const row of rows){const id=kind==='database'?row.uuid:row.queue_id;assert(kind==='database'?UUID.test(id):/^[a-f0-9]{32}$/.test(id));assert(!ids.has(id),'FINAL_ALLOCATION_INVENTORY_DUPLICATED');ids.add(id);assert.equal(typeof(kind==='database'?row.name:row.queue_name),'string');}
   assert(!rows.some(r=>(kind==='database'?r.name:r.queue_name)===name),'FINAL_ALLOCATION_NAME_ALREADY_EXISTS');seen+=rows.length;assert(seen<=total);
   if(seen===total)return;assert.equal(rows.length,i.per_page,'FINAL_ALLOCATION_INVENTORY_INCOMPLETE');
  }throw Error('FINAL_ALLOCATION_INVENTORY_LIMIT');
 }
 try{
  await persist();token=await getToken();assert(typeof token==='string'&&token.length>=20);
  await absentInventory('database','/d1/database',plan.resources.database.name);
  await absentInventory('queue','/queues',plan.resources.queue.name);
  // Read absence before POST: R2 create may otherwise return an existing bucket.
  for(const suffix of ['/r2/buckets/'+plan.resources.bucket.name,...plan.resources.workers.names.slice(2).map(name=>'/workers/scripts/'+name)]){
   const v=await call('GET',suffix);assert.equal(v.status,404,'FINAL_ALLOCATION_NAME_NOT_CONFIRMED_ABSENT');assert.equal(v.response.success,false);assert(v.response.errors?.length);
  }
  state.state='ALLOCATING';await persist();
  const definitions=[['database','/d1/database',{name:plan.resources.database.name}],['bucket','/r2/buckets',{name:plan.resources.bucket.name,storageClass:'Standard'}],['queue','/queues',{queue_name:plan.resources.queue.name}]];
  const observations=[];
  function identity(kind,value,id,verifyBindings=false){
   if(kind==='database'){assert.equal(value.uuid,id);assert.equal(value.name,plan.resources.database.name);}
   if(kind==='bucket')assert.equal(value.name,plan.resources.bucket.name);
   if(kind==='queue'){assert.equal(value.queue_id,id);assert.equal(value.queue_name,plan.resources.queue.name);if(verifyBindings){assert.equal(value.consumers_total_count,0);assert.equal(value.producers_total_count,0);assert(!value.consumers?.length&&!value.producers?.length);}}
  }
  for(const [kind,suffix,body]of definitions){
   const created=success(await call('POST',suffix,body));
   const id=kind==='database'?created.uuid:kind==='queue'?created.queue_id:created.name;
   if(kind==='database'){assert(UUID.test(id));assert.notEqual(id,deploymentTarget.databaseId);assert.notEqual(id,'00000000-0000-0000-0000-000000000000');assert.equal(created.name,body.name);}
   if(kind==='queue'){assert.match(id,/^[a-f0-9]{32}$/);assert.equal(created.queue_name,body.queue_name);}
   if(kind==='bucket')assert.equal(id,body.name);
   identity(kind,created,id);
   state.created[kind]={id,name:plan.resources[kind].name};await persist();
   const v=await call('GET',kind==='database'?suffix+'/'+id:kind==='bucket'?suffix+'/'+body.name:suffix+'/'+id);identity(kind,success(v),id,true);
   const file='resources/'+kind+'.json',raw=JSON.stringify(v)+'\n';await writeFile(root+'/'+file,raw,{mode:0o600,flag:'wx'});observations.push({kind,file,sha256:sha(raw)});
  }
  await unchanged();
  await writeFile(dir+'/index.json',JSON.stringify({schema:'final-resource-observation-index-v1',cohortId:plan.cohortId,sourceCommit:source.sourceCommit,accountId:ACCOUNT,planSha256:sha(await privateBytes(root+'/cohort/plan.json')),records:observations})+'\n',{mode:0o600,flag:'wx'});
  const bound=await recordedFinalResources(root,plan);assert.equal(bound.databaseId,state.created.database.id);assert.equal(bound.queueId,state.created.queue.id);
  state.state='ALLOCATED_OBSERVED_NOT_DEPLOYED_NOT_FROZEN';state.observationIndexSha256=bound.indexSha256;state.finishedAt=Date.now();await persist();return state;
 }catch{
  state.state='UNCERTAIN_NOT_USABLE';state.finishedAt=Date.now();await persist();throw Error('FINAL_RESOURCE_ALLOCATION_STOPPED_INSPECT_SAME_OWNER');
 }finally{token=undefined;await lock.close();await unlink(dir+'/allocation.lock');}
}
