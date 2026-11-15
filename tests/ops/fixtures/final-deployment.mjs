import assert from 'node:assert/strict';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {resourceAllocationFixture} from './final-resource-allocation.mjs';
import {allocateFinalResources} from '../../../scripts/final-resource-allocation.mjs';
import {materializeFinalResourceBindings} from '../../../scripts/final-resource-bindings.mjs';
import {inspectFinalDeployment} from '../../../scripts/final-deployment.mjs';
import {RECOVERY_PHASES} from '../../../scripts/final-technical-recovery.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function deploymentFixture(work){return resourceAllocationFixture(async f=>{
 await mkdir('artifacts/quality-audit',{recursive:true});
 const log='artifacts/quality-audit/deploy-fictional-'+randomUUID()+'.log';await writeFile(log,'SYNTHETIC REHEARSAL LOG; NO REAL SDK RUN');
 try{
  const rehearsal={sourceCommit:f.source.sourceCommit,optimizerImageId:'sha256:'+'2'.repeat(64),jobs:Array.from({length:4},(_,i)=>({slot:'J'+(i+1),attempt:i===1?2:1,validation:'VERIFIED',stopped:true,rows:i===3?3131:31})),recovery:{state:'COMPLETE',originalReplayOrResolution:false,phases:RECOVERY_PHASES.map(name=>({name,stage:'CONFIRMED'}))},sourceRuntimeClosed:true,targetRuntimeClosed:true,runtimeSecretsRetired:true,ownedImageTagRemoved:true,ownedListenersAbsent:true,logs:[{file:log,sha256:sha(await readFile(log))}]};
  const raw=JSON.stringify(rehearsal);await writeFile(f.root+'/local-rehearsal.json',raw,{mode:0o600});
  f.release.localRehearsal={state:'VERIFIED',sourceCommit:f.source.sourceCommit,evidenceSha256:sha(raw)};await f.write(f.root+'/release.json',f.release);
  await allocateFinalResources(f.root,{...f.options,request:f.request});await materializeFinalResourceBindings(f.root,{inspectSource:f.options.inspectSource});
  const sourceKeys={POC_TOKEN:'fictional-source-poc-token-for-deployment',OPERATOR_TOKEN:'fictional-source-operator-token-for-deployment'};await f.write(f.root+'/recovery/source-secrets.json',sourceKeys);
  const versions=new Map(),commands=[],http=[];
  const dockerCommands=[];const executeDocker=async(args,options)=>{dockerCommands.push(args);await options.onSpawn({pid:23456,command:'SYNTHETIC_DOCKER',args});return {stdout:args[0]==='image'&&args[1]==='inspect'?'sha256:'+'2'.repeat(64):args[0]==='image'&&args[1]==='load'?'Loaded image ID: sha256:'+'2'.repeat(64):''};};
  const execute=async(args,options)=>{
   const state=await inspectFinalDeployment(f.root);assert.equal(state.phases.at(-1).stage,'DISPATCHED');await options.onSpawn({pid:12345,command:'controlled-test-command',args});commands.push(args);
   const cfg=JSON.parse(await readFile(args[args.indexOf('--config')+1])),worker=cfg.name;
   if(args[0]==='deploy'){
    assert.equal(args[args.indexOf('--tag')+1],'final-'+f.plan.cohortId);assert(!args.includes('--keep-vars'));
    versions.set(worker,randomUUID());return {stdout:sourceKeys.POC_TOKEN,output:JSON.stringify({type:'deploy',worker_name:worker,version_id:versions.get(worker)})};
   }
   if(args[0]==='deployments')return {stdout:JSON.stringify([{id:randomUUID(),created_on:new Date().toISOString(),versions:[{version_id:versions.get(worker),percentage:100}]}]),output:''};
   if(args[0]==='versions')return {stdout:JSON.stringify({id:versions.get(worker),annotations:{'workers/tag':'final-'+f.plan.cohortId}}),output:''};
   if(args[0]==='containers')return {stdout:'SYNTHETIC image push succeeded',output:''};
   return {stdout:args.includes('execute')?JSON.stringify([{success:true,results:f.plan.migrations.map(m=>({name:path.basename(m.file)}))}]):'fictional migration completed',output:''};
  };
  const request=async(url,init)=>{http.push(url);assert.equal(url,'https://shift-manager-example.example.invalid/__poc/deploy-preflight');assert.equal(init.headers.authorization,'Bearer '+sourceKeys.POC_TOKEN);return Response.json({schema:'poc-deploy-preflight-v1',observedAt:new Date().toISOString(),ready:true,activeJobs:0,activeRevalidations:0,checkedObjects:1,busyObjects:0,inventoryStable:true});};
  return await work({...f,rehearsal,sourceKeys,commands,http,execute,executeDocker,dockerCommands,request});
 }finally{await rm(log);}
});}
