import {env,runInDurableObject,applyD1Migrations} from 'cloudflare:test';
import {expect,it,vi,beforeAll} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
import input from '../fixtures/optimizer-benchmark-input.json';
import {savedCandidateBenchmark,runSavedCandidateBenchmark,SavedProbeFailure,type ProbeTransport} from '../../apps/api/src/saved-candidate-benchmark';
import {probeHttpFailure} from '../../apps/api/src/probe-http-failure';
// As in the draft/leave tests, retain native DO SQLite/RPC while replacing the
// unavailable native Container binding with an explicitly controlled adapter.
vi.mock('@cloudflare/containers',async()=>{
 const {DurableObject}=await import('cloudflare:workers');
 return {Container:class extends DurableObject<Env>{
  constructor(state:DurableObjectState,bindings:Env){
   super(state,bindings);
   Object.defineProperty(state,'container',{configurable:true,value:{running:false,async destroy(){}}});
  }
  async containerFetch(_request:RequestInfo,_init?:RequestInit):Promise<Response>{throw Error('CONTROLLED_TRANSPORT_REQUIRED');}
  renewActivityTimeout(){}
 }};
});
const source={draftId:'fictional-saved-reference',draftRevision:1};
const command=()=>savedCandidateBenchmark.parse({schemaVersion:'solve-seed-v1',input,savedCandidate:{source,assignments:[]}});
const request=(body:unknown,token=env.POC_TOKEN)=>new Request('https://poc.invalid/__poc/optimizer-saved-benchmark',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
const health=()=>({status:'ok',sourceSha256:{'saved_candidate.py':'a'.repeat(64),'solve_request.py':'b'.repeat(64)},runtime:{uid:65534,hasShell:false,deploymentId:'fictional-deployment'}});
const solved=()=>({...Object.fromEntries(['schemaVersion','tenantId','teamId','month','mode','inputVersion','settingsVersion','jobId','attempt'].map(key=>[key,input[key as keyof typeof input]])),jobId:input.jobId,inputHash:'fictional-hash',solverStatus:'FEASIBLE',assignments:[],calculationProfile:'mvp-joint-seed-v1',savedCandidateSource:source,
 metrics:{budgetSeconds:120,initialHintStrategy:'balanced-incumbent-v4'},stages:[],validation:{status:'VERIFIED',objectiveVector:[0,0],daily:['private-detail']}});
const checked=()=>({scope:'multi-task-v1',status:'VERIFIED',violations:[],objectiveVector:[0,0],daily:['private-detail']});
it('saved benchmark rejects credentials, environments, settings injection and real identities before RPC',async()=>{
 expect((await worker.fetch(request(command(),'wrong'),env)).status).toBe(403);
 for(const ENVIRONMENT of ['local','production'])expect((await worker.fetch(request(command()),{...env,ENVIRONMENT})).status).toBe(403);
 let calls=0;
 const bindings={...env,ENVIRONMENT:'poc',SOLVER:{getByName:()=>{calls++;throw new Error('UNEXPECTED_RPC');}}} as unknown as Env;
 for(const body of [{...command(),budgetSeconds:999},{...command(),input:{...input,tenantId:'real-company'}},{...command(),savedCandidate:{source:{...source,draftRevision:true},assignments:[]}},
  {...command(),savedCandidate:{source:{...source,draftId:'real-draft'},assignments:[]}},
  {...command(),input:{...input,padding:'x'.repeat(4_000_000)}},
  {...command(),savedCandidate:{source,assignments:['x'.repeat(8_000_000)]}}])
  expect((await worker.fetch(request(body),bindings)).status).toBe(400);
 const oversized=new Request('https://poc.invalid/__poc/optimizer-saved-benchmark',{method:'POST',headers:{authorization:`Bearer ${env.POC_TOKEN}`},body:'x'.repeat(16_000_001)});
 expect((await worker.fetch(oversized,bindings)).status).toBe(413);expect(calls).toBe(0);
});
it('private saved route preserves stop evidence and never targets a business team',async()=>{
 const data=command();
 const bindings={...env,ENVIRONMENT:'poc',SOLVER:{getByName:(name:string)=>{expect(name).toBe('synthetic-poc');return {benchmarkSaved:async(body:unknown)=>{expect(body).toEqual(data);return {httpStatus:200,body:'{"scope":"fictional"}',processStopped:true};}};}}} as unknown as Env;
 const response=await worker.fetch(request(data),bindings);
 expect(response.status).toBe(200);expect(response.headers.get('x-poc-process-stopped')).toBe('true');expect(response.headers.get('cache-control')).toBe('no-store');
});
it('probe requires a separate checker, keeps compact provenance, and distinguishes UNKNOWN without checking',async()=>{
 for(const feasible of [true,false]){
  const paths:string[]=[];
  const transport:ProbeTransport=async(path,payload)=>{
   paths.push(path);
   if(path==='/health')return Response.json(health());
   if(path==='/check'){expect(payload).toEqual({input,assignments:[]});return Response.json(checked());}
   expect(payload).toEqual(command());return Response.json(feasible?solved():{...solved(),solverStatus:'UNKNOWN',assignments:null});
  };
  const result=await runSavedCandidateBenchmark(command(),transport);
  expect(paths).toEqual(feasible?['/health','/solve','/check','/health']:['/health','/solve','/health']);
  expect(result.validation.status).toBe(feasible?'VERIFIED':'NOT_RUN');expect(result.validation.daily).toBeUndefined();expect(result.solverValidation.daily).toBeUndefined();
  expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/);expect(result).not.toHaveProperty('assignments');
 }
});
it.each(['source','identity','profile','settings','check-invalid','objective','deployment','status'])('probe rejects %s inconsistency rather than claiming acceptance',async(kind)=>{
 let healthCalls=0;
 const transport:ProbeTransport=async(path)=>{
  if(path==='/health'){const data=health();if(++healthCalls>1&&kind==='deployment')data.runtime.deploymentId='changed';return Response.json(data);}
  if(path==='/check')return Response.json(kind==='check-invalid'?{...checked(),status:'INVALID',violations:['HARD_CONDITION']}:kind==='objective'?{...checked(),objectiveVector:[1,0]}:checked());
  const data=solved();
  if(kind==='source')data.savedCandidateSource={...source,draftRevision:2};
  if(kind==='identity')data.jobId='fictional-other';
  if(kind==='profile')data.calculationProfile='legacy-poc-v1';
  if(kind==='settings')data.metrics.budgetSeconds=999;
  if(kind==='status')data.solverStatus='UNKNOWN';
  return Response.json(data);
 };
 await expect(runSavedCandidateBenchmark(command(),transport)).rejects.toThrow();
});
it('diagnostics distinguish result shape and checker failures without echoing values or configuration',async()=>{
 for(const kind of ['shape','checker']){
  const transport:ProbeTransport=async(path)=>path==='/health'?Response.json(health()):path==='/solve'?Response.json(kind==='shape'?{...solved(),metrics:{budgetSeconds:'fictional-secret',initialHintStrategy:'balanced-incumbent-v4'}}:solved()):Response.json({...checked(),status:'INVALID',violations:['fictional-secret']});
  try{await runSavedCandidateBenchmark(command(),transport);throw Error('EXPECTED_FAILURE');}
  catch(error){
   expect(error).toBeInstanceOf(SavedProbeFailure);
   expect((error as SavedProbeFailure).diagnostic).toEqual(kind==='shape'?{phase:'SOLVE',code:'PROBE_RESPONSE_SHAPE',issuePaths:['metrics.budgetSeconds']}:{phase:'CHECK',code:'PROBE_CHECK_INVALID',issuePaths:[]});
   expect(JSON.stringify((error as SavedProbeFailure).diagnostic)).not.toContain('fictional-secret');
  }
 }
});
it('unknown transport messages are replaced with a fixed diagnostic code',async()=>{
 for(const message of ['fictional-secret transport','PROBE_FICTIONAL_SECRET']){
  try{await runSavedCandidateBenchmark(command(),async()=>{throw Error(message);});throw Error('EXPECTED_FAILURE');}
  catch(error){expect((error as SavedProbeFailure).diagnostic).toEqual({phase:'STARTUP',code:'PROBE_TRANSPORT_FAILURE',issuePaths:[]});}
 }
});
it.each([
 [500,'{"error":"MODEL_ERROR"}','MODEL_ERROR_JSON'],
 [400,'{"error":"ValidationError"}','VALIDATION_ERROR_JSON'],
 [400,'{"error":"ValueError"}','VALIDATION_ERROR_JSON'],
 [400,'{"error":"KeyError"}','VALIDATION_ERROR_JSON'],
 [400,'{"error":"TypeError"}','VALIDATION_ERROR_JSON'],
 [400,'{"error":"BODY_LENGTH"}','VALIDATION_ERROR_JSON'],
 [413,'{"error":"BODY_LIMIT"}','BODY_LIMIT_JSON'],
 [404,'{"error":"NOT_FOUND"}','NOT_FOUND_JSON'],
 [500,'Failed to start container: fictional-sensitive-message','SDK_START_PREFIX'],
 [503,'There is no Container instance available at this time.\nfictional-sensitive-message','SDK_CAPACITY_PREFIX'],
 [429,'fictional-sensitive-message','UNRECOGNIZED'],
 [500,'{"error":"MODEL_ERROR","details":"fictional-sensitive-message"}','UNRECOGNIZED'],
 [500,'{"error":"fictional-sensitive-message"}','UNRECOGNIZED'],
 [400,'{"error":"MODEL_ERROR"}','UNRECOGNIZED'],
 [500,'<html>fictional-sensitive-message</html>','UNRECOGNIZED'],
 [500,'{"error":["MODEL_ERROR"]}','UNRECOGNIZED'],
])('HTTP %i response signatures stay finite (%s)',async(status,body,signature)=>{
 const paths:string[]=[];
 try{
  await runSavedCandidateBenchmark(command(),async(path)=>{
   paths.push(path);return path==='/health'?Response.json(health()):new Response(body,{status});
  });throw Error('EXPECTED_FAILURE');
 }catch(error){
  expect(error).toBeInstanceOf(SavedProbeFailure);
  expect((error as SavedProbeFailure).diagnostic).toEqual({phase:'SOLVE',code:`PROBE_HTTP_${status}`,issuePaths:[],http:{status,bodyState:'COMPLETE',signature}});
  expect(JSON.stringify((error as SavedProbeFailure).diagnostic)).not.toContain('fictional-sensitive-message');
 }
 expect(paths).toEqual(['/health','/solve']); // No automatic retry or checker/final-health call.
});
it('partial, oversized, malformed UTF-8 and empty bodies never acquire a recognized signature',async()=>{
 const encoder=new TextEncoder();
 const prefix=encoder.encode('{"error":"MODEL_ERROR"}');
 const chunked=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(prefix);controller.enqueue(encoder.encode('x'.repeat(4_096)));}});
 for(const [body,state] of [[chunked,'OVER_LIMIT'],['x'.repeat(4_097),'OVER_LIMIT'],[new Uint8Array([0xff]),'COMPLETE'],[null,'EMPTY']] as const){
  const failure=await probeHttpFailure(new Response(body,{status:500}));
  expect(failure.http).toEqual({status:500,bodyState:state,signature:'UNRECOGNIZED'});
 }
 const padded='{"error":"MODEL_ERROR"}'.padEnd(4_096,' ');
 expect((await probeHttpFailure(new Response(padded,{status:500}))).http.signature).toBe('MODEL_ERROR_JSON');
});
it('failed reads and cancellation retain the original HTTP status without throwing body details',async()=>{
 const failed=new ReadableStream<Uint8Array>({pull(){throw Error('BODY_LIMIT');}});
 const cannotCancel=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4_097));},cancel(){throw Error('fictional-sensitive-message');}});
 for(const [body,state] of [[failed,'READ_FAILED'],[cannotCancel,'OVER_LIMIT']] as const){
  const failure=await probeHttpFailure(new Response(body,{status:500}));
  expect(failure.message).toBe('PROBE_HTTP_500');
  expect(failure.http).toEqual({status:500,bodyState:state,signature:'UNRECOGNIZED'});
 }
});
it('endless empty chunks are bounded even without clock progress',async()=>{
 let cancelled=false,pulls=0;
 const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}});
 expect((await probeHttpFailure(new Response(body,{status:500}))).http).toEqual({status:500,bodyState:'OVER_LIMIT',signature:'UNRECOGNIZED'});
 expect(cancelled).toBe(true);expect(pulls).toBeLessThanOrEqual(4_098);
});
it('a stalled body and never-settling cancellation cannot extend the shared deadline',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise<void>(()=>{});}});
 const paths:string[]=[],started=Date.now();
 try{
  await runSavedCandidateBenchmark(command(),async(path)=>{
   paths.push(path);return path==='/health'?Response.json(health()):new Response(body,{status:500});
  },started+30);throw Error('EXPECTED_FAILURE');
 }catch(error){
  expect((error as SavedProbeFailure).diagnostic).toEqual({phase:'SOLVE',code:'PROBE_HTTP_500',issuePaths:[],http:{status:500,bodyState:'TIMED_OUT',signature:'UNRECOGNIZED'}});
 }
 expect(cancelled).toBe(true);expect(Date.now()-started).toBeLessThan(1_000);
 expect(paths).toEqual(['/health','/solve']);
});
it.each(['STARTUP','CHECK','FINAL_HEALTH'])('HTTP failure metadata preserves the %s phase',async(phase)=>{
 let healthCalls=0;
 try{
  await runSavedCandidateBenchmark(command(),async(path)=>{
   const fail=path==='/health'?(++healthCalls===1?phase==='STARTUP':phase==='FINAL_HEALTH'):path==='/check'&&phase==='CHECK';
   return fail?Response.json({error:'MODEL_ERROR'},{status:500}):Response.json(path==='/health'?health():path==='/solve'?solved():checked());
  });throw Error('EXPECTED_FAILURE');
 }catch(error){expect((error as SavedProbeFailure).diagnostic).toMatchObject({phase,code:'PROBE_HTTP_500',http:{signature:'MODEL_ERROR_JSON'}});}
});
it('workerd saved probe stops before replying, retains a fence on failed stop, and recovers before replacement',async()=>{
 // Native DO SQLite/RPC with controlled HTTP/process. No cloud or native container start.
 const stub=env.SOLVER.getByName(`saved-probe-failure:${crypto.randomUUID()}`);
 await runInDurableObject(stub,async(instance,state)=>{
  const previousEnv=Object.getOwnPropertyDescriptor(instance,'env');
  Object.defineProperty(instance,'env',{configurable:true,value:{...env,ENVIRONMENT:'poc'}});
  let running=false,failStop=false,stops=0;
  let releaseStop!:()=>void,enteredStop!:()=>void;
  let stopGate:Promise<void>|undefined=new Promise(resolve=>{releaseStop=resolve;});
  const stopEntered=new Promise<void>(resolve=>{enteredStop=resolve;});
  Object.defineProperty(state,'container',{configurable:true,value:{get running(){return running;},async destroy(){stops++;if(failStop)throw Error('STOP_FAILED');enteredStop();if(stopGate)await stopGate;running=false;}}});
  const paths:string[]=[];
  const transport=vi.spyOn(instance,'containerFetch').mockImplementation(async(url)=>{
   const path=new URL(String(url)).pathname;paths.push(path);
   if(path==='/health'){expect(running).toBe(false);running=true;return Response.json(health());}
   return Response.json({error:'MODEL_ERROR'},{status:500});
  });
  try{
   let replied=false;
   const pending=instance.benchmarkSaved(command()).then(response=>{replied=true;return response;});
   await stopEntered;
   expect(replied).toBe(false);
   expect(instance.executionState()).toMatchObject({activeRpc:true,persistedCheckFence:true,processRunning:true});
   await expect(instance.benchmarkSaved(command())).rejects.toThrow('CHECK_BUSY');
   expect(paths).toEqual(['/health','/solve']);
   releaseStop();
   const response=await pending;
   stopGate=undefined;
   expect(response).toMatchObject({httpStatus:502,processStopped:true});
   expect(JSON.parse(response.body).diagnostic).toMatchObject({phase:'SOLVE',code:'PROBE_HTTP_500',http:{signature:'MODEL_ERROR_JSON'}});
   expect(instance.executionState()).toMatchObject({activeRpc:false,persistedCheckFence:false,processRunning:false});
   expect(stops).toBe(1);expect(paths).toEqual(['/health','/solve']);
   failStop=true;
   await expect(instance.benchmarkSaved(command())).rejects.toThrow('STOP_FAILED');
   expect(instance.executionState()).toMatchObject({activeRpc:false,persistedCheckFence:true,processRunning:true});
   const previousCalls=paths.length;
   await expect(instance.benchmarkSaved(command())).rejects.toThrow('STOP_FAILED');
   expect(paths.length).toBe(previousCalls); // Replacement cannot start while old stop is unconfirmed.
   failStop=false;
   const recovered=await instance.benchmarkSaved(command());
   expect(recovered.processStopped).toBe(true);expect(stops).toBe(5);
   expect(instance.executionState()).toMatchObject({activeRpc:false,persistedCheckFence:false,processRunning:false});
  }finally{
   releaseStop();
   transport.mockRestore();
   if(previousEnv)Object.defineProperty(instance,'env',previousEnv);
  }
 });
});
