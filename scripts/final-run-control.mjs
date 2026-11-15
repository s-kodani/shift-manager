// Finite final-acceptance owner. Transport/auth are injected and never persisted.
import {mkdir,open,readFile,realpath,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {save} from './backup-lib.mjs';

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const kind=z.enum(['job','check','fault']);
const slot=z.enum(['J1','J2','J3','J4']);
const operation=z.object({id:uuid,slot,kind,fingerprint:digest,
 stage:z.enum(['DISPATCHED','CONFIRMED','UNCERTAIN']),at:z.number().int().nonnegative(),
 confirmedAt:z.number().int().nonnegative().optional()}).strict();
const observation=z.object({id:uuid,slot,companyId:uuid,teamId:uuid,attempt:z.number().int().min(0).max(3),
 state:z.enum(['QUEUED','RUNNING','CANCELLING','SUCCEEDED','NO_SOLUTION','STALE','FAILED','CANCELLED']),
 solverStatus:z.enum(['OPTIMAL','FEASIBLE','UNKNOWN','INFEASIBLE','MODEL_INVALID']).nullable(),
 validationStatus:z.enum(['VERIFIED','HISTORY_UNVERIFIED','REJECTED','NOT_RUN']).nullable()}).strict();
const binding=z.object({slot,companyId:uuid,teamId:uuid,jobId:uuid}).strict();
const ownerSchema=z.object({schema:z.literal('cloudflare-final-owner-v1'),id:uuid,
 sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),casesSha256:digest,
 stage:z.enum(['PREPARED','RUNNING','STOPPED','CLOSED']),startedAt:z.number().int().nonnegative().nullable(),
 lastAt:z.number().int().nonnegative(),stopCode:z.string().regex(/^[A-Z_]+$/).nullable(),
 limits:z.object({jobs:z.literal(4),checks:z.literal(16),faults:z.literal(1),attempts:z.literal(12),
  functionalMs:z.literal(1800000),cleanupMs:z.literal(300000)}).strict(),
 bindings:z.array(binding).max(4),operations:z.array(operation).max(21),observations:z.array(observation).max(4),
 cleanup:z.object({idle:z.boolean(),credentialsRetired:z.boolean(),privateFilesRemoved:z.boolean()}).strict(),
 cleanupStartedAt:z.number().int().nonnegative().nullable(),cleanupExceeded:z.boolean(),
 resolutions:z.array(z.object({kind:z.literal('REJECTED_J3_SNAPSHOT'),jobId:uuid,at:z.number().int().nonnegative()}).strict()).max(1).default([]),
 closedAt:z.number().int().nonnegative().optional()}).strict();
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function location(root){
 const dir=path.resolve(root);
 if(await realpath(dir)!==dir||((await stat(dir)).mode&0o077)!==0)throw Error('FINAL_PRIVATE_OWNER_REQUIRED');
 return dir;
}
export async function readFinalOwner(root){
 const dir=await location(root),file=dir+'/owner.json',s=await stat(file);
 if(await realpath(file)!==file||(s.mode&0o077)!==0||s.size>65536)throw Error('FINAL_PRIVATE_OWNER_REQUIRED');
 try{return ownerSchema.parse(JSON.parse(await readFile(file,'utf8')));}catch{throw Error('FINAL_OWNER_INVALID');}
}
async function locked(root,work){
 const dir=await location(root),file=dir+'/owner.lock';let handle;
 try{handle=await open(file,'wx',0o600);}catch{throw Error('FINAL_OWNER_LOCKED_INSPECT_EXISTING_PROCESS');}
 try{return await work(dir,await readFinalOwner(dir));}
 finally{await handle.close();await unlink(file);}
}
export async function prepareFinalOwner(root,{sourceCommit,cases},now=Date.now()){
 const limits=cases?.limits;
 if(cases?.schema!=='cloudflare-final-cases-v1'||cases.profile!=='mvp-joint-calendar-fallback-v1'||
    cases.instanceType!=='standard-2'||cases.maxInstances!==1||cases.normalBudgetSeconds!==120||
    !limits||limits.normalJobs!==4||limits.independentChecks!==16||limits.intentionalContainerFaults!==1||
    limits.maximumSolverAttempts!==12||limits.functionalSessionMinutes!==30||limits.cleanupMinutes!==5||
    limits.autoReplacementJobs!==0||limits.additional500PersonPerformanceRuns!==0||limits.mail!==0||limits.ai!==0||limits.scheduledBackup!==0||
    JSON.stringify(cases.jobs?.map(j=>j.id))!==JSON.stringify(['J1','J2','J3','J4']))throw Error('FINAL_CASE_LIMITS_MISMATCH');
 const dir=path.resolve(root);await mkdir(dir,{mode:0o700});await location(dir);
 const owner=ownerSchema.parse({schema:'cloudflare-final-owner-v1',id:randomUUID(),sourceCommit,casesSha256:fingerprint(cases),
  stage:'PREPARED',startedAt:null,lastAt:now,stopCode:null,
  limits:{jobs:4,checks:16,faults:1,attempts:12,functionalMs:1800000,cleanupMs:300000},
  bindings:[],operations:[],observations:[],cleanup:{idle:false,credentialsRetired:false,privateFilesRemoved:false},cleanupStartedAt:null,cleanupExceeded:false});
 const f=await open(dir+'/owner.json','wx',0o600);try{await f.writeFile(JSON.stringify(owner,null,2)+'\n');await f.sync();}finally{await f.close();}
 return owner;
}
export async function bindFinalJob(root,input){
 const b=binding.parse(input);
 return locked(root,async(dir,owner)=>{
  if(owner.stage!=='PREPARED'||owner.bindings.some(v=>v.slot===b.slot||v.jobId===b.jobId))throw Error('FINAL_BINDING_IMMUTABLE');
  owner.bindings.push(b);await save(dir+'/owner.json',owner);return b;
 });
}
async function stop(dir,owner,code,now){
 owner.stage='STOPPED';owner.stopCode=code;owner.lastAt=Math.max(now,owner.lastAt);await save(dir+'/owner.json',owner);
}
export async function haltFinalOwner(root,now=Date.now()){
 return locked(root,async(dir,owner)=>{
  if(owner.stage!=='CLOSED')await stop(dir,owner,owner.stopCode??'OBSERVATION_UNCONFIRMED',now);
 });
}
// Explicit local repair after a known rejected preparation, never an unknown
// job producer. The caller must prove both objects absent and all SDKs idle.
export async function resumeAfterRejectedJ3Snapshot(root,input,now=Date.now()){
 const proof=z.object({status:z.literal(409),jobId:uuid,snapshotAbsent:z.literal(true),jobAbsent:z.literal(true),allSdkIdle:z.literal(true)}).strict().parse(input);
 return locked(root,async(dir,owner)=>{
  const j2=owner.observations.find(o=>o.slot==='J2'),j3=owner.bindings.find(b=>b.slot==='J3');
  if(owner.stage!=='STOPPED'||owner.stopCode!=='OBSERVATION_UNCONFIRMED'||owner.cleanupStartedAt!==null||owner.resolutions.length||
    owner.operations.some(o=>o.stage!=='CONFIRMED'||(o.kind==='job'&&['J3','J4'].includes(o.slot)))||
    owner.operations.filter(o=>o.kind==='fault'&&o.slot==='J2').length!==1||!j2||j2.state!=='SUCCEEDED'||j2.attempt!==2||j2.validationStatus!=='VERIFIED'||
    !owner.observations.some(o=>o.slot==='J1'&&o.state==='SUCCEEDED'&&o.validationStatus==='VERIFIED')||j3?.jobId!==proof.jobId||
    owner.startedAt===null||now<owner.lastAt||now-owner.startedAt>=owner.limits.functionalMs)throw Error('FINAL_REJECTED_PREPARATION_NOT_PROVEN');
  owner.resolutions.push({kind:'REJECTED_J3_SNAPSHOT',jobId:proof.jobId,at:now});owner.stage='RUNNING';owner.stopCode=null;owner.lastAt=now;
  await save(dir+'/owner.json',owner);
 });
}
// One request at most. A transport or confirmation failure blocks later requests;
// even a 404 observation cannot authorize replay of a dispatched producer.
export async function dispatchFinalOperation(root,input,{send,confirm,now=()=>Date.now()}){
 const intent=z.object({id:uuid,slot,kind,fingerprint:digest}).strict().parse(input);
 return locked(root,async(dir,owner)=>{
  const at=now();
  if(!['PREPARED','RUNNING'].includes(owner.stage)||owner.cleanupStartedAt!==null)throw Error('FINAL_RUN_STOPPED');
  if(at<owner.lastAt||(owner.startedAt!==null&&at-owner.startedAt>=owner.limits.functionalMs)){
   await stop(dir,owner,'TIME_BUDGET',at);throw Error('FINAL_TIME_BUDGET');
  }
  if(owner.bindings.length!==4)throw Error('FINAL_BINDINGS_INCOMPLETE');
  const b=owner.bindings.find(v=>v.slot===intent.slot);
  if(!b||owner.operations.some(o=>o.id===intent.id)||(intent.kind==='job'&&(intent.id!==b.jobId||owner.operations.some(o=>o.slot===intent.slot&&o.kind==='job'))))throw Error('FINAL_OPERATION_ALREADY_DISPATCHED_OR_MISMATCHED');
  if(intent.kind==='job'){
   const preceding=owner.bindings.filter(v=>v.slot<intent.slot);
   if(preceding.some(v=>!owner.observations.some(o=>o.slot===v.slot&&o.state==='SUCCEEDED'&&o.validationStatus==='VERIFIED')))throw Error('FINAL_PREVIOUS_JOB_NOT_VERIFIED');
  }
  if(intent.kind==='fault'&&!owner.observations.some(o=>o.slot==='J2'&&intent.slot==='J2'&&o.state==='RUNNING'&&o.attempt===1))throw Error('FINAL_OWNED_FAULT_NOT_RUNNING');
  const max=intent.kind==='job'?owner.limits.jobs:intent.kind==='check'?owner.limits.checks:owner.limits.faults;
  if(owner.operations.filter(o=>o.kind===intent.kind).length>=max){await stop(dir,owner,'REQUEST_BUDGET',at);throw Error('FINAL_REQUEST_BUDGET');}
  owner.startedAt??=at;owner.stage='RUNNING';owner.lastAt=at;
  const row={...intent,stage:'DISPATCHED',at};owner.operations.push(row);await save(dir+'/owner.json',owner);
  let timeOverrun=false;
  try{
   const response=await send();
   if(await confirm(response)!==true)throw Error('UNCONFIRMED');
   row.stage='CONFIRMED';row.confirmedAt=now();
   if(row.confirmedAt<owner.lastAt||row.confirmedAt-owner.startedAt>=owner.limits.functionalMs){timeOverrun=true;await stop(dir,owner,'TIME_BUDGET',row.confirmedAt);throw Error('FINAL_TIME_BUDGET');}
   owner.lastAt=row.confirmedAt;await save(dir+'/owner.json',owner);return {id:row.id,stage:row.stage};
  }catch{
   if(!timeOverrun)row.stage='UNCERTAIN';
   await stop(dir,owner,timeOverrun?'TIME_BUDGET':'OUTCOME_UNKNOWN',now());
   throw Error(timeOverrun?'FINAL_TIME_BUDGET':'FINAL_OUTCOME_UNKNOWN_INSPECT_SAME_OPERATION');
  }
 });
}
export async function observeFinalJob(root,input,now=Date.now()){
 const o=observation.parse(input);
 return locked(root,async(dir,owner)=>{
  const b=owner.bindings.find(v=>v.slot===o.slot),previous=owner.observations.find(v=>v.slot===o.slot);
  if(!b||b.jobId!==o.id||b.companyId!==o.companyId||b.teamId!==o.teamId||
     !owner.operations.some(v=>v.id===o.id&&v.kind==='job')||
     (previous&&(o.attempt<previous.attempt||(!['QUEUED','RUNNING','CANCELLING'].includes(previous.state)&&fingerprint(previous)!==fingerprint(o)))))throw Error('FINAL_OBSERVATION_MISMATCH');
  owner.observations=owner.observations.filter(v=>v.slot!==o.slot);owner.observations.push(o);
  if(owner.observations.reduce((n,v)=>n+v.attempt,0)>owner.limits.attempts){await stop(dir,owner,'ATTEMPT_BUDGET',now);throw Error('FINAL_ATTEMPT_BUDGET');}
  if(['NO_SOLUTION','STALE','FAILED','CANCELLED'].includes(o.state)||
     (o.state==='SUCCEEDED'&&(o.attempt<1||o.validationStatus!=='VERIFIED'||!['OPTIMAL','FEASIBLE'].includes(o.solverStatus)))){
   await stop(dir,owner,'JOB_NOT_VERIFIED',now);throw Error('FINAL_JOB_NOT_VERIFIED');
  }
  // Read-only observation does not resolve an uncertain producer or reopen a run.
  owner.lastAt=Math.max(now,owner.lastAt);await save(dir+'/owner.json',owner);return o;
 });
}
export async function closeFinalOwner(root,input,now=Date.now()){
 const proof=z.object({idle:z.literal(true),credentialsRetired:z.literal(true),privateFilesRemoved:z.literal(true)}).strict().parse(input);
 return locked(root,async(dir,owner)=>{
  if(owner.stage==='CLOSED')return {closed:true,cleanupExceeded:owner.cleanupExceeded};
  if(owner.stage!=='STOPPED'&&(owner.operations.filter(o=>o.kind==='job').length!==4||owner.observations.length!==4||owner.observations.some(o=>o.state!=='SUCCEEDED'||o.validationStatus!=='VERIFIED')))throw Error('FINAL_ACCEPTANCE_INCOMPLETE');
  if(owner.cleanupStartedAt===null)throw Error('FINAL_CLEANUP_NOT_STARTED');
  owner.cleanupExceeded=now<owner.cleanupStartedAt||now-owner.cleanupStartedAt>=owner.limits.cleanupMs;
  // Cleanup remains allowed past its budget; preserve the overrun, never restart.
  owner.cleanup=proof;owner.stage='CLOSED';owner.closedAt=now;owner.lastAt=Math.max(now,owner.lastAt);await save(dir+'/owner.json',owner);return {closed:true,cleanupExceeded:owner.cleanupExceeded};
 });
}
export async function beginFinalCleanup(root,now=Date.now()){
 return locked(root,async(dir,owner)=>{
  if(owner.stage==='CLOSED')throw Error('FINAL_RUN_CLOSED');
  owner.cleanupStartedAt??=now;owner.lastAt=Math.max(now,owner.lastAt);await save(dir+'/owner.json',owner);
  return {startedAt:owner.cleanupStartedAt,deadline:owner.cleanupStartedAt+owner.limits.cleanupMs};
 });
}
