import {deploymentTarget} from './deployment-target.mjs';
// Offline packaging only. PLANNED never authorizes allocation/deploy/solve.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {currentLocalCheckSource} from './final-local-check-proof.mjs';
import {save} from './backup-lib.mjs';
import {verifyFinalCohortSnapshot} from './final-cohort-snapshot.mjs';
import {finalImageReference} from './final-image-reference.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const UNALLOCATED_DATABASE='NOT_ALLOCATED';
const ACCOUNT=deploymentTarget.accountId;
async function privateBytes(file,limit=16_000_000){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<limit);return readFile(file);}
function trackedFiles(){const r=spawnSync('git',['ls-files','-z'],{encoding:'utf8',maxBuffer:8_000_000});assert.equal(r.status,0);return r.stdout.split('\0').filter(Boolean).sort();}
async function readRegular(file){const s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);assert.equal(await realpath(file),path.resolve(file));return readFile(file);}
function snapshotInfra(root,value){const rel=path.relative(process.cwd(),path.resolve('infra',value));assert(!rel.startsWith('..')&&!path.isAbsolute(rel));return path.join(root,'cohort/source',rel);}
export function renderFinalCohort(root,rehearsalId,infra,sourceOperator){
 assert.match(rehearsalId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
 const name='shift-planner-restore-'+rehearsalId.replaceAll('-','').slice(0,12),dir=root+'/recovery';
 const source={...structuredClone(infra),...structuredClone(infra.env.poc)};delete source.env;delete source.ai;delete source.$schema;
 source.account_id=ACCOUNT;source.main=snapshotInfra(root,source.main);source.workers_dev=true;source.preview_urls=false;
 source.secrets={required:['BETTER_AUTH_SECRET','POC_TOKEN']}; // Mail is disabled for this final session.
 source.assets.directory=root+'/cohort/assets';
 source.d1_databases=source.d1_databases.map(d=>({...d,migrations_dir:snapshotInfra(root,d.migrations_dir)}));
 source.containers=source.containers.map(c=>{const value={...c,name:c.name??`${source.name}-${c.class_name.toLowerCase()}-poc`,image:finalImageReference(root)};delete value.image_build_context;return value;});
 assert.equal(source.name,deploymentTarget.workerName);assert.equal(source.vars.MAIL_DELIVERY,'disabled');assert.equal(source.vars.AI_EXPLANATIONS,'disabled');assert.equal(source.vars.OPTIMIZER_SOLVE_PROFILE,'mvp-joint-calendar-fallback-v1');assert.equal(source.containers[0].max_instances,1);assert.equal(source.containers[0].instance_type,'standard-2');
 const operator=structuredClone(sourceOperator);delete operator.$schema;operator.main=snapshotInfra(root,operator.main);operator.d1_databases=structuredClone(source.d1_databases);
 assert.equal(operator.account_id,ACCOUNT);assert.equal(operator.name,deploymentTarget.operatorWorkerName);assert.equal(operator.vars.RECOVERY_DATABASE_ID,source.d1_databases[0].database_id);
 const app=structuredClone(source);app.name=name;delete app.triggers;
 app.containers=app.containers.map(c=>({...c,name:`${name}-${c.class_name.toLowerCase()}`}));
 app.vars={...app.vars,AUTH_BASE_URL:'https://'+name+'.'+deploymentTarget.workersDomain,RECOVERY_SECURITY_ID:rehearsalId};
 app.d1_databases=[{binding:'DB',database_name:name,database_id:UNALLOCATED_DATABASE,migrations_dir:source.d1_databases[0].migrations_dir}];app.r2_buckets=[{binding:'INPUTS',bucket_name:name}];
 app.queues={producers:[{binding:'COMPUTE_QUEUE',queue:name+'-compute'}],consumers:[{queue:name+'-compute',max_batch_size:1,max_batch_timeout:1,max_retries:3,max_concurrency:1}]};
 const targetOperator=structuredClone(operator);targetOperator.name=name+'-operator';targetOperator.vars={OPERATOR_PRINCIPAL:'poc-final-recovery-'+rehearsalId.replaceAll('-','').slice(0,12),RECOVERY_SECURITY_ID:rehearsalId,RECOVERY_DATABASE_ID:UNALLOCATED_DATABASE};targetOperator.d1_databases=structuredClone(app.d1_databases);targetOperator.durable_objects={bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:name}]};
 const profile={kind:'owned-fictional-final-restore-rehearsal',mode:'remote',cohortRoot:root,rehearsalId,databaseName:name,databaseId:UNALLOCATED_DATABASE,bucket:name,configFile:dir+'/app.jsonc'};
 return {source,operator,app,targetOperator,profile,resources:{database:{state:'UNALLOCATED',name,id:null},bucket:{state:'UNALLOCATED',name},queue:{state:'UNALLOCATED',name:name+'-compute'},workers:{state:'UNDEPLOYED',names:[source.name,operator.name,name,targetOperator.name]}},target:{rehearsalId,databaseId:null,databaseName:name,bucket:name,worker:name,queue:name+'-compute',appOrigin:app.vars.AUTH_BASE_URL,operatorOrigin:'https://'+name+'-operator.'+deploymentTarget.workersDomain}};
}
async function assetFiles(root){const result=[];async function visit(relative){for(const name of (await readdir(path.join(root,relative))).sort()){
 const rel=path.join(relative,name),file=path.join(root,rel),s=await lstat(file);assert(!s.isSymbolicLink());if(s.isDirectory())await visit(rel);else{assert(s.isFile()&&s.nlink===1);result.push(rel);}
 }}await visit('');assert(result.includes('index.html'));assert(result.length>1&&result.length<=1000);return result.sort();}
