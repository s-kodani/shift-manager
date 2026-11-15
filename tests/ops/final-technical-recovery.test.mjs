import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {runFinalTechnicalRecovery,RECOVERY_PHASES} from '../../scripts/final-technical-recovery.mjs';
async function fixture(work){const root=path.resolve('.cache/final-recovery-controller-tests',randomUUID());await mkdir(root+'/acceptance',{recursive:true,mode:0o700});await mkdir(root+'/recovery',{mode:0o700});try{return await work({root,id:path.basename(root),sourceCommit:'1'.repeat(40),startedAt:1000});}finally{await rm(root,{recursive:true});}}
const steps=fn=>Object.fromEntries(RECOVERY_PHASES.map(name=>[name,(s,h)=>fn(name,s,h)]));
test('recovery records dispatch before the adapter, binds one backup ID, and completes all ordered phases without solver dispatch',async()=>fixture(async args=>{
 const names=[];const result=await runFinalTechnicalRecovery(args,steps(async(name,s,h)=>{const disk=JSON.parse(await readFile(args.root+'/recovery/workflow.json'));assert.equal(disk.phases.at(-1).name,name);assert.equal(disk.phases.at(-1).stage,'DISPATCHED');assert.equal(disk.backupId,s.backupId);names.push(name);if(name==='AUTH_PREPARE')await h.remember('authOperation',randomUUID());if(name==='AUTH_APPLY')assert(s.children.authOperation);return {verified:true};}),{now:()=>1100});assert.equal(result.state,'COMPLETE');assert.equal(result.phases,17);assert.deepEqual(names,RECOVERY_PHASES);
}));
test('lost restore response stops auth/login/retirement; the same owner is preserved and never replayed',async()=>fixture(async args=>{
 const sent=[];await assert.rejects(runFinalTechnicalRecovery(args,steps(async name=>{sent.push(name);if(name==='RESTORE')throw Error('lost import response');return {verified:true};}),{now:()=>1100}),/FINAL_RECOVERY_STOPPED/);
 const before=await readFile(args.root+'/recovery/workflow.json','utf8'),owner=JSON.parse(before);assert.equal(owner.state,'UNCERTAIN');assert.equal(owner.phases.at(-1).name,'RESTORE');assert.equal(owner.phases.at(-1).stage,'DISPATCHED');assert(!sent.includes('AUTH_APPLY'));let factories=0;
 await assert.rejects(runFinalTechnicalRecovery(args,async()=>{factories++;return steps(async()=>({verified:true}));},{now:()=>1100}));assert.equal(factories,0);assert.equal(await readFile(args.root+'/recovery/workflow.json','utf8'),before);
}));
test('time budget includes recovery and an overrun stops before the next mutation',async()=>fixture(async args=>{
 let time=1100,count=0;await assert.rejects(runFinalTechnicalRecovery(args,steps(async()=>{count++;time=args.startedAt+1800000;return {verified:true};}),{now:()=>time}),/FINAL_RECOVERY_STOPPED/);const state=JSON.parse(await readFile(args.root+'/recovery/workflow.json'));assert.equal(count,1);assert.equal(state.phases[0].stage,'CONFIRMED');assert.equal(state.state,'UNCERTAIN');
}));
test('one live driver lock excludes a second driver without constructing its adapters',async()=>fixture(async args=>{
 let release,entered;const started=new Promise(r=>entered=r),pause=new Promise(r=>release=r),first=runFinalTechnicalRecovery(args,steps(async name=>{if(name==='SOURCE_DOCUMENTS'){entered();await pause;}return {verified:true};}),{now:()=>1100});await started;let called=false;await assert.rejects(runFinalTechnicalRecovery(args,()=>{called=true;return {};},{now:()=>1100}),e=>e.code==='EEXIST');assert.equal(called,false);release();assert.equal((await first).state,'COMPLETE');
}));
