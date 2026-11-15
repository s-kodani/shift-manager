import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { inputFixture, probePolicy } from '../../apps/api/src/input-probes';
import { createInputSnapshot, readInputSnapshot } from '../../apps/api/src/input-snapshots';
import { readInputChanges } from '../../apps/api/src/input-changes';
import { compareInputValues } from '../../apps/api/src/input-changes-contract';
import { createApp } from '../../apps/api/src/index';
import { changeLabel, changeValue } from '../../apps/web/product/input-changes-model';
import type { InputDatabase } from '../../apps/api/src/input-versions';
let f: Awaited<ReturnType<typeof inputFixture>>, snapshotId:string;
const revision=()=>env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(f.company.companyId).first<number>('revision');
const read=async(offset=0,e:Parameters<typeof readInputChanges>[0]=env)=>readInputChanges(e,f.company.companyId,f.team,f.company.userId,snapshotId,
  {expectedRevision:(await revision())!,expectedDraftRevision:0,offset});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{
  f=await inputFixture(env.DB,env.INPUTS);snapshotId=crypto.randomUUID();
  await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,
    {operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
});

it('TS-API-05: unchanged conditions have no differences; contract, wishes and demand show exact old/new values without changing frozen input',async()=>{
  const saved=await readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,snapshotId);
  const bytes=await(await env.INPUTS.get(saved.snapshot.object_key))!.text();
  expect(await read()).toMatchObject({inputRevision:f.revision,currentRevision:f.revision,total:0,totals:{input:0,publication:0},changes:[],nextOffset:null});
  await f.save('staff_contract',{...f.profile,rule:{...f.profile.rule,dailyMax:390},contract:{...f.profile.contract,end:1080}});
  await f.save('staff_month',{unavailable:[{date:'2026-10-02',start:607,end:608}],preferences:[{date:'2026-10-01',kind:'window',start:600,end:990}]});
  await f.save('planning',{...f.plan,demand:f.plan.demand.map((d,i)=>i?{...d,direct:0}:d)});
  const page=await read();
  expect(page.totals).toEqual({input:page.total,publication:0});
  const field=(path:string[])=>page.changes.find(c=>JSON.stringify(c.path)===JSON.stringify(path));
  expect(field(['staff',f.staff.staffId,'contract','end'])).toMatchObject({before:1020,after:1080});
  expect(field(['staff',f.staff.staffId,'rules','staff_contract','dailyMax'])).toMatchObject({before:420,after:390});
  expect(field(['resources','staff_contract',f.staff.staffId,'rule','dailyMax'])).toMatchObject({before:420,after:390});
  expect(field(['staff',f.staff.staffId,'preferences','2026-10-01:window','end'])).toMatchObject({before:1020,after:990});
  expect(field(['demand','2026-10-01:phone:630','direct'])).toMatchObject({before:null,after:0});
  expect(page.changes.some(c=>c.path.includes('unavailable')&&c.path.at(-1)==='end'&&c.after===608)).toBe(true);
  expect(page.changes.filter(c=>c.path[0]==='sources')).toHaveLength(3);
  expect(page.changes.some(c=>c.path.includes('rules')&&c.path.at(-1)==='id')).toBe(false);
  expect(await(await env.INPUTS.get(saved.snapshot.object_key))!.text()).toBe(bytes);
  expect(await env.DB.prepare('SELECT count(*) n FROM compute_job WHERE company_id=?').bind(f.company.companyId).first('n')).toBe(0);
});
it('registered differences remain readable when current rule layers cannot compile; no validation or adoption is implied',async()=>{
  await f.save('company_policy',{...probePolicy,rule:{...probePolicy.rule,monthlyMin:600}});
  await f.save('staff_contract',{...f.profile,rule:{...f.profile.rule,monthlyMax:120}});
  const page=await read();
  expect(page).toMatchObject({currentInputStatus:'UNAVAILABLE',currentInputError:'CONTRADICTORY_RULE'});
  expect(page.changes.find(c=>JSON.stringify(c.path)===JSON.stringify(['resources','staff_contract',f.staff.staffId,'rule','monthlyMax']))).toMatchObject({before:12000,after:120});
  expect(page.changes.find(c=>JSON.stringify(c.path)===JSON.stringify(['resources','company_policy',f.company.companyId,'rule','monthlyMin']))).toMatchObject({before:60,after:600});
  expect(page.changes.every(c=>['sources','resources'].includes(c.path[0]))).toBe(true);
  expect(await env.DB.prepare('SELECT count(*) n FROM schedule_publication_version WHERE company_id=?').bind(f.company.companyId).first('n')).toBe(0);
});
it('a new reference version with the same values is distinct from an effective condition change',async()=>{
  await f.save('staff_contract',f.profile);
  const page=await read();
  expect(page.changes).toHaveLength(1);
  expect(page.changes[0]).toMatchObject({path:['sources','staff_contract',f.staff.staffId],before:7,after:10});
});
it('difference pagination is complete and stable; a changed revision cannot be mixed into a later page',async()=>{
  await f.save('planning',{...f.plan,demand:Array.from({length:60},(_,i)=>({date:`2026-10-${String(Math.floor(i/2)+1).padStart(2,'0')}`,taskId:'phone',start:600+(i%2)*30,end:630+(i%2)*30,direct:2,calculated:null}))});
  const first=await read();expect(first.changes).toHaveLength(50);expect(first.nextOffset).toBe(50);
  const all=[...first.changes];let next=first.nextOffset;
  while(next!==null){const page=await read(next);expect(page.total).toBe(first.total);expect(page.totals).toEqual({input:first.total,publication:0});all.push(...page.changes);next=page.nextOffset;}
  expect(all).toHaveLength(first.total);expect(new Set(all.map(c=>JSON.stringify(c.path))).size).toBe(first.total);
  await f.save('staff_contract',f.profile);
  await expect(readInputChanges(env,f.company.companyId,f.team,f.company.userId,snapshotId,
    {expectedRevision:first.currentRevision,expectedDraftRevision:0,offset:50})).rejects.toThrow('VERSION_CONFLICT');
});
it('staff and foreign company/team/snapshot scopes cannot read condition differences',async()=>{
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  const q={expectedRevision:f.revision,expectedDraftRevision:0,offset:0};
  await expect(readInputChanges(env,f.company.companyId,f.team,f.staffUser,snapshotId,q)).rejects.toThrow('FORBIDDEN');
  const other=await inputFixture(env.DB,env.INPUTS);
  await expect(readInputChanges(env,f.company.companyId,f.team,other.company.userId,snapshotId,q)).rejects.toThrow('FORBIDDEN');
  await expect(readInputChanges(env,other.company.companyId,other.team,other.company.userId,snapshotId,q)).rejects.toThrow('NOT_FOUND');
  await expect(readInputChanges(env,f.company.companyId,other.team,f.company.userId,snapshotId,q)).rejects.toThrow('FORBIDDEN');
});
it.each(['access','revision'])('the final atomic read refuses a late %s change before disclosing differences',async kind=>{
  function wrap(s:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(s,{get(target,key){
      if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
      if(key==='first')return async<T>(column?:string)=>{
        if(kind==='access')await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();
        else await env.DB.prepare('UPDATE company SET revision=revision+1 WHERE id=?').bind(f.company.companyId).run();
        return column?target.first<T>(column):target.first<T>();
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  }
  const db:InputDatabase={batch:env.DB.batch.bind(env.DB),prepare:sql=>sql.includes('AS authorized')?wrap(env.DB.prepare(sql)):env.DB.prepare(sql)};
  await expect(read(0,{...env,DB:db})).rejects.toThrow(kind==='access'?'FORBIDDEN':'VERSION_CONFLICT');
});
it('HTTP rejects unknown/repeated/nondecimal query fields, retains no-store, and applies first-password/session gates',async()=>{
  const app=createApp(),base=env.AUTH_BASE_URL,path=`/api/companies/${f.company.companyId}/inputs/teams/${f.team}/snapshots/${snapshotId}/changes`;
  const login=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
  expect(login.status).toBe(200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const query=`?expectedRevision=${f.revision}&expectedDraftRevision=0`;
  expect((await app.request(base+path+query,{},env)).status).toBe(401);
  const get=(suffix:string)=>app.request(base+path+suffix,{headers:{cookie}},env);
  const response=await get(query);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  for(const suffix of [query+'&unexpected=1',query+'&offset=1e2',query+'&offset=-1',query+'&offset=0&offset=0','?expectedRevision=0x9&expectedDraftRevision=0'])expect((await get(suffix)).status).toBe(400);
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(f.company.userId).run();
  expect((await get(query)).status).toBe(403);
});
it('comparison ignores identity order and rule source IDs while preserving absent/null/zero and explicit long-text truncation',()=>{
  expect(compareInputValues({staff:[{id:'b',rules:[{id:'company_policy:old',dailyMax:60}]},{id:'a'}]},
    {staff:[{id:'a'},{id:'b',rules:[{id:'company_policy:new',dailyMax:60}]}]})).toEqual([]);
  const rows=compareInputValues({a:null,b:0},{a:0,c:null,reason:'架空'.repeat(600)});
  expect(rows.find(c=>c.path[0]==='a')).toMatchObject({before:null,after:0});
  expect(rows.find(c=>c.path[0]==='b')).toMatchObject({before:0,after:undefined});
  expect(rows.find(c=>c.path[0]==='c')).toMatchObject({before:undefined,after:null});
  expect(rows.find(c=>c.path[0]==='reason')).toMatchObject({afterTruncated:true});
  expect(compareInputValues(JSON.parse('{"__proto__":{"start":607}}'),{})).toEqual([
    {path:['__proto__','start'],before:607,after:undefined,beforeTruncated:false,afterTruncated:false},
  ]);
  expect(changeValue(null,['demand','x','direct'])).toBe('未入力');expect(changeValue(0,['demand','x','direct'])).toBe('0');
  expect(changeValue(607,['staff','x','unavailable','date','start'])).toBe('10:07');
  expect(changeLabel(['demand','2026-10-01:phone:630','direct'],()=> '架空スタッフ')).toContain('2026-10-01・phone・10:30');
  expect(changeLabel(['staff','x','rules','staff_contract','dailyMax'],()=> '架空スタッフ')).toContain('架空スタッフ ／ 勤務ルール ／ スタッフ契約 ／ 日上限（分）');
});
