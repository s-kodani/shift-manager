import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,readdir,lstat,chmod} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {prepareFinalCohort,renderFinalCohort,verifyPlannedCohort,UNALLOCATED_DATABASE} from '../../scripts/final-cohort-plan.mjs';
import {finalImageReference} from '../../scripts/final-image-reference.mjs';
import {loadCloudFinalEnvironment} from '../../scripts/final-run-environment.mjs';
import {finalCohortFixture as fixture} from './fixtures/final-cohort-plan.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('offline cohort captures code/migrations/assets and four configs but cannot allocate, freeze, read token or enter remote prepare',async()=>fixture(async f=>{
 let calls=0;const prior=globalThis.fetch;globalThis.fetch=()=>{calls++;throw Error('UNEXPECTED_HTTP');};
 try{
  const plan=await prepareFinalCohort(f.root,f.options);assert.equal(plan.state,'PLANNED');assert.equal(plan.approval,'PENDING');assert.equal(plan.imageId,null);assert.equal(plan.resources.database.id,null);assert.equal(plan.target.databaseId,null);assert.equal(plan.migrations.length,34);assert(plan.optimizer.length>0);
  await verifyPlannedCohort(f.root);assert.equal(JSON.parse(await readFile(f.root+'/cohort/preparation.json')).state,'PLANNED');
  assert.equal(JSON.parse(await readFile(f.root+'/recovery/app.template.jsonc')).d1_databases[0].database_id,UNALLOCATED_DATABASE);
  assert.equal((await lstat(f.root+'/cohort/plan.json')).mode&0o077,0);assert.equal((await lstat(f.root+'/cohort/source-manifest.json')).mode&0o077,0);
  const manifest=JSON.parse(await readFile(f.root+'/cohort/source-manifest.json'));for(const entry of manifest.files)assert.equal(sha(await readFile(f.root+'/cohort/source/'+entry.file)),entry.sha256);
  assert.equal(JSON.parse(await readFile(f.root+'/release.json')).state,'DRAFT');await assert.rejects(loadCloudFinalEnvironment('prepare',f.root),/FINAL_RELEASE_NOT_FROZEN/);assert.equal(calls,0);
  await assert.rejects(prepareFinalCohort(f.root,f.options),e=>e.code==='EEXIST');
  await writeFile(f.root+'/cohort/assets/assets/app.js','changed',{mode:0o600});await assert.rejects(verifyPlannedCohort(f.root),/FINAL_COHORT_FILE_CHANGED/);
 }finally{globalThis.fetch=prior;}
}));
test('changed candidate and input stop before build; failed or changing build keeps a failed owner and does not create PLANNED output',async()=>fixture(async f=>{
 f.release.candidateCommit='2'.repeat(40);await f.write(f.root+'/release.json',f.release);await assert.rejects(prepareFinalCohort(f.root,f.options),/FINAL_COHORT_CANDIDATE_CHANGED/);
 f.release.candidateCommit=f.source.sourceCommit;f.release.limits.normalJobs=5;await f.write(f.root+'/release.json',f.release);await assert.rejects(prepareFinalCohort(f.root,f.options),/FINAL_COHORT_LIMITS_CHANGED/);f.release.limits.normalJobs=4;await f.write(f.root+'/release.json',f.release);
 await writeFile(f.artifact+'/source.json','changed');await assert.rejects(prepareFinalCohort(f.root,f.options));await writeFile(f.artifact+'/source.json','{}');let n=0;await assert.rejects(prepareFinalCohort(f.root,{...f.options,inspectSource:async()=>++n===1?f.source:{...f.source,sourceSha256:'3'.repeat(64)}}),/FINAL_COHORT_PREPARATION_FAILED/);
 assert.equal(JSON.parse(await readFile(f.root+'/cohort/failure.json')).state,'FAILED');assert.equal((await readdir(f.root+'/cohort')).includes('plan.json'),false);await assert.rejects(prepareFinalCohort(f.root,f.options),e=>e.code==='EEXIST');
}));
test('source and recovery configs keep ownership, disabled providers, one container and separate DB/Queue; recovery does not activate cron',async()=>{
 const root=path.resolve('.cache/final-cloudflare',randomUUID()),c=renderFinalCohort(root,randomUUID(),JSON.parse(await readFile('infra/wrangler.jsonc')),JSON.parse(await readFile('infra/operator-provision.jsonc')));
 assert.equal(c.source.vars.AI_EXPLANATIONS,'disabled');assert.equal(c.source.ai,undefined);assert.equal(c.source.env,undefined);assert.equal(c.source.main,root+'/cohort/source/apps/api/src/poc-worker.ts');assert.equal(c.source.containers[0].image_build_context,undefined);assert.equal(c.source.containers[0].image,finalImageReference(root));assert.equal(c.app.containers[0].image,c.source.containers[0].image);assert.equal(c.app.d1_databases[0].migrations_dir,root+'/cohort/source/infra/migrations');assert.equal(c.app.triggers,undefined);assert.equal(c.source.containers[0].instance_type,'standard-2');assert.equal(c.app.containers[0].max_instances,1);assert.notEqual(c.app.queues.producers[0].queue,c.source.queues.producers[0].queue);assert.notEqual(c.app.r2_buckets[0].bucket_name,c.source.r2_buckets[0].bucket_name);assert.equal(c.targetOperator.durable_objects.bindings[0].script_name,c.app.name);assert.equal(c.targetOperator.vars.RECOVERY_DATABASE_ID,UNALLOCATED_DATABASE);assert.equal(c.profile.databaseId,UNALLOCATED_DATABASE);
});
test('the source keeps its existing poc Container application while the target owns a distinct name',async()=>{
 const root=path.resolve('.cache/final-cloudflare',randomUUID()),infra=JSON.parse(await readFile('infra/wrangler.jsonc')),operator=JSON.parse(await readFile('infra/operator-provision.jsonc')),c=renderFinalCohort(root,randomUUID(),infra,operator);
 assert.equal(c.source.containers[0].name,'shift-manager-example-optimizercontainer-poc');assert.equal(c.app.containers[0].name,c.app.name+'-optimizercontainer');assert.notEqual(c.source.containers[0].name,c.app.containers[0].name);
 infra.env.poc.containers[0].name='explicit-existing-application';const explicit=renderFinalCohort(root,randomUUID(),infra,operator);assert.equal(explicit.source.containers[0].name,'explicit-existing-application');assert.notEqual(explicit.app.containers[0].name,explicit.source.containers[0].name);
});
for(const fault of ['file','directory'])test('nonroot COPY modes are preserved under private parents and '+fault+' mode tampering is refused',async()=>fixture(async f=>{
 await prepareFinalCohort(f.root,f.options);const manifest=JSON.parse(await readFile(f.root+'/cohort/source-manifest.json')),entry=manifest.files.find(r=>r.file==='services/optimizer/optimizer/__init__.py');assert.equal(entry.mode,0o644);assert.equal((await lstat(f.root)).mode&0o077,0);assert.equal((await lstat(f.root+'/cohort')).mode&0o077,0);assert.equal((await lstat(f.root+'/cohort/source/services/optimizer/optimizer')).mode&0o777,0o755);assert.equal((await lstat(f.root+'/cohort/source/'+entry.file)).mode&0o777,0o644);await verifyPlannedCohort(f.root);
 await chmod(f.root+'/cohort/source/'+(fault==='file'?entry.file:'services/optimizer/optimizer'),fault==='file'?0o600:0o700);await assert.rejects(verifyPlannedCohort(f.root),/FINAL_COHORT_SOURCE_MODE_CHANGED/);
}));
