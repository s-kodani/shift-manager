import {env,applyD1Migrations,createExecutionContext,waitOnExecutionContext,createMessageBatch,getQueueResult} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {z} from 'zod';
import {createApp} from '../../apps/api/src/index';
import {registeredOperationalFixture,disableRegisteredFixture,type RegisteredRequest} from '../fixtures/registered-operational';
import {executeJob,type ContainerTransport} from '../../apps/api/src/compute-execution';
import {handleJobBatch} from '../../apps/api/src/compute-worker';
import {checkDraftCandidate} from '../../apps/api/src/draft-check';
import type {CandidateCommand} from '../../apps/api/src/draft-contract';
import type {JobMessage} from '../../apps/api/src/compute-jobs';
import type {OptimizerInput,OptimizerAssignments} from '../../packages/contracts/optimizer-input.generated';

const qualitySchema=z.object({status:z.literal('VERIFIED'),violations:z.array(z.string()).length(0),missingHistory:z.array(z.string()).length(0),
 objectiveOrder:z.array(z.string()),objectiveVector:z.array(z.number().int().nonnegative().safe()),objective:z.record(z.string(),z.number().int().nonnegative().safe()),
 generalShortage:z.number().int().nonnegative().safe(),roleSameShortage:z.number().int().nonnegative().safe()}).passthrough();
