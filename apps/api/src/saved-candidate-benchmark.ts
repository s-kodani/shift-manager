// Private fictional probe. Never saves a schedule or changes normal job settings.
import {z} from 'zod';
import {optimizerBenchmark} from './optimizer-benchmark';
import {boundedBytes} from './compute-jobs';
import {sha256} from './input-snapshots';
import {probeHttpFailure,ProbeHttpFailure,type ProbeHttpDiagnostic} from './probe-http-failure';

export const savedCandidateBenchmark=z.object({
 schemaVersion:z.literal('solve-seed-v1'),
 input:optimizerBenchmark.shape.input,
 savedCandidate:z.object({
  source:z.object({draftId:z.string().min(1).max(200).startsWith('fictional-'),draftRevision:z.number().int().positive().safe()}).strict(),
  assignments:z.array(z.unknown()),
 }).strict().nullable(),
}).strict().superRefine((data,ctx)=>{
 const size=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
 if(size(data.input)>4_000_000||size(data.savedCandidate)>8_000_000||size(data)>16_000_000)
  ctx.addIssue({code:'custom',message:'BODY_LIMIT'});
});
export type SavedCandidateBenchmark=z.infer<typeof savedCandidateBenchmark>;
const healthSchema=z.object({status:z.literal('ok'),sourceSha256:z.record(z.string().regex(/^[a-z_]+\.py$/),z.string().regex(/^[a-f0-9]{64}$/)),runtime:z.object({uid:z.literal(65534),hasShell:z.literal(false),deploymentId:z.string().nullable()})}).passthrough();
const resultSchema=z.object({schemaVersion:z.literal('multi-task-v1'),tenantId:z.string(),teamId:z.string(),month:z.string(),mode:z.string(),inputVersion:z.number(),settingsVersion:z.number(),jobId:z.string(),attempt:z.number(),inputHash:z.string(),
 solverStatus:z.enum(['OPTIMAL','FEASIBLE','UNKNOWN','INFEASIBLE','MODEL_INVALID']),assignments:z.array(z.unknown()).nullable(),
 calculationProfile:z.literal('mvp-joint-seed-v1'),savedCandidateSource:savedCandidateBenchmark.shape.savedCandidate.unwrap().shape.source.nullable(),
 metrics:z.object({budgetSeconds:z.literal(120),initialHintStrategy:z.literal('balanced-incumbent-v4')}).passthrough(),
 stages:z.array(z.unknown()),validation:z.record(z.string(),z.unknown()),
}).passthrough();
const checkSchema=z.object({scope:z.literal('multi-task-v1'),status:z.enum(['VERIFIED','HISTORY_UNVERIFIED','INVALID']),violations:z.array(z.string()),objectiveVector:z.array(z.number()).optional()}).passthrough();
export type ProbeTransport=(path:'/health'|'/solve'|'/check',payload?:object)=>Promise<Response>;
const compact=(data:Record<string,unknown>)=>Object.fromEntries(Object.entries(data).filter(([key])=>!['daily','roleRequirements','intervals'].includes(key)));
export class SavedProbeFailure extends Error {
 readonly diagnostic: {phase:string;code:string;issuePaths:string[];http?:ProbeHttpDiagnostic};
 constructor(phase:string,error:unknown){
  const known=new Set(['PROBE_SOURCE_MISSING','PROBE_IDENTITY_MISMATCH','PROBE_SOURCE_IDENTITY_MISMATCH','PROBE_STATUS_MISMATCH','PROBE_CHECK_BODY_LIMIT','PROBE_CHECK_INVALID','PROBE_OBJECTIVE_MISMATCH','PROBE_DEPLOYMENT_CHANGED','BODY_LIMIT']);
  const code=error instanceof z.ZodError?'PROBE_RESPONSE_SHAPE':error instanceof SyntaxError?'PROBE_RESPONSE_JSON':error instanceof Error&&(known.has(error.message)||/^PROBE_HTTP_[1-5][0-9]{2}$/.test(error.message))?error.message:'PROBE_TRANSPORT_FAILURE';
  super(code);
  const fields=new Set(['status','scope','sourceSha256','runtime','uid','hasShell','deploymentId','schemaVersion','tenantId','teamId','month','mode','inputVersion','settingsVersion','jobId','attempt','inputHash','solverStatus','assignments','calculationProfile','savedCandidateSource','draftId','draftRevision','metrics','budgetSeconds','initialHintStrategy','stages','validation','violations','objectiveVector']);
  this.diagnostic={phase,code,issuePaths:error instanceof z.ZodError?error.issues.slice(0,8).map(issue=>issue.path.map(k=>typeof k==='number'?'item':fields.has(String(k))?String(k):'other').join('.')):[]};
  if(error instanceof ProbeHttpFailure)this.diagnostic.http=error.http;
 }
}
async function read(response:Response,limit:number,deadline?:number){
 if(!response.ok)throw await probeHttpFailure(response,deadline);
 const bytes=await boundedBytes(response.body,limit);
 return {body:JSON.parse(new TextDecoder().decode(bytes)),digest:await sha256(bytes)};
}
export async function runSavedCandidateBenchmark(command:SavedCandidateBenchmark,transport:ProbeTransport,deadline?:number){
 let phase='STARTUP';
 try{
 const started=Date.now();
 const health=healthSchema.parse((await read(await transport('/health'),64_000,deadline)).body);
 if(!health.sourceSha256['saved_candidate.py']||!health.sourceSha256['solve_request.py'])throw new Error('PROBE_SOURCE_MISSING');
 const ready=Date.now();
 phase='SOLVE';
 const received=await read(await transport('/solve',command),16_000_000,deadline),result=resultSchema.parse(received.body);
 for(const key of ['tenantId','teamId','month','mode','inputVersion','settingsVersion','jobId','attempt'] as const)
  if(result[key]!==command.input[key])throw new Error('PROBE_IDENTITY_MISMATCH');
 if(JSON.stringify(result.savedCandidateSource)!==JSON.stringify(command.savedCandidate?.source??null))throw new Error('PROBE_SOURCE_IDENTITY_MISMATCH');
 const solvedAt=Date.now();
 let validation:Record<string,unknown>={status:'NOT_RUN',scope:'multi-task-v1',violations:[]};
 if(result.assignments!==null){
  phase='CHECK';
  if(!['FEASIBLE','OPTIMAL'].includes(result.solverStatus))throw new Error('PROBE_STATUS_MISMATCH');
  const payload={input:command.input,assignments:result.assignments};
  if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>16_000_000)throw new Error('PROBE_CHECK_BODY_LIMIT');
  validation=checkSchema.parse((await read(await transport('/check',payload),16_000_000,deadline)).body);
  if(validation.status==='INVALID'||(validation.violations as string[]).length)throw new Error('PROBE_CHECK_INVALID');
  if(JSON.stringify(validation.objectiveVector)!==JSON.stringify(result.validation.objectiveVector))throw new Error('PROBE_OBJECTIVE_MISMATCH');
 }else if(['FEASIBLE','OPTIMAL'].includes(result.solverStatus))throw new Error('PROBE_STATUS_MISMATCH');
 const checkedAt=Date.now();
 phase='FINAL_HEALTH';
 const after=healthSchema.parse((await read(await transport('/health'),64_000,deadline)).body);
 if(JSON.stringify(health)!==JSON.stringify(after))throw new Error('PROBE_DEPLOYMENT_CHANGED');
 return {...Object.fromEntries(['schemaVersion','tenantId','teamId','month','mode','inputVersion','settingsVersion','jobId','attempt','inputHash','solverStatus','calculationProfile','savedCandidateSource','stages','metrics','termination'].map(key=>[key,result[key]])),
  validation:compact(validation),solverValidation:compact(result.validation),assignmentCount:result.assignments?.length??0,
  resultSha256:received.digest,sourceSha256:health.sourceSha256,runtime:health.runtime,
  transport:{startupMillis:ready-started,solveMillis:solvedAt-ready,checkMillis:checkedAt-solvedAt,totalBeforeStopMillis:Date.now()-started},
  scope:'private fictional HTTP/RPC/startup/solve/separate check/stop; excludes Queues, D1/R2 and product browser'};
 }catch(error){throw new SavedProbeFailure(phase,error);}
}
