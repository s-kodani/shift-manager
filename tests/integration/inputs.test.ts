import { env,applyD1Migrations } from 'cloudflare:test';
import { beforeAll,beforeEach,expect,it } from 'vitest';
import { createApp } from '../../apps/api/src/index';
import { createTeam,createStaff,grantTeamAdmin } from '../../apps/api/src/product';
import { inputFixture,probeRule,probePolicy,probeConfig,probeEmployment,runInputProbes } from '../../apps/api/src/input-probes';
import { saveInputVersion,resolveVersion,type ResourceTarget } from '../../apps/api/src/input-versions';
import { createInputSnapshot,readInputSnapshot,loadSources,compileInput } from '../../apps/api/src/input-snapshots';

let f:Awaited<ReturnType<typeof inputFixture>>;
const op=(revision=f.revision)=>({operationId:crypto.randomUUID(),expectedRevision:revision});
const target=(kind:'team_config'|'planning'='planning')=>({company:f.company.companyId,team:f.team,staff:null,kind,entity:f.team});
const revision=()=>env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(f.company.companyId).first<number>('revision');
const command=()=>({...op(),month:'2026-10'});
const snapshot=(c=command(),db=env.DB,bucket=env.INPUTS)=>createInputSnapshot(db,bucket,f.company.companyId,f.team,f.company.userId,c);
const read=(id:string,current=false)=>readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,id,current);
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{f=await inputFixture(env.DB);});

