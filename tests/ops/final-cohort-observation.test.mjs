import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {observeFinalCohort,inspectRegistryImage,verifyWorkerBindings,verifyContainerApplication,verifyQueueOwner,readCurrentContainerApplication} from '../../scripts/final-cohort-observation.mjs';
const ACCOUNT='11111111111111111111111111111111',IMAGE='sha256:'+'2'.repeat(64),DIGEST='sha256:'+'3'.repeat(64);
const registry=async args=>JSON.stringify(args.includes('{{json .Manifest}}')?{digest:DIGEST}:args[0]==='manifest'?{schemaVersion:2,config:{digest:IMAGE}}:{os:'linux',architecture:'amd64'});
import {observationFixture as fixture} from './fixtures/final-cohort-observation.mjs';
test('controlled read-only observations tie four bindings, queues, two registry configs and served assets together without freezing',async()=>fixture(async f=>{
 const r=await observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry});assert.equal(r.state,'BINDINGS_IMAGES_SOURCE_ASSETS_VERIFIED_NOT_FROZEN');assert.equal(r.workers.length,4);assert.equal(r.images.length,2);assert(r.images.every(i=>i.imageId===IMAGE&&i.registryDigest===DIGEST));assert.equal(r.sourceAssets.length,2);assert.equal(r.targetAssets,'DEFERRED_UNTIL_RESTORED_AUTHORIZED_READ');assert.equal(f.registryCalls.length,6);
 const raw=await readFile(f.root+'/observation/state.json','utf8');assert(!raw.includes('fictional-ephemeral-token-for-test'));assert.equal(JSON.parse(await readFile(f.root+'/release.json')).state,'DRAFT');const n=f.calls.length;await assert.rejects(observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry}));assert.equal(f.calls.length,n);
}));
test('wrong database binding stops before registry requests or result issuance',async()=>fixture(async f=>{
 f.versions[f.configs.target.name].resources.bindings.find(b=>b.name==='DB').database_id=randomUUID();
 await assert.rejects(observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry}));assert.equal(f.registryCalls.length,0);assert.equal(JSON.parse(await readFile(f.root+'/observation/state.json')).state,'FAILED_NOT_USABLE');
}));
test('a changed served asset fails before a final record is issued',async()=>fixture(async f=>{
 const request=async(url,init)=>url.endsWith('/app')?new Response('changed'):f.request(url,init);
 await assert.rejects(observeFinalCohort(f.root,{...f.options,request,registry:f.registry}),/INSPECT_SAME_OWNER/);assert.equal(JSON.parse(await readFile(f.root+'/observation/state.json')).state,'FAILED_NOT_USABLE');
}));
test('a replacement Worker version observed after image reads is refused',async()=>fixture(async f=>{
 let n=0;const request=async(url,init)=>{if(url.endsWith('/workers/scripts/'+f.configs.source.name+'/deployments')&&++n===2)f.deployments[f.configs.source.name][0].versions[0].version_id=randomUUID();return f.request(url,init);};
 await assert.rejects(observeFinalCohort(f.root,{...f.options,request,registry:f.registry}));assert.equal(n,2);
}));
test('registry index selects one linux amd64 manifest and checks its config ID; wrong config or ambiguous platform is refused',async()=>{
 const child='sha256:'+'4'.repeat(64),ref='registry.cloudflare.com/fictional/image:version',calls=[];
 const execute=async args=>{calls.push(args);if(args.includes('{{json .Manifest}}'))return JSON.stringify({digest:DIGEST});if(args[0]==='manifest'&&args[2].endsWith(DIGEST))return JSON.stringify({schemaVersion:2,manifests:[{digest:child,platform:{os:'linux',architecture:'amd64'}},{digest:'sha256:'+'5'.repeat(64),platform:{os:'unknown',architecture:'unknown'}}]});return registry(args);};
 assert.equal((await inspectRegistryImage(ref,IMAGE,execute)).platformManifestDigest,child);assert.equal(calls.length,4);
 await assert.rejects(inspectRegistryImage(ref,'sha256:'+'6'.repeat(64),registry),/FINAL_REGISTRY_IMAGE_CONFIG_CHANGED/);
 await assert.rejects(inspectRegistryImage('evil.invalid/image:tag',IMAGE,registry));
 await assert.rejects(inspectRegistryImage('registry.cloudflare.com/fictional/image',IMAGE,registry),/FINAL_REGISTRY_UNVERSIONED_IMAGE/);
 await assert.rejects(inspectRegistryImage('registry.cloudflare.com/fictional/image:latest',IMAGE,registry),/FINAL_REGISTRY_UNVERSIONED_IMAGE/);
 const ambiguous=async args=>args[0]==='manifest'?JSON.stringify({schemaVersion:2,manifests:[{digest:child,platform:{os:'linux',architecture:'amd64'}},{digest:DIGEST,platform:{os:'linux',architecture:'amd64'}}]}):registry(args);
 await assert.rejects(inspectRegistryImage(ref,IMAGE,ambiguous),/FINAL_REGISTRY_AMD64_NOT_UNIQUE/);
});
test('duplicate binding names and a different operator namespace script are refused',()=>{
 const cfg={name:'fictional-operator',d1_databases:[{database_id:'db'}],durable_objects:{bindings:[{script_name:'expected-app'}]},vars:{},secrets:{required:[]}},bindings=[{name:'DB',type:'d1',id:'db'},{name:'SOLVER',type:'durable_object_namespace',namespace_id:'a'.repeat(32),class_name:'OptimizerContainer',script_name:'other-app'}];
 assert.throws(()=>verifyWorkerBindings({resources:{bindings}},cfg));bindings[1].script_name='expected-app';assert.equal(verifyWorkerBindings({resources:{bindings}},cfg).databaseId,'db');assert.throws(()=>verifyWorkerBindings({resources:{bindings:[...bindings,bindings[0]]}},cfg));
});
test('resolved Container resources and Queue consumer script match real API shapes while conflicts fail closed',()=>{
 const ns='a'.repeat(32),app={id:randomUUID(),account_id:'11111111111111111111111111111111',durable_objects:{namespace_id:ns},scheduling_policy:'default',max_instances:1,configuration:{vcpu:1,memory_mib:6144,disk:{size_mb:12000},image:'registry.cloudflare.com/11111111111111111111111111111111/owned:fixed'}};
 assert.deepEqual(verifyContainerApplication(app,ns).observedResources,{vcpu:1,memoryMiB:6144,diskMB:12000});for(const change of [{vcpu:2},{memory_mib:3072},{disk:{size_mb:20000}},{instance_type:'standard-4'}])assert.throws(()=>verifyContainerApplication({...app,configuration:{...app.configuration,...change}},ns));
 const queue={queue_name:'owned',consumers_total_count:1,producers_total_count:1,consumers:[{script:'owned-worker',settings:{batch_size:1,max_concurrency:1,max_retries:3,max_wait_time_ms:1000}}],producers:[{script:'owned-worker'}]};assert.equal(verifyQueueOwner(queue,'owned','owned-worker').worker,'owned-worker');queue.consumers[0].script_name='foreign-worker';assert.throws(()=>verifyQueueOwner(queue,'owned','owned-worker'));
});

