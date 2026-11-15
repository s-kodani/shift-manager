import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot,readInputSnapshot,persistCompiledSnapshot,sha256} from '../../apps/api/src/input-snapshots';
import {createJob,loadJob,readJobResult} from '../../apps/api/src/compute-jobs';
import {executeJob,type ContainerTransport} from '../../apps/api/src/compute-execution';
import {optimizerInputSchema,type OptimizerInput} from '../../packages/contracts/optimizer-input.generated';
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('a live full 500-person solver result passes separate native check and normal job gzip/R2/D1/read under the existing transport deadline',async()=>{
 const bindings=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher;NATIVE_CHECKER:Fetcher;CANCELLATION_NATIVE_CHECK_URL:string};
 const fixture=await(await bindings.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput};
 const f=await inputFixture(env.DB),baselineId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:baselineId,expectedRevision:f.revision,month:'2026-10'});
 const baseline=await readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,baselineId,true);
 const id=crypto.randomUUID(),snapshotId=crypto.randomUUID();
 // A deliberately prepared snapshot fixture. Company/team/revision are real;
 // the 500 fictional staff inputs are not a product registration/API proof.
 const input=optimizerInputSchema.parse({...fixture.input,tenantId:f.company.companyId,teamId:f.team,
  inputVersion:f.revision,settingsVersion:baseline.input.settingsVersion,jobId:snapshotId,attempt:1});
 const command={operationId:snapshotId,expectedRevision:f.revision,month:input.month};
 await persistCompiledSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,command,
  JSON.stringify({fixture:'native-500-operational-v1',...command}),{input,lineage:JSON.parse(baseline.snapshot.lineage)});
 await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 const started=Date.now(),deadline=started+150000;let solves=0,checks=0,terminated=0,solveBytes=0,checkBytes=0;
 const transport:ContainerTransport=async(path,payload)=>{
  if(path==='/solve')solves++;else checks++;
  const body=JSON.stringify(payload);if(path==='/check')checkBytes=new TextEncoder().encode(body).byteLength;
  const response=await bindings.NATIVE_CHECKER.fetch(bindings.CANCELLATION_NATIVE_CHECK_URL+path,{method:'POST',
   headers:{'content-type':'application/json','x-native-timeout-ms':String(Math.max(1,deadline-Date.now()))},body});
  if(path==='/solve')solveBytes=Number(response.headers.get('content-length')??0);
  return response;
 };
 const outcome=await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-v1'},
  {version:1,companyId:f.company.companyId,teamId:f.team,jobId:id},transport,async()=>{terminated++;});
 const elapsed=Date.now()-started,job=(await loadJob(env.DB,f.company.companyId,f.team,id))!;
 expect(outcome).toBe('DONE');expect(job.state).toBe('SUCCEEDED');expect(job.attempt).toBe(1);
 expect(job.validation_status).toBe('VERIFIED');expect(solves).toBe(1);expect(checks).toBe(1);expect(terminated).toBe(1);
 expect(elapsed).toBeLessThan(150000);expect(solveBytes).toBeGreaterThan(4_000_000);expect(checkBytes).toBeGreaterThan(4_000_000);
 const saved=await readJobResult(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id);
 expect(saved.result.assignments).toHaveLength(15500);expect(saved.result.calculationProfile).toBe('mvp-joint-v1');
 const validation=saved.result.validation as {status:string;objectiveVector:number[]};
 expect(validation.status).toBe('VERIFIED');expect(validation.objectiveVector).toEqual([0,0,500,110106000]);
 const object=(await env.INPUTS.get(job.result_key!))!,bytes=new Uint8Array(await object.arrayBuffer());
 expect(isCompressedSchedule(bytes)).toBe(true);expect(await sha256(bytes)).toBe(job.result_sha256);expect(job.result_bytes).toBe(bytes.byteLength);
 expect(object.httpMetadata?.contentEncoding).toBeUndefined();
 // The owned runner stops the real Docker process after the test, separately
 // from this controlled lifecycle callback. No claim about Queues/UI or CPU.
 const report={scope:'live native /solve then separate /check and normal executeJob/R2/D1/read; prepared snapshot fixture, not product registration, Queues or UI',
  elapsedMilliseconds:elapsed,solveBytes,checkBytes,storedBytes:bytes.byteLength,assignments:15500,solverStatus:job.solver_status,
  validationStatus:job.validation_status,objectiveVector:validation.objectiveVector,metrics:saved.result.metrics};
 await env.INPUTS.put('native-large-job-evidence.json',JSON.stringify(report));
 console.log(JSON.stringify(report));
});