it('WP-02/Q118/119/122: compiler preserves every rule, intersected contracts, shared levels, zero demand and exact minutes',async()=>{
  const saved=await snapshot();const data=await read(saved.snapshot!.id);
  expect(data.input.staff[0].rules.map(r=>r.dailyMax)).toEqual([480,450,420]);
  expect(data.input.staff[0].rules.map(r=>r.monthlyMin)).toEqual([60,60,120]);
  expect(data.input.staff[0].contract).toEqual({weekdays:[0,1,2,3,4],start:600,end:1020});
  expect(data.input.weekStart).toBe(6); // Sunday in API -> Sunday=6 in Python.
  expect(data.input.staff[0].skills).toContainEqual({taskId:'phone',level:1,capacity:100});
  expect(data.input.tasks[0].minimumLevel).toBe(1);
  expect(data.input.demand.map(d=>d.direct)).toEqual([0,null]);
  expect(data.input.transitions.map(t=>t.minutes)).toEqual([7,7]);
  expect(data.input.roleRequirements[0]).toMatchObject({rounding:'floor',priority:'same'});
  expect(data.input).toMatchObject({history:[],locks:[],exceptions:[],published:[],mode:'draft',priority:'coverage'});
  expect(data.publication).toBe('NOT_EVALUATED');expect(data.registrationStatus).toBe('STRUCTURALLY_VALID');
  expect(JSON.parse(saved.snapshot!.lineage)).toHaveLength(8);
  expect(await revision()).toBe(f.revision); // Creating a snapshot does not mutate its input version.
});
it('TS-OPT-05 MVP: a later team priority applies only to new snapshots and preserves the previous settings and input digest',async()=>{
  const old=(await snapshot()).snapshot!;
  const previous=await read(old.id);
  expect(previous.input.priority).toBe('coverage');
  await saveInputVersion(env.DB,target('team_config'),f.company.userId,{
    ...op(),effectiveFrom:'2026-10',payload:{...probeConfig,priority:'preference'},
  });
  const next=(await snapshot({...command(),expectedRevision:(await revision())!})).snapshot!;
  const current=await read(next.id);
  expect(current.input.priority).toBe('preference');
  expect(current.input.roleRequirements).toEqual(previous.input.roleRequirements);
  const historical=await read(old.id);
  expect(historical.stale).toBe(true);
  expect(historical.input).toEqual(previous.input);
  expect(historical.snapshot.sha256).toBe(old.sha256);
  expect(historical.snapshot.lineage).toBe(old.lineage);
  expect(next.input_revision).toBeGreaterThan(old.input_revision);
});
it('WP-02: compiled staff use company staff-number order regardless of UUID order, without mixing profiles, changing scope or rewriting old snapshots',async()=>{
  const original=(await snapshot()).snapshot!;
  const oldInput=(await read(original.id)).input;
  const people=[{staffId:f.staff.staffId,profile:f.profile,preferences:oldInput.staff[0].preferences}];
  for(let i=0;i<2;i++) {
    const staff=await createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{
      operationId:crypto.randomUUID(),expectedRevision:(await revision())!,
      staffNumber:'new-'+i,name:'架空順序スタッフ'+i,email:`${crypto.randomUUID()}@example.invalid`,
    });
    const profile={...f.profile,rule:{...f.profile.rule,dailyMax:390-i*30},roleIds:[]};
    const preferences=[{date:'2026-10-02',kind:'off' as const}];
    for(const [kind,payload] of [['staff_contract',profile],['staff_month',{unavailable:[],preferences}]] as const)
      await saveInputVersion(env.DB,{company:f.company.companyId,team:f.team,staff:staff.staffId,kind,entity:staff.staffId},f.company.userId,{
        operationId:crypto.randomUUID(),expectedRevision:(await revision())!,effectiveFrom:'2026-10',payload,
      });
    people.push({staffId:staff.staffId,profile,preferences});
  }
  // Seed number order opposite to actual UUID order, so the old query fails.
  const uuidOrder=[...people].sort((a,b)=>a.staffId<b.staffId?-1:1);
  for(let i=0;i<uuidOrder.length;i++)
    await env.DB.prepare('UPDATE staff SET staff_number=? WHERE company_id=? AND id=?')
      .bind('seed-'+i,f.company.companyId,uuidOrder[i].staffId).run();
  for(let i=0;i<uuidOrder.length;i++)
    await env.DB.prepare('UPDATE staff SET staff_number=? WHERE company_id=? AND id=?')
      .bind('000'+(3-i),f.company.companyId,uuidOrder[i].staffId).run();
  const other=(await createTeam(env.DB,f.company.companyId,f.company.userId,{
    operationId:crypto.randomUUID(),expectedRevision:(await revision())!,name:'架空の別チーム',
  })).teamId;
  await createStaff(env.DB,f.company.companyId,other,f.company.userId,{
    operationId:crypto.randomUUID(),expectedRevision:(await revision())!,staffNumber:'0000',
    name:'架空対象外スタッフ',email:`${crypto.randomUUID()}@example.invalid`,
  });
  const saved=await snapshot({...command(),expectedRevision:(await revision())!});
  const input=(await read(saved.snapshot!.id)).input;
  expect(input.staff.map(s=>s.id)).toEqual(uuidOrder.map(s=>s.staffId).reverse());
  for(const person of people) {
    const row=input.staff.find(s=>s.id===person.staffId)!;
    expect(row.rules.map(r=>r.dailyMax)).toEqual([480,450,person.profile.rule.dailyMax]);
    expect(row.contract).toEqual(oldInput.staff[0].contract);
    expect(row.skills).toEqual(oldInput.staff[0].skills);
    expect(row.preferences).toEqual(person.preferences);
    expect(row.roleIds).toEqual(person.profile.roleIds);
  }
  expect(input.demand).toEqual(oldInput.demand);
  expect(input.events).toEqual(oldInput.events);
  expect(input.roleRequirements).toEqual(oldInput.roleRequirements);
  expect(input.breakRule).toEqual(oldInput.breakRule);
  const historical=await read(original.id);
  expect(historical.stale).toBe(true);
  expect(historical.input).toEqual(oldInput);
  expect(historical.snapshot.sha256).toBe(original.sha256);
});
it('WP-02: effective-month selection is immutable and planning/preferences never carry into another month',async()=>{
  const first=await snapshot();
  await f.save('company_policy',{...probePolicy,rule:{...probeRule,dailyMax:390}},undefined,'2026-12');
  await f.save('company_policy',{...probePolicy,rule:{...probeRule,dailyMax:400}},undefined,'2026-10');
  expect(JSON.parse((await resolveVersion(env.DB,f.company.companyId,'company_policy',f.company.companyId,'2026-11'))!.payload).rule.dailyMax).toBe(400);
  expect(JSON.parse((await resolveVersion(env.DB,f.company.companyId,'company_policy',f.company.companyId,'2026-12'))!.payload).rule.dailyMax).toBe(390);
  expect(await resolveVersion(env.DB,f.company.companyId,'planning',f.team,'2026-11')).toBeNull();
  expect(await resolveVersion(env.DB,f.company.companyId,'staff_month',f.staff.staffId,'2026-11')).toBeNull();
  const historical=await read(first.snapshot!.id);expect(historical.stale).toBe(true);expect(historical.input.staff[0].rules[0].dailyMax).toBe(480);
  await expect(read(first.snapshot!.id,true)).rejects.toThrow('VERSION_CONFLICT');
  await expect(env.DB.prepare('UPDATE work_input_version SET payload=? WHERE company_id=?').bind('{}',f.company.companyId).run()).rejects.toThrow('IMMUTABLE_INPUT_VERSION');
  await expect(env.DB.prepare('DELETE FROM input_snapshot WHERE company_id=?').bind(f.company.companyId).run()).rejects.toThrow('IMMUTABLE_INPUT_SNAPSHOT');
});
it('WP-02: stale and parallel writers cannot overwrite input versions; same operation replays once',async()=>{
  const input={...op(),effectiveFrom:'2026-10',payload:{...f.plan,demand:[]}};
  const outcomes=await Promise.all([saveInputVersion(env.DB,target(),f.company.userId,input),saveInputVersion(env.DB,target(),f.company.userId,input)]);
  expect(outcomes.map(r=>r.replayed).sort()).toEqual([false,true]);expect(await revision()).toBe(f.revision+1);
  await expect(saveInputVersion(env.DB,target(),f.company.userId,{...input,payload:f.plan})).rejects.toThrow('OPERATION_ID_CONFLICT');
  await expect(saveInputVersion(env.DB,target(),f.company.userId,{...input,operationId:crypto.randomUUID()})).rejects.toThrow('VERSION_CONFLICT');
  const two=await Promise.allSettled([0,1].map(()=>saveInputVersion(env.DB,target(),f.company.userId,{...input,...op(f.revision+1)})));
  expect(two.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(two.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'VERSION_CONFLICT'}});
});
it('WP-02: a final audit failure rolls back version, operation and company revision',async()=>{
  await env.DB.prepare(`CREATE TRIGGER input_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='input:team_config' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`).run();
  const input={...op(),effectiveFrom:'2026-10',payload:probeConfig};
  try {
    await expect(saveInputVersion(env.DB,target('team_config'),f.company.userId,input)).rejects.toThrow('INJECTED_FAILURE');
    expect(await revision()).toBe(f.revision);
    expect(await env.DB.prepare('SELECT id FROM input_operation WHERE company_id=? AND id=?').bind(f.company.companyId,input.operationId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT operation_id FROM work_input_version WHERE company_id=? AND operation_id=?').bind(f.company.companyId,input.operationId).first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER input_audit_failure').run();}
});
it('WP-01/02: permission revoked between read and batch is rejected inside the transaction',async()=>{
  const db={prepare:(sql:string)=>env.DB.prepare(sql),batch:async<T>(statements:D1PreparedStatement[])=>{
    await env.DB.prepare('DELETE FROM company_admin WHERE company_id=? AND user_id=?').bind(f.company.companyId,f.company.userId).run();return env.DB.batch<T>(statements);
  }};
  await expect(saveInputVersion(db,target('team_config'),f.company.userId,{...op(),effectiveFrom:'2026-10',payload:probeConfig})).rejects.toThrow('FORBIDDEN');
  expect(await revision()).toBe(f.revision);
});

it.each(['company_policy','employment_policy','team_config','staff_contract','planning','staff_month'].flatMap(kind=>
  ['audit','version','revision'].map(fault=>({kind:kind as ResourceTarget['kind'],fault}))))(
  'input $kind silent $fault omission rolls back every version and can repair the same operation',async({kind,fault})=>{
    const global=kind==='company_policy'||kind==='employment_policy',personal=kind==='staff_contract'||kind==='staff_month';
    const t:ResourceTarget={company:f.company.companyId,team:global?null:f.team,staff:personal?f.staff.staffId:null,kind,
      entity:kind==='employment_policy'?f.employment:global?f.company.companyId:personal?f.staff.staffId:f.team};
    const payload={company_policy:probePolicy,employment_policy:probeEmployment,team_config:probeConfig,staff_contract:f.profile,
      planning:{...f.plan,demand:[]},staff_month:{unavailable:[],preferences:[]}}[kind];
    const c={...op(),effectiveFrom:'2026-10',payload},before=await resolveVersion(env.DB,t.company,kind,t.entity,'2026-10');
    const inject={audit:`BEFORE INSERT ON product_audit WHEN NEW.kind='input:${kind}'`,version:'BEFORE INSERT ON work_input_version',revision:'BEFORE UPDATE ON company'}[fault];
    await env.DB.prepare(`CREATE TRIGGER input_silent_omission ${inject} BEGIN SELECT RAISE(IGNORE); END`).run();
    try {
      await expect(saveInputVersion(env.DB,t,f.company.userId,c,env.INPUTS)).rejects.toThrow();
      expect(await revision()).toBe(f.revision);expect(await resolveVersion(env.DB,t.company,kind,t.entity,'2026-10')).toEqual(before);
      for(const [table,column] of [['input_operation','id'],['work_input_version','operation_id'],['product_audit','id']])
        expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(t.company,c.operationId).first()).toBeNull();
    } finally {await env.DB.prepare('DROP TRIGGER input_silent_omission').run();}
    expect(await saveInputVersion(env.DB,t,f.company.userId,c,env.INPUTS)).toMatchObject({id:c.operationId,revision:f.revision+1,replayed:false});
    expect(await saveInputVersion(env.DB,t,f.company.userId,c,env.INPUTS)).toMatchObject({replayed:true});
    expect(await revision()).toBe(f.revision+1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM product_audit WHERE company_id=? AND id=?').bind(t.company,c.operationId).first('n')).toBe(1);
  },
);
it.each(['audit','manifest'])('snapshot silent %s omission leaves only an immutable R2 orphan and no committed input operation',async fault=>{
  const c=command(),prefix=`companies/${f.company.companyId}/teams/${f.team}/snapshots/${c.operationId}/`;
  const inject=fault==='audit'?"BEFORE INSERT ON product_audit WHEN NEW.kind='input:snapshot'":'BEFORE INSERT ON input_snapshot';
  await env.DB.prepare(`CREATE TRIGGER snapshot_silent_omission ${inject} BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    await expect(snapshot(c)).rejects.toThrow();expect(await revision()).toBe(f.revision);
    for(const table of ['input_operation','input_snapshot','product_audit'])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
    expect((await env.INPUTS.list({prefix})).objects).toHaveLength(1);
  } finally {await env.DB.prepare('DROP TRIGGER snapshot_silent_omission').run();}
  const saved=await snapshot(c);expect(saved.replayed).toBe(false);expect((await read(c.operationId)).input.jobId).toBe(c.operationId);
  expect((await env.INPUTS.list({prefix})).objects).toHaveLength(2);expect((await snapshot(c)).replayed).toBe(true);
  expect(await revision()).toBe(f.revision);
});
it.each(['planning','staff_month'] as const)('monthly manager input %s refuses a silently omitted fixed-source registration',async kind=>{
  const t:ResourceTarget={company:f.company.companyId,team:f.team,staff:kind==='staff_month'?f.staff.staffId:null,kind,entity:kind==='staff_month'?f.staff.staffId:f.team};
  const c={...op(),effectiveFrom:'2026-10',payload:kind==='staff_month'?{unavailable:[],preferences:[]}:{...f.plan,demand:[]}};
  await env.DB.prepare('CREATE TRIGGER registration_silent_omission BEFORE INSERT ON input_registration_draft BEGIN SELECT RAISE(IGNORE); END').run();
  try {
    await expect(saveInputVersion(env.DB,t,f.company.userId,c,env.INPUTS)).rejects.toThrow();expect(await revision()).toBe(f.revision);
    for(const [table,column] of [['input_operation','id'],['work_input_version','operation_id'],['product_audit','id']])
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND ${column}=?`).bind(t.company,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER registration_silent_omission').run();}
  expect(await saveInputVersion(env.DB,t,f.company.userId,c,env.INPUTS)).toMatchObject({replayed:false});
});
it('WP-02: R2 upload failure leaves no D1 manifest, operation or input revision change',async()=>{
  const c=command();const bucket={put:async()=>{throw new Error('INJECTED_R2_FAILURE');}} as unknown as R2Bucket;
  await expect(snapshot(c,env.DB,bucket)).rejects.toThrow('INJECTED_R2_FAILURE');
  expect(await revision()).toBe(f.revision);
  expect(await env.DB.prepare('SELECT id FROM input_operation WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
});
it('WP-02: late D1 failure leaves only an unreferenced R2 object, never a half-committed manifest',async()=>{
  const c=command();let key='';const bucket={put:async(...args:Parameters<R2Bucket['put']>)=>{key=args[0];return env.INPUTS.put(...args);}} as R2Bucket;
  await env.DB.prepare(`CREATE TRIGGER snapshot_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='input:snapshot' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`).run();
  try {
    await expect(snapshot(c,env.DB,bucket)).rejects.toThrow('INJECTED_FAILURE');
    expect(await revision()).toBe(f.revision);expect(await env.INPUTS.head(key)).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM input_snapshot WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM input_operation WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
  } finally {await env.DB.prepare('DROP TRIGGER snapshot_audit_failure').run();await env.INPUTS.delete(key);}
});
it('WP-02: concurrent snapshot retries cannot overwrite or delete the winning object',async()=>{
  const c=command();let uploads=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const bucket=new Proxy(env.INPUTS,{get(target,key){
    if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
      if(++uploads===2)release();await gate;return target.put(...args);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const saved=await Promise.all([snapshot(c,env.DB,bucket),snapshot(c,env.DB,bucket)]);
  expect(saved.map(s=>s.replayed).sort()).toEqual([false,true]);
  expect(saved[0].snapshot!.object_key).toBe(saved[1].snapshot!.object_key);
  const objects=await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/snapshots/${c.operationId}/`});
  // The losing request has no delete authority. Its immutable orphan does not
  // become a second manifest, change the revision or replace the winning bytes.
  expect(objects.objects).toHaveLength(2);
  expect(objects.objects.filter(o=>o.key===saved[0].snapshot!.object_key)).toHaveLength(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM input_snapshot WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first('n')).toBe(1);
  expect(await revision()).toBe(f.revision);
  expect((await read(c.operationId)).input.jobId).toBe(c.operationId);
});
it('WP-02: stale change during R2 upload is rejected at manifest commit, with the old snapshot bytes retained as an orphan',async()=>{
  const c=command();let key='';const bucket={put:async(...args:Parameters<R2Bucket['put']>)=>{
    key=args[0];const result=await env.INPUTS.put(...args);await f.save('company_policy',probePolicy);return result;
  }} as R2Bucket;
  await expect(snapshot(c,env.DB,bucket)).rejects.toThrow('VERSION_CONFLICT');
  expect(await env.INPUTS.head(key)).not.toBeNull();expect(await env.DB.prepare('SELECT id FROM input_snapshot WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first()).toBeNull();
  await env.INPUTS.delete(key);
});
it('WP-02: missing and same-length tampered objects fail integrity verification',async()=>{
  const saved=(await snapshot()).snapshot!;
  const raw=await (await env.INPUTS.get(saved.object_key))!.text();
  await env.INPUTS.put(saved.object_key,raw.replace('coverage','prefxxxx')); // Equal byte length.
  await expect(read(saved.id)).rejects.toThrow('SNAPSHOT_DIGEST_MISMATCH');
  await env.INPUTS.delete(saved.object_key);await expect(read(saved.id)).rejects.toThrow('SNAPSHOT_OBJECT_MISSING');
});
it('WP-02/Q110: event registration refuses impossible attendance and fixed-break overlap; touching intervals are allowed',async()=>{
  for(const event of [{...f.plan.events[0],start:570,end:660},{...f.plan.events[0],start:810,end:840},{...f.plan.events[0],date:'2026-10-04'}]) {
    await expect(f.save('planning',{...f.plan,events:[event]})).rejects.toThrow('EVENT_ATTENDANCE_CONFLICT');
    expect(await revision()).toBe(f.revision);
  }
  await f.save('planning',{...f.plan,events:[{...f.plan.events[0],end:780}]});
});
it('WP-02/Q83/110: overlapping events and unavailable participant changes are rejected before saving',async()=>{
  await expect(f.save('planning',{...f.plan,events:[{...f.plan.events[0],end:720},{...f.plan.events[0],id:'meeting',kind:'meeting',start:690,end:750}]})).rejects.toThrow('OVERLAPPING_EVENT');
  await expect(f.save('staff_month',{unavailable:[{date:'2026-10-01',start:660,end:690}],preferences:[]})).rejects.toThrow('EVENT_ATTENDANCE_CONFLICT');
  expect(await revision()).toBe(f.revision);
});
it('WP-02/Q127: bad references, absent demand, duplicate/unaligned input and preparation exceeding a slot are refused',async()=>{
  for(const [kind,payload,code] of [
    ['team_config',{...probeConfig,transitions:[{fromTaskId:'phone',toTaskId:'supervision',minutes:31}]},'PREPARATION_EXCEEDS_SLOT'],
    ['team_config',{...probeConfig,tasks:[{...probeConfig.tasks[0],capacities:[{level:1,capacity:100}]}]},'INVALID_TASK_CAPACITY_LEVEL'],
    ['planning',{...f.plan,events:[{...f.plan.events[0],staffIds:[crypto.randomUUID()]}]},'UNKNOWN_STAFF'],
    ['planning',{...f.plan,demand:[{...f.plan.demand[0],direct:null,calculated:null}]},'DEMAND_UNSET'],
    ['planning',{...f.plan,demand:[{...f.plan.demand[0],start:601}]},'INVALID_INPUT'],
    ['planning',{...f.plan,demand:[f.plan.demand[0],f.plan.demand[0]]},'DUPLICATE_INPUT'],
    ['planning',{...f.plan,roleRequirements:[f.plan.roleRequirements[0],{...f.plan.roleRequirements[0],id:'overlap'}]},'OVERLAPPING_ROLE_REQUIREMENT'],
  ] as const) {
    const promise=f.save(kind,payload);
    if(code==='INVALID_INPUT')await expect(promise).rejects.toThrow();else await expect(promise).rejects.toThrow(code);
  }
  expect(await revision()).toBe(f.revision);
});
it('WP-02: snapshots recheck references after newer config/policy makes an earlier monthly input invalid',async()=>{
  await f.save('team_config',{...probeConfig,slotMinutes:60});
  await expect(snapshot({...command(),expectedRevision:await revision() as number})).rejects.toThrow('INVALID_DEMAND_SLOT');
});
it('WP-02: absent monthly wishes mean no wishes, while missing contracts/planning fail closed and rule contradictions are not relaxed',async()=>{
  const sources=await loadSources(env.DB,f.company.companyId,f.team,'2026-10');
  const noWishes={...sources,versions:sources.versions.filter(v=>v.kind!=='staff_month')};
  expect(compileInput(f.company.companyId,f.team,'2026-10',crypto.randomUUID(),noWishes).input.staff[0].preferences).toEqual([]);
  for(const kind of ['staff_contract','planning'])expect(()=>compileInput(f.company.companyId,f.team,'2026-10',crypto.randomUUID(),{...sources,versions:sources.versions.filter(v=>v.kind!==kind)})).toThrow('INPUT_NOT_CONFIGURED');
  await f.save('company_policy',{...probePolicy,rule:{...probeRule,monthlyMax:90}});
  await expect(snapshot({...command(),expectedRevision:await revision() as number})).rejects.toThrow('CONTRADICTORY_RULE');
});
it('WP-01/02: HTTP requires correct origin/session, scoped management, strict fields and bounded bodies',async()=>{
  const app=createApp();const base=env.AUTH_BASE_URL;
  const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
  expect(login.status).toBe(200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const path=`/api/companies/${f.company.companyId}/inputs/teams/${f.team}/planning`;
  const request=(url=path,body?:object,origin=base)=>app.request(base+url,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},env);
  expect((await request(path+'/2026-10')).headers.get('cache-control')).toBe('no-store');
  expect((await request(path,{...op(),effectiveFrom:'2026-10',payload:f.plan},'https://foreign.invalid')).status).toBe(403);
  expect((await request(path,{...op(),effectiveFrom:'2026-10',payload:{...f.plan,history:[]}})).status).toBe(400);
  expect((await request(path,{...op(),effectiveFrom:'1999-10',payload:f.plan})).status).toBe(400);
  expect((await request(path,{padding:'x'.repeat(2_000_001)})).status).toBe(413);
  const other=(await createTeam(env.DB,f.company.companyId,f.company.userId,{...op(),name:'架空別チーム'})).teamId;
  await grantTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,{...op(f.revision+1),userId:f.staffUser});
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  const personal={company:f.company.companyId,team:f.team,staff:f.staff.staffId,kind:'staff_contract' as const,entity:f.staff.staffId};
  await expect(saveInputVersion(env.DB,{...personal,team:other},f.company.userId,{...op(f.revision+2),effectiveFrom:'2026-10',payload:f.profile})).rejects.toThrow('INVALID_REFERENCE');
  await expect(saveInputVersion(env.DB,{company:f.company.companyId,team:null,staff:null,kind:'company_policy',entity:f.company.companyId},f.staffUser,{...op(f.revision+2),effectiveFrom:'2026-10',payload:probePolicy})).rejects.toThrow('FORBIDDEN');
  await expect(readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,other,f.staffUser,crypto.randomUUID())).rejects.toThrow('FORBIDDEN');
});
it('WP-02: dedicated Cloudflare input probe runs against real workerd D1 and R2 and disables fictional accounts',async()=>{
  const result=await runInputProbes(env);expect(result.results).toHaveLength(9);expect(result.results.every(r=>r.passed)).toBe(true);
  expect(await env.DB.prepare('SELECT count(*) n FROM access_state WHERE enabled=1 AND user_id IN (SELECT actor_id FROM input_operation WHERE company_id=?)').bind(result.input.tenantId).first('n')).toBe(0);
});
it('WP-02: monthly planning accepts a valid body larger than 16 KiB without widening the master-data limit',async()=>{
  const app=createApp(),base=env.AUTH_BASE_URL;
  const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const demand=Array.from({length:31*48},(_,i)=>({date:`2026-10-${String(Math.floor(i/48)+1).padStart(2,'0')}`,start:i%48*30,end:i%48*30+30,taskId:'phone',direct:0,calculated:1}));
  const body=JSON.stringify({...op(),effectiveFrom:'2026-10',payload:{demand,events:[],roleRequirements:[]}});
  expect(body.length).toBeGreaterThan(16*1024);
  const response=await app.request(base+`/api/companies/${f.company.companyId}/inputs/teams/${f.team}/planning`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body},env);
  expect(response.status).toBe(200);
  const master=await app.request(base+`/api/companies/${f.company.companyId}/teams`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(17000)})},env);
  expect(master.status).toBe(413);
});
it('WP-02: empty permission and cross-company snapshot reads cannot expose frozen staff inputs',async()=>{
  const saved=await snapshot();
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  await expect(readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.staffUser,saved.snapshot!.id)).rejects.toThrow('FORBIDDEN');
  const other=await inputFixture(env.DB);
  await expect(readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,other.company.userId,saved.snapshot!.id)).rejects.toThrow('FORBIDDEN');
  await expect(readInputSnapshot(env.DB,env.INPUTS,other.company.companyId,other.team,other.company.userId,saved.snapshot!.id)).rejects.toThrow('NOT_FOUND');
});
