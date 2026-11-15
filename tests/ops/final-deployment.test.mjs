import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {deployFinalCohort,inspectFinalDeployment,verifyDeployedVersion} from '../../scripts/final-deployment.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
import {deploymentFixture as fixture} from './fixtures/final-deployment.mjs';
test('one controlled deployment aligns source migrations, observes four 100% Worker versions, keeps image/freeze pending and stores no raw secrets',async()=>fixture(async f=>{
 const r=await deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request});assert.equal(r.state,'WORKER_VERSIONS_OBSERVED_IMAGE_PENDING_NOT_FROZEN');assert.equal(r.workerVersions.length,4);assert.equal(r.imageIdentity,'NOT_YET_VERIFIED');assert.equal(f.commands.filter(c=>c[0]==='deploy').length,4);assert.equal(f.http.length,4);
 assert.equal(JSON.parse(await readFile(f.root+'/release.json')).state,'DRAFT');assert(!(await readFile(f.root+'/deployment/state.json','utf8')).includes(f.sourceKeys.POC_TOKEN));
 const keys=JSON.parse(await readFile(f.root+'/recovery/secrets.json'));assert.equal(keys.BETTER_AUTH_SECRET.length,64);assert.notEqual(keys.POC_TOKEN,f.sourceKeys.POC_TOKEN);
 const app=JSON.parse(await readFile(f.root+'/recovery/app-secrets.json'));assert.deepEqual(Object.keys(app).sort(),['BETTER_AUTH_SECRET','POC_TOKEN']);
 const before=await readFile(f.root+'/deployment/state.json','utf8');await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request}));assert.equal(await readFile(f.root+'/deployment/state.json','utf8'),before);assert.equal(f.commands.length,15);
}));
test('missing or changed local rehearsal stops before private source credential reads or deployment',async()=>fixture(async f=>{
 await rm(f.root+'/recovery/source-secrets.json');
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request}),e=>e.code==='ENOENT');
 await assert.rejects(readFile(f.root+'/deployment/state.json'),e=>e.code==='ENOENT');assert.equal(f.commands.length,0);assert.equal(f.http.length,0);
 await f.write(f.root+'/recovery/source-secrets.json',f.sourceKeys);await writeFile(f.root+'/local-rehearsal.json','changed');
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request}));assert.equal(f.commands.length,0);assert.equal(f.http.length,0);
}));
test('busy or unconfirmed source preflight prevents schema and Worker changes',async()=>fixture(async f=>{
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:async()=>Response.json({schema:'poc-deploy-preflight-v1',observedAt:new Date().toISOString(),ready:false,activeJobs:1,activeRevalidations:0,checkedObjects:0,busyObjects:0,inventoryStable:false})}));
 assert.equal(f.commands.length,0);assert.equal((await inspectFinalDeployment(f.root)).state,'UNCERTAIN_NOT_USABLE');
}));
test('rehashed materialization cannot deploy a different target database',async()=>fixture(async f=>{
 const file=f.root+'/recovery/app.jsonc',cfg=JSON.parse(await readFile(file));cfg.d1_databases[0].database_id=randomUUID();await f.write(file,cfg);
 const metadata=JSON.parse(await readFile(f.root+'/recovery/materialization.json'));metadata.files.find(v=>v.file==='app.jsonc').sha256=sha(await readFile(file));await f.write(f.root+'/recovery/materialization.json',metadata);
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request}),/FINAL_DEPLOYMENT_TARGET_CONFIG_CHANGED/);assert.equal(f.commands.length,0);assert.equal(f.http.length,0);
}));
test('lost deployment response keeps the dispatched source command, refuses replay and never deploys another Worker',async()=>fixture(async f=>{
 let deploys=0;const execute=async(args,options)=>{if(args[0]==='deploy'){deploys++;throw Error('LOST_DEPLOYMENT_RESPONSE');}return f.execute(args,options);};
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute,executeDocker:f.executeDocker,request:f.request}));const state=await inspectFinalDeployment(f.root);assert.equal(state.state,'UNCERTAIN_NOT_USABLE');assert.equal(state.phases.at(-1).name,'source-deploy');assert.equal(state.phases.at(-1).stage,'DISPATCHED');assert.equal(deploys,1);
 await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute,executeDocker:f.executeDocker,request:f.request}));assert.equal(deploys,1);
}));
test('split or replaced traffic and a different version annotation cannot be frozen as the deployed version',()=>{
 const id=randomUUID(),worker='fictional-worker',tag='fictional-tag',version={id,annotations:{'workers/tag':tag}},base={id:randomUUID(),created_on:new Date().toISOString(),versions:[{version_id:id,percentage:100}]};
 assert.equal(verifyDeployedVersion(worker,id,tag,[base],version).versionId,id);
 for(const versions of [[{version_id:id,percentage:50}],[{version_id:randomUUID(),percentage:100}]])assert.throws(()=>verifyDeployedVersion(worker,id,tag,[{...base,versions}],version));
 assert.throws(()=>verifyDeployedVersion(worker,id,tag,[base],{...version,annotations:{'workers/tag':'other'}}));
});
test('a different loaded image stops before registry push, migrations or Worker deployment',async()=>fixture(async f=>{
 const executeDocker=async(args,options)=>{const r=await f.executeDocker(args,options);return args[0]==='image'&&args[1]==='inspect'?{stdout:'sha256:'+'f'.repeat(64)}:r;};await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker,request:f.request}));assert.equal(f.commands.length,0);assert.equal(f.http.length,1);assert.equal((await inspectFinalDeployment(f.root)).state,'UNCERTAIN_NOT_USABLE');assert(!f.dockerCommands.some(a=>a[0]==='tag'));
}));
test('unknown image push stops before source changes, removes owned local tags and never retries',async()=>fixture(async f=>{
 const execute=async(args,options)=>{const result=await f.execute(args,options);if(args[0]==='containers')throw Error('SYNTHETIC_LOST_PUSH_REPLY');return result;};await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute,executeDocker:f.executeDocker,request:f.request}));const state=await inspectFinalDeployment(f.root);assert.equal(state.state,'UNCERTAIN_NOT_USABLE');assert.equal(state.phases.at(-1).name,'image-push');assert.equal(state.phases.at(-1).stage,'DISPATCHED');assert.equal(state.imageLocalTagsRemoved,true);assert.equal(f.commands.length,1);assert(!f.commands.some(a=>a[0]==='deploy'||a[0]==='d1'));await assert.rejects(deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute,executeDocker:f.executeDocker,request:f.request}));assert.equal(f.commands.length,1);
}));
