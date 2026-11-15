import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,afterEach,expect,it} from 'vitest';
import {inputFixture,probeConfig,probePolicy,probeEmployment} from '../../apps/api/src/input-probes';
import {saveInputVersion,type ResourceTarget} from '../../apps/api/src/input-versions';
import {createInputSnapshot,readInputSnapshot,sha256} from '../../apps/api/src/input-snapshots';
import {readHistory,saveHistory} from '../../apps/api/src/work-history';
import {createJob,loadJob,readJobResult} from '../../apps/api/src/compute-jobs';
import {executeJob} from '../../apps/api/src/compute-execution';
import {saveDraft,readDraftHead,type DraftVerifier} from '../../apps/api/src/schedule-drafts';
import {publishSchedule,readPublicationHead} from '../../apps/api/src/schedule-publications';
import {optimizerAssignmentsSchema,optimizerInputSchema} from '../../packages/contracts/optimizer-input.generated';

// Invalid solver output and stop acknowledgement are controlled. Rule reports
// and the missing-history normal solve use the real Docker/Python service.
const month='2026-10';
const cases=[
 {name:'TS-RULE-02 company daily240 survives looser employment/personal limits',kind:'company',code:'DAILY_HOURS'},
 {name:'TS-RULE-02 employment daily240 survives looser company/personal limits',kind:'employment',code:'DAILY_HOURS'},
 {name:'TS-RULE-02 personal daily240 is enforced with both common layers',kind:'personal',code:'DAILY_HOURS'},
 {name:'TS-RULE-03 current week360 plus September60 exceeds week360',kind:'weekly',code:'WEEKLY_HOURS'},
 {name:'TS-RULE-03 month360 exceeds monthly240 independently',kind:'month-max',code:'MONTHLY_HOURS'},
 {name:'TS-RULE-04 October180 plus September300 cannot meet October minimum240',kind:'month-min',code:'MONTHLY_HOURS'},
 {name:'TS-RULE-04 one October day plus one September day cannot meet October minimum2 days',kind:'min-days',code:'MONTHLY_DAYS'},
 {name:'TS-RULE-06 October29 off days plus September off days cannot meet October minimum30 off days',kind:'min-off',code:'MONTHLY_DAYS'},
 {name:'TS-RULE-01 one unavailable minute forbids an otherwise valid long shift',kind:'partial-unavailable',code:'UNAVAILABLE'},
 {name:'TS-RULE-01 full-day unavailable is hard while an off preference is soft',kind:'full-unavailable',code:'UNAVAILABLE'},
 {name:'TS-RULE-07 attendance after personal contract15:00 is rejected',kind:'contract',code:'CONTRACT'},
] as const;
type Kind=(typeof cases)[number]['kind']|'missing-history';
let f:Awaited<ReturnType<typeof inputFixture>>|undefined,snapshotId:string;
const fixture=()=>{if(!f)throw Error('RULE_FIXTURE_MISSING');return f;};
const company=()=>fixture().company.companyId,user=()=>fixture().company.userId;
const revision=async()=> (await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(company()).first<number>('revision'))!;
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
afterEach(async()=>{
 if(!f)return;
 await env.DB.batch([
  env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id IN (?,?)').bind(f.company.userId,f.staffUser),
  env.DB.prepare('DELETE FROM session WHERE userId IN (?,?)').bind(f.company.userId,f.staffUser),
  env.DB.prepare('UPDATE account SET password=NULL WHERE userId IN (?,?)').bind(f.company.userId,f.staffUser),
 ]);f=undefined;
});
async function save(kind:ResourceTarget['kind'],payload:unknown,entity?:string){
 const personal=kind==='staff_contract'||kind==='staff_month',team=personal||kind==='team_config';
 return saveInputVersion(env.DB,{company:company(),team:team?fixture().team:null,staff:personal?fixture().staff.staffId:null,kind,entity:entity??(personal?fixture().staff.staffId:team?fixture().team:company())},user(),{operationId:crypto.randomUUID(),expectedRevision:await revision(),effectiveFrom:month,payload},env.INPUTS);
}
async function setup(kind:Kind){
 f=await inputFixture(env.DB,env.INPUTS);
 await save('team_config',{...probeConfig,patterns:[...probeConfig.patterns,{id:'short',start:600,end:780,breakKind:'auto'}]});
 if(kind==='missing-history'){
  // A finite feasible reference case: one available short day, all product
  // constraints retained. This checks history classification, not throughput.
  await save('staff_contract',{...f.profile,contract:{...f.profile.contract,end:780}});
  await save('staff_month',{unavailable:Array.from({length:30},(_,n)=>({date:`${month}-${String(n+2).padStart(2,'0')}`,start:0,end:1440})),preferences:[{date:'2026-10-01',kind:'work'},{date:'2026-10-01',kind:'pattern',patternId:'short'}]});
 }
 if(kind==='company')await save('company_policy',{...probePolicy,rule:{...probePolicy.rule,dailyMax:240}});
 if(kind==='employment')await save('employment_policy',{...probeEmployment,rule:{...probeEmployment.rule,dailyMax:240}},f.employment);
 const overrides=kind==='personal'?{dailyMax:240}:kind==='weekly'?{weeklyMax:360}:kind==='month-max'?{monthlyMax:240}:kind==='month-min'?{monthlyMin:240}:kind==='min-days'?{minDays:2}:kind==='min-off'?{minOff:30}:{};
 if(Object.keys(overrides).length||kind==='contract')await save('staff_contract',{...f.profile,rule:{...f.profile.rule,...overrides},contract:{...f.profile.contract,end:kind==='contract'?900:f.profile.contract.end}});
 if(kind==='partial-unavailable'||kind==='full-unavailable')await save('staff_month',{unavailable:[{date:kind==='partial-unavailable'?'2026-10-01':'2026-10-02',start:kind==='partial-unavailable'?840:0,end:kind==='partial-unavailable'?841:1440}],preferences:[{date:'2026-10-01',kind:'off'}]});
 if(kind!=='missing-history'){
  const h=await readHistory(env.DB,env.INPUTS,company(),f.team,user(),month);
  await saveHistory(env.DB,company(),f.team,user(),{operationId:crypto.randomUUID(),expectedRevision:await revision(),month,records:h.missing.map(r=>({...r,workedMinutes:r.date==='2026-09-30'?(kind==='weekly'?60:kind==='month-min'?300:kind==='min-days'?180:0):0,evidence:'架空P0手計算・確認済み月境界実績'}))});
 }
 snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,company(),f.team,user(),{operationId:snapshotId,expectedRevision:await revision(),month});
}
function assignments(days=1,long=false){
 return optimizerAssignmentsSchema.parse(Array.from({length:31},(_,n)=>{
  const working=n<days,end=long?1020:780;
  return {staffId:fixture().staff.staffId,date:`${month}-${String(n+1).padStart(2,'0')}`,
   shift:working?{patternId:long?'day':'short',start:600,end,breakKind:long?'fixed':'auto',break:long?[780,840]:null,workedMinutes:long?360:180,cancelled:[]}:null,
   blocks:working?Array.from({length:(end-600)/30},(_,i)=>600+i*30).filter(start=>!(long&&[780,810].includes(start))&&!(n===0&&start===660)).map(start=>({start,end:start+30,taskId:'phone',roleId:null})):[],roleIntervals:[]};
 }));
}
async function transport(path:string,payload:unknown,referenceSolve=false){
 const n=env as unknown as {CANCELLATION_NATIVE_CHECK_URL:string;NATIVE_CHECKER:Fetcher};
 const r=await n.NATIVE_CHECKER.fetch(n.CANCELLATION_NATIVE_CHECK_URL+path,{method:'POST',headers:{'content-type':'application/json',...(referenceSolve?{'x-native-reference-solve':'history-reference-v1'}:{})},body:JSON.stringify(payload)});expect(r.status).toBe(200);return r;
}
const verifier:DraftVerifier=async c=>{
 const frozen=await readInputSnapshot(env.DB,env.INPUTS,c.companyId,c.teamId,c.userId,c.snapshotId,true,true),input=optimizerInputSchema.parse({...frozen.input,locks:c.locks,exceptions:c.exceptions});
 return {snapshotSha256:frozen.snapshot.sha256,inputSha256:await sha256(new TextEncoder().encode(JSON.stringify(input))),validation:await (await transport('/check',{input,assignments:c.assignments})).json()};
};
async function job(rows:ReturnType<typeof assignments>,referenceSolve=false){
 const id=crypto.randomUUID();await createJob(env.DB,env.INPUTS,company(),fixture().team,user(),{operationId:id,snapshotId,expectedRevision:await revision()});
 let report:unknown,stops=0;
 const outcome=await executeJob({...env,...(referenceSolve?{OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-fallback-v1'}:{})},{version:1,companyId:company(),teamId:fixture().team,jobId:id},async(path,payload)=>{
  if(path==='/solve')return referenceSolve?transport(path,payload,true):Response.json({...payload,solverStatus:'FEASIBLE',assignments:rows});
  const r=await transport(path,payload);report=await r.clone().json();return r;
 },async()=>{stops++;});
 expect(outcome).toBe('DONE');expect(stops).toBe(1);return {id,report:report as {status:string;violations:string[];missingHistory:string[]}};
}
async function noPublication(id:string){
 expect((await readPublicationHead(env,company(),fixture().team,user(),month)).publication).toBeNull();
 for(const table of ['schedule_publication_version','schedule_publication_notice'])expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE company_id=?`).bind(company()).first('n')).toBe(0);
 expect(await env.DB.prepare('SELECT id FROM product_audit WHERE company_id=? AND id=?').bind(company(),id).first()).toBeNull();
}
it.each(cases)('$name: native check -> result/draft/publication fail closed',async c=>{
 await setup(c.kind);const r=await revision(),two=c.kind==='month-min'||c.kind==='min-days';
 const good=await job(assignments(two?2:1));expect(good.report.status).toBe('VERIFIED');expect(good.report.violations).toEqual([]);
 const invalid=assignments(['full-unavailable','min-off'].includes(c.kind)?2:1,!['month-min','min-days','full-unavailable','min-off'].includes(c.kind));
 const bad=await job(invalid);expect(bad.report.status).toBe('INVALID');expect(bad.report.violations).toHaveLength(1);expect(bad.report.violations[0].startsWith(c.code+':')).toBe(true);
 const stored=await loadJob(env.DB,company(),fixture().team,bad.id);expect(stored).toMatchObject({state:'FAILED',failure_code:'RESULT_INVALID',result_key:null,result_sha256:null});
 await expect(readJobResult(env.DB,env.INPUTS,company(),fixture().team,user(),bad.id)).rejects.toThrow('RESULT_NOT_READY');
 const draft=crypto.randomUUID();await expect(saveDraft(env,company(),fixture().team,user(),{operationId:draft,expectedRevision:r,sourceJobId:good.id,expectedDraftRevision:0,assignments:invalid,locks:[],exceptions:[]},verifier)).rejects.toMatchObject({code:'DRAFT_INVALID',violations:bad.report.violations});
 expect((await readDraftHead(env,company(),fixture().team,user(),month)).draft).toBeNull();
 expect(await env.DB.prepare('SELECT id FROM schedule_draft_version WHERE company_id=? AND id=?').bind(company(),draft).first()).toBeNull();expect(await env.DB.prepare('SELECT id FROM product_audit WHERE company_id=? AND id=?').bind(company(),draft).first()).toBeNull();
 expect((await env.INPUTS.list({prefix:`companies/${company()}/teams/${fixture().team}/drafts/`})).objects).toHaveLength(0);
 const publication=crypto.randomUUID();await expect(publishSchedule(env,company(),fixture().team,user(),{operationId:publication,expectedRevision:r,expectedDraftRevision:0,expectedPublicationRevision:0,source:{kind:'job',id:bad.id},acknowledgeShortage:true},verifier)).rejects.toThrow('PUBLICATION_SOURCE_NOT_READY');await noPublication(publication);
 expect(await revision()).toBe(r);expect((await loadJob(env.DB,company(),fixture().team,good.id))?.state).toBe('SUCCEEDED');
 expect(await env.DB.prepare("SELECT count(*) AS n FROM compute_job WHERE company_id=? AND state IN ('QUEUED','RUNNING','CANCELLING')").bind(company()).first('n')).toBe(0);
});
it('TS-RULE-06 real missing history permits only a reference draft and refuses publication',async()=>{
 await setup('missing-history');const r=await revision(),source=await job(assignments(),true);expect(source.report.status).toBe('HISTORY_UNVERIFIED');expect(source.report.violations).toEqual([]);expect(source.report.missingHistory.length).toBeGreaterThan(0);
 const stored=await readJobResult(env.DB,env.INPUTS,company(),fixture().team,user(),source.id);expect(stored.result.validation.status).toBe('HISTORY_UNVERIFIED');expect(stored.result.calculationProfile).toBe('mvp-joint-calendar-fallback-v1');expect((stored.result.metrics as {processBudget:{parentValidation:string}}).processBudget.parentValidation).toBe('HISTORY_UNVERIFIED');
 const draft=crypto.randomUUID();await saveDraft(env,company(),fixture().team,user(),{operationId:draft,expectedRevision:r,sourceJobId:source.id,expectedDraftRevision:0,assignments:optimizerAssignmentsSchema.parse(stored.result.assignments),locks:[],exceptions:[]},verifier);
 const h=await readDraftHead(env,company(),fixture().team,user(),month);expect(h.draft?.validation.status).toBe('HISTORY_UNVERIFIED');
 const publication=crypto.randomUUID();await expect(publishSchedule(env,company(),fixture().team,user(),{operationId:publication,expectedRevision:r,expectedDraftRevision:1,expectedPublicationRevision:0,source:{kind:'draft',id:draft},acknowledgeShortage:true},verifier)).rejects.toThrow('PUBLICATION_NOT_VERIFIED');await noPublication(publication);expect(await revision()).toBe(r);
});
