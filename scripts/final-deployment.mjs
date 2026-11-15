import {requireDeploymentTarget} from './deployment-target.mjs';
import {targetFetch} from './deployment-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
// One final deployment owner. Version observations do not issue an image proof,
// release freeze or acceptance. No automatic replay after a dispatched command.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,lstat,realpath,open,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {verifyFinalAllocationReadiness,inspectFinalResourceAllocation} from './final-resource-allocation.mjs';
import {recordedFinalResources} from './final-resource-bindings.mjs';
import {RECOVERY_PHASES} from './final-technical-recovery.mjs';
import {assertPocDeployReady,boundedPreflight} from './poc-deploy-guard.mjs';
import {currentLocalCheckSource} from './final-local-check-proof.mjs';
import {save} from './backup-lib.mjs';
import {finalImageTag,finalImageReference} from './final-image-reference.mjs';
import {imageLoadArgs,assertImageLoadOutput} from './final-snapshot-image.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function bytes(file,limit=2_000_000){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<limit);return readFile(file);}
const json=async file=>JSON.parse(await bytes(file));
export async function verifyFinalDeploymentReadiness(arg,{inspectSource=currentLocalCheckSource}={}){
 const ready=await verifyFinalAllocationReadiness(arg,{inspectSource}),{root,plan,source}=ready,release=await json(root+'/release.json');
 assert.equal(release.localRehearsal?.state,'VERIFIED','FINAL_DEPLOYMENT_REHEARSAL_REQUIRED');assert.equal(release.localRehearsal.sourceCommit,source.sourceCommit);
 const raw=await bytes(root+'/local-rehearsal.json');assert.equal(sha(raw),release.localRehearsal.evidenceSha256);const rehearsal=JSON.parse(raw);
 assert.equal(rehearsal.sourceCommit,source.sourceCommit);assert.equal(rehearsal.recovery?.state,'COMPLETE');assert.deepEqual(rehearsal.recovery.phases.map(p=>[p.name,p.stage]),RECOVERY_PHASES.map(name=>[name,'CONFIRMED']));assert.equal(rehearsal.recovery.originalReplayOrResolution,false);
 for(const key of ['sourceRuntimeClosed','targetRuntimeClosed','runtimeSecretsRetired','ownedImageTagRemoved','ownedListenersAbsent'])assert.equal(rehearsal[key],true);
 assert.equal(rehearsal.jobs?.length,4);rehearsal.jobs.forEach((j,i)=>{assert.equal(j.slot,'J'+(i+1));assert.equal(j.validation,'VERIFIED');assert.equal(j.stopped,true);assert.equal(j.rows,i===3?3131:31);assert.equal(j.attempt,i===1?2:1);});
 const checks=await json(root+'/local-checks/report.json');assert.equal(rehearsal.optimizerImageId,checks.imageId,'FINAL_DEPLOYMENT_IMAGE_CHANGED');
 assert(Array.isArray(rehearsal.logs)&&rehearsal.logs.length>0);for(const log of rehearsal.logs){assert(log.file.startsWith('artifacts/quality-audit/')&&!log.file.split('/').includes('..'));const file=path.resolve(log.file);assert.equal(await realpath(file),file);assert.equal(sha(await readFile(file)),log.sha256,'FINAL_DEPLOYMENT_REHEARSAL_LOG_CHANGED');}
 const allocation=await inspectFinalResourceAllocation(root);assert.equal(allocation.state,'ALLOCATED_OBSERVED_NOT_DEPLOYED_NOT_FROZEN');assert.equal(allocation.sourceCommit,source.sourceCommit);assert.equal(allocation.sourceSha256,source.sourceSha256);assert.equal(allocation.releaseSha256,ready.releaseSha256);
 const observed=await recordedFinalResources(root,plan);assert.equal(observed.indexSha256,allocation.observationIndexSha256);
 const materialized=await json(root+'/recovery/materialization.json');assert.equal(materialized.state,'MATERIALIZED_NOT_DEPLOYED_NOT_FROZEN');assert.equal(materialized.sourceCommit,source.sourceCommit);assert.equal(materialized.observationIndexSha256,observed.indexSha256);assert.equal(materialized.databaseId,observed.databaseId);
 for(const f of materialized.files)assert.equal(sha(await bytes(root+'/recovery/'+f.file)),f.sha256);
 const configs={source:root+'/cohort/source-app.jsonc',sourceOperator:root+'/recovery/source-operator.jsonc',target:root+'/recovery/app.jsonc',targetOperator:root+'/recovery/operator.jsonc'};
 const values=Object.fromEntries(await Promise.all(Object.entries(configs).map(async([k,f])=>[k,await json(f)])));
 const expectedApp=await json(root+'/recovery/app.template.jsonc'),expectedOperator=await json(root+'/recovery/operator.template.jsonc'),expectedProfile=await json(root+'/recovery/profile.template.json');
 expectedApp.d1_databases[0].database_id=observed.databaseId;expectedOperator.d1_databases[0].database_id=observed.databaseId;expectedOperator.vars.RECOVERY_DATABASE_ID=observed.databaseId;expectedProfile.databaseId=observed.databaseId;
 assert.deepEqual(values.target,expectedApp,'FINAL_DEPLOYMENT_TARGET_CONFIG_CHANGED');assert.deepEqual(values.targetOperator,expectedOperator);assert.deepEqual(await json(root+'/recovery/profile.json'),expectedProfile);
 assert.deepEqual(Object.values(values).map(c=>c.name),plan.resources.workers.names);
 for(const key of ['source','target']){assert.deepEqual(values[key].secrets,{required:['BETTER_AUTH_SECRET','POC_TOKEN']});assert.equal(values[key].vars.MAIL_DELIVERY,'disabled');assert.equal(values[key].vars.AI_EXPLANATIONS,'disabled');assert.equal(values[key].containers[0].image,finalImageReference(root));assert.equal(values[key].containers[0].image_build_context,undefined);}
 return {...ready,configs,values,materializationSha256:sha(await bytes(root+'/recovery/materialization.json')),allocationSha256:sha(await bytes(root+'/resources/allocation.json'))};
}
export function verifyDeployedVersion(worker,versionId,tag,deployments,version){
 assert(UUID.test(versionId));assert(Array.isArray(deployments)&&deployments.length>0);
 assert(deployments.every(d=>UUID.test(d.id)&&Number.isFinite(Date.parse(d.created_on))&&Array.isArray(d.versions)));
 const latest=[...deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];assert(Number.isFinite(Date.parse(latest.created_on)));
 assert.deepEqual(latest.versions,[{version_id:versionId,percentage:100}],'FINAL_DEPLOYMENT_NOT_CURRENT');assert.equal(version.id,versionId);assert.equal(version.annotations?.['workers/tag'],tag);
 return {worker,versionId,deploymentId:latest.id,tag};
}
async function runWrangler(args,{log,output,timeout,onSpawn}){
 await writeFile(output,'',{mode:0o600,flag:'wx'});let result;
 try{result=await new Promise((resolve,reject)=>{
  requireDeploymentTarget();const commandArgs=['node_modules/wrangler/bin/wrangler.js',...args];
  let recording=Promise.resolve();
  const child=execFile(process.execPath,commandArgs,{timeout,maxBuffer:16_000_000,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_OUTPUT_FILE_PATH:output,CLOUDFLARE_ACCOUNT_ID:deploymentTarget.accountId,CLOUDFLARE_API_BASE_URL:'https://api.cloudflare.com/client/v4',CF_API_BASE_URL:'https://api.cloudflare.com/client/v4',WRANGLER_API_ENVIRONMENT:'production',CLOUDFLARE_CONTAINER_REGISTRY:'registry.cloudflare.com',CLOUDFLARE_ENV:''}},async(error,stdout,stderr)=>{try{await recording;error?reject(Error('UNCONFIRMED')):resolve({stdout,stderr});}catch{reject(Error('UNCONFIRMED'));}});
  // DISPATCHED is already durable before spawn. Retain the exact owned PID.
  recording=onSpawn({pid:child.pid,command:process.execPath,args:commandArgs}).catch(()=>{child.kill();throw Error('SPAWN_RECORD_FAILED');});
  void recording.catch(()=>{});
 });}
 catch{await writeFile(log,JSON.stringify({state:'UNCONFIRMED',rawOutputRetained:false})+'\n',{mode:0o600,flag:'wx'});throw Error('FINAL_WRANGLER_COMMAND_UNCONFIRMED');}
 // CLI responses may contain secrets or signed URLs. Store only byte counts
 // and digests; parse the returned stdout in memory.
 await writeFile(log,JSON.stringify({state:'EXIT_ZERO',stdoutBytes:Buffer.byteLength(result.stdout),stdoutSha256:sha(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),stderrSha256:sha(result.stderr),rawOutputRetained:false})+'\n',{mode:0o600,flag:'wx'});
 return {stdout:result.stdout,output:await readFile(output,'utf8')};
}
export async function inspectFinalDeployment(arg){
 const root=path.resolve(arg),id=path.basename(root);assert(UUID.test(id));assert.equal(root,path.resolve('.cache/final-cloudflare',id));
 const state=await json(root+'/deployment/state.json');assert.equal(state.schema,'final-deployment-v1');assert.equal(state.cohortId,id);return state;
}
async function runOwnedDocker(args,{timeout,onSpawn}){
 let recording=Promise.resolve();return new Promise((resolve,reject)=>{const child=execFile('docker',args,{timeout,maxBuffer:1_000_000},async(error,stdout,stderr)=>{try{await recording;if(error){const e=Error('FINAL_DOCKER_UNCONFIRMED');e.missingImage=args[0]==='image'&&args[1]==='inspect'&&/No such image:/.test(stderr);throw e;}resolve({stdout});}catch(e){reject(e);}});recording=onSpawn({pid:child.pid,command:'docker',args}).catch(()=>{child.kill();throw Error('FINAL_DOCKER_RECEIPT_UNCONFIRMED');});void recording.catch(()=>{});});
}
export async function deployFinalCohort(arg,{inspectSource=currentLocalCheckSource,execute=runWrangler,executeDocker=runOwnedDocker,request=targetFetch}={}){
 const ready=await verifyFinalDeploymentReadiness(arg,{inspectSource}),{root,source,configs,values}=ready,dir=root+'/deployment';
 try{await lstat(dir);throw Error('FINAL_DEPLOYMENT_ALREADY_STARTED');}catch(error){if(error.code!=='ENOENT')throw error;}
 // Missing local input is repairable before claiming an execution owner.
 let sourceKeys=await json(root+'/recovery/source-secrets.json'),targetKeys;assert.deepEqual(Object.keys(sourceKeys).sort(),['OPERATOR_TOKEN','POC_TOKEN']);assert(Object.values(sourceKeys).every(v=>typeof v==='string'&&v.length>=32));await mkdir(dir,{mode:0o700});
 const lock=await open(dir+'/driver.lock','wx',0o600),state={schema:'final-deployment-v1',cohortId:ready.plan.cohortId,sourceCommit:source.sourceCommit,releaseSha256:ready.releaseSha256,state:'PREPARING',startedAt:Date.now(),phases:[],workerVersions:[],imageIdentity:'NOT_YET_VERIFIED',solverStarts:0};
 const persist=()=>save(dir+'/state.json',state),deadline=state.startedAt+15*60_000,tag='final-'+state.cohortId;
 async function unchanged(){const now=await verifyFinalDeploymentReadiness(root,{inspectSource});for(const key of ['releaseSha256','materializationSha256','allocationSha256'])assert.equal(now[key],ready[key]);}
 async function phase(name,run,summarize=v=>v){assert(Date.now()<deadline);await unchanged();const p={name,stage:'DISPATCHED',at:Date.now()};state.phases.push(p);await persist();const value=await run(p);p.result=summarize(value);p.stage='CONFIRMED';p.finishedAt=Date.now();assert(p.finishedAt<deadline);await persist();return value;}
 async function command(name,args){return phase(name,async p=>execute(args,{log:dir+'/'+name+'.private.log',output:dir+'/'+name+'.output.jsonl',timeout:Math.min(300_000,deadline-Date.now()),onSpawn:async process=>{p.process=process;await persist();}}),v=>({stdoutSha256:sha(v.stdout),outputSha256:sha(v.output)}));}
 async function docker(args){const p=state.phases.at(-1);return executeDocker(args,{timeout:Math.min(120000,deadline-Date.now()),onSpawn:async process=>{p.dockerProcesses??=[];p.dockerProcesses.push(process);await persist();}});}
 async function cleanupImageTags(imageId){for(const tag of [finalImageTag(root),finalImageReference(root)]){let exists=true;try{assert.equal((await docker(['image','inspect',tag,'--format','{{.Id}}'])).stdout.trim(),imageId);}catch(e){if(e.missingImage)exists=false;else throw e;}if(exists)await docker(['image','rm',tag]);}state.imageLocalTagsRemoved=true;await persist();}
 async function preflight(name){return phase(name,async()=>assertPocDeployReady(await boundedPreflight(await request(values.source.vars.AUTH_BASE_URL+'/__poc/deploy-preflight',{method:'POST',headers:{authorization:'Bearer '+sourceKeys.POC_TOKEN},redirect:'error',signal:AbortSignal.timeout(30_000)}))));}
 try{
  await persist();
  await preflight('source-before-image-promotion');
  const imageId=(await json(root+'/local-checks/report.json')).imageId;
  await phase('image-stage',async()=>{const loaded=await docker(imageLoadArgs(root));assertImageLoadOutput(loaded.stdout,imageId);assert.equal((await docker(['image','inspect',imageId,'--format','{{.Id}}'])).stdout.trim(),imageId);await docker(['tag',imageId,finalImageTag(root)]);return {imageId,registryRef:finalImageReference(root),rebuilt:false};});
  try{await command('image-push',['containers','push',finalImageTag(root),'--config',configs.source]);}finally{await cleanupImageTags(imageId);}
  await preflight('source-before-migration');
  targetKeys=Object.fromEntries(['BETTER_AUTH_SECRET','POC_TOKEN','OPERATOR_TOKEN'].map(k=>[k,randomBytes(32).toString('hex')]));
  for(const [file,value]of [['secrets.json',targetKeys],['app-secrets.json',{BETTER_AUTH_SECRET:targetKeys.BETTER_AUTH_SECRET,POC_TOKEN:targetKeys.POC_TOKEN}],['operator-secrets.json',{OPERATOR_TOKEN:targetKeys.OPERATOR_TOKEN}]])await writeFile(root+'/recovery/'+file,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  await writeFile(root+'/.dev.vars','POC_TOKEN='+sourceKeys.POC_TOKEN+'\n',{mode:0o600,flag:'wx'});
  await command('source-migrate',['d1','migrations','apply','DB','--remote','--config',configs.source]);
  const schema=await command('source-schema',['d1','execute','DB','--remote','--config',configs.source,'--json','--command','SELECT name FROM d1_migrations ORDER BY name']);
  const result=JSON.parse(schema.stdout);assert.equal(result.length,1);assert.equal(result[0].success,true);assert.deepEqual(result[0].results.map(r=>r.name),ready.plan.migrations.map(m=>path.basename(m.file)).sort());
  for(const role of ['source','sourceOperator','target','targetOperator']){
   if(role==='source'||role==='sourceOperator')await preflight(role+'-before-deploy');
   const cfg=configs[role],worker=values[role].name,args=['deploy','--config',cfg,'--no-autoconfig','--tag',tag,'--message','final source '+source.sourceCommit];
   if(role==='target'||role==='targetOperator')args.push('--secrets-file',root+'/recovery/'+(role==='target'?'app':'operator')+'-secrets.json');
   const deployed=await command(role+'-deploy',args),records=deployed.output.trim().split('\n').filter(Boolean).map(JSON.parse).filter(v=>v.type==='deploy');assert.equal(records.length,1);assert.equal(records[0].worker_name,worker);const versionId=records[0].version_id;assert(UUID.test(versionId));
   const listed=await command(role+'-deployments',['deployments','list','--config',cfg,'--json']),viewed=await command(role+'-version',['versions','view',versionId,'--config',cfg,'--json']);
   state.workerVersions.push(verifyDeployedVersion(worker,versionId,tag,JSON.parse(listed.stdout),JSON.parse(viewed.stdout)));await persist();
  }
  await unchanged();state.state='WORKER_VERSIONS_OBSERVED_IMAGE_PENDING_NOT_FROZEN';state.finishedAt=Date.now();await persist();return state;
 }catch{state.state='UNCERTAIN_NOT_USABLE';state.finishedAt=Date.now();await persist();throw Error('FINAL_DEPLOYMENT_STOPPED_INSPECT_SAME_OWNER');}
 finally{sourceKeys=undefined;targetKeys=undefined;await lock.close();await unlink(dir+'/driver.lock');}
}
