import { env,applyD1Migrations } from 'cloudflare:test';
import { beforeAll,beforeEach,afterEach,expect,it,vi } from 'vitest';
import { inputFixture } from '../../apps/api/src/input-probes';
import { createApp } from '../../apps/api/src/index';
import { createTeam,createStaff,grantTeamAdmin,saveCalendarSettings } from '../../apps/api/src/product';
import { readStaffSubmission,saveStaffSubmission,setSubmissionWindow,readSubmissionWindow } from '../../apps/api/src/staff-submission';
import { createInputSnapshot,readInputSnapshot } from '../../apps/api/src/input-snapshots';
import { resolveVersion,type InputDatabase } from '../../apps/api/src/input-versions';
import { submissionDeadline } from '../../apps/api/src/submission-deadline';
import { staffMonth } from '../../apps/api/src/input-contracts';
import { z } from 'zod';

let f:Awaited<ReturnType<typeof inputFixture>>;
const future='2099-10';
const current=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,7);
const empty=():z.infer<typeof staffMonth>=>({unavailable:[],preferences:[]});
const revision=()=>env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(f.company.companyId).first<number>('revision');
const command=(expected=f.revision)=>({operationId:crypto.randomUUID(),expectedRevision:expected,payload:empty()});
const save=(c=command(),month=future,db:InputDatabase=env.DB)=>saveStaffSubmission(db,env.INPUTS,f.company.companyId,f.team,f.staffUser,month,c);
const open=(month=current(),expectedRevision=0,closesAt:number|null=Date.now()+60000,user=f.company.userId,team=f.team)=>setSubmissionWindow(env.DB,f.company.companyId,team,user,month,{operationId:crypto.randomUUID(),expectedRevision,closesAt});
const beforeBatch=(action:()=>Promise<unknown>):InputDatabase=>{
  const mutations=new WeakSet<D1PreparedStatement>();
  return {prepare:sql=>{
    const statement=env.DB.prepare(sql);
    if(!/^INSERT INTO input_operation\b/.test(sql))return statement;
    return new Proxy(statement,{get(target,key){
      if(key==='bind')return (...values:Parameters<D1PreparedStatement['bind']>)=>{const bound=target.bind(...values);mutations.add(bound);return bound;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  },batch:async<T>(statements:D1PreparedStatement[])=>{
    // Identify the actual write, independent of optional completion checks.
    if(statements.some(s=>mutations.has(s)))await action();return env.DB.batch<T>(statements);
  }};
};
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{f=await inputFixture(env.DB,env.INPUTS);await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();});
afterEach(()=>vi.restoreAllMocks());

it('Q86-89 self submission: only own data, exact unavailable minutes, equal separate wishes and immutable snapshot lineage',async()=>{
  const context=await readStaffSubmission(env.DB,f.company.companyId,f.team,f.staffUser,future);
  expect(context).toMatchObject({staffId:f.staff.staffId,accepting:true,version:null,deadline:{deadlineDate:'2099-09-20',timeZone:'Asia/Tokyo'}});
  expect(Object.keys(context).sort()).toEqual(['accepting','calendarId','deadline','month','patterns','revision','serverTime','staffId','version','window'].sort());
  const c={...command(),payload:{unavailable:[{date:future+'-02',start:607,end:617}],preferences:[{date:future+'-01',kind:'work' as const},{date:future+'-01',kind:'pattern' as const,patternId:'day'},{date:future+'-01',kind:'window' as const,start:600,end:1020}]}};
  expect(await save(c)).toMatchObject({replayed:false,revision:f.revision+1});
  const {saveInputVersion}=await import('../../apps/api/src/input-versions');
  await saveInputVersion(env.DB,{company:f.company.companyId,team:f.team,staff:null,kind:'planning',entity:f.team},f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,effectiveFrom:future,payload:{demand:[],events:[],roleRequirements:[]}},env.INPUTS);
  const snapshot=await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,month:future});
  const frozen=await readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,snapshot.snapshot!.id);
  expect(frozen.input.staff[0]).toMatchObject(c.payload);expect(JSON.parse(snapshot.snapshot!.lineage)).toContainEqual(expect.objectContaining({kind:'staff_month',version:c.operationId}));
  expect(await resolveVersion(env.DB,f.company.companyId,'staff_month',f.staff.staffId,'2099-11')).toBeNull();
  await expect(env.DB.prepare('UPDATE work_input_version SET payload=? WHERE company_id=? AND operation_id=?').bind('{}',f.company.companyId,c.operationId).run()).rejects.toThrow('IMMUTABLE_INPUT_VERSION');
});
it('same-ID parallel retry, altered intent and distinct-ID optimistic conflict never duplicate a self save',async()=>{
  const c=command();const saved=await Promise.all([save(c),save(c)]);
  expect(saved.map(r=>r.replayed).sort()).toEqual([false,true]);expect(await revision()).toBe(f.revision+1);
  await expect(save({...c,payload:{unavailable:[],preferences:[{date:future+'-01',kind:'off'}]}})).rejects.toThrow('OPERATION_ID_CONFLICT');
  const outcomes=await Promise.allSettled([save(command(f.revision+1)),save(command(f.revision+1))]);
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(o=>o.status==='rejected')).toMatchObject({reason:{code:'VERSION_CONFLICT'}});
  await expect(save(command())).rejects.toThrow('VERSION_CONFLICT');
});
it('both wishes and unavailable dates close together; authorized window permits saving and late replay only',async()=>{
  const month=current();expect((await readStaffSubmission(env.DB,f.company.companyId,f.team,f.staffUser,month)).accepting).toBe(false);
  for(const payload of [{unavailable:[],preferences:[{date:month+'-02',kind:'off' as const}]},{unavailable:[{date:month+'-02',start:0,end:1440}],preferences:[]}])await expect(save({...command(),payload},month)).rejects.toThrow('SUBMISSION_CLOSED');
  await open(month);const c=command();await save(c,month);
  await open(month,1,null);
  expect(await save(c,month)).toMatchObject({replayed:true});await expect(save(command(f.revision+1),month)).rejects.toThrow('SUBMISSION_CLOSED');
  expect(await revision()).toBe(f.revision+1);
});
it('D1 checks live window, live membership and password gate again at write, rolling back the entire batch',async()=>{
  const month=current();await open(month);
  const c=command();await expect(save(c,month,beforeBatch(()=>open(month,1,null)))).rejects.toThrow('SUBMISSION_CLOSED');
  expect(await revision()).toBe(f.revision);
  expect(await env.DB.prepare('SELECT id FROM input_operation WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
  await expect(save(command(),future,beforeBatch(()=>env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.staffUser).run()))).rejects.toThrow('FORBIDDEN');
  expect(await revision()).toBe(f.revision);
});
it('an API clock before the deadline cannot bypass D1 time; cutoff SQL agrees with JST/leap-year/month-end arithmetic',async()=>{
  const month=current(),now=Date.now();vi.spyOn(Date,'now').mockReturnValue(Date.parse(month+'-01T00:00:00Z')-32*86400000);
  await expect(save(command(),month)).rejects.toThrow('SUBMISSION_CLOSED');expect(await revision()).toBe(f.revision);
  vi.restoreAllMocks();
  for(const [month,day] of [['2099-10',20],['2000-03',31],['2027-03',31],['2026-05',31],['2026-01',1]] as const) {
    const sql=await env.DB.prepare(`SELECT (unixepoch(date(?||'-01','-1 month','+'||min(?,CAST(strftime('%d',date(?||'-01','-1 day')) AS INTEGER))||' days'))-32400)*1000 AS cutoff`).bind(month,day,month).first<number>('cutoff');
    expect(sql).toBe(submissionDeadline(month,day).closesAt);
  }
  expect(Date.now()).toBeGreaterThanOrEqual(now);
});
it('receipt/audit failure rolls back operation, input, draft source and revision; retry uses the same ID',async()=>{
  await env.DB.prepare(`CREATE TRIGGER submission_audit_fault BEFORE INSERT ON product_audit WHEN NEW.kind='input:staff_month' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`).run();
  const c=command();try{await expect(save(c)).rejects.toThrow('INJECTED_FAILURE');}finally{await env.DB.prepare('DROP TRIGGER submission_audit_fault').run();}
  expect(await revision()).toBe(f.revision);
  for(const [table,column] of [['input_operation','id'],['work_input_version','operation_id'],['input_registration_draft','operation_id']] as const)expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  expect(await save(c)).toMatchObject({replayed:false});
});
it('window version is separate from inputs; scoped manager permissions, parallel edits and immutable retry are enforced',async()=>{
  await expect(open(current(),0,Date.now()+60000,f.staffUser)).rejects.toThrow('FORBIDDEN');
  const other=await createTeam(env.DB,f.company.companyId,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:f.revision,name:'架空別チーム'});
  await grantTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:f.revision+1,userId:f.staffUser});
  await expect(open(current(),0,Date.now()+60000,f.staffUser,other.teamId)).rejects.toThrow('FORBIDDEN');
  const before=await revision(),c={operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000};
  const write=()=>setSubmissionWindow(env.DB,f.company.companyId,f.team,f.staffUser,current(),c);
  expect((await Promise.all([write(),write()])).map(r=>r.replayed).sort()).toEqual([false,true]);expect(await revision()).toBe(before);
  await expect(setSubmissionWindow(env.DB,f.company.companyId,f.team,f.staffUser,current(),{...c,closesAt:null})).rejects.toThrow('OPERATION_ID_CONFLICT');
  await expect(open(current())).rejects.toThrow('SUBMISSION_WINDOW_CONFLICT');
  await expect(open(current(),1,Date.now()-1)).rejects.toThrow('SUBMISSION_WINDOW_EXPIRED');
  await expect(env.DB.prepare('UPDATE staff_submission_window SET closes_at=NULL WHERE company_id=?').bind(f.company.companyId).run()).rejects.toThrow('IMMUTABLE_SUBMISSION_WINDOW');
  expect((await readSubmissionWindow(env.DB,f.company.companyId,f.team,f.staffUser,current())).window).toMatchObject({id:c.operationId,revision:1});
});
it.each(['audit','version','revision','draft-source'])('self submission silent %s omission rolls back own input and can repair the same operation',async fault=>{
  const c=command(),before=await resolveVersion(env.DB,f.company.companyId,'staff_month',f.staff.staffId,future);
  const inject={audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='input:staff_month'",version:'BEFORE INSERT ON work_input_version',revision:'BEFORE UPDATE ON company','draft-source':'BEFORE INSERT ON input_registration_draft'}[fault];
  await env.DB.prepare(`CREATE TRIGGER self_silent_omission ${inject} BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    await expect(save(c)).rejects.toThrow();expect(await revision()).toBe(f.revision);
    expect(await resolveVersion(env.DB,f.company.companyId,'staff_month',f.staff.staffId,future)).toEqual(before);
    for(const [table,column] of [['input_operation','id'],['work_input_version','operation_id'],['input_registration_draft','operation_id'],['product_audit','id']])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER self_silent_omission').run();}
  expect(await save(c)).toMatchObject({replayed:false});expect(await save(c)).toMatchObject({replayed:true});expect(await revision()).toBe(f.revision+1);
});
it.each(['audit','window'])('submission window silent %s omission preserves closed state until the same reopening is repaired',async fault=>{
  const month=current(),before=await readSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,month);
  const c={operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000};
  const write=()=>setSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,month,c);
  const inject=fault==='audit'?"BEFORE INSERT ON product_audit WHEN NEW.kind='staff_submission_window'":'BEFORE INSERT ON staff_submission_window';
  await env.DB.prepare(`CREATE TRIGGER window_silent_omission ${inject} BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    await expect(write()).rejects.toThrow();expect(await revision()).toBe(f.revision);
    expect((await readSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,month)).window).toEqual(before.window);
    for(const table of ['staff_submission_window','product_audit'])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER window_silent_omission').run();}
  expect(await write()).toMatchObject({replayed:false});expect(await write()).toMatchObject({replayed:true});
  expect((await readSubmissionWindow(env.DB,f.company.companyId,f.team,f.company.userId,month)).window).toMatchObject({id:c.operationId,revision:1});
});
it('native HTTP requires session/origin/first change, forbids extra staff IDs and foreign scopes, and keeps manager endpoints protected',async()=>{
  const app=createApp(),base=env.AUTH_BASE_URL;
  const email=(await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(f.staffUser).first<string>('email'))!;
  const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email,password:f.staff.initialPassword})},env);
  expect(login.status).toBe(200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const prefix=`/api/companies/${f.company.companyId}/inputs/teams/${f.team}`,path=prefix+'/self-month/'+future;
  expect((await app.request(base+path,{},env)).status).toBe(401);
  const request=(path:string,body?:unknown,origin=base)=>app.request(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
  expect((await request(path)).headers.get('cache-control')).toBe('no-store');
  expect((await request(path,command(),'https://foreign.invalid')).status).toBe(403);
  expect((await request(path,{...command(),staffId:crypto.randomUUID()})).status).toBe(400);
  expect((await request(path,{padding:'x'.repeat(128*1024)})).status).toBe(413);
  expect((await request(prefix+'/submission-window/'+future)).status).toBe(403);
  expect((await request(prefix+'/planning/'+future)).status).toBe(403);
  const foreign=await inputFixture(env.DB,env.INPUTS);
  expect((await request(`/api/companies/${foreign.company.companyId}/inputs/teams/${foreign.team}/self-month/${future}`)).status).toBe(403);
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(f.staffUser).run();
  expect((await request(path)).status).toBe(403);
});
it('保存直前のカレンダー変更と受付再開権限の失効を原子検査し、D1時刻より古い追加受付を拒否する',async()=>{
  const c=command();const changing=beforeBatch(()=>saveCalendarSettings(env.DB,f.company.companyId,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:f.revision,effectiveFrom:future,settings:{weekStart:0,deadlineDay:31,halfDayDivider:720,roleRounding:'floor'}}));
  await expect(save(c,future,changing)).rejects.toThrow('VERSION_CONFLICT');expect(await revision()).toBe(f.revision+1);
  const db:InputDatabase={prepare:sql=>env.DB.prepare(sql),batch:async<T>(statements:D1PreparedStatement[])=>{await env.DB.prepare('DELETE FROM company_admin WHERE company_id=? AND user_id=?').bind(f.company.companyId,f.company.userId).run();return env.DB.batch<T>(statements);}};
  await expect(setSubmissionWindow(db,f.company.companyId,f.team,f.company.userId,current(),{operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000})).rejects.toThrow('FORBIDDEN');
  await env.DB.prepare('INSERT INTO company_admin(company_id,user_id) VALUES (?,?)').bind(f.company.companyId,f.company.userId).run();
  const past=Date.now()-1000;vi.spyOn(Date,'now').mockReturnValue(past-1000);
  await expect(open(current(),0,past)).rejects.toThrow('SUBMISSION_WINDOW_EXPIRED');
});
it('direct SQL cannot grant a normal staff member manager access or change another person through self metadata',async()=>{
  const other=await createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:f.revision,name:'架空他人',staffNumber:'0002',email:crypto.randomUUID()+'@example.invalid'});
  const context=await readStaffSubmission(env.DB,f.company.companyId,f.team,f.staffUser,future);
  for(const [staff,month,calendar] of [[other.staffId,future,context.calendarId],[f.staff.staffId,null,null],[f.staff.staffId,null,context.calendarId]])await expect(env.DB.prepare(`INSERT INTO input_operation(company_id,id,actor_id,team_id,staff_id,kind,entity_id,expected_revision,fingerprint,submission_month,submission_calendar_id) VALUES (?,?,?,?,?,'staff_month',?,?,?,?,?)`).bind(f.company.companyId,crypto.randomUUID(),f.staffUser,f.team,staff,staff,f.revision+1,'fictional',month,calendar).run()).rejects.toThrow('INPUT_FORBIDDEN');
  expect(await revision()).toBe(f.revision+1);
});
