import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect} from 'vitest';
import {hashPassword} from 'better-auth/crypto';
import {createApp} from '../../apps/api/src/index';
import {provisionCompany,createTeam,createStaff} from '../../apps/api/src/product';
import {securityCheckpoint,reconcileRecoverySecurity,inspectRecoverySecurity} from '../../apps/operations/src/recovery-security';
import {changeMaintenance,maintenanceStatus} from '../../apps/operations/src/maintenance-control';
import {recoveryDigest,recoveryReconcile} from '../../scripts/recovery-security-contract.mjs';
import operator from '../../apps/operations/src/operator-worker';
const base=env.AUTH_BASE_URL,principal='poc-operator',sourceId=crypto.randomUUID(),targetId=crypto.randomUUID();let restoreId=crypto.randomUUID();
const sourceEnv={DB:env.DB,RECOVERY_DATABASE_ID:sourceId,RECOVERY_SECURITY_ID:'',OPERATOR_PRINCIPAL:principal};
const targetEnv={...sourceEnv,RECOVERY_DATABASE_ID:targetId,RECOVERY_SECURITY_ID:restoreId};
const idle=async()=>({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
const mailbox:{email:string;url:string}[]=[];const app=createApp(async m=>{mailbox.push(m);});
const request=(path:string,body?:object,cookie?:string,recovery='')=>app.request(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:base,...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined},{...env,RECOVERY_SECURITY_ID:recovery});
async function login(email:string,password:string,recovery=''){
 const r=await request('/api/auth/sign-in/email',{email,password},undefined,recovery);expect(r.status).toBe(200);return r.headers.get('set-cookie')!.split(';')[0];
}
async function freeze(revision=2,updatedAt=Date.now()-10){const id=crypto.randomUUID();await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN',revision=?,maintenance_id=?,last_operation_id=NULL,updated_at=? WHERE id=1").bind(revision,id,updatedAt).run();return id;}
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{mailbox.length=0;restoreId=crypto.randomUUID();targetEnv.RECOVERY_SECURITY_ID=restoreId;await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();});
async function fixture(){
 const email='recovery-admin-'+crypto.randomUUID()+'@example.invalid',staffEmail='recovery-staff-'+crypto.randomUUID()+'@example.invalid';
 const admin=await provisionCompany(env.DB,{name:'架空復旧企業',adminName:'架空管理者',adminEmail:email});
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(admin.userId).run();
 const team=await createTeam(env.DB,admin.companyId,admin.userId,{operationId:crypto.randomUUID(),expectedRevision:0,name:'架空復旧チーム'});
 const staff=await createStaff(env.DB,admin.companyId,team.teamId,admin.userId,{operationId:crypto.randomUUID(),expectedRevision:1,name:'架空復旧スタッフ',email:staffEmail,staffNumber:'0001'});
 const member=await env.DB.prepare('SELECT user_id FROM staff WHERE id=?').bind(staff.staffId).first<string>('user_id');expect(member).not.toBeNull();
 await env.DB.batch([env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(member),env.DB.prepare("UPDATE team_member SET role='team_admin' WHERE user_id=?").bind(member)]);
 const cookie=await login(staffEmail,staff.initialPassword!);
 expect((await request('/api/auth/request-password-reset',{email:staffEmail})).status).toBe(200);
 const oldResetToken=new URL(mailbox.at(-1)!.url).pathname.split('/').pop()!;expect(oldResetToken.length).toBeGreaterThan(0);
 const backupAt=Date.now()-10,backup={users:(await env.DB.prepare('SELECT id,email,emailVerified,role,banned,banReason,banExpires FROM user').all<Record<string,unknown>>()).results,accounts:(await env.DB.prepare('SELECT * FROM account').all<Record<string,unknown>>()).results,
  access:(await env.DB.prepare('SELECT * FROM access_state').all<Record<string,unknown>>()).results,sessions:(await env.DB.prepare('SELECT * FROM session').all<Record<string,unknown>>()).results};
 const newPassword='Fictional-recovered-'+crypto.randomUUID();
 expect((await request('/api/password',{currentPassword:staff.initialPassword!,newPassword},cookie)).status).toBe(200);
 await env.DB.batch([env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(admin.userId),env.DB.prepare('UPDATE user SET banned=1,emailVerified=1 WHERE id=?').bind(admin.userId),env.DB.prepare("UPDATE team_member SET role='staff' WHERE user_id=?").bind(member)]);
 const sourceMaintenance=await freeze(4),sealed=await securityCheckpoint(sourceEnv,{maintenanceId:sourceMaintenance,expectedRevision:4});
 // Restore the older authentication rows while retaining the business rows,
 // representing the stale authority that an unchanged SQL backup contains.
 await env.DB.prepare('DELETE FROM session').run();await env.DB.prepare('DELETE FROM account').run();
 for(const row of backup.users)await env.DB.prepare('UPDATE user SET email=?,emailVerified=?,role=?,banned=?,banReason=?,banExpires=? WHERE id=?').bind(row.email,row.emailVerified,row.role,row.banned,row.banReason,row.banExpires,row.id).run();
 for(const row of backup.accounts){const keys=Object.keys(row);await env.DB.prepare(`INSERT INTO account(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();}
 for(const row of backup.access)await env.DB.prepare('UPDATE access_state SET enabled=?,must_change_password=? WHERE user_id=?').bind(row.enabled,row.must_change_password,row.user_id).run();
 for(const row of backup.sessions){const keys=Object.keys(row);await env.DB.prepare(`INSERT INTO session(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();}
 await env.DB.prepare("UPDATE team_member SET role='team_admin' WHERE user_id=?").bind(member).run();
 const maintenanceId=await freeze(2,backupAt);
 const command=recoveryReconcile.parse({operationId:crypto.randomUUID(),restoreId,maintenanceId,expectedRevision:2,reason:'最新の架空権限・資格情報を確認して復旧',...sealed});
 return {email,staffEmail,admin,staff,member:member!,cookie,newPassword,command,oldResetToken};
}
it('restored namespace blocks auth and operator resume until fresh security reconciliation, including an unrelated copied receipt',async()=>{
 const f=await fixture();
 expect((await request('/api/auth/sign-in/email',{email:f.staffEmail,password:f.staff.initialPassword!},undefined,restoreId)).status).toBe(503);
 await expect(changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:f.command.maintenanceId,expectedRevision:2,reason:'架空再開'},idle,restoreId)).rejects.toThrow('RECOVERY_SECURITY_REQUIRED');
 const done=await reconcileRecoverySecurity(targetEnv,f.command);expect(done.found).toBe(true);
 expect((await request('/api/access',undefined,f.cookie,crypto.randomUUID())).status).toBe(503);
 const resume={action:'resume' as const,operationId:crypto.randomUUID(),maintenanceId:f.command.maintenanceId,expectedRevision:3,reason:'架空再開'};
 await changeMaintenance(env.DB,principal,resume,idle,restoreId);
 // A resume receipt copied into another restore cannot pass its fresh gate.
 await expect(changeMaintenance(env.DB,principal,resume,idle,crypto.randomUUID())).rejects.toThrow('RECOVERY_SECURITY_REQUIRED');
});
it('latest password and disabled user survive reconciliation; all old sessions and reset links are invalidated, lower team role and business data are retained',async()=>{
 const f=await fixture(),before=await env.DB.prepare('SELECT * FROM company').all();
 const done=await reconcileRecoverySecurity(targetEnv,f.command);expect(done.found).toBe(true);
 expect(await env.DB.prepare('SELECT count(*) FROM session').first('count(*)')).toBe(0);expect(await env.DB.prepare('SELECT count(*) FROM verification').first('count(*)')).toBe(0);
 expect(await env.DB.prepare('SELECT emailVerified FROM user WHERE id=?').bind(f.admin.userId).first('emailVerified')).toBe(1);
 expect(await env.DB.prepare('SELECT role FROM team_member WHERE user_id=?').bind(f.member).first('role')).toBe('staff');
 expect((await env.DB.prepare('SELECT * FROM company').all()).results).toEqual(before.results);
 await changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:f.command.maintenanceId,expectedRevision:3,reason:'架空再開'},idle,restoreId);
 expect((await request('/api/context',undefined,f.cookie,restoreId)).status).toBe(401);
 expect((await request('/api/auth/sign-in/email',{email:f.staffEmail,password:f.staff.initialPassword!},undefined,restoreId)).status).toBe(401);
 const cookie=await login(f.staffEmail,f.newPassword,restoreId);expect((await request('/api/context',undefined,cookie,restoreId)).status).toBe(200);
 expect((await request('/api/auth/sign-in/email',{email:f.email,password:f.admin.initialPassword},undefined,restoreId)).status).toBe(403);
 expect((await request('/api/auth/reset-password',{token:f.oldResetToken,newPassword:'Fictional-next-'+crypto.randomUUID()},undefined,restoreId)).ok).toBe(false);
});
it('latest initial-change requirement and absent authority stay fail closed after restore',async()=>{
 const f=await fixture();const cp=structuredClone(f.command.checkpoint);cp.users=cp.users.filter(u=>u.id!==f.admin.userId);cp.accounts=cp.accounts.filter(a=>a.userId!==f.admin.userId);cp.access=cp.access.filter(a=>a.user_id!==f.admin.userId);cp.admins=[];
 cp.access.find(a=>a.user_id===f.member)!.must_change_password=1;
 const c={...f.command,checkpoint:cp,checkpointSha256:await recoveryDigest(cp)};await reconcileRecoverySecurity(targetEnv,c);
 expect(await env.DB.prepare('SELECT enabled FROM access_state WHERE user_id=?').bind(f.admin.userId).first('enabled')).toBe(0);
 expect(await env.DB.prepare('SELECT banned FROM user WHERE id=?').bind(f.admin.userId).first('banned')).toBe(1);
 await changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:c.maintenanceId,expectedRevision:3,reason:'架空再開'},idle,restoreId);
 const cookie=await login(f.staffEmail,f.newPassword,restoreId);expect((await request('/api/context',undefined,cookie,restoreId)).status).toBe(403);
 const next='Fictional-next-'+crypto.randomUUID();expect((await request('/api/password',{currentPassword:f.newPassword,newPassword:next},cookie,restoreId)).status).toBe(200);
 expect((await request('/api/context',undefined,await login(f.staffEmail,next,restoreId),restoreId)).status).toBe(200);
});
it('frozen source and target, checksum, nonce, expiry, account provider and all references are required before authority changes',async()=>{
 const f=await fixture();
 for(const c of [{...f.command,restoreId:crypto.randomUUID()},{...f.command,checkpointSha256:'0'.repeat(64)},
  {...f.command,checkpoint:{...f.command.checkpoint,sourceDatabaseId:targetId}}])await expect(reconcileRecoverySecurity(targetEnv,c)).rejects.toThrow('RECOVERY_');
 const expired={...f.command.checkpoint,capturedAt:Date.now()-1_000_000,expiresAt:Date.now()-1_000_000+900_000};expired.expiresAt=expired.capturedAt+900_000;
 await expect(reconcileRecoverySecurity(targetEnv,{...f.command,checkpoint:expired,checkpointSha256:await recoveryDigest(expired)})).rejects.toThrow('RECOVERY_CHECKPOINT_EXPIRED');
 await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();await expect(securityCheckpoint(sourceEnv,{maintenanceId:f.command.maintenanceId,expectedRevision:2})).rejects.toThrow('RECOVERY_SOURCE_NOT_FROZEN');
 await expect(reconcileRecoverySecurity(targetEnv,f.command)).rejects.toThrow('RECOVERY_TARGET_NOT_FROZEN');
 expect((await inspectRecoverySecurity(env.DB,principal,f.command.operationId)).found).toBe(false);
});
it('same operation is idempotent, altered payload and principal are rejected, receipt survives response loss and cannot be modified',async()=>{
 const f=await fixture(),rows=await Promise.all(Array.from({length:4},()=>reconcileRecoverySecurity(targetEnv,f.command)));expect(rows.every(r=>r.found)).toBe(true);expect((await maintenanceStatus(env.DB)).revision).toBe(3);
 await expect(reconcileRecoverySecurity(targetEnv,{...f.command,reason:'別の理由'})).rejects.toThrow('RECOVERY_OPERATION_REUSED');
 await expect(reconcileRecoverySecurity({...targetEnv,OPERATOR_PRINCIPAL:'different'},f.command)).rejects.toThrow('RECOVERY_OPERATION_REUSED');
 expect((await inspectRecoverySecurity(env.DB,principal,f.command.operationId)).found).toBe(true);expect((await inspectRecoverySecurity(env.DB,'different',f.command.operationId)).found).toBe(false);
 await expect(env.DB.prepare('DELETE FROM recovery_security_receipt WHERE id=?').bind(f.command.operationId).run()).rejects.toThrow('IMMUTABLE');
});
it('write failures and silently skipped replacements, deletion, state or receipt abort all reconciliation',async()=>{
 const f=await fixture();
 const before=async()=>JSON.stringify((await env.DB.batch(['user','account','session','verification','access_state','company_admin','team_member','membership','maintenance_state','recovery_security_receipt'].map(t=>env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1`)))).map(r=>r.results));
 const original=await before();
 for(const [table,event] of [['user','UPDATE'],['account','INSERT'],['access_state','INSERT'],['team_member','INSERT'],['session','DELETE'],['verification','DELETE'],['maintenance_state','UPDATE'],['recovery_security_receipt','INSERT']]){
  await env.DB.prepare(`CREATE TRIGGER recovery_skip BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();
  await expect(reconcileRecoverySecurity(targetEnv,f.command)).rejects.toThrow('RECOVERY_RECONCILIATION_UNAVAILABLE');expect(await before()).toBe(original);await env.DB.prepare('DROP TRIGGER recovery_skip').run();
 }
 await env.DB.prepare("CREATE TRIGGER recovery_fail BEFORE INSERT ON team_member BEGIN SELECT RAISE(ABORT,'fictional storage failure'); END").run();
 await expect(reconcileRecoverySecurity(targetEnv,f.command)).rejects.toThrow('RECOVERY_RECONCILIATION_UNAVAILABLE');expect(await before()).toBe(original);await env.DB.prepare('DROP TRIGGER recovery_fail').run();
 const cp=structuredClone(f.command.checkpoint);cp.members.find(m=>m.user_id===f.member)!.team_id=crypto.randomUUID();
 await expect(reconcileRecoverySecurity(targetEnv,{...f.command,checkpoint:cp,checkpointSha256:await recoveryDigest(cp)})).rejects.toThrow('RECOVERY_RECONCILIATION_UNAVAILABLE');expect(await before()).toBe(original);
 await reconcileRecoverySecurity(targetEnv,f.command);
});
it('operator recovery endpoints require machine authorization, enforce body bounds and withhold checkpoint bodies on rejected requests',async()=>{
 const f=await fixture(),token=crypto.randomUUID()+crypto.randomUUID(),cfg={...targetEnv,DB:env.DB,SOLVER:env.SOLVER,OPERATOR_TOKEN:token};
 const req=(body:unknown,headers:Record<string,string>={})=>new Request('https://operator.example.invalid/recovery/security/reconcile',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 expect((await operator.fetch(req(f.command,{authorization:'Bearer wrong'}),cfg)).status).toBe(403);
 expect((await operator.fetch(req(f.command,{origin:base}),cfg)).status).toBe(403);
 expect((await operator.fetch(req({padding:'x'.repeat(1_000_001)}),cfg)).status).toBe(413);
 const response=await operator.fetch(req(f.command),cfg);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(JSON.stringify(await response.json())).not.toContain('password');
 const inspect=new Request('https://operator.example.invalid/recovery/security/inspect',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operationId:f.command.operationId})});
 expect(await (await operator.fetch(inspect,{...cfg,RECOVERY_SECURITY_ID:crypto.randomUUID()})).json()).toEqual({found:false});
});
it('bounded checkpoint and atomic replacement handle 500 additional fictional identities without dropping their authority',async()=>{
 const password='Fictional-bulk-'+crypto.randomUUID(),encoded=await hashPassword(password),at=new Date().toISOString();
 const rows=Array.from({length:500},(_,i)=>({id:crypto.randomUUID(),account:crypto.randomUUID(),email:`recovery-bulk-${i}-${crypto.randomUUID()}@example.invalid`,enabled:i%3===0?0:1,change:i%5===0?1:0}));
 const data=JSON.stringify(rows);await env.DB.batch([
  env.DB.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) SELECT json_extract(value,'$.id'),'架空復旧スタッフ',json_extract(value,'$.email'),0,?,?,'user',0 FROM json_each(?)").bind(at,at,data),
  env.DB.prepare("INSERT INTO account(id,accountId,userId,providerId,password,createdAt,updatedAt) SELECT json_extract(value,'$.account'),json_extract(value,'$.id'),json_extract(value,'$.id'),'credential',?,?,? FROM json_each(?)").bind(encoded,at,at,data),
  env.DB.prepare("INSERT INTO access_state SELECT json_extract(value,'$.id'),json_extract(value,'$.enabled'),json_extract(value,'$.change') FROM json_each(?)").bind(data),
 ]);
 const backupAt=Date.now()-10,sourceMaintenance=await freeze(4),sealed=await securityCheckpoint(sourceEnv,{maintenanceId:sourceMaintenance,expectedRevision:4});
 expect(new TextEncoder().encode(JSON.stringify(sealed.checkpoint)).length).toBeLessThan(900_000);
 await env.DB.prepare('UPDATE access_state SET enabled=1,must_change_password=0').run();await env.DB.prepare('UPDATE account SET password=NULL WHERE userId=?').bind(rows[1].id).run();
 const maintenanceId=await freeze(2,backupAt),c={operationId:crypto.randomUUID(),restoreId,maintenanceId,expectedRevision:2,reason:'架空500名の資格情報を照合',...sealed};
 await reconcileRecoverySecurity(targetEnv,c);
 const actual=await env.DB.prepare('SELECT user_id,enabled,must_change_password FROM access_state WHERE user_id IN (SELECT json_extract(value,\'$.id\') FROM json_each(?)) ORDER BY user_id').bind(data).all();
 expect(actual.results).toEqual(rows.map(u=>({user_id:u.id,enabled:u.enabled,must_change_password:u.change})).sort((a,b)=>a.user_id.localeCompare(b.user_id)));
 expect(await env.DB.prepare('SELECT password FROM account WHERE userId=?').bind(rows[1].id).first('password')).toBe(encoded);
});
