import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect} from 'vitest';
import {admitMaintenance,releaseMaintenance} from '../../apps/api/src/maintenance';
import {maintenanceDatabase,databaseOnlyAuthPath} from '../../apps/api/src/maintenance-database';
import {changeMaintenance,maintenanceStatus,listMaintenanceLeases,inspectMaintenanceOperation} from '../../apps/operations/src/maintenance-control';
import {createApp} from '../../apps/api/src/index';
import {provisionCompany} from '../../apps/api/src/product';
import operator from '../../apps/operations/src/operator-worker';

const principal='poc-operator',idle=async()=>({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
const begin=()=>({action:'begin' as const,operationId:crypto.randomUUID(),expectedRevision:0,reason:'架空認証処理の書込み失効'});
const retire=(maintenanceId:string,leaseIds:string[],expectedRevision=1)=>({action:'retire' as const,operationId:crypto.randomUUID(),maintenanceId,expectedRevision,leaseIds,reason:'D1専用受付の権限を失効'});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();await env.DB.prepare('DELETE FROM maintenance_lease').run();});

it('database-only auth allowlist excludes mail, product mutations and local hooks',()=>{
 for(const path of ['/api/auth/sign-in/email','/api/auth/sign-out','/api/auth/get-session','/api/auth/reset-password','/api/password','/api/access'])expect(databaseOnlyAuthPath(path)).toBe(true);
 for(const path of ['/api/auth/request-password-reset','/api/auth/change-password','/api/context','/__local/fixture','/api/password/'])expect(databaseOnlyAuthPath(path)).toBe(false);
});
it('guarded SQL preserves ordered bound results, returning writes and original metadata without extra write rows',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1);expect(id).not.toBeNull();const db=maintenanceDatabase(env.DB,id!);
 const rows=await db.batch([db.prepare('SELECT ? AS first').bind(7),db.prepare('SELECT ? AS second').bind('架空')]);
 expect(rows.map(r=>r.results)).toEqual([[{first:7}],[{second:'架空'}]]);expect(rows.every(r=>r.meta.rows_written===0)).toBe(true);
 expect(await db.prepare('SELECT 42 AS value').first('value')).toBe(42);
 expect(await db.prepare('SELECT 1 AS value WHERE 0').first()).toBeNull();
 await expect(db.prepare('SELECT 1 AS value').first('missing')).rejects.toThrow('D1_COLUMN_NOTFOUND');
 const r=await db.prepare('UPDATE maintenance_lease SET started_at=started_at+1 WHERE id=? RETURNING id').bind(id).all();
 expect(r.meta.changes).toBe(1);expect(r.meta.rows_written).toBe(1);expect(r.results).toEqual([{id}]);
 expect(await db.batch([])).toEqual([]);await releaseMaintenance(env.DB,id!);
});
it('retirement is explicit revocation; pre-created statements cannot write before or after reopening',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),db=maintenanceDatabase(env.DB,id!);
 const write=db.prepare('UPDATE maintenance_state SET updated_at=0');
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 const command=retire(b.operationId,[id!]),r=await changeMaintenance(env.DB,principal,command,idle);
 expect(r).toMatchObject({action:'retire',mode:'DRAINING',revision:2});expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
 for(const check of [()=>write.run(),()=>db.batch([write]),()=>db.prepare('SELECT 1').all()])await expect(check()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 const audit=await env.DB.prepare('SELECT guard_version,retired_at FROM maintenance_lease_retirement WHERE lease_id=?').bind(id).first();expect(audit).toMatchObject({guard_version:1});
 expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_lease_recovery WHERE lease_id=?').bind(id).first('n')).toBe(0);
 await changeMaintenance(env.DB,principal,{action:'freeze',operationId:crypto.randomUUID(),maintenanceId:b.operationId,expectedRevision:2,reason:'架空凍結'},idle);
 await changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:b.operationId,expectedRevision:3,reason:'架空再開'},idle);
 await expect(write.run()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 await expect(env.DB.prepare("INSERT INTO maintenance_lease(id,kind,started_at,guard_version) VALUES (?,'FOREGROUND',0,1)").bind(id).run()).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
 await releaseMaintenance(env.DB,id!);expect((await inspectMaintenanceOperation(env.DB,principal,command.operationId)).found).toBe(true);
});
it('legacy, background, completed, missing and mixed leases are never retired',async()=>{
 const legacy=await admitMaintenance(env.DB,'FOREGROUND'),background=await admitMaintenance(env.DB,'BACKGROUND'),fenced=await admitMaintenance(env.DB,'FOREGROUND',1),done=await admitMaintenance(env.DB,'FOREGROUND',1);
 await env.DB.prepare('UPDATE maintenance_lease SET started_at=0 WHERE id=?').bind(legacy).run();
 await env.DB.prepare('UPDATE maintenance_lease SET completed_at=1 WHERE id=?').bind(done).run();
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 for(const ids of [[legacy!],[background!],[done!],[crypto.randomUUID()],[fenced!,legacy!]])await expect(changeMaintenance(env.DB,principal,retire(b.operationId,ids),idle)).rejects.toMatchObject({code:'MAINTENANCE_DATABASE_GUARD_REQUIRED'});
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(4);
 await expect(env.DB.prepare('UPDATE maintenance_lease SET guard_version=1 WHERE id=?').bind(legacy).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_GUARD');
 await expect(admitMaintenance(env.DB,'BACKGROUND',1)).rejects.toMatchObject({code:'MAINTENANCE_UNAVAILABLE'});
});
it('batch business failures roll back preceding mutations while a valid lease remains usable',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),db=maintenanceDatabase(env.DB,id!);
 const before=await env.DB.prepare('SELECT updated_at FROM maintenance_state WHERE id=1').first('updated_at');
 await expect(db.batch([db.prepare('UPDATE maintenance_state SET updated_at=123'),db.prepare('INSERT INTO maintenance_state(id,mode,revision,updated_at) VALUES (1,\'OPEN\',0,0)')])).rejects.toThrow();
 expect(await env.DB.prepare('SELECT updated_at FROM maintenance_state WHERE id=1').first('updated_at')).toBe(before);
 expect(await db.prepare('SELECT 1 AS ok').first('ok')).toBe(1);await releaseMaintenance(env.DB,id!);
});
it('foreign statements and execution escape hatches fail closed',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),db=maintenanceDatabase(env.DB,id!);
 await expect(db.batch([env.DB.prepare('SELECT 1')])).rejects.toMatchObject({code:'MAINTENANCE_STATEMENT_SCOPE'});
 for(const method of [()=>db.exec('SELECT 1'),()=>db.withSession(),()=>db.dump(),()=>db.prepare('SELECT 1').raw()])expect(method).toThrow('MAINTENANCE_UNSUPPORTED_DATABASE_METHOD');
 await releaseMaintenance(env.DB,id!);
});
it('selection and receipt replay are atomic across concurrent callers and changed identities',async()=>{
 const a=await admitMaintenance(env.DB,'FOREGROUND',1),z=await admitMaintenance(env.DB,'FOREGROUND',1),other=await admitMaintenance(env.DB,'FOREGROUND');
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);const c=retire(b.operationId,[a!,z!]);
 const results=await Promise.all(Array.from({length:5},()=>changeMaintenance(env.DB,principal,c,idle)));expect(results.every(r=>r.revision===2)).toBe(true);
 expect((await changeMaintenance(env.DB,principal,{...c,leaseIds:[z!,a!]},idle)).id).toBe(c.operationId);
 for(const changed of [{...c,leaseIds:[a!]},{...c,reason:'異なる理由'},{...c,action:'reclaim' as const}])await expect(changeMaintenance(env.DB,principal,changed,idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 await expect(changeMaintenance(env.DB,'other',c,idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 expect(await inspectMaintenanceOperation(env.DB,'other',c.operationId)).toEqual({found:false});
 expect((await listMaintenanceLeases(env.DB,{})).leases).toHaveLength(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);await releaseMaintenance(env.DB,other!);
});
it('retirement audit or deletion failure cannot leave partial revocation, including silently skipped SQL',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),b=begin();await changeMaintenance(env.DB,principal,b,idle);
 for(const [table,operation] of [['maintenance_retirement_operation','INSERT'],['maintenance_lease_retirement','INSERT'],['maintenance_lease','DELETE'],['maintenance_retirement_commit','INSERT']]){
  const c=retire(b.operationId,[id!]);
  await env.DB.exec(`CREATE TRIGGER retirement_test_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fictional failure'); END;`);
  try{await expect(changeMaintenance(env.DB,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER retirement_test_failure');}
  expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await inspectMaintenanceOperation(env.DB,principal,c.operationId)).found).toBe(false);
 }
 for(const [table,operation] of [['maintenance_lease_retirement','INSERT'],['maintenance_lease','DELETE'],['maintenance_retirement_commit','INSERT']]){
  const c=retire(b.operationId,[id!]);await env.DB.exec(`CREATE TRIGGER retirement_test_skip BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END;`);
  try{await expect(changeMaintenance(env.DB,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER retirement_test_skip');}
  expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await inspectMaintenanceOperation(env.DB,principal,c.operationId)).found).toBe(false);
 }
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);
});
it('a normal release racing the retirement batch creates no false receipt',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),b=begin();await changeMaintenance(env.DB,principal,b,idle);const c=retire(b.operationId,[id!]);
 const racing={prepare:env.DB.prepare.bind(env.DB),async batch<T>(statements:D1PreparedStatement[]){await releaseMaintenance(env.DB,id!);return env.DB.batch<T>(statements);}};
 await expect(changeMaintenance(racing,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});expect((await inspectMaintenanceOperation(env.DB,principal,c.operationId)).found).toBe(false);
 expect((await maintenanceStatus(env.DB)).revision).toBe(1);
});
it('a silently skipped completion-recovery commit also rolls back state, audit and deletion',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND');await env.DB.prepare('UPDATE maintenance_lease SET completed_at=1 WHERE id=?').bind(id).run();
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);const c={...retire(b.operationId,[id!]),action:'reclaim' as const};
 await env.DB.exec('CREATE TRIGGER retirement_test_reclaim_skip BEFORE INSERT ON maintenance_recovery_commit BEGIN SELECT RAISE(IGNORE); END;');
 try{await expect(changeMaintenance(env.DB,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER retirement_test_reclaim_skip');}
 expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);expect((await inspectMaintenanceOperation(env.DB,principal,c.operationId)).found).toBe(false);
 expect((await changeMaintenance(env.DB,principal,c,idle)).revision).toBe(2);
});
it('operator-only retirement respects existing authorization and body guards',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1),b=begin();await changeMaintenance(env.DB,principal,b,idle);const c=retire(b.operationId,[id!]),token=crypto.randomUUID()+crypto.randomUUID();
 const cfg={DB:env.DB,SOLVER:env.SOLVER,RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:'00000000-0000-0000-0000-000000000000',OPERATOR_TOKEN:token,OPERATOR_PRINCIPAL:principal as 'poc-operator'};
 const request=(auth:string,origin=false)=>new Request('https://operator.example.invalid/maintenance/command',{method:'POST',headers:{authorization:auth,'content-type':'application/json',...(origin?{origin:'https://fictional.example.invalid'}:{})},body:JSON.stringify(c)});
 expect((await operator.fetch(request('Bearer invalid'),cfg)).status).toBe(403);expect((await operator.fetch(request('Bearer '+token,true),cfg)).status).toBe(403);
 expect((await operator.fetch(request('Bearer '+token),cfg)).status).toBe(200);
});

