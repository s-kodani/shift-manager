import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {registeredOperationalFixture,disableRegisteredFixture} from '../fixtures/registered-operational';
import {createJob,loadJob,readJobResult} from '../../apps/api/src/compute-jobs';
import {executeJob,type ContainerTransport} from '../../apps/api/src/compute-execution';
import {saveDraft} from '../../apps/api/src/schedule-drafts';
import {checkDraftCandidate} from '../../apps/api/src/draft-check';
import {createDraftSnapshot} from '../../apps/api/src/draft-recalculation';
import {readInputSnapshot} from '../../apps/api/src/input-snapshots';
import type {OptimizerInput,OptimizerAssignments} from '../../packages/contracts/optimizer-input.generated';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('500 registered identities and three rule layers compile, solve, save a checked manual fixed exception, recompile and solve without losing conditions',async()=>{
 const bindings=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher;NATIVE_CHECKER:Fetcher;CANCELLATION_NATIVE_CHECK_URL:string};
 const source=await(await bindings.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput;assignments:OptimizerAssignments};
 const started=Date.now(),f=await registeredOperationalFixture(env,source);
 console.log(JSON.stringify({phase:'registered-and-compiled',staff:f.frozen.input.staff.length,history:f.frozen.input.history.length,milliseconds:Date.now()-started}));
 const reports:unknown[]=[];
 try{
  expect(f.frozen.input.staff).toHaveLength(500);expect(f.frozen.input.staff.every(s=>s.rules.length===3&&s.rules.every(r=>r.monthlyMin===2400))).toBe(true);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM work_history_version WHERE company_id=? AND team_id=?').bind(f.companyId,f.team).first<number>('n')).toBe(3500);
  // Oct 1 is Thursday: the Monday week prefix is three days, and the
  // five-day consecutive rule needs Sep 26..30. Older confirmed rows stay in
  // D1 but are irrelevant to this calculation; no missing day is filled in.
  expect(f.frozen.input.history).toHaveLength(2500);
  for(const person of f.frozen.input.staff)expect(f.frozen.input.history.filter(h=>h.staffId===person.id).map(h=>h.date).sort())
   .toEqual(['2026-09-26','2026-09-27','2026-09-28','2026-09-29','2026-09-30']);
  expect(f.frozen.input.events).toHaveLength(source.input.events.length);
  expect(f.frozen.input.roleRequirements).toEqual(source.input.roleRequirements);expect(f.frozen.input.transitions).toEqual(source.input.transitions);
  expect(f.frozen.input.locks).toEqual([]);expect(f.frozen.input.exceptions).toEqual([]);
  const inverse=new Map([...f.staffIds].map(([old,id])=>[id,old]));
  const normalized=(input:OptimizerInput)=>input.staff.map(s=>({...s,id:inverse.get(s.id),rules:s.rules.map(({id,...r})=>r)})).sort((a,b)=>a.id!.localeCompare(b.id!));
  expect(normalized(f.frozen.input)).toEqual(source.input.staff.map(s=>({...s,rules:s.rules.map(({id,...r})=>r)})).sort((a,b)=>a.id.localeCompare(b.id)));
  const transport=(deadline:number):ContainerTransport=>async(path,payload)=>bindings.NATIVE_CHECKER.fetch(bindings.CANCELLATION_NATIVE_CHECK_URL+path,{method:'POST',headers:{'content-type':'application/json','x-native-timeout-ms':String(Math.max(1,deadline-Date.now()))},body:JSON.stringify(payload)});
  const run=async(snapshotId:string,revision:number,label:string)=>{
   const id=crypto.randomUUID();await createJob(env.DB,env.INPUTS,f.companyId,f.team,f.userId,{operationId:id,snapshotId,expectedRevision:revision});
   const t=Date.now();let stopped=0;
   const outcome=await executeJob({...env,OPTIMIZER_SOLVE_PROFILE:'mvp-joint-v1'},{version:1,companyId:f.companyId,teamId:f.team,jobId:id},transport(t+150000),async()=>{stopped++;});
   const job=(await loadJob(env.DB,f.companyId,f.team,id))!;
   expect(outcome).toBe('DONE');expect(job.state).toBe('SUCCEEDED');expect(job.validation_status).toBe('VERIFIED');expect(job.attempt).toBe(1);expect(stopped).toBe(1);expect(Date.now()-t).toBeLessThan(150000);
   const saved=await readJobResult(env.DB,env.INPUTS,f.companyId,f.team,f.userId,id);
   expect(saved.result.assignments).toHaveLength(15500);
   const report={phase:label,milliseconds:Date.now()-t,solverStatus:job.solver_status,validationStatus:job.validation_status,storedBytes:job.result_bytes,metrics:saved.result.metrics};reports.push(report);console.log(JSON.stringify(report));
   return id;
  };
  const first=await run(f.snapshotId,f.revision,'registered-initial-job');
  const draftId=crypto.randomUUID();
  const draft=await saveDraft(env,f.companyId,f.team,f.userId,{operationId:draftId,expectedRevision:f.revision,expectedDraftRevision:0,sourceJobId:first,...f.manual},
   c=>checkDraftCandidate(env,c,transport(Date.now()+60000),async()=>{}));
  const snapshotId=crypto.randomUUID();
  await createDraftSnapshot(env,f.companyId,f.team,f.userId,draftId,{operationId:snapshotId,expectedRevision:draft.inputRevision,expectedDraftRevision:1});
  const fixed=await readInputSnapshot(env.DB,env.INPUTS,f.companyId,f.team,f.userId,snapshotId,true);
  expect(fixed.input.locks).toEqual(f.manual.locks);expect(fixed.input.exceptions).toEqual(f.manual.exceptions);
  expect(fixed.input.locks).toHaveLength(25);expect(fixed.input.exceptions).toHaveLength(25);expect(normalized(fixed.input)).toEqual(normalized(f.frozen.input));
  expect(JSON.parse(fixed.snapshot.lineage).some((r:{kind:string;version:string})=>r.kind==='manual_draft'&&r.version===draftId)).toBe(true);
  await run(snapshotId,draft.inputRevision,'registered-fixed-recalculation');
  console.log(JSON.stringify({phase:'registered-acceptance-complete',staff:500,totalMilliseconds:Date.now()-started,scope:'real business registration functions/CSV, source compiler, two live native solves, separate checks, manual fixed exception and draft snapshot, normal R2/D1/read; excludes HTTP/auth/browser/Queues and real DO termination',reports}));
 }finally{await disableRegisteredFixture(env,f.companyId);}
},600000);
