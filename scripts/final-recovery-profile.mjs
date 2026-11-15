import {deploymentTarget} from './deployment-target.mjs';
// One frozen execution's isolated fictional target. No token read or network.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyFinalFreezeProof} from './final-freeze-proof.mjs';
import {assertFrozenFinalRelease} from './final-release-policy.mjs';
import {verifyLocalCheckFiles} from './final-local-check-proof.mjs';
import {finalImageReference} from './final-image-reference.mjs';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
export const FINAL_RECOVERY_KIND='owned-fictional-final-restore-rehearsal';
export const FINAL_SOURCE_DB=deploymentTarget.databaseId,FINAL_SOURCE_BUCKET=deploymentTarget.inputBucket;
export const FINAL_SOURCE_OPERATOR=deploymentTarget.operatorOrigin;
const ACCOUNT=deploymentTarget.accountId,SOURCE_BASE=deploymentTarget.appOrigin;
export async function privateFinalRecoveryBytes(file){
 assert.equal(await realpath(file),file,'FINAL_RECOVERY_SYMLINK');const s=await lstat(file);
 assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<2_000_000,'FINAL_RECOVERY_PRIVATE_FILE_REQUIRED');return readFile(file);
}
async function json(file){return JSON.parse(await privateFinalRecoveryBytes(file));}
function keys(value,allowed){assert(value&&Object.keys(value).every(k=>allowed.includes(k)),'FINAL_RECOVERY_UNEXPECTED_CONFIG');}
export async function readFinalRecoveryBinding(cohortRoot){
 const root=path.resolve(cohortRoot),id=path.basename(root);assert(UUID.test(id));assert.equal(root,path.resolve('.cache/final-cloudflare',id));
 assert.equal(await realpath(root),root);assert.equal((await lstat(root)).mode&0o077,0);
 const dir=root+'/recovery';assert.equal(await realpath(dir),dir);assert.equal((await lstat(dir)).mode&0o077,0);
 const info=await json(root+'/runtime.json');assert.equal(info.id,id);assert.equal(info.root,root);assert.equal(info.mode,'cloudflare');assert.equal(info.base,SOURCE_BASE);assert.equal(info.artifact,path.resolve('artifacts/final-cloudflare',id));
 const releaseBytes=await privateFinalRecoveryBytes(root+'/execution-release.json'),release=JSON.parse(releaseBytes),casesBytes=await privateFinalRecoveryBytes(root+'/execution-cases.json');
 assertFrozenFinalRelease(release,{sourceCommit:release.sourceCommit,casesSha256:sha(casesBytes),configSha256:release.configSha256,sourceInputSha256:sha(await privateFinalRecoveryBytes(info.artifact+'/source.json'))});
 const execution=await json(root+'/execution-binding.json');assert.equal(execution.id,id);assert.equal(execution.base,SOURCE_BASE);assert.equal(execution.releaseSha256,sha(releaseBytes));
 const owner=await json(root+'/acceptance/owner.json');assert.equal(owner.schema,'cloudflare-final-owner-v1');assert.equal(owner.sourceCommit,release.sourceCommit);assert.equal(owner.casesSha256,sha(JSON.stringify(JSON.parse(casesBytes))));assert(['RUNNING','STOPPED','CLOSED'].includes(owner.stage));
 let promotedImage=false;
 if(release.localChecks){const checks=await verifyLocalCheckFiles(root+'/execution-local-checks',release.sourceCommit,{expectedSha256:release.localChecks.evidenceSha256});assert.equal(checks.value.sourceSha256,release.cohort.sourceSha256,'FINAL_RECOVERY_CHECKED_SOURCE_CHANGED');promotedImage=Boolean(checks.value.imageArchive);}
 const sourceRoot=root+'/cohort/source';
 const report=await json(info.artifact+'/final-acceptance.json');assert.equal(report.id,id);assert.equal(report.sourceCommit,release.sourceCommit);assert.equal(report.stage,'FOUR_JOBS_VERIFIED','FINAL_RECOVERY_FOUR_JOBS_REQUIRED');
 for(const slot of ['J1','J2','J3','J4']){assert.equal(report.jobs[slot]?.validation,'VERIFIED');assert.equal(report.jobs[slot]?.stopped,true);assert.equal(report.jobs[slot]?.rows,slot==='J4'?3131:31);}
 const bindingBytes=await privateFinalRecoveryBytes(dir+'/binding.json'),binding=JSON.parse(bindingBytes);
 assert.equal(sha(bindingBytes),release.cohort.recoveryBindings.evidenceSha256,'FINAL_RECOVERY_BINDING_CHANGED');assert.equal(binding.schema,'final-recovery-binding-v1');assert.equal(binding.state,'FROZEN');assert.equal(binding.cohortId,id);assert.equal(binding.sourceCommit,release.sourceCommit);
 assert.deepEqual(binding.source,{databaseId:FINAL_SOURCE_DB,bucket:FINAL_SOURCE_BUCKET,appOrigin:SOURCE_BASE,operatorOrigin:FINAL_SOURCE_OPERATOR});
 const p=await json(dir+'/profile.json'),cfg=await json(dir+'/app.jsonc'),operator=await json(dir+'/operator.jsonc'),sourceOperator=await json(dir+'/source-operator.jsonc');
 for(const file of ['profile.json','app.jsonc','operator.jsonc','source-operator.jsonc'])assert.equal(sha(await privateFinalRecoveryBytes(dir+'/'+file)),binding.files[file],'FINAL_RECOVERY_CONFIG_CHANGED');
 const rid=p.rehearsalId;assert(UUID.test(rid));const name='shift-planner-restore-'+rid.replaceAll('-','').slice(0,12),appOrigin='https://'+name+'.'+deploymentTarget.workersDomain,operatorOrigin='https://'+name+'-operator.'+deploymentTarget.workersDomain;
 assert.equal(p.kind,FINAL_RECOVERY_KIND);assert.equal(p.mode,'remote');assert.equal(p.cohortRoot,root);assert.equal(p.configFile,dir+'/app.jsonc');assert.equal(p.databaseName,name);assert.equal(p.bucket,name);assert(UUID.test(p.databaseId));assert.notEqual(p.databaseId,FINAL_SOURCE_DB);
 keys(p,['kind','mode','cohortRoot','rehearsalId','databaseName','databaseId','bucket','configFile']);
 assert.deepEqual(binding.target,{rehearsalId:rid,databaseId:p.databaseId,databaseName:name,bucket:name,worker:name,queue:name+'-compute',appOrigin,operatorOrigin});
 keys(cfg,['$schema','name','account_id','main','compatibility_date','compatibility_flags','rules','vars','d1_databases','r2_buckets','observability','assets','containers','durable_objects','exports','queues','secrets','workers_dev','preview_urls']);
 assert.equal(cfg.account_id,ACCOUNT);assert.equal(cfg.name,name);assert.equal(cfg.main,sourceRoot+'/apps/api/src/poc-worker.ts');assert.equal(cfg.workers_dev,true);assert.equal(cfg.preview_urls,false);
 assert.equal(cfg.assets?.directory,root+'/cohort/assets','FINAL_RECOVERY_ASSET_PATH_CHANGED');
 assert.equal(cfg.vars.ENVIRONMENT,'poc');assert.equal(cfg.vars.AUTH_BASE_URL,appOrigin);assert.equal(cfg.vars.MAIL_DELIVERY,'disabled');assert.equal(cfg.vars.AI_EXPLANATIONS,'disabled');assert.equal(cfg.vars.RECOVERY_SECURITY_ID,rid);assert.equal(cfg.vars.OPTIMIZER_SOLVE_PROFILE,'mvp-joint-calendar-fallback-v1');
 assert.deepEqual(cfg.d1_databases,[{binding:'DB',database_name:name,database_id:p.databaseId,migrations_dir:sourceRoot+'/infra/migrations'}]);assert.deepEqual(cfg.r2_buckets,[{binding:'INPUTS',bucket_name:name}]);
 assert.deepEqual(cfg.containers,[{class_name:'OptimizerContainer',...(promotedImage?{name:name+'-optimizercontainer',image:finalImageReference(root)}:{image:sourceRoot+'/services/optimizer/Dockerfile',image_build_context:sourceRoot}),instance_type:'standard-2',max_instances:1}]);
 assert.deepEqual(cfg.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer'}]});assert.deepEqual(cfg.exports,{OptimizerContainer:{type:'durable-object',storage:'sqlite'}});
 assert.deepEqual(cfg.queues,{producers:[{binding:'COMPUTE_QUEUE',queue:name+'-compute'}],consumers:[{queue:name+'-compute',max_batch_size:1,max_batch_timeout:1,max_retries:3,max_concurrency:1}]});
 const principal='poc-final-recovery-'+rid.replaceAll('-','').slice(0,12);
 keys(operator,['$schema','name','account_id','main','compatibility_date','compatibility_flags','workers_dev','preview_urls','observability','vars','durable_objects','d1_databases','secrets']);
 assert.equal(operator.account_id,ACCOUNT);assert.equal(operator.name,name+'-operator');assert.equal(operator.main,sourceRoot+'/apps/operations/src/operator-worker.ts');assert.equal(operator.workers_dev,true);assert.equal(operator.preview_urls,false);
 assert.deepEqual(operator.vars,{OPERATOR_PRINCIPAL:principal,RECOVERY_SECURITY_ID:rid,RECOVERY_DATABASE_ID:p.databaseId});assert.deepEqual(operator.d1_databases,cfg.d1_databases);assert.deepEqual(operator.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:name}]});
 assert.equal(sourceOperator.main,sourceRoot+'/apps/operations/src/operator-worker.ts');
 assert.equal(sourceOperator.account_id,ACCOUNT);assert.equal(sourceOperator.name,deploymentTarget.operatorWorkerName);assert.equal(sourceOperator.vars.RECOVERY_SECURITY_ID,'');assert.equal(sourceOperator.vars.RECOVERY_DATABASE_ID,FINAL_SOURCE_DB);assert.equal(sourceOperator.d1_databases?.length,1);assert.equal(sourceOperator.d1_databases[0].binding,'DB');assert.equal(sourceOperator.d1_databases[0].database_id,FINAL_SOURCE_DB);assert.equal(sourceOperator.vars.OPERATOR_PRINCIPAL,'poc-operator');
 await verifyFinalFreezeProof(root,releaseBytes);
 return {root,dir,profileFile:dir+'/profile.json',p,cfg,operator,sourceOperator,principal,operatorBase:operatorOrigin,sourceOperatorBase:FINAL_SOURCE_OPERATOR,release,binding,bindingSha256:sha(bindingBytes)};
}
export async function validateFinalRecoveryProfile(manifest,profileFile,p){
 const c=await readFinalRecoveryBinding(p.cohortRoot);assert.equal(path.resolve(profileFile),c.profileFile);assert.deepEqual(p,c.p);
 assert.equal(manifest.source.mode,'remote');assert.equal(manifest.source.databaseId,FINAL_SOURCE_DB);assert.equal(manifest.source.bucket,FINAL_SOURCE_BUCKET);assert.equal(manifest.source.env,'poc');
 return {...p,flags:['--remote','--config',p.configFile],targetIdentity:{mode:'remote',cohortId:path.basename(c.root),sourceCommit:c.release.sourceCommit,bindingSha256:c.bindingSha256,configFile:p.configFile,configSha256:c.binding.files['app.jsonc']}};
}
export function assertFinalRecoveryCurrentSource(p){
 if(p.kind!==FINAL_RECOVERY_KIND)return;
 const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),dirty=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});
 assert.equal(head.status,0);assert.equal(dirty.status,0);assert.equal(dirty.stdout,'','FINAL_RECOVERY_DIRTY_SOURCE');
 assert.equal(head.stdout.trim(),p.targetIdentity?.sourceCommit,'FINAL_RECOVERY_SOURCE_CHANGED');
}
