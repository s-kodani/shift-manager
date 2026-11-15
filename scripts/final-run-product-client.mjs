// Normal product HTTP adapter; caller supplies live auth, PoC token and transport.
// No deployment, fixture provisioning, automatic polling or replacement job.
import {z} from 'zod';
import {boundedJson} from './operator-client.mjs';
import {readFinalOwner,dispatchFinalOperation,observeFinalJob,haltFinalOwner,fingerprint} from './final-run-control.mjs';

const slotSchema=z.enum(['J1','J2','J3','J4']);
const commandSchema=z.object({snapshotId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()}).strict();
const jobView=z.object({id:z.string().uuid(),company_id:z.string().uuid(),team_id:z.string().uuid(),
 snapshot_id:z.string().uuid(),input_revision:z.number().int().nonnegative(),attempt:z.number().int().min(0).max(3),
 state:z.enum(['QUEUED','RUNNING','CANCELLING','SUCCEEDED','NO_SOLUTION','STALE','FAILED','CANCELLED']),
 solver_status:z.string().nullable(),validation_status:z.string().nullable()});
export function finalProductClient(root,request,{now=()=>Date.now()}={}){
 async function owned(slot){
  slotSchema.parse(slot);const owner=await readFinalOwner(root),binding=owner.bindings.find(b=>b.slot===slot);
  if(!binding)throw Error('FINAL_BINDING_MISSING');
  return {...binding,base:`/api/companies/${binding.companyId}/compute/teams/${binding.teamId}/jobs`};
 }
 function matches(b,j){return j.id===b.jobId&&j.company_id===b.companyId&&j.team_id===b.teamId;}
 async function read(route){
  const response=await request(route);
  if(response.status!==200){await response.body?.cancel();throw Error('UNCONFIRMED');}
  return boundedJson(response,16*1024*1024);
 }
 return {
  async dispatch(slot,input){
   const b=await owned(slot),command={operationId:b.jobId,...commandSchema.parse(input)};
   return dispatchFinalOperation(root,{id:b.jobId,slot,kind:'job',fingerprint:fingerprint(command)},{
    now,send:()=>request(b.base,command),
    confirm:async response=>{
     if(response.status!==202){await response.body?.cancel();return false;}
     const value=await boundedJson(response,65536),j=jobView.parse(value.job);
     return matches(b,j)&&j.snapshot_id===command.snapshotId&&j.input_revision===command.expectedRevision;
    },
   });
  },
  async observe(slot){
   const b=await owned(slot);
   try{
    const raw=await read(b.base+'/'+b.jobId),j=jobView.parse(raw);
    if(!matches(b,j))throw Error('UNCONFIRMED');
    await observeFinalJob(root,{id:j.id,slot,companyId:j.company_id,teamId:j.team_id,attempt:j.attempt,
     state:j.state,solverStatus:j.solver_status,validationStatus:j.validation_status},now());
    // Full attempt/failure evidence is returned for the caller's private archive.
    return raw;
   }catch{await haltFinalOwner(root,now());throw Error('FINAL_OBSERVATION_UNCONFIRMED_INSPECT_SAME_JOB');}
  },
  async result(slot){
   const b=await owned(slot);
   try{
    const job=jobView.parse(await read(b.base+'/'+b.jobId)),value=await read(b.base+'/'+b.jobId+'/result'),r=value.result;
    if(!matches(b,job)||job.state!=='SUCCEEDED'||job.validation_status!=='VERIFIED'||
       value.stale!==false||value.inputStale!==false||r?.jobId!==b.jobId||r?.tenantId!==b.companyId||r?.teamId!==b.teamId||
       r?.attempt!==job.attempt||r?.inputVersion!==job.input_revision||r?.validation?.status!=='VERIFIED'||
       !['FEASIBLE','OPTIMAL'].includes(r?.solverStatus)||r?.metrics?.processBudget?.childReaped!==true)throw Error('UNCONFIRMED');
    return value;
   }catch{await haltFinalOwner(root,now());throw Error('FINAL_RESULT_UNCONFIRMED_INSPECT_SAME_JOB');}
  },
 };
}
