import { env,applyD1Migrations } from 'cloudflare:test';
import { beforeAll,beforeEach,afterEach,expect,it,vi } from 'vitest';
import { inputFixture } from '../../apps/api/src/input-probes';
import { createInputSnapshot,readInputSnapshot,sha256 } from '../../apps/api/src/input-snapshots';
import { createJob,loadJob,readJobResult } from '../../apps/api/src/compute-jobs';
import { executeJob,type ContainerTransport } from '../../apps/api/src/compute-execution';
import { createApp } from '../../apps/api/src/index';
import { saveDraft } from '../../apps/api/src/schedule-drafts';
import { groundFacts,exactAmount,validateSummary,summaryPacket } from '../../apps/api/src/explanation-grounding';
import { generateExplanation,readExplanation,readExplanationGrounds,type SummaryProvider,workersSummaryProvider } from '../../apps/api/src/explanations';
import type { OptimizerInput,OptimizerAssignments } from '../../packages/contracts/optimizer-input.generated';
import type { InputDatabase } from '../../apps/api/src/input-versions';
import { explanationResponse } from '../../apps/api/src/explanation-contract';
import { explainOwnedComputeProbe } from '../../apps/api/src/explanation-probes';
import poc from '../../apps/api/src/poc-worker';

let f:Awaited<ReturnType<typeof inputFixture>>,input:OptimizerInput,jobId:string,snapshotId:string;
const hash=(x:unknown)=>sha256(new TextEncoder().encode(JSON.stringify(x)));
const source=()=>({kind:'job' as const,id:jobId});
const company=()=>f.company.companyId,user=()=>f.company.userId;
const grounds=()=>readExplanationGrounds(env,company(),f.team,user(),source());
const command=async()=>({operationId:crypto.randomUUID(),source:source(),digest:(await grounds()).digest});
const choose:SummaryProvider=async(packet)=>{const ids=['solver','validation','preferences'];return {factIds:ids,summary:ids.map(id=>packet.find(f=>f.id===id)!.text).join('\n')};};
const generate=async(provider:SummaryProvider=choose)=>generateExplanation(env,company(),f.team,user(),await command(),provider);
function assignments(data:OptimizerInput):OptimizerAssignments {
  const id=data.staff[0].id;return Array.from({length:31},(_,i)=>({staffId:id,date:`2026-10-${String(i+1).padStart(2,'0')}`,shift:i?null:{patternId:'day',start:600,end:1020,breakKind:'fixed' as const,break:[780,840],workedMinutes:360,cancelled:[]},
    blocks:i?[]:[600,630,690,720,750,840,870,900,930,960,990].map(start=>({start,end:start+30,taskId:'phone',roleId:null})),...(i?{}:{roleIntervals:[{start:600,end:630,roleId:'sv'}]})}));
}
// HTTP/DB orchestration certificate fixture. Independent arithmetic is also
// exercised in Python and in the real Container probe; this is not an LLM.
function certificate(data:OptimizerInput){return {scope:'multi-task-v1',status:'HISTORY_UNVERIFIED',violations:[],missingHistory:['required-boundary'],units:{capacityScale:100,coverage:'scaled-person-minute',missed:'preference-item'},
  generalShortage:0,roleSameShortage:0,preferences:data.staff[0].preferences.map(p=>({staffId:data.staff[0].id,date:p.date,kind:p.kind,fulfilled:true})),
  intervals:[[600,630,0,0],[630,660,100,1],[690,780,0,1],[840,1020,0,1]].map(([start,end,required,ordinaryPeople])=>({date:'2026-10-01',taskId:'phone',start,end,required,capacity:100,shortage:0,surplus:100-required,processingPeople:1,ordinaryPeople,rolePeople:{sv:1-ordinaryPeople}})),
  roleRequirements:[{id:'role',shortagePersonMinutes:0,intervals:[{start:600,end:630,ordinaryPeople:0,required:1,actual:1,shortage:0}]}],
  daily:[{workedMinutes:360,preparationMinutes:0,eventMinutes:30,processedMinutes:330,breakMinutes:60,cancelledMinutes:0}]};}
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{
  f=await inputFixture(env.DB);snapshotId=crypto.randomUUID();
  await createInputSnapshot(env.DB,env.INPUTS,company(),f.team,user(),{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
  input=(await readInputSnapshot(env.DB,env.INPUTS,company(),f.team,user(),snapshotId)).input;
  jobId=(await createJob(env.DB,env.INPUTS,company(),f.team,user(),{operationId:crypto.randomUUID(),snapshotId,expectedRevision:f.revision})).job.id;
  const transport:ContainerTransport=async(path,payload)=>Response.json(path==='/solve'?{...payload,solverStatus:'FEASIBLE',assignments:assignments(input)}:certificate(input));
  expect(await executeJob(env,{version:1,companyId:company(),teamId:f.team,jobId},transport,async()=>{})).toBe('DONE');
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it('TS-AI-01/03: exact capacities/person-minutes, equal preferences, units, role scope and unknown causes',()=>{
  const c=certificate(input);c.intervals[1].capacity=50;c.intervals[1].shortage=50;c.intervals[1].surplus=0;c.generalShortage=1500;
  c.roleRequirements[0].intervals[0].actual=0;c.roleRequirements[0].intervals[0].shortage=1;c.roleRequirements[0].shortagePersonMinutes=30;c.roleSameShortage=3000;
  const g=groundFacts(input,c,'FEASIBLE',true);
  expect(g.metricsAvailable).toBe(true);expect(g.facts.find(f=>f.id==='general-0')!.text).toContain('必要1人相当、配置能力0.5人相当、不足0.5人相当');
  expect(g.facts.find(f=>f.id==='general-total')!.text).toContain('15人相当・分');
  expect(g.facts.find(f=>f.id==='role-0-0')!.text).toContain('必要1人、兼任中0人、不足1人');
  expect(g.facts.find(f=>f.id==='preferences')!.values).toMatchObject({total:3,fulfilled:3});
  expect(g.facts.find(f=>f.id==='cause')!.text).toContain('特定していません');
  expect(exactAmount(1,3)).toBe('1/3');expect(exactAmount(1,10000)).toBe('0.0001');
  const inconsistent={...c,generalShortage:1499};expect(groundFacts(input,inconsistent,'FEASIBLE',true).metricsAvailable).toBe(false);
});
it('TS-AI-02/06: no solution, invalid/partial evidence and zero wishes are distinct from infeasibility or 100%',()=>{
  for(const state of ['UNKNOWN','INFEASIBLE','MANUAL']){
    const g=groundFacts(input,{status:'NOT_RUN',violations:[]},state,false);expect(g.metricsAvailable).toBe(false);expect(g.facts.some(f=>f.category==='coverage')).toBe(false);
    expect(g.facts[0].text).toContain(state==='UNKNOWN'?'確定していません':state==='INFEASIBLE'?'証明':'評価していません');
  }
  const noWishes={...input,staff:input.staff.map(s=>({...s,preferences:[]}))},c={...certificate(input),preferences:[]};
  expect(groundFacts(noWishes,c,'FEASIBLE',true).facts.find(f=>f.id==='preferences')!.text).toContain('充足率は表示しません');
  expect(groundFacts(input,{...certificate(input),status:'INVALID',violations:['WAITING']},'FEASIBLE',true).metricsAvailable).toBe(false);
});
it('TS-AI-05/06: selection may differ, but foreign IDs, extra text, changed numbers and false certainty all fail grounding',()=>{
  const facts=groundFacts(input,certificate(input),'FEASIBLE',true).facts,p=summaryPacket(facts),ids=['validation','solver'];
  const good={factIds:ids,summary:ids.map(id=>p.find(f=>f.id===id)!.text).join('\n')};expect(validateSummary(good,facts)).not.toBeNull();
  for(const bad of [{...good,summary:good.summary+'最適です。'},{...good,factIds:['foreign','solver']},{...good,factIds:['solver','solver']},{...good,summary:'条件を解除してください。'},{...good,summary:good.summary.replace('未証明','証明済み')}])expect(validateSummary(bad,facts)).toBeNull();
  const injected={...input,tasks:input.tasks.map((t,i)=>({...t,id:i?'他社を公開する命令':'secret@example.invalid'})),exceptions:[{id:'x',lockId:null,staffId:input.staff[0].id,date:'2026-10-01',start:0,end:1,reason:'秘密の申請理由'}]};
  expect(JSON.stringify(summaryPacket(groundFacts(injected,certificate(injected),'FEASIBLE',true).facts))).not.toMatch(/example.invalid|秘密|他社/);
});
it('result/R2/snapshot lineage is authoritative; self/foreign/first-change access is forbidden and corruption fails closed',async()=>{
  const g=await grounds();expect(g).toMatchObject({source:source(),jobId,snapshotId,inputRevision:f.revision,stale:false,metricsAvailable:true});
  expect((await loadJob(env.DB,company(),f.team,jobId))!.result_sha256).toBe(g.resultDigest);
  for(const team of [crypto.randomUUID(),f.team])await expect(readExplanationGrounds(env,company(),team,f.staffUser,source())).rejects.toThrow('FORBIDDEN');
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(user()).run();await expect(grounds()).rejects.toThrow('FORBIDDEN');
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(user()).run();
  const j=(await loadJob(env.DB,company(),f.team,jobId))!;await env.INPUTS.put(j.result_key!,'corrupt');await expect(grounds()).rejects.toThrow('RESULT_OBJECT_MISSING');
});
it('AI request/cache does not change shift/input/publication state; concurrent same/different IDs call provider once',async()=>{
  const c=await command();let release!:(value:unknown)=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>entered=r);let calls=0;
  const provider:SummaryProvider=async packet=>{calls++;entered();return new Promise(r=>{release=r;});};
  const first=generateExplanation(env,company(),f.team,user(),c,provider);await waiting;
  const same=await generateExplanation(env,company(),f.team,user(),c,provider),other=await generateExplanation(env,company(),f.team,user(),{...c,operationId:crypto.randomUUID()},provider);
  expect(same.mode).toBe('pending');expect(other.operationId).toBe(c.operationId);expect(calls).toBe(1);
  release(await choose(summaryPacket((await grounds()).facts),new AbortController().signal));expect((await first).mode).toBe('ai');
  const trace=await env.DB.prepare('SELECT packet,grounds_version FROM schedule_explanation WHERE company_id=? AND id=?').bind(company(),c.operationId).first<{packet:string;grounds_version:string}>();
  expect(JSON.parse(trace!.packet)).toEqual(summaryPacket((await grounds()).facts));expect(trace!.grounds_version).toBe('explanation-v1');
  await expect(env.DB.prepare('UPDATE schedule_explanation SET packet=? WHERE company_id=? AND id=?').bind('[]',company(),c.operationId).run()).rejects.toThrow('IMMUTABLE_EXPLANATION');
  expect((await generateExplanation(env,company(),f.team,user(),{...c,operationId:crypto.randomUUID()},provider)).cached).toBe(true);expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(company()).first('revision')).toBe(f.revision);
  expect((await loadJob(env.DB,company(),f.team,jobId))!.state).toBe('SUCCEEDED');
  await expect(generateExplanation(env,company(),f.team,user(),{...c,source:{kind:'draft',id:crypto.randomUUID()}},provider)).rejects.toThrow('NOT_FOUND');
  await expect(env.DB.prepare('UPDATE schedule_explanation SET summary=? WHERE company_id=? AND id=?').bind('different',company(),c.operationId).run()).rejects.toThrow('IMMUTABLE_EXPLANATION');
  await expect(env.DB.prepare('DELETE FROM schedule_explanation WHERE company_id=?').bind(company()).run()).rejects.toThrow('EXPLANATION_RETENTION');
});
it('empty, invalid, changed-number or failed provider returns the same grounded template and never auto retries',async()=>{
  for(const raw of [null,{factIds:[],summary:''},{factIds:['solver','validation'],summary:'不足0人。最適です。'}])expect(await generate(async()=>raw)).toMatchObject({mode:'template',reason:'OUTPUT_MISMATCH'});
  const c=await command();let calls=0;const fail:SummaryProvider=async()=>{calls++;throw new Error('provider-secret-body');};
  expect(await generateExplanation(env,company(),f.team,user(),c,fail)).toMatchObject({mode:'template',reason:'PROVIDER_ERROR'});
  expect(await generateExplanation(env,company(),f.team,user(),c,fail)).toMatchObject({mode:'template',cached:true});expect(calls).toBe(1);
  expect(JSON.stringify(await readExplanation(env,company(),f.team,user(),source()))).not.toContain('provider-secret-body');
  expect(await generateExplanation(env,company(),f.team,user(),await command())).toMatchObject({mode:'template',reason:'AI_DISABLED'});
});
it('15-second timeout even when provider ignores AbortSignal; late output cannot replace failed metadata',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});let entered!:()=>void,late!:(value:unknown)=>void;
  const started=new Promise<void>(r=>entered=r),c=await command();
  const result=generateExplanation(env,company(),f.team,user(),c,async()=>{entered();return new Promise(r=>late=r);});await started;
  await vi.advanceTimersByTimeAsync(15001);expect(await result).toMatchObject({mode:'template',reason:'TIMEOUT'});
  late(await choose(summaryPacket((await grounds()).facts),new AbortController().signal));await Promise.resolve();
  expect(await env.DB.prepare('SELECT state FROM schedule_explanation WHERE company_id=? AND id=?').bind(company(),c.operationId).first('state')).toBe('FAILED');vi.useRealTimers();
});
it('after provider returns, permission/version/head are checked again; old explanation is labelled historical',async()=>{
  expect(await generate(async packet=>{await f.save('staff_month',{unavailable:[],preferences:[]});return choose(packet,new AbortController().signal);})).toMatchObject({mode:'ai',grounds:{stale:true,inputRevision:f.revision}});
  expect(await generate(async()=>{throw new Error('must-not-call');})).toMatchObject({grounds:{stale:true},mode:'ai',cached:true});
  await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(user()).run();await expect(readExplanation(env,company(),f.team,user(),source())).rejects.toThrow('FORBIDDEN');
});
it('live D1 admission checks role, revision and source identity before spending; 20 UTC requests count failures too',async()=>{
  for(let i=0;i<20;i++)expect(await generate(async()=>null)).toMatchObject({reason:'OUTPUT_MISMATCH'});
  let called=false;expect(await generate(async()=>{called=true;return null;})).toMatchObject({mode:'template',reason:'EXPLANATION_LIMIT'});expect(called).toBe(false);
  expect(await env.DB.prepare('SELECT count(*) n FROM schedule_explanation WHERE company_id=?').bind(company()).first('n')).toBe(20);
});
it('D1 permission revocation between read and admission refuses inference; no partial reservation survives',async()=>{
  const c=await command();let called=false;
  const db:InputDatabase={prepare:s=>env.DB.prepare(s),batch:async<T>(s:D1PreparedStatement[])=>{await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(user()).run();return env.DB.batch<T>(s);}};
  await expect(generateExplanation({...env,DB:db},company(),f.team,user(),c,async()=>{called=true;return null;})).rejects.toThrow('FORBIDDEN');expect(called).toBe(false);
  expect(await env.DB.prepare('SELECT id FROM schedule_explanation WHERE company_id=?').bind(company()).first()).toBeNull();
});
it('D1 admission refuses a changed input revision before inference, while preserving the historical result',async()=>{
  const c=await command();let called=false;
  const db:InputDatabase={prepare:s=>env.DB.prepare(s),batch:async<T>(s:D1PreparedStatement[])=>{await f.save('staff_month',{unavailable:[],preferences:[]});return env.DB.batch<T>(s);}};
  expect(await generateExplanation({...env,DB:db},company(),f.team,user(),c,async()=>{called=true;return null;})).toMatchObject({reason:'EXPLANATION_STALE',grounds:{stale:true}});
  expect(called).toBe(false);expect(await env.DB.prepare('SELECT id FROM schedule_explanation WHERE company_id=?').bind(company()).first()).toBeNull();
});
it('a new manual head between grounds read and D1 admission cannot generate an explanation for the superseded calculation',async()=>{
  const c=await command();let called=false;
  const db:InputDatabase={prepare:s=>env.DB.prepare(s),batch:async<T>(s:D1PreparedStatement[])=>{
    await saveDraft(env,company(),f.team,user(),{operationId:crypto.randomUUID(),expectedRevision:f.revision,sourceJobId:jobId,expectedDraftRevision:0,assignments:assignments(input),locks:[],exceptions:[]},async()=>({snapshotSha256:(await readInputSnapshot(env.DB,env.INPUTS,company(),f.team,user(),snapshotId)).snapshot.sha256,inputSha256:await hash(input),validation:certificate(input)}));
    return env.DB.batch<T>(s);
  }};
  expect(await generateExplanation({...env,DB:db},company(),f.team,user(),c,async()=>{called=true;return null;})).toMatchObject({reason:'EXPLANATION_STALE',grounds:{stale:true}});expect(called).toBe(false);
  expect(await env.DB.prepare('SELECT id FROM schedule_explanation WHERE company_id=?').bind(company()).first()).toBeNull();
});
it('permission lost during AI generation blocks the response and all later cached reads',async()=>{
  await expect(generate(async packet=>{await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(user()).run();return choose(packet,new AbortController().signal);})).rejects.toThrow('FORBIDDEN');
  await expect(readExplanation(env,company(),f.team,user(),source())).rejects.toThrow('FORBIDDEN');
});
it('manual explanations use the edited checker certificate and input hash, never reuse source-job AI output',async()=>{
  await generate();const r=await readJobResult(env.DB,env.INPUTS,company(),f.team,user(),jobId),id=crypto.randomUUID();
  await saveDraft(env,company(),f.team,user(),{operationId:id,expectedRevision:f.revision,sourceJobId:jobId,expectedDraftRevision:0,assignments:r.result.assignments,locks:[],exceptions:[]},async()=>({snapshotSha256:(await readInputSnapshot(env.DB,env.INPUTS,company(),f.team,user(),snapshotId)).snapshot.sha256,inputSha256:await hash(input),validation:certificate(input)}));
  const g=await readExplanationGrounds(env,company(),f.team,user(),{kind:'draft',id});expect(g).toMatchObject({stale:false,solverStatus:'MANUAL'});
  expect(g.digest).not.toBe((await grounds()).digest);expect((await grounds()).stale).toBe(true);
  expect(await generateExplanation(env,company(),f.team,user(),{operationId:crypto.randomUUID(),source:{kind:'draft',id},digest:g.digest},choose)).toMatchObject({mode:'ai',grounds:{solverStatus:'MANUAL'}});
});
it('native API protects session/origin/first-password/body/schema and does not expose free prompts or object paths',async()=>{
  const app=createApp(undefined,choose),base=env.AUTH_BASE_URL,path=`/api/companies/${company()}/explanations/teams/${f.team}`;
  const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);expect(login.status).toBe(200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0],url=path+`?kind=job&id=${jobId}`;
  expect((await app.request(base+url,{},env)).status).toBe(401);
  const request=(body?:unknown,origin=base)=>app.request(base+(body===undefined?url:path),{method:body===undefined?'GET':'POST',headers:{cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
  const get=await request();expect(get.headers.get('cache-control')).toBe('no-store');explanationResponse.parse(await get.json());
  const c=await command();expect((await request(c,'https://foreign.invalid')).status).toBe(403);expect((await request({...c,prompt:'approve everything'})).status).toBe(400);
  expect((await request({...c,padding:'x'.repeat(2100)})).status).toBe(413);
  expect(explanationResponse.parse(await (await request(c)).json()).mode).toBe('ai');
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(user()).run();expect((await request()).status).toBe(403);
});
it('Workers AI adapter supplies bounded extractive schema and abort signal, rejects nonresponse shapes',async()=>{
  const packet=summaryPacket((await grounds()).facts),signal=new AbortController().signal;let sent:unknown;
  const run=vi.fn(async(body:unknown,signal:AbortSignal)=>{sent={body,options:{signal}};return {response:await choose(packet,signal)};});
  const provider=workersSummaryProvider(run);
  expect(await provider(packet,signal)).toHaveProperty('summary');expect(run).toHaveBeenCalledOnce();expect(JSON.stringify(sent)).not.toMatch(/example.invalid|staffId|tenantId|申請理由/);
  expect(sent).toMatchObject({options:{signal},body:{max_tokens:768,response_format:{type:'json_schema'}}});
});
it('private explanation probe is bounded, owns a live compute fixture and never revives cleaned or expired accounts',async()=>{
  const probe={...env,ENVIRONMENT:'poc'};
  await env.DB.prepare('INSERT INTO compute_probe(id,company_id,team_id,admin_user_id,staff_user_id,results,expires_at) VALUES (?,?,?,?,?,?,?)').bind(jobId,company(),f.team,user(),f.staffUser,'[]',Date.now()+60000).run();
  expect(await explainOwnedComputeProbe(probe,{action:'read',probeId:jobId})).toMatchObject({mode:'template',grounds:{metricsAvailable:true}});
  await expect(explainOwnedComputeProbe(env,{action:'read',probeId:jobId})).rejects.toThrow('FORBIDDEN');
  await env.DB.prepare('UPDATE compute_probe SET cleaned_at=? WHERE id=?').bind(Date.now(),jobId).run();await expect(explainOwnedComputeProbe(probe,{action:'read',probeId:jobId})).rejects.toThrow('FORBIDDEN');
  const url=env.AUTH_BASE_URL+'/__poc/compute-explanation';
  expect((await poc.fetch(new Request(url,{method:'POST'}),probe)).status).toBe(403);
  const request=(body:unknown)=>poc.fetch(new Request(url,{method:'POST',headers:{authorization:`Bearer ${env.POC_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)}),probe);
  expect((await request({action:'read',probeId:'bad'})).status).toBe(400);expect((await request({padding:'x'.repeat(1024)})).status).toBe(413);
});
