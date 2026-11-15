import {settledMaintenanceWork} from './maintenance';
// Private, dedicated Cloudflare fixtures only. Product HTTP never imports these.
import {z} from 'zod';
import {inputFixture} from './input-probes';
import {createInputSnapshot} from './input-snapshots';
import {createJob,cancelJob,dispatchJobs,loadJob,readJobResult,ACTIVE_STATES,type JobMessage} from './compute-jobs';
import {ProductError} from './product';
import {faultCommand,faultEvidence,type FaultCommand} from './compute-faults';
export const computeProbeCommand=z.object({probeId:z.string().uuid()}).strict();
type Probe={id:string;company_id:string;team_id:string;admin_user_id:string;staff_user_id:string;results:string;expires_at:number;cleaned_at:number|null};
export async function startComputeProbe(env:Env){
 const f=await inputFixture(env.DB),id=crypto.randomUUID(),snapshotId=crypto.randomUUID();
 try{
  await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
  const command={operationId:id,snapshotId,expectedRevision:f.revision};
  const accepted=await settledMaintenanceWork([createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,command),createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,command)]);
  let blocked=false;
  try{await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{...command,operationId:crypto.randomUUID()});}
  catch(error){blocked=error instanceof ProductError&&error.code==='TEAM_JOB_ACTIVE';}
  const results=[{name:'same_acceptance_has_one_job',passed:accepted.filter(r=>r.replayed).length===1},{name:'second_normal_job_rejected',passed:blocked}];
  await env.DB.prepare('INSERT INTO compute_probe(id,company_id,team_id,admin_user_id,staff_user_id,results,expires_at) VALUES (?,?,?,?,?,?,?)')
   .bind(id,f.company.companyId,f.team,f.company.userId,f.staffUser,JSON.stringify(results),Date.now()+15*60_000).run();
  if(results.some(r=>!r.passed))throw new Error('COMPUTE_ACCEPT_PROBE_FAILED');
  await dispatchJobs(env.DB,env.COMPUTE_QUEUE);
  // Deliberate duplicate delivery; no staff inputs or object keys in the queue.
  await env.COMPUTE_QUEUE.send({version:1,companyId:f.company.companyId,teamId:f.team,jobId:id} satisfies JobMessage);
  return {probeId:id,results,duplicateSent:true};
 }catch(error){
  const job=await loadJob(env.DB,f.company.companyId,f.team,id);
  if(job&&['QUEUED','RUNNING'].includes(job.state))await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:job.attempt});
  await disableProbeAccounts(env,f.company.userId,f.staffUser);
  throw error;
 }
}
async function probeRow(env:Pick<Env,'DB'>,id:string){
 const probe=await env.DB.prepare('SELECT * FROM compute_probe WHERE id=?').bind(id).first<Probe>();
 if(!probe)throw new ProductError('NOT_FOUND',404);return probe;
}
async function disableProbeAccounts(env:Pick<Env,'DB'>,admin:string,staff:string){
 await env.DB.batch([
  env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id IN (?,?)').bind(admin,staff),
  env.DB.prepare('DELETE FROM session WHERE userId IN (?,?)').bind(admin,staff),
 ]);
}
export async function inspectComputeProbe(env:Env,id:string){
 const probe=await probeRow(env,id),job=(await loadJob(env.DB,probe.company_id,probe.team_id,id))!;
 const attempts=await env.DB.prepare('SELECT attempt,started_at,finished_at,final_state,failure_code FROM compute_attempt WHERE company_id=? AND job_id=? ORDER BY attempt').bind(probe.company_id,id).all();
 const execution=await env.SOLVER.getByName(`company:${probe.company_id}:team:${probe.team_id}`).executionState();
 const result=job.result_key&&!probe.cleaned_at?await readJobResult(env.DB,env.INPUTS,probe.company_id,probe.team_id,probe.admin_user_id,id):null;
 const faults=await env.DB.prepare('SELECT * FROM compute_fault_probe WHERE probe_id=? ORDER BY requested_at').bind(id).all();
 return {probeId:id,results:JSON.parse(probe.results),state:job.state,attempt:job.attempt,solverStatus:job.solver_status,validationStatus:job.validation_status,failureCode:job.failure_code,attempts:attempts.results,execution,result,faults:faults.results,cleaned:probe.cleaned_at!==null};
}
export async function interruptComputeProbe(env:Env,input:FaultCommand){
 const command=faultCommand.parse(input);
 if(env.ENVIRONMENT!=='poc')throw new ProductError('FORBIDDEN',403);
 const probe=await probeRow(env,command.probeId);
 const replay=await faultEvidence(env.DB,command);
 if(replay)return {requested:true,replayed:true,evidence:replay};
 const name=`company:${probe.company_id}:team:${probe.team_id}`;
 let rpcRejected=false;
 try{await env.SOLVER.getByName(name).interruptOwnedProbe({version:1,companyId:probe.company_id,teamId:probe.team_id,jobId:probe.id},command);}
 catch{rpcRejected=true;}
 const recorded=await faultEvidence(env.DB,command);
 if(!recorded)return {requested:false,rpcRejected};
 // A fresh stub is needed after an abort. A changed boot proves reset; it does
 // not prove recovery or a stopped old process, which are recorded separately.
 const after=await env.SOLVER.getByName(name).executionState();
 await env.DB.prepare('UPDATE compute_fault_probe SET after_boot=?,after_process_running=?,observed_at=? WHERE id=? AND observed_at IS NULL')
  .bind(after.bootId,after.processRunning?1:0,Date.now(),command.operationId).run();
 return {requested:true,rpcRejected,resetObserved:command.mode==='restart'&&after.bootId!==recorded.before_boot,evidence:await faultEvidence(env.DB,command),executionAfter:after};
}
export async function diagnoseComputeProbe(env:Env,id:string){
 const probe=await probeRow(env,id);return env.SOLVER.getByName(`company:${probe.company_id}:team:${probe.team_id}`).diagnoseTransport();
}
export async function cleanupComputeProbe(env:Env,id:string){
 const probe=await probeRow(env,id),job=(await loadJob(env.DB,probe.company_id,probe.team_id,id))!;
 if(ACTIVE_STATES.has(job.state)){
  if(['QUEUED','RUNNING'].includes(job.state))await cancelJob(env.DB,probe.company_id,probe.team_id,probe.admin_user_id,id,{operationId:crypto.randomUUID(),expectedAttempt:job.attempt});
  await dispatchJobs(env.DB,env.COMPUTE_QUEUE);
  return {cleaned:false,cancellationPending:true};
 }
 const stopped=await env.SOLVER.getByName(`company:${probe.company_id}:team:${probe.team_id}`).releaseIdleProbe();
 if(!stopped.released)return {cleaned:false,cancellationPending:false,processReleased:false,cleanupPending:true};
 await disableProbeAccounts(env,probe.admin_user_id,probe.staff_user_id);
 await env.DB.prepare('UPDATE compute_probe SET cleaned_at=? WHERE id=?').bind(Date.now(),id).run();
 return {cleaned:true,cancellationPending:false,processReleased:stopped.released};
}
export async function cleanupExpiredComputeProbes(env:Env){
 const expired=await env.DB.prepare('SELECT id FROM compute_probe WHERE expires_at<=? AND cleaned_at IS NULL LIMIT 50').bind(Date.now()).all<{id:string}>();
 for(const probe of expired.results)try{await cleanupComputeProbe(env,probe.id);}catch{/* Retry a racing cancellation/temporary failure on the next cron. */}
}
