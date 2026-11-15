// Controlled /solve reference and failure injection; actual Docker independent
// /check, business registration/compiler, workerd D1 and R2. Not a real SDK
// process-stop or CP-SAT optimization/performance claim.
import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {registeredOperationalFixture,disableRegisteredFixture} from '../fixtures/registered-operational';
import type {OptimizerInput,OptimizerAssignments} from '../../packages/contracts/optimizer-input.generated';
import {createJob,loadJob,readJobResult,getJob,type JobMessage} from '../../apps/api/src/compute-jobs';
import {executeJob,type ContainerTransport} from '../../apps/api/src/compute-execution';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
async function registered(){
 const binding=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher};
 const all=await(await binding.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput;assignments:OptimizerAssignments};
 const input={...all.input,staff:all.input.staff.slice(0,10)},ids=new Set(input.staff.map(s=>s.id));
 input.events=input.events.map(e=>({...e,staffIds:e.staffIds.filter(id=>ids.has(id))})).filter(e=>e.staffIds.length>0);
 input.history=input.history.filter(h=>ids.has(h.staffId));input.locks=input.locks.filter(l=>ids.has(l.staffId));input.exceptions=input.exceptions.filter(e=>ids.has(e.staffId));
 // This is an initial ordinary snapshot: manual locks/exceptions are not yet
 // registered. Keep every unavailability/rule and leave the source's single
 // manually excepted day off instead of silently carrying its permission.
 expect(input.exceptions).toHaveLength(1);
 const assignments=all.assignments.filter(a=>ids.has(a.staffId)).map(a=>
  input.exceptions.some(e=>e.staffId===a.staffId&&e.date===a.date)
   ? {...a,shift:null,blocks:[],roleIntervals:[]} : a);
 const f=await registeredOperationalFixture(env,{input,assignments});
 expect(f.frozen.input.locks).toEqual([]);expect(f.frozen.input.exceptions).toEqual([]);
 return f;
}
function transport(f:Awaited<ReturnType<typeof registered>>,counts:{solve:number;check:number}):ContainerTransport{
 const native=env as unknown as {NATIVE_CHECKER:Fetcher;CANCELLATION_NATIVE_CHECK_URL:string};
 return async(path,payload)=>{
  if(path==='/solve'){
   counts.solve++;
   return Response.json({...payload,assignments:f.manual.assignments,solverStatus:'FEASIBLE',validation:{status:'INVALID',scope:'untrusted reference label'}});
  }
  counts.check++;
  const response=await native.NATIVE_CHECKER.fetch(native.CANCELLATION_NATIVE_CHECK_URL+'/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const diagnostic=await response.clone().json() as {status?:string;violations?:string[]};
  if(!response.ok||diagnostic.status!=='VERIFIED')console.info(JSON.stringify({scope:'fictional native reference check',httpStatus:response.status,status:diagnostic.status,violations:diagnostic.violations}));
  return response;
 };
}
async function start(f:Awaited<ReturnType<typeof registered>>){
 const accepted=await createJob(env.DB,env.INPUTS,f.companyId,f.team,f.userId,{operationId:crypto.randomUUID(),snapshotId:f.snapshotId,expectedRevision:f.revision});
 return {version:1,companyId:f.companyId,teamId:f.team,jobId:accepted.job.id} satisfies JobMessage;
}
it('native /check: an uncertain R2 write never becomes the referenced result, and retry uses the independently checked current attempt',async()=>{
 const f=await registered();
 try{
  const message=await start(f),counts={solve:0,check:0};let stopped=0;
  const INPUTS=new Proxy(env.INPUTS,{get(target,key){
   if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{expect(stopped).toBe(1);await target.put(...args);throw Error('R2_RESPONSE_LOST');};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const first=await executeJob({...env,INPUTS},message,transport(f,counts),async()=>{stopped++;});
  expect(await loadJob(env.DB,f.companyId,f.team,message.jobId)).toMatchObject({state:'QUEUED',attempt:1,result_key:null,failure_code:'RESULT_UPLOAD_FAILED'});
  expect(first).toBe('RETRY');
  const prefix=`companies/${f.companyId}/teams/${f.team}/jobs/${message.jobId}/`,old=(await env.INPUTS.list({prefix})).objects;
  expect(old).toHaveLength(1);
  await expect(readJobResult(env.DB,env.INPUTS,f.companyId,f.team,f.userId,message.jobId)).rejects.toThrow('RESULT_NOT_READY');
  expect(await executeJob(env,message,transport(f,counts),async()=>{stopped++;})).toBe('DONE');
  const job=await loadJob(env.DB,f.companyId,f.team,message.jobId),saved=await readJobResult(env.DB,env.INPUTS,f.companyId,f.team,f.userId,message.jobId);
  expect(job).toMatchObject({state:'SUCCEEDED',attempt:2,validation_status:'VERIFIED'});expect(job!.result_key).not.toBe(old[0].key);
  expect(saved.result.validation.status).toBe('VERIFIED');expect(saved.result.validation.violations).toEqual([]);
  expect(saved.result.assignments).toEqual(f.manual.assignments);expect(saved.result.attempt).toBe(2);
  expect(counts).toEqual({solve:2,check:2});expect(stopped).toBe(2);
  expect((await env.INPUTS.list({prefix})).objects).toHaveLength(2);
  expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.companyId).first('n')).toBe(1);
 }finally{await disableRegisteredFixture(env,f.companyId);}
});
it('native /check: silently omitted D1 audit rolls back, then lost successful batch response resolves without a third attempt or duplicate history',async()=>{
 const f=await registered();
 try{
  const message=await start(f),counts={solve:0,check:0};let stopped=0;
  await env.DB.prepare("CREATE TRIGGER native_ignore_compute_audit BEFORE INSERT ON product_audit WHEN NEW.kind='compute:completed' BEGIN SELECT RAISE(IGNORE); END").run();
  try{
   const first=await executeJob(env,message,transport(f,counts),async()=>{stopped++;});
   expect(await loadJob(env.DB,f.companyId,f.team,message.jobId)).toMatchObject({state:'QUEUED',attempt:1,result_key:null,failure_code:'RESULT_COMMIT_FAILED'});
   expect(first).toBe('RETRY');
   expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.companyId).first('n')).toBe(0);
  }finally{await env.DB.prepare('DROP TRIGGER native_ignore_compute_audit').run();}
  let lost=false;
  const DB=new Proxy(env.DB,{get(target,key){
   if(key==='batch')return async<T>(statements:D1PreparedStatement[])=>{
    const results=await target.batch<T>(statements);
    if(!lost&&(await loadJob(env.DB,f.companyId,f.team,message.jobId))?.state==='SUCCEEDED'){lost=true;throw Error('D1_RESPONSE_LOST');}
    return results;
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  expect(await executeJob({...env,DB},message,transport(f,counts),async()=>{stopped++;})).toBe('DONE');
  expect(lost).toBe(true);expect(stopped).toBe(2);expect(counts).toEqual({solve:2,check:2});
  expect((await readJobResult(env.DB,env.INPUTS,f.companyId,f.team,f.userId,message.jobId)).result.validation.status).toBe('VERIFIED');
  expect(await executeJob(env,message,async()=>{throw Error('DUPLICATE_CALCULATION');},async()=>{throw Error('DUPLICATE_STOP');})).toBe('DONE');
  expect((await getJob(env.DB,f.companyId,f.team,f.userId,message.jobId)).attempts.map(a=>a.final_state)).toEqual(['QUEUED','SUCCEEDED']);
  expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.companyId).first('n')).toBe(1);
 }finally{await disableRegisteredFixture(env,f.companyId);}
});