it('real Better Auth password change resumed after retirement cannot update credentials or clear the initial-change gate',async()=>{
 const account=await provisionCompany(env.DB,{name:'架空認証復旧社',adminName:'架空管理者',adminEmail:crypto.randomUUID()+'@example.invalid'});
 const app=createApp();const url=env.AUTH_BASE_URL;const signIn=await app.request(url+'/api/auth/sign-in/email',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({email:await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(account.userId).first('email'),password:account.initialPassword})},env);
 expect(signIn.status).toBe(200);const cookie=signIn.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');expect(cookie).not.toBe('');
 const originalHash=await env.DB.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").bind(account.userId).first('password');
 let signal!:()=>void,release!:()=>void;const paused=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);const writes=new WeakSet<D1PreparedStatement>();
 function intercept(statement:D1PreparedStatement,sql:string):D1PreparedStatement{
  const wrapper=new Proxy(statement,{get(target,key){if(key==='bind')return (...args:unknown[])=>intercept(target.bind(...args),sql);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  if(/^\s*update\s+"?account"?/i.test(sql))writes.add(wrapper);return wrapper;
 }
 const delayed=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>intercept(target.prepare(sql),sql);if(key==='batch')return async<T>(statements:D1PreparedStatement[])=>{if(statements.some(s=>writes.has(s))){signal();await gate;}return target.batch<T>(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const pending=app.request(url+'/api/password',{method:'POST',headers:{origin:url,cookie,'content-type':'application/json'},body:JSON.stringify({currentPassword:account.initialPassword,newPassword:'Fictional-Recovery-'+crypto.randomUUID()})},{...env,DB:delayed});
 await paused;
 const page=await listMaintenanceLeases(env.DB,{});expect(page.leases).toHaveLength(1);expect(page.leases[0]).toMatchObject({guard_version:1,completed_at:null});
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);await changeMaintenance(env.DB,principal,retire(b.operationId,[page.leases[0].id]),idle);
 // A reopening cannot resurrect authority captured by the older request.
 await changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:b.operationId,expectedRevision:2,reason:'架空の業務再開'},idle);
 release();const response=await pending;expect(response.status).toBe(503);expect(response.headers.get('set-cookie')).toBeNull();expect(await response.json()).toEqual({error:'MAINTENANCE_LEASE_RETIRED'});
 expect(await env.DB.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").bind(account.userId).first('password')).toBe(originalHash);
 expect(await env.DB.prepare('SELECT must_change_password FROM access_state WHERE user_id=?').bind(account.userId).first('must_change_password')).toBe(1);
 const denied=await app.request(url+'/api/context',{headers:{cookie}},env);expect(denied.status).toBe(403);expect(await denied.json()).toEqual({error:'PASSWORD_CHANGE_REQUIRED'});
 const newPassword='Fictional-Fresh-'+crypto.randomUUID();
 const fresh=await app.request(url+'/api/password',{method:'POST',headers:{origin:url,cookie,'content-type':'application/json'},body:JSON.stringify({currentPassword:account.initialPassword,newPassword})},env);
 expect(fresh.status).toBe(200);expect(await env.DB.prepare('SELECT must_change_password FROM access_state WHERE user_id=?').bind(account.userId).first('must_change_password')).toBe(0);
 const loggedIn=await app.request(url+'/api/auth/sign-in/email',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({email:await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(account.userId).first('email'),password:newPassword})},env);
 expect(loggedIn.status).toBe(200);const freshCookie=loggedIn.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 expect((await app.request(url+'/api/context',{headers:{cookie:freshCookie}},env)).status).toBe(200);
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