function quality(value:unknown){const q=qualitySchema.parse(value);expect(q.objectiveOrder).toEqual(['roleFirst','combined','missed','surplus']);expect(q.objectiveVector).toEqual(q.objectiveOrder.map(n=>q.objective[n]));expect(q.objective.combined).toBe(q.generalShortage+q.roleSameShortage);return {objectiveVector:q.objectiveVector,generalShortage:q.generalShortage,roleSameShortage:q.roleSameShortage};}
const lex=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;return 0;};
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('500-person HTTP first-change, registration, dispatched native computation, fixed recalculation, publication and self-only read preserve certificates and replay semantics',async()=>{
 const native=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher;NATIVE_CHECKER:Fetcher;CANCELLATION_NATIVE_CHECK_URL:string;NATIVE_SAVED_CANDIDATE_PROFILE:string};
 const seeded=native.NATIVE_SAVED_CANDIDATE_PROFILE==='mvp-joint-seed-v1';
 const source=await(await native.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput;assignments:OptimizerAssignments};
 const sent:unknown[]=[],reports:unknown[]=[];let solves=0,checks=0,terminated=0,admin:RegisteredRequest,staff:RegisteredRequest,staffId='';
 const transport=(deadline:number):ContainerTransport=>async(path,payload)=>{if(path==='/solve')solves++;else checks++;return native.NATIVE_CHECKER.fetch(native.CANCELLATION_NATIVE_CHECK_URL+path,{method:'POST',headers:{'content-type':'application/json','x-native-timeout-ms':String(Math.max(1,deadline-Date.now()))},body:JSON.stringify(payload)});};
 const queue:Queue={send:async(body)=>{sent.push(body);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};},
  sendBatch:async(messages)=>{for(const m of messages)sent.push(m.body);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};},metrics:async()=>({backlogCount:0,backlogBytes:0})};
 // The product handler/consumer and native bytes are real. Queue delivery and
 // DO RPC/lifecycle are controlled adapters, not real Queues or DO evidence.
 const bindings={...env,OPTIMIZER_SOLVE_PROFILE:seeded?'mvp-joint-seed-v1':'mvp-joint-v1',COMPUTE_QUEUE:queue,SOLVER:{getByName:()=>({
  runJob:(message:JobMessage)=>executeJob(bindings,message,transport(Date.now()+150000),async()=>{terminated++;}),
  checkDraft:(command:CandidateCommand)=>checkDraftCandidate(bindings,command,transport(Date.now()+60000),async()=>{terminated++;}),
 })}} as unknown as Env;
 const app=createApp(),base=env.AUTH_BASE_URL;
 const request=async(path:string,body?:object,cookie?:string,origin=base)=>{
  const context=createExecutionContext();
  const response=await app.request(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},bindings,context);
  await waitOnExecutionContext(context);expect(response.headers.get('cache-control')).toBe('no-store');return response;
 };
 const authenticate=async(email:string,password:string)=>{
  expect((await request('/api/context')).status).toBe(401);
  const login=await request('/api/auth/sign-in/email',{email,password});expect(login.status).toBe(200);
  const old=login.headers.get('set-cookie')!.split(';')[0];
  expect((await request('/api/context',undefined,old)).status).toBe(403);
  const access=await(await request('/api/access',undefined,old)).json() as {mustChange:boolean};expect(access.mustChange).toBe(true);
  const changed=await request('/api/password',{currentPassword:password,newPassword:'Native-changed-'+crypto.randomUUID()},old);expect(changed.status).toBe(200);
  const cookie=changed.headers.get('set-cookie')!.split(';')[0];expect((await request('/api/context',undefined,old)).status).toBe(401);
  expect((await request('/api/context',undefined,cookie)).status).toBe(200);
  expect((await request('/api/password',{currentPassword:'invalid',newPassword:'Native-invalid-origin-'+crypto.randomUUID()},cookie,'https://foreign.invalid')).status).toBe(403);
  return ((path,body)=>request(path,body,cookie)) as RegisteredRequest;
 };
 const json=async<T>(client:RegisteredRequest,path:string,body?:object,status=200)=>{const response=await client(path,body);expect(response.status).toBe(status);return await response.json() as T;};
 const started=Date.now();
 const f=await registeredOperationalFixture(env,source,{
  authenticate:async(issued,email)=>{admin=await authenticate(email,issued.initialPassword);return admin;},
  firstStaffIssued:async(email,id,password)=>{staffId=id;staff=await authenticate(email,password);},
 });
 const company='/api/companies/'+f.companyId,inputs=company+'/inputs/teams/'+f.team,jobs=company+'/compute/teams/'+f.team+'/jobs',schedules=company+'/schedules/teams/'+f.team;
 try {
  console.log(JSON.stringify({phase:'http-registered-and-compiled',staff:f.frozen.input.staff.length,history:f.frozen.input.history.length,milliseconds:Date.now()-started,firstChanges:2}));
  expect(f.frozen.input.staff).toHaveLength(500);expect(f.frozen.input.history).toHaveLength(2500);
  const inverse=new Map([...f.staffIds].map(([old,id])=>[id,old]));
  const normalize=(input:OptimizerInput)=>input.staff.map(s=>({...s,id:inverse.get(s.id)??s.id,rules:s.rules.map(({id,...r})=>r)})).sort((a,b)=>a.id.localeCompare(b.id));
  expect(normalize(f.frozen.input)).toEqual(normalize(source.input));
  expect(f.frozen.input.events.map(e=>({...e,staffIds:e.staffIds.map(id=>inverse.get(id)!)}))).toEqual(source.input.events);
  expect(f.frozen.input.demand).toEqual(source.input.demand);expect(f.frozen.input.roleRequirements).toEqual(source.input.roleRequirements);
  const people=await json<{staff:unknown[]}>(admin!,company+'/teams/'+f.team+'/staff');expect(people.staff).toHaveLength(500);
  expect((await staff!(jobs)).status).toBe(403);expect((await staff!(company+'/teams/'+f.team+'/staff')).status).toBe(403);
  const consume=async(message:unknown,label:string)=>{const context=createExecutionContext(),batch=createMessageBatch('native-controlled',[{id:label,timestamp:Date.now(),attempts:1,body:message}]);await handleJobBatch(batch,bindings);const result=await getQueueResult(batch,context);expect(result.explicitAcks).toEqual([label]);expect(result.retryMessages).toEqual([]);};
  const run=async(snapshotId:string,revision:number,phase:string)=>{
   const id=crypto.randomUUID(),command={operationId:id,snapshotId,expectedRevision:revision},sentBefore=sent.length;
   await json(admin!,jobs,command,202);expect(sent).toHaveLength(sentBefore+1);
   const message=sent.at(-1);expect(message).toEqual({version:1,companyId:f.companyId,teamId:f.team,jobId:id});
   await json(admin!,jobs,command,202);expect(sent).toHaveLength(sentBefore+1);
   const t=Date.now();await consume(message,phase);
   const status=await json<{state:string;attempt:number;validation_status:string}>(admin!,jobs+'/'+id);expect(status.state).toBe('SUCCEEDED');expect(status.attempt).toBe(1);
   const saved=await json<{result:{solverStatus:string;assignments:OptimizerAssignments;validation:unknown;metrics:Record<string,unknown>;stages:unknown[]};stale:boolean}>(admin!,jobs+'/'+id+'/result');
   expect(saved.stale).toBe(false);expect(saved.result.assignments).toHaveLength(15500);expect(['FEASIBLE','OPTIMAL']).toContain(saved.result.solverStatus);
   const final=quality(saved.result.validation),initial=saved.result.metrics.initialIncumbent as {adopted?:boolean;objectiveVector?:number[]}|undefined;
   if(initial?.adopted&&initial.objectiveVector)expect(lex(final.objectiveVector,initial.objectiveVector)).toBeLessThanOrEqual(0);
   const milliseconds=Date.now()-t;expect(milliseconds).toBeLessThan(150000);
   const count=solves;await consume(message,phase+'-duplicate');expect(solves).toBe(count);
   const report={phase,milliseconds,solverStatus:saved.result.solverStatus,validationStatus:'VERIFIED',final,metrics:saved.result.metrics,stages:saved.result.stages};reports.push(report);console.log(JSON.stringify(report));
   expect((await staff!(jobs+'/'+id+'/result')).status).toBe(403);return {id,final,self:saved.result.assignments.filter(a=>a.staffId===staffId),savedCandidate:saved.result.metrics.savedCandidate};
  };
  const first=await run(f.snapshotId,f.revision,'http-initial-job');
  const draftId=crypto.randomUUID();
  const draft=await json<{inputRevision:number;draftRevision:number}>(admin!,schedules+'/drafts',{operationId:draftId,expectedRevision:f.revision,expectedDraftRevision:0,sourceJobId:first.id,...f.manual});expect(draft.draftRevision).toBe(1);
  const checkedManual=await json<{draft:{validation:unknown}}>(admin!,schedules+'/drafts/'+draftId);const manual=quality(checkedManual.draft.validation);
  console.log(JSON.stringify({phase:'http-checked-manual-reference',final:manual,scope:seeded?'controlled saved draft; explicitly advisory in opt-in seeded profile':'controlled manual edit; not a solver answer or search seed'}));
  const snapshotId=crypto.randomUUID();await json(admin!,schedules+'/drafts/'+draftId+'/snapshots',{operationId:snapshotId,expectedRevision:draft.inputRevision,expectedDraftRevision:1});
  const fixed=await json<{input:OptimizerInput;snapshot:{lineage:string}}>(admin!,inputs+'/snapshots/'+snapshotId);
  expect(fixed.input.locks).toEqual(f.manual.locks);expect(fixed.input.exceptions).toEqual(f.manual.exceptions);expect(normalize(fixed.input)).toEqual(normalize(f.frozen.input));
  expect(JSON.parse(fixed.snapshot.lineage).some((r:{kind:string;version:string})=>r.kind==='manual_draft'&&r.version===draftId)).toBe(true);
  const second=await run(snapshotId,draft.inputRevision,'http-fixed-recalculation');
  if(seeded){
   expect(second.savedCandidate).toMatchObject({adopted:true,precheckStatus:'VERIFIED',validationStatus:'VERIFIED',sourceObjectiveVector:manual.objectiveVector});
   expect(lex(second.final.objectiveVector,manual.objectiveVector)).toBeLessThanOrEqual(0);
  }
  console.log(JSON.stringify({phase:'http-fixed-quality-comparison',manual:manual.objectiveVector,recalculated:second.final.objectiveVector,recalculationWorseThanManual:lex(second.final.objectiveVector,manual.objectiveVector)>0}));
  const publicationId=crypto.randomUUID(),publish={operationId:publicationId,expectedRevision:draft.inputRevision,expectedDraftRevision:1,expectedPublicationRevision:0,source:{kind:'job',id:second.id},acknowledgeShortage:true};
  const publicationStarted=Date.now();let shortageApprovalChecked=false;
  if(second.final.objectiveVector[0]>0||second.final.objectiveVector[1]>0){
   const rejected=await admin!(schedules+'/publications',{...publish,acknowledgeShortage:false});
   expect(rejected.status).toBe(400);expect(await rejected.json()).toEqual({error:'PUBLICATION_SHORTAGE_ACK_REQUIRED'});
   expect(await env.DB.prepare('SELECT count(*) n FROM schedule_publication_commit WHERE company_id=?').bind(f.companyId).first<number>('n')).toBe(0);
   shortageApprovalChecked=true;
  }
  const published=await json<{publication:string;publicationRevision:number;revision:number}>(admin!,schedules+'/publications',publish);expect(published.publication).toBe('PUBLISHED');expect(published.publicationRevision).toBe(1);
  const replay=await json<{replayed:boolean}>(admin!,schedules+'/publications',publish);expect(replay.replayed).toBe(true);
  const proof=await json<{publication:{assignments:OptimizerAssignments;validation:unknown}}>(admin!,schedules+'/publications/'+publicationId);
  expect(proof.publication.assignments).toHaveLength(15500);const publishedQuality=quality(proof.publication.validation);expect(publishedQuality).toEqual(second.final);
  const visible=await json<{publication:{assignments:OptimizerAssignments;validation?:unknown;exceptions?:unknown};revalidationRequired:boolean}>(staff!,schedules+'/publications/'+publicationId);
  expect(visible.publication.assignments).toHaveLength(31);expect(visible.publication.assignments).toEqual(second.self);expect(visible.publication.assignments.every(a=>a.staffId===staffId)).toBe(true);expect(visible.publication.validation).toBeUndefined();expect(visible.publication.exceptions).toBeUndefined();expect(visible.revalidationRequired).toBe(false);
  const notices=await json<{notices:{publicationId:string}[]}>(staff!,schedules+'/publications/notices');expect(notices.notices).toHaveLength(1);expect(notices.notices[0].publicationId).toBe(publicationId);
  await json(staff!,schedules+'/publications/notices/'+publicationId+'/read',{});
  const noticeCount=await env.DB.prepare('SELECT count(*) n FROM schedule_publication_notice WHERE company_id=? AND publication_id=?').bind(f.companyId,publicationId).first<number>('n');expect(noticeCount).toBe(500);
  console.log(JSON.stringify({phase:'http-publication-and-self-read',milliseconds:Date.now()-publicationStarted,notices:noticeCount,selfDays:31,replay:true,shortageApprovalChecked,sourceFinal:second.final,publishedFinal:publishedQuality}));
  console.log(JSON.stringify({phase:'http-acceptance-complete',totalMilliseconds:Date.now()-started,staff:500,solves,checks,controlledTerminationCallbacks:terminated,reports,scope:'real product HTTP/auth/registration/compiler/consumer/native solve/check/R2/D1/draft/publication/self read; Queue delivery and DO RPC/lifecycle controlled; excludes browser/real Queues/DO lifecycle/remote full acceptance'}));
 } finally {
  await disableRegisteredFixture(env,f.companyId);
  const users='SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?';
  const credentials=await env.DB.prepare(`SELECT count(*) n FROM access_state WHERE user_id IN (${users})`).bind(f.companyId,f.companyId).first<number>('n');expect(credentials).toBe(501);
  const active=await env.DB.prepare(`SELECT count(*) n FROM access_state WHERE enabled<>0 AND user_id IN (${users})`).bind(f.companyId,f.companyId).first<number>('n');
  const sessions=await env.DB.prepare(`SELECT count(*) n FROM session WHERE userId IN (${users})`).bind(f.companyId,f.companyId).first<number>('n');
  const passwords=await env.DB.prepare(`SELECT count(*) n FROM account WHERE password IS NOT NULL AND userId IN (${users})`).bind(f.companyId,f.companyId).first<number>('n');
  expect({active,sessions,passwords}).toEqual({active:0,sessions:0,passwords:0});
  expect((await admin!('/api/context')).status).toBe(401);expect((await staff!('/api/context')).status).toBe(401);
  console.log(JSON.stringify({phase:'http-credentials-disabled',credentials,active,sessions,passwords,emailSent:false}));
 }
},600000);