async function buildApp(){const r=await promisify(execFile)('npm',['run','build:app'],{timeout:120000,maxBuffer:8_000_000});return r.stdout+r.stderr;}
export async function prepareFinalCohort(arg,{inspectSource=currentLocalCheckSource,listSource=trackedFiles,build=buildApp,assetsDirectory=path.resolve('dist/app')}={}){
 const root=path.resolve(arg),id=path.basename(root);assert.match(id,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);assert.equal(root,path.resolve('.cache/final-cloudflare',id));assert.equal(await realpath(root),root);assert.equal((await lstat(root)).mode&0o077,0);
 const release=JSON.parse(await privateBytes(root+'/release.json')),info=JSON.parse(await privateBytes(root+'/runtime.json'));assert.equal(release.state,'DRAFT','FINAL_COHORT_DRAFT_REQUIRED');assert.equal(info.id,id);assert.equal(info.root,root);assert.equal(info.artifact,path.resolve('artifacts/final-cloudflare',id));assert.equal(info.mode,'cloudflare');assert.equal(info.base,deploymentTarget.appOrigin);
 const before=await inspectSource();assert.equal(release.candidateCommit,before.sourceCommit,'FINAL_COHORT_CANDIDATE_CHANGED');assert.equal(sha(await readFile('infra/wrangler.jsonc')),release.configSha256);const casesBytes=await readFile('docs/mvp/cloudflare-final-cases.json');assert.equal(sha(casesBytes),release.casesSha256);assert.deepEqual(release.limits,JSON.parse(casesBytes).limits,'FINAL_COHORT_LIMITS_CHANGED');
 const input=await privateBytes(info.artifact+'/source.json');assert.equal(sha(input),release.sourceInputSha256);
 const cohort=root+'/cohort',recovery=root+'/recovery';await mkdir(cohort,{mode:0o700});
 const write=(file,v)=>writeFile(file,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
 await write(cohort+'/preparation.json',{schema:'final-cohort-preparation-v1',state:'BUILD_DISPATCHED',cohortId:id,sourceCommit:before.sourceCommit,startedAt:Date.now()});
 try{
  await write(cohort+'/build-app.log',await build());assert.deepEqual(await inspectSource(),before,'FINAL_COHORT_SOURCE_CHANGED_DURING_BUILD');
  await mkdir(recovery,{mode:0o700});const rid=randomUUID(),configs=renderFinalCohort(root,rid,JSON.parse(await readFile('infra/wrangler.jsonc')),JSON.parse(await readFile('infra/operator-provision.jsonc')));
  const files=[['cohort/source-app.jsonc',configs.source],['recovery/source-operator.jsonc',configs.operator],['recovery/app.template.jsonc',configs.app],['recovery/operator.template.jsonc',configs.targetOperator],['recovery/profile.template.json',configs.profile]];
  for(const [file,value]of files)await write(root+'/'+file,value);
  // The enclosing cohort stays private; Docker COPY retains nonroot access.
  const records=[];let total=0;await mkdir(cohort+'/source',{mode:0o755});
  for(const file of (await listSource()).sort()){
   assert(!path.isAbsolute(file)&&!file.split('/').includes('..'));assert(!file.startsWith('.git/')&&!file.startsWith('.cache/')&&!file.startsWith('artifacts/'));
   const bytes=await readRegular(path.resolve(file));total+=bytes.length;assert(total<=128_000_000,'FINAL_COHORT_SOURCE_SIZE_LIMIT');
   const mode=(await lstat(file)).mode&0o111?0o755:0o644,dest=cohort+'/source/'+file;await mkdir(path.dirname(dest),{recursive:true,mode:0o755});await writeFile(dest,bytes,{mode,flag:'wx'});records.push({file,bytes:bytes.length,sha256:sha(bytes),mode});
  }
  assert.equal(sha(JSON.stringify(records.map(r=>[r.file,r.sha256]))),before.sourceSha256,'FINAL_COHORT_SOURCE_RECORDS_CHANGED');
  await mkdir(cohort+'/assets',{mode:0o700});const assets=[];let assetBytes=0;
  for(const file of await assetFiles(assetsDirectory)){const bytes=await readRegular(path.join(assetsDirectory,file)),dest=cohort+'/assets/'+file;assetBytes+=bytes.length;assert(assetBytes<=128_000_000,'FINAL_COHORT_ASSET_SIZE_LIMIT');await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await write(dest,bytes);assets.push({file,bytes:bytes.length,sha256:sha(bytes)});}
  const migrations=records.filter(r=>r.file.startsWith('infra/migrations/')&&r.file.endsWith('.sql'));assert.equal(migrations.length,34);assert(migrations.every((m,i)=>Number(m.file.split('/').at(-1).slice(0,4))===i+1));
  const optimizer=records.filter(r=>r.file.startsWith('services/optimizer/optimizer/')&&r.file.endsWith('.py'));
  await write(cohort+'/source-manifest.json',{schema:'final-source-snapshot-v1',...before,files:records});await write(cohort+'/asset-manifest.json',{schema:'final-assets-v1',sourceCommit:before.sourceCommit,files:assets});
  const planned={schema:'final-cohort-plan-v1',state:'PLANNED',cohortId:id,candidateCommit:before.sourceCommit,sourceSha256:before.sourceSha256,sourceInputSha256:release.sourceInputSha256,casesSha256:release.casesSha256,configSha256:release.configSha256,sourceSnapshotSha256:sha(await readFile(cohort+'/source-manifest.json')),assetsSha256:sha(await readFile(cohort+'/asset-manifest.json')),migrations,optimizer,configs:await Promise.all(files.map(async([file])=>({file,sha256:sha(await readFile(root+'/'+file))}))),resources:configs.resources,target:configs.target,limits:release.limits,approval:'PENDING',imageId:null,cloudflareCalls:0,solverStarts:0,tokensRead:0};
  assert.deepEqual(await inspectSource(),before,'FINAL_COHORT_SOURCE_CHANGED');await write(cohort+'/plan.json',planned);await save(cohort+'/preparation.json',{schema:'final-cohort-preparation-v1',state:'PLANNED',cohortId:id,sourceCommit:before.sourceCommit,finishedAt:Date.now()});return planned;
 }catch{await write(cohort+'/failure.json',{schema:'final-cohort-preparation-failure-v1',state:'FAILED',at:Date.now(),cloudflareCalls:0,tokensRead:0});throw Error('FINAL_COHORT_PREPARATION_FAILED_INSPECT_SAME_OWNER');}
}
export async function verifyPlannedCohort(root){
 root=path.resolve(root);const plan=JSON.parse(await privateBytes(root+'/cohort/plan.json'));assert.equal(root,path.resolve('.cache/final-cloudflare',plan.cohortId));assert.equal(plan.schema,'final-cohort-plan-v1');assert.equal(plan.state,'PLANNED');assert.equal(plan.approval,'PENDING');assert.equal(plan.imageId,null);assert.equal(plan.target.databaseId,null);assert.equal(plan.resources.database.id,null);assert.equal(plan.resources.database.state,'UNALLOCATED');
 await verifyFinalCohortSnapshot(root,{candidateCommit:plan.candidateCommit,sourceSnapshotSha256:plan.sourceSnapshotSha256,assetsSha256:plan.assetsSha256});
 const release=JSON.parse(await privateBytes(root+'/release.json'));assert.equal(release.state,'DRAFT');assert.equal(release.candidateCommit,plan.candidateCommit);assert.equal(release.casesSha256,plan.casesSha256);assert.equal(release.configSha256,plan.configSha256);assert.equal(release.sourceInputSha256,plan.sourceInputSha256);assert.deepEqual(release.limits,plan.limits);
 assert.equal(sha(await privateBytes(path.resolve('artifacts/final-cloudflare',plan.cohortId,'source.json'))),plan.sourceInputSha256,'FINAL_COHORT_INPUT_CHANGED');
 return plan;
}
