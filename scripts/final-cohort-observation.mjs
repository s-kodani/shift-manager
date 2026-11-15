import {targetFetch} from './deployment-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
// Read-only final-session observation. No allocation/deployment/start/freeze.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyFinalDeploymentReadiness,inspectFinalDeployment,verifyDeployedVersion} from './final-deployment.mjs';
import {currentLocalCheckSource} from './final-local-check-proof.mjs';
import {wranglerToken} from './final-resource-allocation.mjs';
import {boundedJson} from './operator-client.mjs';
import {boundedPreflight,assertPocDeployReady} from './poc-deploy-guard.mjs';
import {save} from './backup-lib.mjs';
const ACCOUNT=deploymentTarget.accountId,API='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT;
const sha=b=>createHash('sha256').update(b).digest('hex'),HEX32=/^[a-f0-9]{32}$/,DIGEST=/^sha256:[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function json(file){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<2_000_000);return JSON.parse(await readFile(file));}
export function verifyWorkerBindings(version,cfg){
 const bindings=version.resources?.bindings;assert(Array.isArray(bindings));assert.equal(new Set(bindings.map(b=>b.name)).size,bindings.length);
 const one=(name,type)=>{const b=bindings.find(b=>b.name===name);assert(b&&b.type===type,'FINAL_REMOTE_BINDING_CHANGED');return b;};
 const db=one('DB','d1');assert.equal(db.database_id??db.id,cfg.d1_databases[0].database_id);if(db.database_id&&db.id)assert.equal(db.database_id,db.id);
 const solver=one('SOLVER','durable_object_namespace');assert(HEX32.test(solver.namespace_id));assert.equal(solver.class_name,'OptimizerContainer');assert.equal(solver.script_name??cfg.name,cfg.durable_objects.bindings[0].script_name??cfg.name);
 for(const [name,text]of Object.entries(cfg.vars))assert.equal(one(name,'plain_text').text,text,'FINAL_REMOTE_VAR_CHANGED');
 const expected=['DB','SOLVER',...Object.keys(cfg.vars)];
 if(cfg.r2_buckets){assert.equal(one('INPUTS','r2_bucket').bucket_name,cfg.r2_buckets[0].bucket_name);assert.equal(one('COMPUTE_QUEUE','queue').queue_name,cfg.queues.producers[0].queue);one('ASSETS','assets');expected.push('INPUTS','COMPUTE_QUEUE','ASSETS');}
 assert.deepEqual(bindings.filter(b=>b.type!=='secret_text').map(b=>b.name).sort(),expected.sort(),'FINAL_REMOTE_UNEXPECTED_BINDING');
 for(const name of cfg.secrets.required)one(name,'secret_text');
 // Return only named resource identities, never secret or unrelated values.
 return {worker:cfg.name,databaseId:db.database_id??db.id,namespaceId:solver.namespace_id,solverScript:solver.script_name??cfg.name,...cfg.r2_buckets?{bucket:cfg.r2_buckets[0].bucket_name,queue:cfg.queues.producers[0].queue}:{}};
}
function registryReference(ref){assert.match(ref,/^registry\.cloudflare\.com\/[A-Za-z0-9_./-]+(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/);assert(!ref.split('/').includes('..'));assert(ref.includes('@')||/:\w[^/]*$/.test(ref),'FINAL_REGISTRY_UNVERSIONED_IMAGE');assert(!ref.split('@')[0].endsWith(':latest'),'FINAL_REGISTRY_UNVERSIONED_IMAGE');return ref.split('@')[0];}
export async function inspectRegistryImage(ref,expectedImageId,execute){
 const repository=registryReference(ref);assert(DIGEST.test(expectedImageId));
 const descriptor=JSON.parse(await execute(['buildx','imagetools','inspect',ref,'--format','{{json .Manifest}}']));assert(DIGEST.test(descriptor.digest));
 if(ref.includes('@'))assert.equal(ref.split('@')[1],descriptor.digest);
 const pinned=repository+'@'+descriptor.digest;let manifest=JSON.parse(await execute(['manifest','inspect',pinned])),selected=descriptor.digest;
 assert.equal(manifest.schemaVersion,2);
 if(manifest.manifests){const candidates=manifest.manifests.filter(m=>m.platform?.os==='linux'&&m.platform?.architecture==='amd64');assert.equal(candidates.length,1,'FINAL_REGISTRY_AMD64_NOT_UNIQUE');selected=candidates[0].digest;assert(DIGEST.test(selected));manifest=JSON.parse(await execute(['manifest','inspect',repository+'@'+selected]));}
 assert.equal(manifest.schemaVersion,2);assert.equal(manifest.config?.digest,expectedImageId,'FINAL_REGISTRY_IMAGE_CONFIG_CHANGED');
 const config=JSON.parse(await execute(['buildx','imagetools','inspect',repository+'@'+selected,'--format','{{json .Image}}']));assert.equal(config.os,'linux');assert.equal(config.architecture,'amd64');
 return {imageRef:ref,registryDigest:descriptor.digest,platformManifestDigest:selected,imageId:expectedImageId,os:'linux',architecture:'amd64'};
}
export function verifyContainerApplication(app,namespaceId){
 assert(UUID.test(app.id));assert.equal(app.account_id,ACCOUNT);assert.equal(app.durable_objects?.namespace_id,namespaceId);assert.equal(app.scheduling_policy,'default','FINAL_CONTAINER_POLICY_NOT_VERIFIED');assert.equal(app.max_instances,1);
 // The API returns resolved resources rather than the Wrangler tier label.
 const c=app.configuration;assert.equal(c?.vcpu,1);assert.equal(c.memory_mib,6144);assert.equal(c.disk?.size_mb,12000);if(c.instance_type!==undefined)assert.equal(c.instance_type,'standard-2');registryReference(c.image);
 return {applicationId:app.id,namespaceId,imageRef:c.image,instanceType:'standard-2',observedResources:{vcpu:c.vcpu,memoryMiB:c.memory_mib,diskMB:c.disk.size_mb},maxInstances:1};
}
export async function readCurrentContainerApplication(id,namespaceId,read,{deadline,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let attempt=0;attempt<7;attempt++){
  assert(now()<deadline,'FINAL_CONTAINER_ROLLOUT_DEADLINE');const detail=await read(id);assert.equal(detail.id,id,'FINAL_CONTAINER_ID_CHANGED');const proof=verifyContainerApplication(detail,namespaceId);
  if(detail.active_rollout_id==null)return proof;
  assert(UUID.test(detail.active_rollout_id),'FINAL_CONTAINER_ROLLOUT_ID_INVALID');assert(attempt<6,'FINAL_CONTAINER_ROLLOUT_PENDING');const delay=Math.min(5000,deadline-now());assert(delay>0,'FINAL_CONTAINER_ROLLOUT_DEADLINE');await wait(delay);
 }
}
export function verifyQueueOwner(queue,name,worker){
 assert.equal(queue.queue_name,name);assert.equal(queue.consumers_total_count,1);assert.equal(queue.producers_total_count,1);assert.equal(queue.consumers?.length,1);assert.equal(queue.producers?.length,1);const consumer=queue.consumers[0];assert.equal(consumer.script??consumer.script_name,worker);if(consumer.script&&consumer.script_name)assert.equal(consumer.script,consumer.script_name);assert.equal(queue.producers[0].script,worker);
 const settings=queue.consumers[0].settings;assert.equal(settings?.batch_size,1);assert.equal(settings.max_concurrency,1);assert.equal(settings.max_retries,3);assert.equal(settings.max_wait_time_ms,1000);return {name,worker};
}
async function bodyBytes(response,limit){const reader=response.body?.getReader();assert(reader);let size=0;const chunks=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('FINAL_OBSERVATION_BODY_LIMIT');}chunks.push(value);}return Buffer.concat(chunks);}
async function dockerInspect(args){try{const r=await promisify(execFile)('docker',args,{timeout:30_000,maxBuffer:1_000_000});return r.stdout;}catch{throw Error('FINAL_REGISTRY_READ_UNCONFIRMED');}}
export async function observeFinalCohort(arg,{inspectSource=currentLocalCheckSource,getToken=wranglerToken,request=targetFetch,registry=dockerInspect}={}){
 const ready=await verifyFinalDeploymentReadiness(arg,{inspectSource}),{root,source,plan,values}=ready,deployment=await inspectFinalDeployment(root),deploymentSha=sha(await readFile(root+'/deployment/state.json'));
 assert.equal(deployment.state,'WORKER_VERSIONS_OBSERVED_IMAGE_PENDING_NOT_FROZEN');assert.equal(deployment.sourceCommit,source.sourceCommit);assert.equal(deployment.releaseSha256,ready.releaseSha256);assert(deployment.phases.every(p=>p.stage==='CONFIRMED'));assert.deepEqual(deployment.workerVersions.map(v=>v.worker),plan.resources.workers.names);
 assert(deployment.workerVersions.every(v=>UUID.test(v.versionId)));
 const dir=root+'/observation';await mkdir(dir,{mode:0o700});const state={schema:'final-cohort-observation-owner-v1',cohortId:plan.cohortId,state:'OBSERVING',startedAt:Date.now(),requests:[],registryCommands:[],solverStarts:0};const deadline=state.startedAt+5*60_000,persist=()=>save(dir+'/state.json',state);let token,sourceKeys;
 async function unchanged(){const now=await verifyFinalDeploymentReadiness(root,{inspectSource});assert.equal(now.releaseSha256,ready.releaseSha256);assert.equal(now.materializationSha256,ready.materializationSha256);assert.equal(sha(await readFile(root+'/deployment/state.json')),deploymentSha);}
 async function http(url,headers,method='GET'){
  assert(state.requests.length<40&&Date.now()<deadline);await unchanged();assert(url.startsWith(API+'/')||url.startsWith(deploymentTarget.appOrigin+'/'));const record={url,method,stage:'DISPATCHED'};state.requests.push(record);await persist();
  const response=await request(url,{method,headers,redirect:'error',signal:AbortSignal.timeout(Math.min(30_000,Math.max(1,deadline-Date.now())))});return {response,record};
 }
 async function api(suffix){const {response,record}=await http(API+suffix,{authorization:'Bearer '+token});assert.equal(response.status,200);const body=await boundedJson(response,1_000_000);assert.equal(body.success,true);assert(!body.errors?.length);record.stage='CONFIRMED';await persist();return body;}
 async function inspect(args){assert(state.registryCommands.length<8&&Date.now()<deadline);state.registryCommands.push({args,stage:'DISPATCHED'});await persist();const value=await registry(args);assert(Buffer.byteLength(value)<1_000_000);state.registryCommands.at(-1).stage='CONFIRMED';await persist();return value;}
 try{
  await persist();token=await getToken();assert(typeof token==='string'&&token.length>=20);sourceKeys=await json(root+'/recovery/source-secrets.json');assert(typeof sourceKeys.POC_TOKEN==='string'&&sourceKeys.POC_TOKEN.length>=32);const workers=[],rawVersions={};
  for(const [role,cfg]of Object.entries(values)){
   const expected=deployment.workerVersions.find(v=>v.worker===cfg.name),listed=(await api('/workers/scripts/'+cfg.name+'/deployments')).result.deployments,version=(await api('/workers/scripts/'+cfg.name+'/versions/'+expected.versionId)).result;
   const v=verifyDeployedVersion(cfg.name,expected.versionId,'final-'+plan.cohortId,listed,version);workers.push({...v,role,...verifyWorkerBindings(version,cfg)});rawVersions[role]=version;
  }
  assert.equal(workers[1].namespaceId,workers[0].namespaceId);assert.equal(workers[3].namespaceId,workers[2].namespaceId);assert.notEqual(workers[0].namespaceId,workers[2].namespaceId);
  const apps=[];let pageToken='',done=false;for(let page=0;page<10;page++){
   const result=await api('/containers/applications'+(pageToken?'?page_token='+encodeURIComponent(pageToken):''));assert(Array.isArray(result.result));apps.push(...result.result.filter(a=>[workers[0].namespaceId,workers[2].namespaceId].includes(a.durable_objects?.namespace_id)));pageToken=result.result_info?.next_page_token??'';if(!pageToken){done=true;break;}
  }assert(done,'FINAL_CONTAINER_INVENTORY_INCOMPLETE');
  const imageId=(await json(root+'/local-checks/report.json')).imageId,images=[];
  // Inventory locates IDs; its configuration may lag behind a completed rollout.
  for(const role of ['source','target']){const worker=workers.find(w=>w.role===role),matching=apps.filter(a=>a.durable_objects.namespace_id===worker.namespaceId);assert.equal(matching.length,1);assert(UUID.test(matching[0].id));const app=await readCurrentContainerApplication(matching[0].id,worker.namespaceId,async id=>(await api('/containers/applications/'+id)).result,{deadline}),proof=await inspectRegistryImage(app.imageRef,imageId,inspect);images.push({role,...app,...proof});}
  const queues=[];for(const role of ['source','target']){const cfg=values[role],name=cfg.queues.producers[0].queue,listed=(await api('/queues?name='+encodeURIComponent(name))).result;assert(Array.isArray(listed)&&listed.length===1&&listed[0].queue_name===name);assert(HEX32.test(listed[0].queue_id));queues.push(verifyQueueOwner((await api('/queues/'+listed[0].queue_id)).result,name,cfg.name));}
  const manifest=await json(root+'/cohort/asset-manifest.json'),sourceAssets=[];
  for(const asset of manifest.files){assert(asset.file==='index.html'||/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(asset.file));const route=asset.file==='index.html'?'/app':'/app-assets/'+asset.file;const {response,record}=await http(values.source.vars.AUTH_BASE_URL+route,{authorization:'Bearer '+sourceKeys.POC_TOKEN});assert.equal(response.status,200);const b=await bodyBytes(response,asset.bytes+1);assert.equal(b.length,asset.bytes);assert.equal(sha(b),asset.sha256,'FINAL_SERVED_ASSET_CHANGED');sourceAssets.push({file:asset.file,bytes:b.length,sha256:sha(b)});record.stage='CONFIRMED';await persist();}
  // Re-observe versions and applications after registry/asset reads.
  for(const worker of workers){const listed=(await api('/workers/scripts/'+worker.worker+'/deployments')).result.deployments;verifyDeployedVersion(worker.worker,worker.versionId,worker.tag,listed,rawVersions[worker.role]);}
  for(const image of images){const detail=(await api('/containers/applications/'+image.applicationId)).result;assert.equal(detail.active_rollout_id??null,null,'FINAL_CONTAINER_ROLLOUT_CHANGED');const now=verifyContainerApplication(detail,image.namespaceId);assert.equal(now.applicationId,image.applicationId);assert.equal(now.imageRef,image.imageRef);}
  const last=await http(values.source.vars.AUTH_BASE_URL+'/__poc/deploy-preflight',{authorization:'Bearer '+sourceKeys.POC_TOKEN},'POST'),preflight=assertPocDeployReady(await boundedPreflight(last.response));last.record.stage='CONFIRMED';await persist();
  await unchanged();assert(Date.now()<deadline);const report={schema:'final-cohort-observation-v1',state:'BINDINGS_IMAGES_SOURCE_ASSETS_VERIFIED_NOT_FROZEN',cohortId:plan.cohortId,sourceCommit:source.sourceCommit,sourceSha256:source.sourceSha256,releaseSha256:ready.releaseSha256,deploymentSha256:deploymentSha,materializationSha256:ready.materializationSha256,observedAt:Date.now(),workers,images,queues,sourceAssets,targetAssets:'DEFERRED_UNTIL_RESTORED_AUTHORIZED_READ',preflight,solverStarts:0};
  const raw=JSON.stringify(report,null,2)+'\n';await writeFile(dir+'/report.json',raw,{mode:0o600,flag:'wx'});state.state='COMPLETE_NOT_FROZEN';state.reportSha256=sha(raw);await persist();return report;
 }catch{state.state='FAILED_NOT_USABLE';await persist();throw Error('FINAL_COHORT_OBSERVATION_STOPPED_INSPECT_SAME_OWNER');}
 finally{token=undefined;sourceKeys=undefined;}
}
