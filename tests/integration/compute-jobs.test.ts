import {env,applyD1Migrations,createExecutionContext,waitOnExecutionContext,createMessageBatch,getQueueResult} from 'cloudflare:test';
import {beforeAll,beforeEach,expect,it} from 'vitest';
import {inputFixture,probePolicy} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,loadJob,cancelJob,claimJob,endJob,completeJob,dispatchJobs,getJob,listJobs,readJobResult,type JobMessage,type ResultManifest} from '../../apps/api/src/compute-jobs';
import {executeJob,recoverStoppedJob,type ContainerTransport} from '../../apps/api/src/compute-execution';
import {createApp} from '../../apps/api/src/index';
import {handleJobMessages} from '../../apps/api/src/compute-worker';
import type {InputDatabase} from '../../apps/api/src/input-versions';
import type {OptimizerInput} from '../../packages/contracts/optimizer-input.generated';
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import {sha256} from '../../apps/api/src/input-snapshots';

let f:Awaited<ReturnType<typeof inputFixture>>,snapshotId:string;
const message=(id:string):JobMessage=>({version:1,companyId:f.company.companyId,teamId:f.team,jobId:id});
const command=()=>({operationId:crypto.randomUUID(),snapshotId,expectedRevision:f.revision});
const create=(data=command(),db:InputDatabase=env.DB,bucket=env.INPUTS)=>createJob(db,bucket,f.company.companyId,f.team,f.company.userId,data);
const row=(id:string)=>loadJob(env.DB,f.company.companyId,f.team,id);
const cancel=(id:string,attempt:number)=>cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:attempt});
const output=(input:OptimizerInput,assignments:unknown[]|null=[])=>({...input,assignments,solverStatus:assignments===null?'UNKNOWN':'FEASIBLE',validation:{status:'VERIFIED'},publication:'UNSAFE_SOLVER_CLAIM'});
const valid:ContainerTransport=async(path,payload)=>Response.json(path==='/solve'?output(payload as OptimizerInput):{status:'HISTORY_UNVERIFIED',scope:'multi-task-v1',violations:[],missingHistory:['fake-boundary']});
const manifest=(job:NonNullable<Awaited<ReturnType<typeof row>>>):ResultManifest=>({key:'test/'+job.id,digest:'0'.repeat(64),bytes:1,solverStatus:'UNKNOWN',validationStatus:'NOT_RUN',state:'NO_SOLUTION'});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{
 f=await inputFixture(env.DB);snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
});
it.each(['outbox','audit'])('compute acceptance silent %s omission creates no partial queued job',async fault=>{
 const c=command(),table=fault==='outbox'?'compute_outbox':'product_audit',when=fault==='audit'?" WHEN NEW.kind='compute:accepted'":'';
 await env.DB.prepare(`CREATE TRIGGER compute_accept_silent BEFORE INSERT ON ${table}${when} BEGIN SELECT RAISE(IGNORE); END`).run();
 try{
  await expect(create(c)).rejects.toThrow();expect(await row(c.operationId)).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM compute_outbox WHERE company_id=? AND job_id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM product_audit WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
 }finally{await env.DB.prepare('DROP TRIGGER compute_accept_silent').run();}
 expect((await create(c)).replayed).toBe(false);expect((await create(c)).replayed).toBe(true);
});
it.each(['QUEUED','RUNNING'].flatMap(state=>['operation','job','outbox','audit'].map(fault=>({state,fault}))))('compute cancel $state silent $fault omission preserves job until same-ID repair',async({state,fault})=>{
 const id=(await create()).job.id;if(state==='RUNNING')await claimJob(env.DB,message(id));const before=(await row(id))!;
 await env.DB.prepare('UPDATE compute_outbox SET next_delivery_at=12345 WHERE company_id=? AND job_id=?').bind(f.company.companyId,id).run();
 const c={operationId:crypto.randomUUID(),expectedAttempt:before.attempt};
 const target={operation:'BEFORE INSERT ON compute_cancel_operation',job:'BEFORE UPDATE ON compute_job',outbox:'BEFORE UPDATE ON compute_outbox',audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='compute:cancel_requested'"}[fault];
 await env.DB.prepare(`CREATE TRIGGER compute_cancel_silent ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
 const mark=()=>cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,c);
 try{
  await expect(mark()).rejects.toThrow();expect(await row(id)).toEqual(before);
  expect(await env.DB.prepare('SELECT next_delivery_at FROM compute_outbox WHERE company_id=? AND job_id=?').bind(f.company.companyId,id).first('next_delivery_at')).toBe(12345);
  for(const table of ['compute_cancel_operation','product_audit'])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
 }finally{await env.DB.prepare('DROP TRIGGER compute_cancel_silent').run();}
 expect(await mark()).toMatchObject({replayed:false,job:{state:state==='QUEUED'?'CANCELLED':'CANCELLING'}});expect((await mark()).replayed).toBe(true);
});
it('compute claim silent attempt omission preserves queued state and does not start transport',async()=>{
 const id=(await create()).job.id;await env.DB.prepare('CREATE TRIGGER compute_claim_silent BEFORE INSERT ON compute_attempt BEGIN SELECT RAISE(IGNORE); END').run();
 try{await expect(executeJob(env,message(id),async()=>{throw Error('UNRECORDED_ATTEMPT_EXECUTED');},async()=>{throw Error('UNCLAIMED_STOP');})).rejects.toThrow();expect(await row(id)).toMatchObject({state:'QUEUED',attempt:0,lease_token:null});}
 finally{await env.DB.prepare('DROP TRIGGER compute_claim_silent').run();}
 expect(await executeJob(env,message(id),valid,async()=>{})).toBe('DONE');expect(await row(id)).toMatchObject({state:'SUCCEEDED',attempt:1});
});
it.each(['FAILED','STALE','CANCELLED','QUEUED'] as const)('compute end %s silent attempt finish omission retains active lease until repair',async state=>{
 const id=(await create()).job.id,job=(await claimJob(env.DB,message(id)))!;
 await env.DB.prepare('CREATE TRIGGER compute_finish_silent BEFORE UPDATE ON compute_attempt BEGIN SELECT RAISE(IGNORE); END').run();
 try{await expect(endJob(env.DB,job,state,'Fictional failure')).rejects.toThrow();expect(await row(id)).toEqual(job);await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');}
 finally{await env.DB.prepare('DROP TRIGGER compute_finish_silent').run();}
 expect(await endJob(env.DB,job,state,'Fictional failure')).toBe(true);
 expect(await env.DB.prepare('SELECT final_state,failure_code FROM compute_attempt WHERE company_id=? AND job_id=? AND attempt=1').bind(f.company.companyId,id).first()).toEqual({final_state:state,failure_code:'Fictional failure'});
});
it('compute end silent job update is not a losing old lease and refuses false completion',async()=>{
 const id=(await create()).job.id,job=(await claimJob(env.DB,message(id)))!;
 await env.DB.prepare('CREATE TRIGGER compute_end_silent BEFORE UPDATE ON compute_job BEGIN SELECT RAISE(IGNORE); END').run();
 try{await expect(endJob(env.DB,job,'FAILED','Fictional failure')).rejects.toThrow();expect(await row(id)).toEqual(job);}
 finally{await env.DB.prepare('DROP TRIGGER compute_end_silent').run();}
 expect(await endJob(env.DB,job,'FAILED','Fictional failure')).toBe(true);expect(await endJob(env.DB,job,'FAILED','OLD')).toBe(false);
});
it.each([false,true])('compute result silent attempt finish omission blocks adoption and can adopt after same-lease repair (noAssignment=%s)',async noAssignment=>{
 const id=(await create()).job.id,job=(await claimJob(env.DB,message(id)))!,m={...manifest(job),state:noAssignment?'NO_SOLUTION' as const:'SUCCEEDED' as const,solverStatus:noAssignment?'UNKNOWN':'FEASIBLE',validationStatus:noAssignment?'NOT_RUN':'HISTORY_UNVERIFIED'};
 await env.DB.prepare('CREATE TRIGGER compute_adopt_silent BEFORE UPDATE ON compute_attempt BEGIN SELECT RAISE(IGNORE); END').run();
 try{await expect(completeJob(env.DB,job,m)).rejects.toThrow();expect(await row(id)).toEqual(job);expect(await env.DB.prepare('SELECT 1 FROM product_audit WHERE company_id=? AND id=?').bind(f.company.companyId,id+':completed').first()).toBeNull();}
 finally{await env.DB.prepare('DROP TRIGGER compute_adopt_silent').run();}
 expect(await completeJob(env.DB,job,m)).toBe(true);expect((await row(id))!.state).toBe(m.state);
 expect(await env.DB.prepare('SELECT final_state FROM compute_attempt WHERE company_id=? AND job_id=? AND attempt=1').bind(f.company.companyId,id).first('final_state')).toBe(m.state);
});
it('large result transport uses a separate checker and hashes stored gzip before decoding and identity checks',async()=>{
 const id=(await create()).job.id,large='fictional'.repeat(1_000_000);let checked=false,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/solve')return Response.json({...output(payload as OptimizerInput,[large]),validation:{status:'INVALID'}});
  expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(4_000_000);
  expect((payload as {assignments:string[]}).assignments[0]).toBe(large);checked=true;
  return Response.json({status:'HISTORY_UNVERIFIED',scope:'multi-task-v1',violations:[]});
 };
 expect(await executeJob(env,message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect(checked).toBe(true);expect(stopped).toBe(1);
 const job=(await row(id))!,object=(await env.INPUTS.get(job.result_key!))!,bytes=new Uint8Array(await object.arrayBuffer());
 expect(isCompressedSchedule(bytes)).toBe(true);expect(job.result_bytes).toBe(bytes.byteLength);
 expect(job.result_sha256).toBe(await sha256(bytes));
 expect(object.httpMetadata?.contentEncoding).toBeUndefined();
 const result=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id);
 expect(result.result.assignments).toEqual([large]);expect(result.result.validation.status).toBe('HISTORY_UNVERIFIED');
 bytes[bytes.length-1]^=1;await env.INPUTS.put(job.result_key!,bytes);
 await expect(readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).rejects.toThrow('RESULT_DIGEST_MISMATCH');
});
it.each(['','mvp-joint-v1','mvp-joint-covered-off-hints-v1','mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'])('normal job profile %s preserves settings with a separate checker and process termination (controlled transport)',async(profile)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/solve')return Response.json({...output(payload as OptimizerInput),calculationProfile:profile||'legacy-poc-v1',metrics:{budgetSeconds:profile?120:20,initialHintStrategy:profile?'balanced-incumbent-v4':'legacy-first-v1',coveredOffHintsEnabled:['mvp-joint-covered-off-hints-v1','mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'].includes(profile),calendarRosterHintsEnabled:profile==='mvp-joint-calendar-roster-v1',calendarFallbackHintsEnabled:profile==='mvp-joint-calendar-fallback-v1',
   ...(['mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1'].includes(profile)?{processBudget:{seconds:120,expired:false,childReaped:true,childExitCode:0,terminationStatus:'COMPLETED',parentValidation:'VERIFIED'}}:{})}});
  checks++;return Response.json({status:'HISTORY_UNVERIFIED',scope:'multi-task-v1',violations:[]});
 };
 expect(await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:profile},message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect(checks).toBe(1);expect(stopped).toBe(1);
 const saved=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id);
 expect(saved.result.calculationProfile).toBe(profile||'legacy-poc-v1');expect(saved.result.validation.status).toBe('HISTORY_UNVERIFIED');
});
for(const profile of ['mvp-joint-process-budget-v1','mvp-joint-calendar-roster-v1','mvp-joint-calendar-fallback-v1']){
it.each([
 {childReaped:false},{seconds:75},{parentValidation:'NOT_RUN'},{parentValidation:'HISTORY_UNVERIFIED'},{childExitCode:7},
 {expired:true},{terminationStatus:'UNKNOWN'},
])('process profile refuses inconsistent lifecycle %j before checking or saving',async(change)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/check'){checks++;return Response.json({status:'VERIFIED',scope:'multi-task-v1',violations:[]});}
  return Response.json({...output(payload as OptimizerInput),calculationProfile:profile,
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,calendarRosterHintsEnabled:profile==='mvp-joint-calendar-roster-v1',calendarFallbackHintsEnabled:profile==='mvp-joint-calendar-fallback-v1',
    processBudget:{seconds:120,expired:false,childReaped:true,childExitCode:0,terminationStatus:'COMPLETED',parentValidation:'VERIFIED',...change}}});
 };
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:profile},message(id),transport,async()=>{stopped++;});
 expect((await row(id))!).toMatchObject({state:'FAILED',result_key:null});expect(checks).toBe(0);expect(stopped).toBe(1);
});
it.each(['HISTORY_UNVERIFIED','INVALID','DEADLINE'])('reference result keeps parent status and still requires independent check (%s)',async(status)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/check'){checks++;return Response.json({status,scope:'multi-task-v1',violations:status==='INVALID'?['WORKED_MINUTES:changed']:[],missingHistory:['boundary']});}
  return Response.json({...output(payload as OptimizerInput),validation:{status:'HISTORY_UNVERIFIED'},calculationProfile:profile,
   ...(status==='DEADLINE'?{termination:'PROCESS_DEADLINE'}:{}),
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,calendarRosterHintsEnabled:profile==='mvp-joint-calendar-roster-v1',calendarFallbackHintsEnabled:profile==='mvp-joint-calendar-fallback-v1',
    processBudget:{seconds:120,expired:status==='DEADLINE',childReaped:true,childExitCode:0,terminationStatus:status==='DEADLINE'?'UNKNOWN':'COMPLETED',parentValidation:'HISTORY_UNVERIFIED'}}});
 };
 expect(await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:profile},message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect(checks).toBe(status==='DEADLINE'?0:1);expect(stopped).toBe(1);
 if(status==='DEADLINE')expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SETTINGS_MISMATCH',result_key:null});
 else if(status==='INVALID')expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_INVALID',result_key:null});
 else{
  expect((await row(id))!).toMatchObject({state:'SUCCEEDED',validation_status:'HISTORY_UNVERIFIED'});
  const saved=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id);
  expect(saved.result.validation.status).toBe('HISTORY_UNVERIFIED');expect(saved.result.publication).toBe('BLOCKED_A1');
  expect((saved.result.metrics as {processBudget:{parentValidation:string}}).processBudget.parentValidation).toBe('HISTORY_UNVERIFIED');
 }
});
it.each(['no-candidate','verified','history'])('a reaped process deadline requires a separately verified candidate (%s)',async(kind)=>{
 const hasCandidate=kind!=='no-candidate';
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/check'){checks++;return Response.json({status:kind==='history'?'HISTORY_UNVERIFIED':'VERIFIED',scope:'multi-task-v1',violations:[]});}
  return Response.json({...output(payload as OptimizerInput),solverStatus:hasCandidate?'FEASIBLE':'UNKNOWN',assignments:hasCandidate?output(payload as OptimizerInput).assignments:null,
   termination:'PROCESS_DEADLINE',calculationProfile:profile,metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,calendarRosterHintsEnabled:profile==='mvp-joint-calendar-roster-v1',calendarFallbackHintsEnabled:profile==='mvp-joint-calendar-fallback-v1',
    processBudget:{seconds:120,expired:true,childReaped:true,childExitCode:-15,terminationStatus:'UNKNOWN',parentValidation:hasCandidate?'VERIFIED':'NOT_RUN'}}});
 };
 expect(await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:profile},message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect(checks).toBe(hasCandidate?1:0);expect(stopped).toBe(1);
 expect((await row(id))!).toMatchObject({state:kind==='history'?'FAILED':hasCandidate?'SUCCEEDED':'NO_SOLUTION'});
 if(kind==='history')expect((await row(id))!).toMatchObject({failure_code:'RESULT_INVALID',result_key:null});
});
}
it('the forced 75-second diagnostic cannot become a normal job configuration',async()=>{
 const id=(await create()).job.id;let checks=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-process-stop-75-v1'},message(id),async(path,payload)=>{
  if(path==='/check')checks++;
  return Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-process-stop-75-v1'});
 },async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SETTINGS_MISMATCH',result_key:null});expect(checks).toBe(0);
});
it.each([undefined,false,'true'])('covered-off profile refuses missing or mismatched hint metadata %s before checking or saving',async(coveredOffHintsEnabled)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/check'){checks++;return Response.json({status:'VERIFIED',scope:'multi-task-v1',violations:[]});}
  return Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-covered-off-hints-v1',
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled}});
 };
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-covered-off-hints-v1'},message(id),transport,async()=>{stopped++;});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SHAPE_INVALID',result_key:null});
 expect(checks).toBe(0);expect(stopped).toBe(1);
});
it.each([undefined,false,'true'])('calendar profile refuses missing or mismatched calendar metadata %s',async(calendarRosterHintsEnabled)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-roster-v1'},message(id),async(path,payload)=>{
  if(path==='/check'){checks++;throw new Error('CHECK_MUST_NOT_RUN');}
  return Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-calendar-roster-v1',
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,calendarRosterHintsEnabled,
    processBudget:{seconds:120,expired:false,childReaped:true,childExitCode:0,terminationStatus:'COMPLETED',parentValidation:'VERIFIED'}}});
 },async()=>{stopped++;});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SHAPE_INVALID',result_key:null});
 expect(checks).toBe(0);expect(stopped).toBe(1);
});
it('calendar candidate remains blocked when the separate checker rejects it; stop precedes the terminal state',async()=>{
 const id=(await create()).job.id;let stopped=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-roster-v1'},message(id),async(path,payload)=>{
  if(path==='/check')return Response.json({status:'INVALID',scope:'multi-task-v1',violations:['MONTHLY_HOURS']});
  return Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-calendar-roster-v1',
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,calendarRosterHintsEnabled:true,
    processBudget:{seconds:120,expired:false,childReaped:true,childExitCode:0,terminationStatus:'COMPLETED',parentValidation:'VERIFIED'}}});
 },async()=>{expect((await row(id))!.state).toBe('RUNNING');stopped++;});
 expect(stopped).toBe(1);expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_INVALID',result_key:null});
});
it.each(['mvp-split-process-v1','mvp-early-checkpoint-v1','mvp-checked-hint-v1'])('diagnostic-only %s cannot be adopted as a calendar job',async(profile)=>{
 const id=(await create()).job.id;let checks=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-roster-v1'},message(id),async(path,payload)=>{
  if(path==='/check')checks++;
  return Response.json({...output(payload as OptimizerInput),calculationProfile:profile});
 },async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SETTINGS_MISMATCH',result_key:null});expect(checks).toBe(0);
});
it.each([
 {calendarFallbackHintsEnabled:undefined,calendarRosterHintsEnabled:false},
 {calendarFallbackHintsEnabled:false,calendarRosterHintsEnabled:false},
 {calendarFallbackHintsEnabled:'true',calendarRosterHintsEnabled:false},
 {calendarFallbackHintsEnabled:true,calendarRosterHintsEnabled:true},
 {calendarFallbackHintsEnabled:true,calendarRosterHintsEnabled:undefined},
])('calendar fallback job refuses mismatched mode flags %j',async(flags)=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-fallback-v1'},message(id),async(path,payload)=>{
  if(path==='/check'){checks++;throw new Error('CHECK_MUST_NOT_RUN');}
  return Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-calendar-fallback-v1',
   metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4',coveredOffHintsEnabled:true,...flags,
    processBudget:{seconds:120,expired:false,childReaped:true,childExitCode:0,terminationStatus:'COMPLETED',parentValidation:'VERIFIED'}}});
 },async()=>{stopped++;});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SHAPE_INVALID',result_key:null});
 expect(checks).toBe(0);expect(stopped).toBe(1);
});
it.each([undefined,'legacy-poc-v1'])('a configured normal profile refuses stale/mismatched runtime metadata %s without saving a result',async(calculationProfile)=>{
 const id=(await create()).job.id;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-v1'},message(id),async(_path,payload)=>Response.json({...output(payload as OptimizerInput),calculationProfile}),async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SETTINGS_MISMATCH',result_key:null});
});
it('matching profile name cannot conceal a different solver strategy or budget',async()=>{
 const id=(await create()).job.id;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-v1'},message(id),async(_path,payload)=>Response.json({...output(payload as OptimizerInput),calculationProfile:'mvp-joint-v1',metrics:{budgetSeconds:240,initialHintStrategy:'legacy-first-v1'}}),async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SHAPE_INVALID',result_key:null});
});
it('opt-in seeded profile without a draft keeps input identity and separate checking (controlled transport)',async()=>{
 const id=(await create()).job.id;let checks=0,stopped=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/solve'){
   const envelope=payload as {schemaVersion:string;input:OptimizerInput;savedCandidate:null};
   expect(envelope.schemaVersion).toBe('solve-seed-v1');expect(envelope.savedCandidate).toBeNull();
   expect(Object.keys(envelope).sort()).toEqual(['input','savedCandidate','schemaVersion']);
   expect(envelope.input.jobId).toBe(id);expect(envelope.input.attempt).toBe(1);
   return Response.json({...output(envelope.input),calculationProfile:'mvp-joint-seed-v1',savedCandidateSource:null,
    metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4'}});
  }
  checks++;expect((payload as {input:OptimizerInput}).input.jobId).toBe(id);
  return Response.json({status:'HISTORY_UNVERIFIED',scope:'multi-task-v1',violations:[]});
 };
 expect(await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-seed-v1'},message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect(checks).toBe(1);expect(stopped).toBe(1);expect((await row(id))!.state).toBe('SUCCEEDED');
});
it('opt-in runtime cannot substitute a different saved draft source before result check/storage',async()=>{
 const id=(await create()).job.id;let stopped=0,checks=0;
 await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-seed-v1'},message(id),async(path,payload)=>{
  if(path==='/check'){checks++;throw new Error('CHECK_MUST_NOT_RUN');}
  return Response.json({...output((payload as {input:OptimizerInput}).input),calculationProfile:'mvp-joint-seed-v1',
   savedCandidateSource:{draftId:'foreign-draft',draftRevision:1},metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4'}});
 },async()=>{stopped++;});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_SEED_SOURCE_MISMATCH',result_key:null});
 expect(checks).toBe(0);expect(stopped).toBe(1);
});
it('WP-04/Q104: simultaneous starts have one team winner; identical retries share the job and outbox',async()=>{
 const c=command(),outcomes=await Promise.all([create(c),create(c)]);
 expect(outcomes.map(r=>r.replayed).sort()).toEqual([false,true]);
 expect(await env.DB.prepare('SELECT count(*) n FROM compute_outbox WHERE company_id=?').bind(f.company.companyId).first('n')).toBe(1);
 await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');
 await expect(create({...c,snapshotId:crypto.randomUUID()})).rejects.toThrow('OPERATION_ID_CONFLICT');
 expect(await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(f.company.companyId).first('revision')).toBe(f.revision);
});
it('product UI: job history stays scoped to the authorized team and hides lease/actor/object secrets',async()=>{
 const first=(await create()).job.id;await cancel(first,0);const second=(await create()).job.id;
 const history=await listJobs(env.DB,f.company.companyId,f.team,f.company.userId);
 expect(history.jobs).toHaveLength(2);expect(new Set(history.jobs.map(j=>j.id))).toEqual(new Set([first,second]));
 for(const job of history.jobs){expect(job).toMatchObject({month:'2026-10',publication:'BLOCKED_A1'});for(const key of ['lease_token','fingerprint','actor_id','result_key'])expect(job).not.toHaveProperty(key);}
 await expect(listJobs(env.DB,f.company.companyId,crypto.randomUUID(),f.company.userId)).rejects.toThrow('FORBIDDEN');
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
 await expect(listJobs(env.DB,f.company.companyId,f.team,f.staffUser)).rejects.toThrow('FORBIDDEN');
 await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();
 await expect(listJobs(env.DB,f.company.companyId,f.team,f.company.userId)).rejects.toThrow('FORBIDDEN');
});
it('WP-04: audit failure rolls back both acceptance and delivery obligation',async()=>{
 await env.DB.prepare("CREATE TRIGGER reject_job_audit BEFORE INSERT ON product_audit WHEN NEW.kind='compute:accepted' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END").run();
 const c=command();
 try{await expect(create(c)).rejects.toThrow('INJECTED_FAILURE');expect(await row(c.operationId)).toBeNull();expect(await env.DB.prepare('SELECT job_id FROM compute_outbox WHERE company_id=?').bind(f.company.companyId).first()).toBeNull();}
 finally{await env.DB.prepare('DROP TRIGGER reject_job_audit').run();}
});
it('WP-04: permission and input revision are rechecked inside acceptance transaction',async()=>{
 const c=command();const db={prepare:(sql:string)=>env.DB.prepare(sql),batch:async<T>(statements:D1PreparedStatement[])=>{
  await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();return env.DB.batch<T>(statements);
 }};
 await expect(create(c,db)).rejects.toThrow('FORBIDDEN');expect(await row(c.operationId)).toBeNull();
 await env.DB.prepare('UPDATE access_state SET enabled=1 WHERE user_id=?').bind(f.company.userId).run();
 await f.save('company_policy',probePolicy);
 await expect(create(c)).rejects.toThrow('VERSION_CONFLICT');
});
it('WP-04: failed send and lost delivery replay from D1 without exposing input or object keys',async()=>{
 const id=(await create()).job.id;const now=Date.now();
 const failed=await dispatchJobs(env.DB,{send:async()=>{throw new Error('SEND_FAILED');}},now);expect(failed.sent).toBe(0);expect(failed.failed).toBeGreaterThan(0);
 const sent:unknown[]=[];const queue:Pick<Queue,'send'>={send:async(body:unknown)=>{sent.push(body);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};}};
 expect((await dispatchJobs(env.DB,queue,now+61_000)).failed).toBe(0);
 expect((await dispatchJobs(env.DB,queue,now+122_000)).failed).toBe(0);
 expect(sent.filter(body=>(body as JobMessage).jobId===id)).toEqual([message(id),message(id)]);for(const body of sent)expect(Object.keys(body as object).sort()).toEqual(['companyId','jobId','teamId','version']);expect((await row(id))!.state).toBe('QUEUED');
});
it('WP-04: duplicate consumers obtain one execution lease; an old lease cannot overwrite a retry',async()=>{
 const id=(await create()).job.id;
 const claims=await Promise.all([claimJob(env.DB,message(id)),claimJob(env.DB,message(id))]);
 expect(claims.filter(Boolean)).toHaveLength(1);const first=claims.find(Boolean)!;
 await recoverStoppedJob(env,message(id));const second=(await claimJob(env.DB,message(id)))!;
 expect(second.attempt).toBe(2);expect(second.lease_token).not.toBe(first.lease_token);
 expect(await completeJob(env.DB,first,manifest(first))).toBe(false);expect(await endJob(env.DB,first,'FAILED','OLD')).toBe(false);
 expect((await row(id))!.state).toBe('RUNNING');
});
it('WP-04: a separate checker replaces solver assertions; result bytes and lineage are preserved, never published',async()=>{
 const id=(await create()).job.id;let stopped=0;
 expect(await executeJob(env,message(id),valid,async()=>{stopped++;})).toBe('DONE');expect(stopped).toBe(1);
 const done=(await row(id))!;expect(done).toMatchObject({state:'SUCCEEDED',attempt:1,solver_status:'FEASIBLE',validation_status:'HISTORY_UNVERIFIED',lease_token:null});
 const result=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id);
 expect(result).toMatchObject({stale:false,publication:'BLOCKED_A1',result:{jobId:id,snapshotId,validation:{status:'HISTORY_UNVERIFIED'},publication:'BLOCKED_A1'}});
 expect(await executeJob(env,message(id),async()=>{throw new Error('DUPLICATE_EXECUTED');},async()=>{})).toBe('DONE');
 expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.company.companyId).first('n')).toBe(1);
 await expect(env.DB.prepare('DELETE FROM compute_job WHERE company_id=? AND id=?').bind(f.company.companyId,id).run()).rejects.toThrow('IMMUTABLE_JOB');
 await expect(env.DB.prepare("UPDATE compute_attempt SET final_state='FAILED' WHERE company_id=? AND job_id=?").bind(f.company.companyId,id).run()).rejects.toThrow('IMMUTABLE_ATTEMPT');
});
it('WP-04: invalid assignments and mismatched job identity never become saved results',async()=>{
 const id=(await create()).job.id;
 await executeJob(env,message(id),async(path,payload)=>Response.json(path==='/solve'?output(payload as OptimizerInput):{status:'INVALID',scope:'multi-task-v1',violations:['MANDATORY']}),async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'RESULT_INVALID',result_key:null});
 const next=(await create()).job.id;
 await executeJob(env,message(next),async(_path,payload)=>Response.json({...output(payload as OptimizerInput),jobId:crypto.randomUUID()}),async()=>{});
 expect((await row(next))!).toMatchObject({state:'FAILED',failure_code:'RESULT_IDENTITY_MISMATCH',result_key:null});
});
it('WP-04: an input update after object upload rejects adoption at final D1 commit',async()=>{
 const id=(await create()).job.id;
 const bucket={get:env.INPUTS.get.bind(env.INPUTS),put:async(...args:Parameters<R2Bucket['put']>)=>{
  const saved=await env.INPUTS.put(...args);await f.save('company_policy',probePolicy);return saved;
 }} as R2Bucket;
 await executeJob({DB:env.DB,INPUTS:bucket},message(id),valid,async()=>{});
 expect((await row(id))!).toMatchObject({state:'STALE',failure_code:'INPUT_CHANGED',result_key:null});
 const objects=await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`});expect(objects.objects).toHaveLength(1);
 await expect(readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).rejects.toThrow('RESULT_NOT_READY');
});
it('WP-04: running cancellation keeps the team lock until process termination is confirmed',async()=>{
 const id=(await create()).job.id;
 let resume!:()=>void,start!:()=>void;const entered=new Promise<void>(r=>{start=r;});const pending=new Promise<void>(r=>{resume=r;});let stopped=false;
 const execution=executeJob(env,message(id),async(path,payload)=>{if(path==='/solve'){start();await pending;}return valid(path,payload);},async()=>{stopped=true;});
 await entered;expect((await cancel(id,1)).job.state).toBe('CANCELLING');
 await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');expect(stopped).toBe(false);
 resume();await execution;expect(stopped).toBe(true);expect((await row(id))!.state).toBe('CANCELLED');expect((await create()).job.state).toBe('QUEUED');
});
it('WP-04: failed process termination retains active job; stopped recovery retries at most three times',async()=>{
 const id=(await create()).job.id;
 await expect(executeJob(env,message(id),async()=>{throw new Error('PROCESS_LOST');},async()=>{throw new Error('STOP_UNCONFIRMED');})).rejects.toThrow('STOP_UNCONFIRMED');
 expect((await row(id))!.state).toBe('RUNNING');await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');
 await recoverStoppedJob(env,message(id));
 for(let attempt=2;attempt<=3;attempt++){
  await executeJob(env,message(id),async()=>{throw new Error('PROCESS_LOST');},async()=>{});
  expect((await row(id))!.attempt).toBe(attempt);
 }
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'SOLVE_FAILED'});
});
it.each([false,true])('WP-04: a valid result without confirmed process termination stays RUNNING and cannot release the team lock (noAssignment=%s)',async(noAssignment)=>{
 const id=(await create()).job.id;let stops=0;
 await expect(executeJob(env,message(id),noAssignment?async(_path,payload)=>Response.json(output(payload as OptimizerInput,null)):valid,async()=>{
  stops++;throw new Error('PROCESS_STOP_UNCONFIRMED');
 })).rejects.toThrow('PROCESS_STOP_UNCONFIRMED');
 expect(stops).toBe(1);expect((await row(id))!).toMatchObject({state:'RUNNING',attempt:1,result_key:null});
 await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');
 expect(await env.DB.prepare('SELECT final_state FROM compute_attempt WHERE company_id=? AND job_id=? AND attempt=1').bind(f.company.companyId,id).first('final_state')).toBeNull();
 expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND id=?").bind(f.company.companyId,id+':completed').first('n')).toBe(0);
 expect((await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`})).objects).toHaveLength(0);
});
it('WP-04: cancellation during process-stop confirmation blocks new jobs and prevents successful result adoption',async()=>{
 const id=(await create()).job.id;let entered!:()=>void,release!:()=>void;
 const starting=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{release=r;});
 const execution=executeJob(env,message(id),valid,async()=>{entered();await waiting;});
 await starting;
 try{
  expect((await row(id))!).toMatchObject({state:'RUNNING',result_key:null});
  await expect(create()).rejects.toThrow('TEAM_JOB_ACTIVE');
  expect(await executeJob(env,message(id),async()=>{throw Error('DUPLICATE_EXECUTED');},async()=>{})).toBe('BUSY');
  expect((await cancel(id,1)).job.state).toBe('CANCELLING');
 }finally{release();await execution;}
 expect((await row(id))!).toMatchObject({state:'CANCELLED',result_key:null});
 expect((await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`})).objects).toHaveLength(0);
 expect((await create()).job.state).toBe('QUEUED');
});
it('WP-04: UNKNOWN with no assignment stays distinct from INFEASIBLE; expired execution cannot commit',async()=>{
 const id=(await create()).job.id;
 await executeJob(env,message(id),async(_path,payload)=>Response.json(output(payload as OptimizerInput,null)),async()=>{});
 expect((await row(id))!).toMatchObject({state:'NO_SOLUTION',solver_status:'UNKNOWN',validation_status:'NOT_RUN'});
 const next=(await create()).job.id,claimed=(await claimJob(env.DB,message(next)))!;
 expect(await completeJob(env.DB,claimed,manifest(claimed),claimed.lease_expires_at!+1)).toBe(false);
});
it('WP-04: result reads recheck live permission, scope and digest; queued cancellation is replayable',async()=>{
 const id=(await create()).job.id;await executeJob(env,message(id),valid,async()=>{});
 const other=await inputFixture(env.DB);
 await expect(getJob(env.DB,f.company.companyId,f.team,other.company.userId,id)).rejects.toThrow('FORBIDDEN');
 await expect(getJob(env.DB,other.company.companyId,other.team,other.company.userId,id)).rejects.toThrow('NOT_FOUND');
 const job=(await row(id))!,raw=await(await env.INPUTS.get(job.result_key!))!.text();
 await env.INPUTS.put(job.result_key!,raw.replace('FEASIBLE','FEASIBLX'));
 await expect(readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).rejects.toThrow('RESULT_DIGEST_MISMATCH');
 await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();
 await expect(readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).rejects.toThrow('FORBIDDEN');
 await env.DB.prepare('UPDATE access_state SET enabled=1 WHERE user_id=?').bind(f.company.userId).run();
 const next=(await create()).job.id,c={operationId:crypto.randomUUID(),expectedAttempt:0};
 expect((await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,next,c)).job.state).toBe('CANCELLED');
 expect((await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,next,c)).replayed).toBe(true);
});
it('WP-04: completion audit failure rolls back result adoption and process-stopped retry retains attempt history',async()=>{
 const id=(await create()).job.id;
 await env.DB.prepare("CREATE TRIGGER reject_result_audit BEFORE INSERT ON product_audit WHEN NEW.kind='compute:completed' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END").run();
 try{expect(await executeJob(env,message(id),valid,async()=>{})).toBe('RETRY');expect((await row(id))!).toMatchObject({state:'QUEUED',attempt:1,result_key:null});}
 finally{await env.DB.prepare('DROP TRIGGER reject_result_audit').run();}
 await executeJob(env,message(id),valid,async()=>{});
 expect((await row(id))!).toMatchObject({state:'SUCCEEDED',failure_code:null});
 const attempts=await env.DB.prepare('SELECT attempt,final_state FROM compute_attempt WHERE company_id=? AND job_id=? ORDER BY attempt').bind(f.company.companyId,id).all();
 expect(attempts.results).toEqual([{attempt:1,final_state:'QUEUED'},{attempt:2,final_state:'SUCCEEDED'}]);
});
it.each([false,true])('WP-04: a silently skipped completion audit cannot commit a result (noAssignment=%s)',async(noAssignment)=>{
 const id=(await create()).job.id;let stopped=0;
 const transport=noAssignment?async(_path:'/solve'|'/check',payload:object)=>Response.json(output(payload as OptimizerInput,null)):valid;
 await env.DB.prepare("CREATE TRIGGER ignore_result_audit BEFORE INSERT ON product_audit WHEN NEW.kind='compute:completed' BEGIN SELECT RAISE(IGNORE); END").run();
 try{
  expect(await executeJob(env,message(id),transport,async()=>{stopped++;})).toBe('RETRY');
  expect(stopped).toBe(1);expect((await row(id))!).toMatchObject({state:'QUEUED',attempt:1,result_key:null});
  expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.company.companyId).first('n')).toBe(0);
 }finally{await env.DB.prepare('DROP TRIGGER ignore_result_audit').run();}
 expect(await executeJob(env,message(id),transport,async()=>{stopped++;})).toBe('DONE');
 expect((await row(id))!).toMatchObject({state:noAssignment?'NO_SOLUTION':'SUCCEEDED',attempt:2,failure_code:null});
 expect(stopped).toBe(2);
});
it.each([false,true])('WP-04: a committed result with a lost D1 response is acknowledged from its terminal state (noAssignment=%s)',async(noAssignment)=>{
 const id=(await create()).job.id;let lost=false,stopped=0,transports=0;
 const DB=new Proxy(env.DB,{get(target,key){
  if(key==='batch')return async<T>(statements:D1PreparedStatement[])=>{
   const results=await target.batch<T>(statements);
   if(!lost&&['SUCCEEDED','NO_SOLUTION'].includes((await row(id))?.state??'')){lost=true;throw Error('D1_RESPONSE_LOST');}
   return results;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await executeJob({...env,DB},message(id),async(path,payload)=>{transports++;return noAssignment?Response.json(output(payload as OptimizerInput,null)):valid(path,payload);},async()=>{stopped++;})).toBe('DONE');
 expect(lost).toBe(true);expect(stopped).toBe(1);expect(transports).toBe(noAssignment?1:2);
 expect((await row(id))!).toMatchObject({state:noAssignment?'NO_SOLUTION':'SUCCEEDED',attempt:1,failure_code:null});
 expect(await executeJob(env,message(id),async()=>{throw Error('DUPLICATE_CALCULATION');},async()=>{throw Error('DUPLICATE_STOP');})).toBe('DONE');
 expect((await getJob(env.DB,f.company.companyId,f.team,f.company.userId,id)).attempts).toHaveLength(1);
 expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.company.companyId).first('n')).toBe(1);
 expect((await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).result.jobId).toBe(id);
});
it.each([false,true])('WP-04: R2 write failure/lost response preserves retry lineage and never references an uncertain object (stored=%s)',async(stored)=>{
 const id=(await create()).job.id;let stopped=0;
 const INPUTS=new Proxy(env.INPUTS,{get(target,key){
  if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{expect(stopped).toBe(1);if(stored)await target.put(...args);throw Error('R2_RESPONSE_LOST');};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await executeJob({...env,INPUTS},message(id),valid,async()=>{stopped++;})).toBe('RETRY');
 expect((await row(id))!).toMatchObject({state:'QUEUED',attempt:1,result_key:null,failure_code:'RESULT_UPLOAD_FAILED'});
 const prefix=`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`,before=(await env.INPUTS.list({prefix})).objects;
 expect(before).toHaveLength(stored?1:0);
 await expect(readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).rejects.toThrow('RESULT_NOT_READY');
 expect(await executeJob(env,message(id),valid,async()=>{stopped++;})).toBe('DONE');
 const done=(await row(id))!;expect(done).toMatchObject({state:'SUCCEEDED',attempt:2,failure_code:null});
 expect(before.every(object=>object.key!==done.result_key)).toBe(true);
 expect((await env.INPUTS.list({prefix})).objects).toHaveLength(stored?2:1);
 expect((await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id)).result.attempt).toBe(2);
 expect((await getJob(env.DB,f.company.companyId,f.team,f.company.userId,id)).attempts.map(a=>a.final_state)).toEqual(['QUEUED','SUCCEEDED']);
 expect(stopped).toBe(2);
});
it('WP-04: cancellation during an R2 response loss ends cancelled after stop and retains the unreferenced object',async()=>{
 const id=(await create()).job.id;let stopped=0;
 const INPUTS=new Proxy(env.INPUTS,{get(target,key){
  if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
   expect(stopped).toBe(1);await target.put(...args);expect((await cancel(id,1)).job.state).toBe('CANCELLING');throw Error('R2_RESPONSE_LOST');
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await executeJob({...env,INPUTS},message(id),valid,async()=>{stopped++;})).toBe('DONE');
 expect((await row(id))!).toMatchObject({state:'CANCELLED',attempt:1,result_key:null});expect(stopped).toBe(1);
 expect((await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`})).objects).toHaveLength(1);
 expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.company.companyId).first('n')).toBe(0);
 expect((await create()).job.state).toBe('QUEUED');
});
it('WP-04: an input update after an uncertain R2 upload makes the same-job retry stale before another solver call',async()=>{
 const id=(await create()).job.id;let solves=0;
 const INPUTS=new Proxy(env.INPUTS,{get(target,key){
  if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{await target.put(...args);await f.save('company_policy',probePolicy);throw Error('R2_RESPONSE_LOST');};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await executeJob({...env,INPUTS},message(id),async(path,payload)=>{if(path==='/solve')solves++;return valid(path,payload);},async()=>{})).toBe('RETRY');
 expect(await executeJob(env,message(id),async()=>{throw Error('STALE_INPUT_EXECUTED');},async()=>{})).toBe('DONE');
 expect(solves).toBe(1);expect((await row(id))!).toMatchObject({state:'STALE',attempt:2,result_key:null,failure_code:'VERSION_CONFLICT'});
 expect((await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/jobs/${id}/`})).objects).toHaveLength(1);
});
it('WP-04: unreadable D1 state after a committed response loss cannot fabricate a retry, and later reconciliation does not recalculate',async()=>{
 const id=(await create()).job.id;let lost=false,stopped=0;
 const DB=new Proxy(env.DB,{get(target,key){
  if(key==='prepare')return (sql:string)=>{if(lost)throw Error('D1_UNAVAILABLE');return target.prepare(sql);};
  if(key==='batch')return async<T>(statements:D1PreparedStatement[])=>{
   const results=await target.batch<T>(statements);if(!lost&&(await row(id))?.state==='SUCCEEDED'){lost=true;throw Error('D1_RESPONSE_LOST');}return results;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(executeJob({...env,DB},message(id),valid,async()=>{stopped++;})).rejects.toThrow('D1_UNAVAILABLE');
 expect(stopped).toBe(1);expect((await row(id))!).toMatchObject({state:'SUCCEEDED',attempt:1});
 await recoverStoppedJob(env,message(id));
 expect(await executeJob(env,message(id),async()=>{throw Error('DUPLICATE_EXECUTION');},async()=>{throw Error('DUPLICATE_STOP');})).toBe('DONE');
 expect((await getJob(env.DB,f.company.companyId,f.team,f.company.userId,id)).attempts).toHaveLength(1);
});
it('WP-04: a conflicting canonical audit cannot substitute for this result adoption',async()=>{
 const id=(await create()).job.id;
 await env.DB.prepare('INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)').bind(f.company.companyId,id+':completed',f.company.userId,'conflicting-kind',f.revision,Date.now()).run();
 expect(await executeJob(env,message(id),valid,async()=>{})).toBe('RETRY');
 expect((await row(id))!).toMatchObject({state:'QUEUED',result_key:null,failure_code:'RESULT_COMMIT_FAILED'});
 expect(await env.DB.prepare('SELECT kind FROM product_audit WHERE company_id=? AND id=?').bind(f.company.companyId,id+':completed').first('kind')).toBe('conflicting-kind');
});
it('WP-04: permission revoked after independent checking prevents final result adoption',async()=>{
 const id=(await create()).job.id;
 await executeJob(env,message(id),async(path,payload)=>{
  const result=await valid(path,payload);
  if(path==='/check')await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();
  return result;
 },async()=>{});
 expect((await row(id))!).toMatchObject({state:'FAILED',failure_code:'ACCESS_REVOKED',result_key:null});
});
it('WP-04: individual queue acknowledgement separates invalid, completed, busy and failed deliveries',async()=>{
 const id=(await create()).job.id;
 const batch=createMessageBatch<unknown>('test',[
  {id:'bad',timestamp:Date.now(),attempts:1,body:{...message(id),objectKey:'untrusted'}},
  ...['done','busy','failed'].map(key=>({id:key,timestamp:Date.now(),attempts:1,body:message(id)})),
 ]);
 const delays:{id:string;seconds:number|undefined}[]=[];
 for(const item of batch.messages){const retry=item.retry.bind(item);item.retry=(options)=>{delays.push({id:item.id,seconds:options?.delaySeconds});retry(options);};}
 let calls=0;await handleJobMessages(batch,async()=>{calls++;if(calls===1)return 'DONE';if(calls===2)return 'BUSY';throw new Error('TEMPORARY');});
 const result=await getQueueResult(batch,createExecutionContext());
 expect(result.explicitAcks.sort()).toEqual(['bad','done']);expect(result.retryMessages.map(r=>r.msgId)).toEqual(['busy','failed']);expect(delays).toEqual([{id:'busy',seconds:10},{id:'failed',seconds:30}]);
});
it('WP-04: product HTTP returns an accepted job, enforces Origin/body/session and uses delivery after response',async()=>{
 const app=createApp(),base=env.AUTH_BASE_URL,path=`/api/companies/${f.company.companyId}/compute/teams/${f.team}/jobs`;
 const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
 const cookie=login.headers.get('set-cookie')!.split(';')[0];const c=command();
 expect((await app.request(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(c)},env)).status).toBe(401);
 const headers={cookie,origin:base,'content-type':'application/json'};
 expect((await app.request(base+path,{method:'POST',headers:{...headers,origin:'https://other.invalid'},body:JSON.stringify(c)},env)).status).toBe(403);
 expect((await app.request(base+path,{method:'POST',headers,body:JSON.stringify({...c,padding:'x'.repeat(5000)})},env)).status).toBe(413);
 const context=createExecutionContext(),sent:unknown[]=[];
 const queue:Queue={send:async(body)=>{sent.push(body);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};},sendBatch:env.COMPUTE_QUEUE.sendBatch.bind(env.COMPUTE_QUEUE),metrics:env.COMPUTE_QUEUE.metrics.bind(env.COMPUTE_QUEUE)};
 const response=await app.request(base+path,{method:'POST',headers,body:JSON.stringify(c)},{...env,COMPUTE_QUEUE:queue},context);
 expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toBe('no-store');await waitOnExecutionContext(context);
 expect(sent).toContainEqual(message(c.operationId));
 const status=await app.request(base+path+'/'+c.operationId,{headers:{cookie}},env);
 expect(status.status).toBe(200);const body=await status.json();expect(body).not.toHaveProperty('lease_token');expect(body).not.toHaveProperty('result_key');
});