test('a stale application listing only locates IDs; current image proof comes from the individual GET',async()=>fixture(async f=>{
 f.view.listedApps=structuredClone(f.apps);f.view.listedApps[0].configuration.image='registry.cloudflare.com/'+ACCOUNT+'/source:stale';
 const r=await observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry});assert.equal(r.images[0].imageRef,f.apps[0].configuration.image);assert(f.registryCalls.every(args=>!args.some(a=>a.includes('source:stale'))));for(const app of f.apps)assert.equal(f.calls.filter(u=>u.endsWith('/containers/applications/'+app.id)).length,2);
}));
test('a valid listing cannot hide a changed namespace in the individual GET',async()=>fixture(async f=>{
 f.view.listedApps=structuredClone(f.apps);f.apps[0].durable_objects.namespace_id='f'.repeat(32);
 await assert.rejects(observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry}));assert.equal(f.registryCalls.length,0);assert.equal(JSON.parse(await readFile(f.root+'/observation/state.json')).state,'FAILED_NOT_USABLE');
}));

for(const fault of ['complete','pending','namespace'])test('bounded application detail '+({complete:'accepts a completed rollout after one wait',pending:'refuses a rollout that remains pending',namespace:'refuses a changed namespace without waiting'})[fault],async()=>{
 const ns='a'.repeat(32),id=randomUUID(),rollout=randomUUID(),app={id,account_id:ACCOUNT,durable_objects:{namespace_id:ns},scheduling_policy:'default',max_instances:1,configuration:{vcpu:1,memory_mib:6144,disk:{size_mb:12000},image:'registry.cloudflare.com/'+ACCOUNT+'/owned:fixed'}};let reads=0,waits=0;const read=async requested=>{assert.equal(requested,id);reads++;return {...app,...fault==='namespace'?{durable_objects:{namespace_id:'f'.repeat(32)}}:{},...(fault==='complete'&&reads>1?{}:{active_rollout_id:rollout})};};const options={deadline:100000,now:()=>0,wait:async ms=>{assert.equal(ms,5000);waits++;}};
 if(fault==='complete'){assert.equal((await readCurrentContainerApplication(id,ns,read,options)).applicationId,id);assert.equal(reads,2);assert.equal(waits,1);}else{await assert.rejects(readCurrentContainerApplication(id,ns,read,options));assert.equal(reads,fault==='pending'?7:1);assert.equal(waits,fault==='pending'?6:0);}
});
