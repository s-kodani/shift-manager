import {deploymentTarget} from './deployment-target.mjs';
// Local materialization of recorded resource observations only. This neither
// verifies Cloudflare live state nor allocates, deploys, approves or freezes.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,lstat,realpath,open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyPlannedCohort,UNALLOCATED_DATABASE} from './final-cohort-plan.mjs';
import {currentLocalCheckSource} from './final-local-check-proof.mjs';
import {save} from './backup-lib.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),ACCOUNT=deploymentTarget.accountId,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function bytes(file){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<1_000_000);return readFile(file);}
export async function recordedFinalResources(root,plan){
 const indexBytes=await bytes(root+'/resources/index.json'),index=JSON.parse(indexBytes);assert.equal(index.schema,'final-resource-observation-index-v1');assert.equal(index.cohortId,plan.cohortId);assert.equal(index.sourceCommit,plan.candidateCommit);assert.equal(index.accountId,ACCOUNT);assert.equal(index.planSha256,sha(await bytes(root+'/cohort/plan.json')));assert.deepEqual(index.records.map(r=>r.kind),['database','bucket','queue']);
 const values={};for(const r of index.records){assert.equal(r.file,'resources/'+r.kind+'.json');const raw=await bytes(root+'/'+r.file);assert.equal(sha(raw),r.sha256,'FINAL_RESOURCE_EVIDENCE_CHANGED');const v=JSON.parse(raw);assert.equal(v.status,200);assert.equal(v.response.success,true);assert(!v.response.errors||v.response.errors.length===0);values[r.kind]=v;}
 const db=values.database.response.result,queue=values.queue.response.result,bucket=values.bucket.response.result;assert(UUID.test(db.uuid),'FINAL_RESOURCE_DATABASE_ID_REQUIRED');assert.notEqual(db.uuid,deploymentTarget.databaseId);assert.notEqual(db.uuid,'00000000-0000-0000-0000-000000000000');assert.match(queue.queue_id,/^[a-f0-9]{32}$/,'FINAL_RESOURCE_QUEUE_ID_REQUIRED');
 assert.equal(db.name,plan.resources.database.name);assert.equal(bucket.name,plan.resources.bucket.name);assert.equal(queue.queue_name,plan.resources.queue.name);assert.equal(queue.consumers_total_count,0,'FINAL_RESOURCE_QUEUE_ALREADY_BOUND');assert.equal(queue.producers_total_count,0,'FINAL_RESOURCE_QUEUE_ALREADY_BOUND');assert(!queue.consumers?.length&&!queue.producers?.length,'FINAL_RESOURCE_QUEUE_ALREADY_BOUND');
 const paths={database:'/client/v4/accounts/'+ACCOUNT+'/d1/database/'+db.uuid,bucket:'/client/v4/accounts/'+ACCOUNT+'/r2/buckets/'+bucket.name,queue:'/client/v4/accounts/'+ACCOUNT+'/queues/'+queue.queue_id};
 for(const [kind,v]of Object.entries(values))assert.deepEqual(v.request,{method:'GET',origin:'https://api.cloudflare.com',path:paths[kind]},'FINAL_RESOURCE_OBSERVATION_SCOPE_CHANGED');
 return {databaseId:db.uuid,queueId:queue.queue_id,indexSha256:sha(indexBytes),records:index.records};
}
export async function materializeFinalResourceBindings(arg,{inspectSource=currentLocalCheckSource}={}){
 const root=path.resolve(arg),plan=await verifyPlannedCohort(root),before=await inspectSource();assert.equal(plan.candidateCommit,before.sourceCommit,'FINAL_RESOURCE_SOURCE_CHANGED');assert.equal(plan.sourceSha256,before.sourceSha256,'FINAL_RESOURCE_SOURCE_CHANGED');
 const observed=await recordedFinalResources(root,plan),dir=root+'/recovery',file=dir+'/materialization.json',lock=await open(dir+'/materialization.lock','wx',0o600);let owns=false;
 try{
  const marker=await open(file,'wx',0o600);await marker.close();owns=true;await save(file,{schema:'final-resource-materialization-v1',state:'PREPARING_NOT_USABLE',cohortId:plan.cohortId,sourceCommit:before.sourceCommit});
  const app=JSON.parse(await bytes(dir+'/app.template.jsonc')),operator=JSON.parse(await bytes(dir+'/operator.template.jsonc')),profile=JSON.parse(await bytes(dir+'/profile.template.json'));
  assert.equal(app.d1_databases[0].database_id,UNALLOCATED_DATABASE);assert.equal(operator.d1_databases[0].database_id,UNALLOCATED_DATABASE);assert.equal(operator.vars.RECOVERY_DATABASE_ID,UNALLOCATED_DATABASE);assert.equal(profile.databaseId,UNALLOCATED_DATABASE);
  app.d1_databases[0].database_id=observed.databaseId;operator.d1_databases[0].database_id=observed.databaseId;operator.vars.RECOVERY_DATABASE_ID=observed.databaseId;profile.databaseId=observed.databaseId;
  const records=[];for(const [name,value]of [['app.jsonc',app],['operator.jsonc',operator],['profile.json',profile]]){const raw=JSON.stringify(value,null,2)+'\n';await writeFile(dir+'/'+name,raw,{mode:0o600,flag:'wx'});records.push({file:name,sha256:sha(raw)});}
  assert.deepEqual(await inspectSource(),before,'FINAL_RESOURCE_SOURCE_CHANGED');assert.deepEqual(await recordedFinalResources(root,plan),observed,'FINAL_RESOURCE_EVIDENCE_CHANGED');await verifyPlannedCohort(root);for(const r of records)assert.equal(sha(await bytes(dir+'/'+r.file)),r.sha256,'FINAL_RESOURCE_OUTPUT_CHANGED');
  const result={schema:'final-resource-materialization-v1',state:'MATERIALIZED_NOT_DEPLOYED_NOT_FROZEN',cohortId:plan.cohortId,sourceCommit:before.sourceCommit,sourceSha256:before.sourceSha256,observationIndexSha256:observed.indexSha256,databaseId:observed.databaseId,queueId:observed.queueId,target:{...plan.target,databaseId:observed.databaseId},files:records,independentReview:'PENDING',cloudflareLiveStateVerified:false,cloudflareCalls:0,solverStarts:0,tokensRead:0};await save(file,result);return result;
 }catch{if(owns)await save(file,{schema:'final-resource-materialization-v1',state:'FAILED_NOT_USABLE',cohortId:plan.cohortId,sourceCommit:before.sourceCommit,cloudflareCalls:0});throw Error('FINAL_RESOURCE_MATERIALIZATION_STOPPED_INSPECT_SAME_OWNER');}
 finally{await lock.close();await unlink(dir+'/materialization.lock');}
}
