import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,open,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {prepareFinalOwner,readFinalOwner,bindFinalJob,dispatchFinalOperation,observeFinalJob,closeFinalOwner,beginFinalCleanup,haltFinalOwner,resumeAfterRejectedJ3Snapshot,fingerprint} from '../../scripts/final-run-control.mjs';
import {finalProductClient} from '../../scripts/final-run-product-client.mjs';
const cases=JSON.parse(await readFile(new URL('../../docs/mvp/cloudflare-final-cases.json',import.meta.url)));
async function fixture(t){
 const parent=await realpath(await mkdtemp(tmpdir()+'/shift-final-control-')),root=parent+'/owner';t.after(()=>rm(parent,{recursive:true,force:true}));
 const owner=await prepareFinalOwner(root,{sourceCommit:'a'.repeat(40),cases},1000);
 const companyId=randomUUID(),teamId=randomUUID(),bindings=['J1','J2','J3','J4'].map(slot=>({slot,companyId,teamId,jobId:randomUUID()}));
 for(const b of bindings)await bindFinalJob(root,b);
 const intent=(index,kind='job')=>({id:kind==='job'?bindings[index].jobId:randomUUID(),slot:bindings[index].slot,kind,fingerprint:fingerprint({snapshotId:randomUUID()})});
 const dispatch=async(index,options={})=>dispatchFinalOperation(root,intent(index),{send:async()=>({status:202}),confirm:r=>r.status===202,now:()=>1001,...options});
 const observed=(index,extra={})=>({id:bindings[index].jobId,slot:bindings[index].slot,companyId,teamId,attempt:1,state:'SUCCEEDED',solverStatus:'FEASIBLE',validationStatus:'VERIFIED',...extra});
 return {root,owner,bindings,intent,dispatch,observed};
}
test('operation identity is durable before one POST and never dispatched twice',async t=>{
 const f=await fixture(t),i=f.intent(0);let calls=0;
 const send=async()=>{calls++;const owner=await readFinalOwner(f.root);assert.equal(owner.operations[0].stage,'DISPATCHED');assert.equal(owner.operations[0].id,i.id);return {status:202};};
 await dispatchFinalOperation(f.root,i,{send,confirm:r=>r.status===202,now:()=>1001});
 await assert.rejects(dispatchFinalOperation(f.root,i,{send,confirm:()=>true,now:()=>1002}),/ALREADY_DISPATCHED/);
 assert.equal(calls,1);assert.equal((await readFinalOwner(f.root)).operations[0].stage,'CONFIRMED');
 await assert.rejects(bindFinalJob(f.root,{...f.bindings[0],jobId:randomUUID()}),/IMMUTABLE/);
});
test('a response lost after server acceptance is preserved and blocks replacements and later jobs',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.dispatch(0,{send:async()=>{calls++;throw Error('secret token and raw provider text');}}),/^Error: FINAL_OUTCOME_UNKNOWN_INSPECT_SAME_OPERATION$/);
 const owner=await readFinalOwner(f.root);assert.equal(owner.stage,'STOPPED');assert.equal(owner.stopCode,'OUTCOME_UNKNOWN');assert.equal(owner.operations[0].stage,'UNCERTAIN');
 assert(!JSON.stringify(owner).includes('secret token'));
 await observeFinalJob(f.root,f.observed(0),1002);
 await assert.rejects(f.dispatch(0),/RUN_STOPPED/);await assert.rejects(f.dispatch(1),/RUN_STOPPED/);assert.equal(calls,1);
});
test('known rejection or invalid confirmation also prevents silent retry',async t=>{
 for(const response of [{status:409},{status:202,wrongId:true}]){
  const f=await fixture(t);await assert.rejects(f.dispatch(0,{send:async()=>response,confirm:r=>r.status===202&&!r.wrongId}),/OUTCOME_UNKNOWN/);
  assert.equal((await readFinalOwner(f.root)).stage,'STOPPED');
 }
});
test('four ordered owned jobs retain failed-attempt history externally and require VERIFIED before advancing',async t=>{
 const f=await fixture(t);await assert.rejects(f.dispatch(1),/PREVIOUS_JOB_NOT_VERIFIED/);
 await f.dispatch(0);await observeFinalJob(f.root,f.observed(0),1001);
 await f.dispatch(1);await observeFinalJob(f.root,f.observed(1,{state:'RUNNING',validationStatus:null,solverStatus:null}),1001);
 const fault=f.intent(1,'fault');await dispatchFinalOperation(f.root,fault,{send:async()=>true,confirm:r=>r===true,now:()=>1001});
 await observeFinalJob(f.root,f.observed(1,{attempt:2}),1001);
 for(const i of [2,3]){await f.dispatch(i);await observeFinalJob(f.root,f.observed(i),1001);}
 const owner=await readFinalOwner(f.root);assert.equal(owner.operations.filter(o=>o.kind==='job').length,4);assert.equal(owner.observations.reduce((n,o)=>n+o.attempt,0),5);
 await assert.rejects(observeFinalJob(f.root,f.observed(3,{id:randomUUID()}),1001),/OBSERVATION_MISMATCH/);
 await assert.rejects(observeFinalJob(f.root,f.observed(1),1001),/OBSERVATION_MISMATCH/);
 await assert.rejects(closeFinalOwner(f.root,{idle:false,credentialsRetired:true,privateFilesRemoved:true},1002));
 await beginFinalCleanup(f.root,1002);
 await closeFinalOwner(f.root,{idle:true,credentialsRetired:true,privateFilesRemoved:true},1002);
 assert.equal((await readFinalOwner(f.root)).stage,'CLOSED');
});
test('UNKNOWN, unverified history and failed jobs stop rather than become INFEASIBLE or publishable',async t=>{
 for(const change of [{solverStatus:'UNKNOWN'},{validationStatus:'HISTORY_UNVERIFIED'},{state:'FAILED',solverStatus:null,validationStatus:null}]){
  const f=await fixture(t);await f.dispatch(0);
  await assert.rejects(observeFinalJob(f.root,f.observed(0,change),1001),/JOB_NOT_VERIFIED/);
  const owner=await readFinalOwner(f.root);assert.equal(owner.stage,'STOPPED');assert.deepEqual(owner.observations[0],f.observed(0,change));
  await assert.rejects(f.dispatch(1),/RUN_STOPPED/);
 }
});
test('request/check/fault and elapsed-time limits stop further producers',async t=>{
 const f=await fixture(t);await f.dispatch(0);await observeFinalJob(f.root,f.observed(0),1001);
 for(let n=0;n<16;n++)await dispatchFinalOperation(f.root,f.intent(0,'check'),{send:async()=>true,confirm:()=>true,now:()=>1001});
 let sent=0;await assert.rejects(dispatchFinalOperation(f.root,f.intent(0,'check'),{send:async()=>{sent++;},confirm:()=>true,now:()=>1001}),/REQUEST_BUDGET/);assert.equal(sent,0);
 const g=await fixture(t);await g.dispatch(0);await observeFinalJob(g.root,g.observed(0),1001);
 await assert.rejects(g.dispatch(1,{now:()=>1801001,send:async()=>{sent++;}}),/TIME_BUDGET/);assert.equal(sent,0);
 const h=await fixture(t);await h.dispatch(0);await observeFinalJob(h.root,h.observed(0),1001);await h.dispatch(1);await observeFinalJob(h.root,h.observed(1,{state:'RUNNING'}),1001);
 await dispatchFinalOperation(h.root,h.intent(1,'fault'),{send:async()=>true,confirm:()=>true,now:()=>1001});
 await assert.rejects(dispatchFinalOperation(h.root,h.intent(1,'fault'),{send:async()=>{sent++;},confirm:()=>true,now:()=>1001}),/REQUEST_BUDGET/);assert.equal(sent,0);
});
test('same-owner concurrency and orphaned locks never trigger a second producer',async t=>{
 const f=await fixture(t);let started,release;
 const entered=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const first=f.dispatch(0,{send:async()=>{started();await wait;return {status:202};}});await entered;
 await assert.rejects(f.dispatch(0),/OWNER_LOCKED/);release();await first;
 const lock=await open(f.root+'/owner.lock','wx',0o600);await lock.close();
 await assert.rejects(f.dispatch(1),/OWNER_LOCKED/);
 assert.equal((await readFinalOwner(f.root)).operations.length,1);
});
test('changed limits, mutable owner identities and early cleanup cannot authorize execution',async t=>{
 const parent=await mkdtemp(tmpdir()+'/shift-final-limit-');t.after(()=>rm(parent,{recursive:true,force:true}));
 await assert.rejects(prepareFinalOwner(parent+'/bad',{sourceCommit:'a'.repeat(40),cases:{...cases,limits:{...cases.limits,additional500PersonPerformanceRuns:1}}},1000),/LIMITS_MISMATCH/);
 const f=await fixture(t);await assert.rejects(closeFinalOwner(f.root,{idle:true,credentialsRetired:true,privateFilesRemoved:true}),/ACCEPTANCE_INCOMPLETE/);
 await assert.rejects(dispatchFinalOperation(f.root,{...f.intent(0),id:randomUUID()},{send:async()=>assert.fail('must not send'),confirm:()=>true,now:()=>1001}),/MISMATCHED/);
 const owner=await readFinalOwner(f.root);owner.extraToken='must not disclose';await writeFile(f.root+'/owner.json',JSON.stringify(owner),{mode:0o600});
 await assert.rejects(readFinalOwner(f.root),/^Error: FINAL_OWNER_INVALID$/);
});
test('normal HTTP client preserves job/snapshot/revision identity and reads actual attempt evidence',async t=>{
 const f=await fixture(t),b=f.bindings[0],snapshotId=randomUUID(),calls=[];
 const job={id:b.jobId,company_id:b.companyId,team_id:b.teamId,snapshot_id:snapshotId,input_revision:12,
  attempt:1,state:'SUCCEEDED',solver_status:'FEASIBLE',validation_status:'VERIFIED',attempts:[{attempt:1,final_state:'SUCCEEDED'}]};
 const result={jobId:b.jobId,tenantId:b.companyId,teamId:b.teamId,attempt:1,inputVersion:12,
  solverStatus:'FEASIBLE',validation:{status:'VERIFIED'},metrics:{processBudget:{childReaped:true}}};
 const client=finalProductClient(f.root,async(route,body)=>{
  calls.push({route,body});
  if(body){assert.equal(body.operationId,b.jobId);assert.equal(body.snapshotId,snapshotId);return Response.json({job},{status:202});}
  return route.endsWith('/result')?Response.json({result,stale:false,inputStale:false}):Response.json(job);
 },{now:()=>1001});
 await client.dispatch('J1',{snapshotId,expectedRevision:12});assert.deepEqual((await client.observe('J1')).attempts,job.attempts);
 assert.deepEqual((await client.result('J1')).result,result);assert.equal(calls.filter(c=>c.body).length,1);
 assert(calls.every(c=>c.route.startsWith(`/api/companies/${b.companyId}/compute/teams/${b.teamId}/jobs`)));
});
test('normal HTTP client cannot resend an accepted POST after abort or an absent job read',async t=>{
 const f=await fixture(t);let posts=0;
 const client=finalProductClient(f.root,async(_route,body)=>{if(body){posts++;throw Error('socket closed secret');}return Response.json({error:'NOT_FOUND'},{status:404});},{now:()=>1001});
 await assert.rejects(client.dispatch('J1',{snapshotId:randomUUID(),expectedRevision:12}),/OUTCOME_UNKNOWN/);
 await assert.rejects(client.observe('J1'),/OBSERVATION_UNCONFIRMED/);
 await assert.rejects(client.dispatch('J1',{snapshotId:randomUUID(),expectedRevision:12}),/RUN_STOPPED/);assert.equal(posts,1);
});
test('wrong HTTP result identity, stale result and unreaped process block following jobs',async t=>{
 for(const change of ['identity','stale','process']){
  const f=await fixture(t),b=f.bindings[0],job={id:b.jobId,company_id:b.companyId,team_id:b.teamId,snapshot_id:randomUUID(),input_revision:12,attempt:1,state:'SUCCEEDED',solver_status:'FEASIBLE',validation_status:'VERIFIED'};
  const result={jobId:change==='identity'?randomUUID():b.jobId,tenantId:b.companyId,teamId:b.teamId,attempt:1,inputVersion:12,solverStatus:'FEASIBLE',validation:{status:'VERIFIED'},metrics:{processBudget:{childReaped:change!=='process'}}};
  const client=finalProductClient(f.root,async(route,body)=>body?Response.json({job},{status:202}):route.endsWith('/result')?Response.json({result,stale:change==='stale',inputStale:false}):Response.json(job),{now:()=>1001});
  await client.dispatch('J1',{snapshotId:job.snapshot_id,expectedRevision:12});await client.observe('J1');
  await assert.rejects(client.result('J1'),/RESULT_UNCONFIRMED/);await assert.rejects(f.dispatch(1),/RUN_STOPPED/);
 }
});
test('cleanup blocks new producers and records a five-minute overrun while allowing shutdown',async t=>{
 const f=await fixture(t);await assert.rejects(f.dispatch(0,{send:async()=>{throw Error('uncertain');}}),/OUTCOME_UNKNOWN/);
 const start=await beginFinalCleanup(f.root,1002);assert.equal(start.deadline,301002);
 assert.equal((await beginFinalCleanup(f.root,2002)).startedAt,1002);
 await assert.rejects(f.dispatch(0),/RUN_STOPPED/);
 const proof={idle:true,credentialsRetired:true,privateFilesRemoved:true};
 assert.deepEqual(await closeFinalOwner(f.root,proof,301002),{closed:true,cleanupExceeded:true});
 const owner=await readFinalOwner(f.root);assert.equal(owner.stage,'CLOSED');assert.equal(owner.stopCode,'OUTCOME_UNKNOWN');assert.equal(owner.cleanupExceeded,true);
});
test('one known rejected J3 preparation may resume only after absent objects and idle proof; unknown job producers cannot reopen',async t=>{
 const f=await fixture(t);await f.dispatch(0);await observeFinalJob(f.root,f.observed(0),1001);await f.dispatch(1);
 await observeFinalJob(f.root,f.observed(1,{state:'RUNNING',validationStatus:null,solverStatus:null}),1001);
 await dispatchFinalOperation(f.root,f.intent(1,'fault'),{send:async()=>true,confirm:()=>true,now:()=>1001});
 await observeFinalJob(f.root,f.observed(1,{attempt:2}),1001);await haltFinalOwner(f.root,1002);
 const proof={status:409,jobId:f.bindings[2].jobId,snapshotAbsent:true,jobAbsent:true,allSdkIdle:true};
 await assert.rejects(resumeAfterRejectedJ3Snapshot(f.root,{...proof,jobId:randomUUID()},1003),/NOT_PROVEN/);
 await assert.rejects(resumeAfterRejectedJ3Snapshot(f.root,{...proof,jobAbsent:false},1003));
 await resumeAfterRejectedJ3Snapshot(f.root,proof,1003);assert.equal((await readFinalOwner(f.root)).stage,'RUNNING');
 await haltFinalOwner(f.root,1004);await assert.rejects(resumeAfterRejectedJ3Snapshot(f.root,proof,1005),/NOT_PROVEN/);
 const g=await fixture(t);await assert.rejects(g.dispatch(0,{send:async()=>{throw Error('unknown accepted producer');}}),/OUTCOME_UNKNOWN/);
 await assert.rejects(resumeAfterRejectedJ3Snapshot(g.root,{...proof,jobId:g.bindings[2].jobId},1003),/NOT_PROVEN/);
});
