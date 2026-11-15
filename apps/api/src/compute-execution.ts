import {SCHEDULE_JSON_LIMIT,encodeStoredSchedule,scheduleObjectMetadata} from './schedule-serialization';
import {z} from 'zod';
import {optimizerInputSchema,type OptimizerInput} from '../../../packages/contracts/optimizer-input.generated';
import {readInputSnapshot,sha256} from './input-snapshots';
import {claimJob,completeJob,endJob,loadJob,boundedBytes,ACTIVE_STATES,type JobMessage} from './compute-jobs';
import {ProductError} from './product';
import {readDraft} from './schedule-drafts';

const solved=z.object({schemaVersion:z.literal('multi-task-v1'),tenantId:z.string(),teamId:z.string(),month:z.string(),mode:optimizerInputSchema.shape.mode,
 inputVersion:z.number().int(),settingsVersion:z.number().int(),jobId:z.string(),attempt:z.number().int(),
 solverStatus:z.enum(['OPTIMAL','FEASIBLE','INFEASIBLE','UNKNOWN','MODEL_INVALID']),assignments:z.array(z.unknown()).nullable()}).passthrough();
const checked=z.object({status:z.enum(['VERIFIED','HISTORY_UNVERIFIED','INVALID']),scope:z.literal('multi-task-v1'),violations:z.array(z.string())}).passthrough();
export type ContainerTransport=(path:'/solve'|'/check',payload:object)=>Promise<Response>;
export type ExecutionResult='DONE'|'BUSY'|'RETRY';
export async function executeJob(env:Pick<Env,'DB'|'INPUTS'>&Partial<Pick<Env,'OPTIMIZER_SOLVE_PROFILE'>>,message:JobMessage,transport:ContainerTransport,terminate:()=>Promise<void>):Promise<ExecutionResult> {
 const job=await claimJob(env.DB,message);
 if(!job){const old=await loadJob(env.DB,message.companyId,message.teamId,message.jobId);return old&&['RUNNING','CANCELLING'].includes(old.state)?'BUSY':'DONE';}
 let disposition:{state:'FAILED'|'STALE'|'CANCELLED'|'QUEUED';code:string|null}|null=null;
 let committed=false;
 let stopStarted=false,stopped=false;
 const stop=async()=>{stopStarted=true;await terminate();stopped=true;};
 let phase:'SNAPSHOT_READ'|'SOLVE'|'CHECK'|'PROCESS_STOP'|'RESULT_UPLOAD'|'RESULT_COMMIT'='SNAPSHOT_READ';
 try{
  const frozen=await readInputSnapshot(env.DB,env.INPUTS,job.company_id,job.team_id,job.actor_id,job.snapshot_id,true);
  const input:OptimizerInput=optimizerInputSchema.parse({...frozen.input,jobId:job.id,attempt:job.attempt});
  const inputBytes=new TextEncoder().encode(JSON.stringify(input));
  let payload:object=input;
  const seeded=env.OPTIMIZER_SOLVE_PROFILE==='mvp-joint-seed-v1';
  const seedSource=seeded?frozen.draftSource:null;
  if(seeded){
   let savedCandidate:object|null=null;
   if(seedSource){
    const saved=await readDraft(env,job.company_id,job.team_id,job.actor_id,seedSource.draftId);
    if(saved.superseded||saved.draft.draftRevision!==seedSource.draftRevision)throw new ProductError('DRAFT_VERSION_CONFLICT');
    if(saved.draft.month!==input.month)throw new Error('SEED_IDENTITY_MISMATCH');
    // The immutable snapshot already carries only the authorized hard locks.
    // Prior duties remain advisory and are checked against this latest input
    // inside the container, never copied into new hard constraints.
    savedCandidate={source:seedSource,assignments:saved.draft.assignments};
    if(new TextEncoder().encode(JSON.stringify(savedCandidate)).byteLength>8_000_000)throw new Error('SOLVE_PAYLOAD_TOO_LARGE');
   }
   payload={schemaVersion:'solve-seed-v1',input,savedCandidate};
   if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>SCHEDULE_JSON_LIMIT)throw new Error('SOLVE_PAYLOAD_TOO_LARGE');
  }
  phase='SOLVE';
  const response=await transport('/solve',payload);
  if(!response.ok){await response.body?.cancel();throw new Error(`SOLVE_HTTP_${response.status}`);}
  const output=solved.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response.body,SCHEDULE_JSON_LIMIT))));
  let processExpired=false;
  for(const key of ['tenantId','teamId','month','mode','inputVersion','settingsVersion','jobId','attempt'] as const)if(output[key]!==input[key])throw new Error('RESULT_IDENTITY_MISMATCH');
  if(env.OPTIMIZER_SOLVE_PROFILE){
   if(!['mvp-joint-v1','mvp-joint-seed-v1','mvp-joint-covered-off-hints-v1','mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'].includes(env.OPTIMIZER_SOLVE_PROFILE)||output.calculationProfile!==env.OPTIMIZER_SOLVE_PROFILE)throw new Error('RESULT_SETTINGS_MISMATCH');
   z.object({budgetSeconds:z.literal(120),initialHintStrategy:z.literal('balanced-incumbent-v4')}).passthrough().parse(output.metrics);
   if(['mvp-joint-covered-off-hints-v1','mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'].includes(env.OPTIMIZER_SOLVE_PROFILE))z.object({coveredOffHintsEnabled:z.literal(true)}).passthrough().parse(output.metrics);
   if(env.OPTIMIZER_SOLVE_PROFILE==='mvp-joint-calendar-roster-v1')z.object({calendarRosterHintsEnabled:z.literal(true)}).passthrough().parse(output.metrics);
   if(env.OPTIMIZER_SOLVE_PROFILE==='mvp-joint-calendar-fallback-v1')z.object({calendarFallbackHintsEnabled:z.literal(true),calendarRosterHintsEnabled:z.literal(false)}).passthrough().parse(output.metrics);
   if(['mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'].includes(env.OPTIMIZER_SOLVE_PROFILE)){
    const {processBudget}=z.object({processBudget:z.object({seconds:z.literal(120),expired:z.boolean(),childReaped:z.literal(true),
     childExitCode:z.number().int(),terminationStatus:z.enum(['UNKNOWN','COMPLETED']),parentValidation:z.enum(['VERIFIED','HISTORY_UNVERIFIED','NOT_RUN'])}).passthrough()}).passthrough().parse(output.metrics);
    const parentStatus=output.assignments===null?'NOT_RUN':z.object({status:z.enum(['VERIFIED','HISTORY_UNVERIFIED'])}).passthrough().parse(output.validation).status;
    processExpired=processBudget.expired;
    if(processBudget.parentValidation!==parentStatus||
       (processBudget.expired?(parentStatus==='HISTORY_UNVERIFIED'||processBudget.terminationStatus!=='UNKNOWN'||output.termination!=='PROCESS_DEADLINE'||!['FEASIBLE','UNKNOWN'].includes(output.solverStatus)):
        processBudget.terminationStatus!=='COMPLETED'||processBudget.childExitCode!==0||output.termination==='PROCESS_DEADLINE'))throw new Error('RESULT_SETTINGS_MISMATCH');
   }
  }
  if(seeded){
   const source=z.object({draftId:z.string(),draftRevision:z.number().int().positive().safe()}).strict().nullable().parse(output.savedCandidateSource);
   if(source?.draftId!==seedSource?.draftId||source?.draftRevision!==seedSource?.draftRevision)throw new Error('RESULT_SEED_SOURCE_MISMATCH');
  }
  if(output.solverStatus==='MODEL_INVALID')throw new Error('MODEL_INVALID');
  const cancelled=await loadJob(env.DB,job.company_id,job.team_id,job.id);
  if(cancelled?.state==='CANCELLING'){disposition={state:'CANCELLED',code:null};return 'DONE';}
  let validation:object={status:'NOT_RUN',scope:'multi-task-v1',violations:[]};
  if(output.assignments!==null){
   if(!['OPTIMAL','FEASIBLE'].includes(output.solverStatus))throw new Error('RESULT_STATUS_MISMATCH');
   const payload={input,assignments:output.assignments};
   if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>SCHEDULE_JSON_LIMIT)throw new Error('CHECK_PAYLOAD_TOO_LARGE');
   phase='CHECK';
   const verification=await transport('/check',payload);
   if(!verification.ok){await verification.body?.cancel();throw new Error(`CHECK_HTTP_${verification.status}`);}
   const independent=checked.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(verification.body,SCHEDULE_JSON_LIMIT))));
   if(independent.status==='INVALID'||independent.violations.length||(processExpired&&independent.status!=='VERIFIED'))throw new Error('RESULT_INVALID');
   validation=independent;
  }else if(['OPTIMAL','FEASIBLE'].includes(output.solverStatus))throw new Error('RESULT_STATUS_MISMATCH');
  // Successful/no-solution adoption also releases the team's active-job lock.
  // Confirm physical termination first; a valid answer is not a stopped process.
  phase='PROCESS_STOP';
  await stop();
  const afterStop=await loadJob(env.DB,job.company_id,job.team_id,job.id);
  if(afterStop?.state==='CANCELLING'){disposition={state:'CANCELLED',code:null};return 'DONE';}
  // The solver's own validation is replaced by a separate /check invocation.
  const result={...output,validation,publication:'BLOCKED_A1',snapshotId:job.snapshot_id,snapshotSha256:frozen.snapshot.sha256,inputSha256:await sha256(inputBytes)};
  const bytes=await encodeStoredSchedule(result);
  const digest=await sha256(bytes),key=`companies/${job.company_id}/teams/${job.team_id}/jobs/${job.id}/attempts/${job.attempt}/${crypto.randomUUID()}.json`;
  phase='RESULT_UPLOAD';
  if(!await env.INPUTS.put(key,bytes,{sha256:digest,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:scheduleObjectMetadata(bytes)}))throw new Error('RESULT_UPLOAD_FAILED');
  phase='RESULT_COMMIT';
  committed=await completeJob(env.DB,job,{key,digest,bytes:bytes.byteLength,solverStatus:output.solverStatus,
   validationStatus:z.object({status:z.string()}).parse(validation).status,state:output.assignments===null?'NO_SOLUTION':'SUCCEEDED'});
  if(!committed){
   const current=await loadJob(env.DB,job.company_id,job.team_id,job.id);
   if(current?.state==='CANCELLING')disposition={state:'CANCELLED',code:null};
   else if(current?.state==='RUNNING')disposition={state:'FAILED',code:'EXECUTION_EXPIRED'};
   // An unreferenced result remains for later proven-safe GC. No current draft
   // or published shift is changed by computation completion.
  }
  return 'DONE';
 }catch(error){
  // An unknown stop must retain the attempt and durable fence. Do not turn it
  // into a retry or attempt a second stop in this invocation's finally block.
  if(stopStarted&&!stopped)throw error;
  const current=await loadJob(env.DB,job.company_id,job.team_id,job.id);
  // A transaction may have committed while only its response was lost. Its
  // immutable terminal state is authoritative; do not queue it again. An
  // unreadable state still throws and retains the DO fence for reconciliation.
  if(current&&!ACTIVE_STATES.has(current.state))return 'DONE';
  if(current?.state==='CANCELLING')disposition={state:'CANCELLED',code:null};
  else if(error instanceof ProductError)disposition={state:['VERSION_CONFLICT','DRAFT_VERSION_CONFLICT'].includes(error.code)?'STALE':'FAILED',code:error.code==='FORBIDDEN'?'ACCESS_REVOKED':error.code};
  else {
   const code=error instanceof Error?error.message:'';
   const terminal=error instanceof z.ZodError||error instanceof SyntaxError||code==='BODY_LIMIT'||['MODEL_INVALID','RESULT_IDENTITY_MISMATCH','SEED_IDENTITY_MISMATCH','RESULT_SEED_SOURCE_MISMATCH','SOLVE_PAYLOAD_TOO_LARGE','RESULT_SETTINGS_MISMATCH','RESULT_STATUS_MISMATCH','RESULT_INVALID','CHECK_PAYLOAD_TOO_LARGE','RESULT_TOO_LARGE'].includes(code);
   disposition={state:terminal||job.attempt>=3?'FAILED':'QUEUED',code:error instanceof z.ZodError?'RESULT_SHAPE_INVALID':error instanceof SyntaxError?'INVALID_JSON':terminal?code:/^(SOLVE|CHECK)_HTTP_[1-5][0-9]{2}$/.test(code)?code:`${phase}_FAILED`};
  }
  return disposition.state==='QUEUED'?'RETRY':'DONE';
 }finally{
  // Release/retry only after the process is known to have stopped. A failed
  // termination deliberately retains RUNNING/CANCELLING and its durable fence.
  if(!stopStarted)await stop();
  if(disposition&&!committed)await endJob(env.DB,job,disposition.state,disposition.code);
 }
}
export async function recoverStoppedJob(env:Pick<Env,'DB'>,message:JobMessage) {
 const old=await loadJob(env.DB,message.companyId,message.teamId,message.jobId);
 if(old&&['RUNNING','CANCELLING'].includes(old.state))await endJob(env.DB,old,old.state==='CANCELLING'?'CANCELLED':old.attempt<3?'QUEUED':'FAILED',old.state==='CANCELLING'?null:'PROCESS_RECOVERED');
}
