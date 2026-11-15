import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect} from 'vitest';
import {hashPassword} from 'better-auth/crypto';
import {createApp} from '../../apps/api/src/index';
import {provisionCompany,createTeam,createStaff} from '../../apps/api/src/product';
import {reissueRecoverySecurity,inspectRecoveryReissue} from '../../apps/operations/src/recovery-reissue';
import {securityCheckpoint,reconcileRecoverySecurity} from '../../apps/operations/src/recovery-security';
import {changeMaintenance,maintenanceStatus} from '../../apps/operations/src/maintenance-control';
import operator from '../../apps/operations/src/operator-worker';
import {recoveryReissue} from '../../scripts/recovery-reissue-contract.mjs';
const principal='fictional-operator',sourceId=crypto.randomUUID(),targetId=crypto.randomUUID();
let restoreId=crypto.randomUUID();
const mailbox:{email:string;url:string}[]=[];
const app=createApp(async m=>{mailbox.push(m);});
const target=()=>({DB:env.DB,OPERATOR_PRINCIPAL:principal,RECOVERY_DATABASE_ID:targetId,RECOVERY_SECURITY_ID:restoreId});
const idle=async()=>({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
const request=(path:string,body?:object,cookie?:string,recovery=restoreId)=>app.request(env.AUTH_BASE_URL+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:env.AUTH_BASE_URL,...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined},{...env,RECOVERY_SECURITY_ID:recovery});
const login=(email:string,password:string,recovery=restoreId)=>request('/api/auth/sign-in/email',{email,password},undefined,recovery);
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{mailbox.length=0;restoreId=crypto.randomUUID();await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();});
async function fixture(){
 const admin=await provisionCompany(env.DB,{name:'架空元不在復旧企業',adminName:'架空管理者',adminEmail:'reissue-admin-'+crypto.randomUUID()+'@example.invalid'});
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(admin.userId).run();
 const team=(await createTeam(env.DB,admin.companyId,admin.userId,{operationId:crypto.randomUUID(),expectedRevision:0,name:'架空確認チーム'})).teamId;
 const staffEmail='reissue-staff-'+crypto.randomUUID()+'@example.invalid';
 const staff=await createStaff(env.DB,admin.companyId,team,admin.userId,{operationId:crypto.randomUUID(),expectedRevision:1,name:'架空再発行スタッフ',staffNumber:'0001',email:staffEmail});
 const staffUser=(await env.DB.prepare('SELECT user_id FROM staff WHERE id=?').bind(staff.staffId).first<string>('user_id'))!;
 const absent=await createStaff(env.DB,admin.companyId,team,admin.userId,{operationId:crypto.randomUUID(),expectedRevision:2,name:'架空未確認スタッフ',staffNumber:'0002',email:'reissue-absent-'+crypto.randomUUID()+'@example.invalid'});
 const absentUser=(await env.DB.prepare('SELECT user_id FROM staff WHERE id=?').bind(absent.staffId).first<string>('user_id'))!;
 await env.DB.batch([env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(staffUser),env.DB.prepare("UPDATE team_member SET role='team_admin' WHERE user_id=?").bind(staffUser)]);
 const cookie=(await login(staffEmail,staff.initialPassword!,'')).headers.get('set-cookie')!.split(';')[0];
 expect((await request('/api/auth/request-password-reset',{email:staffEmail},undefined,'')).status).toBe(200);
 const resetToken=new URL(mailbox.at(-1)!.url).pathname.split('/').pop()!;
 const maintenanceId=crypto.randomUUID();
 await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN',revision=2,maintenance_id=?,updated_at=? WHERE id=1").bind(maintenanceId,Date.now()-10).run();
 const passwords=['Fictional-fresh-'+crypto.randomUUID()+'-'+crypto.randomUUID(),'Fictional-fresh-'+crypto.randomUUID()+'-'+crypto.randomUUID()];
 const command=recoveryReissue.parse({operationId:crypto.randomUUID(),restoreId,maintenanceId,expectedRevision:2,backupId:crypto.randomUUID(),sourceDatabaseId:sourceId,sourceUnavailable:true,oldEnvironmentIsolated:true,isolationEvidenceRef:'fictional-isolation-01',verifiedAt:Date.now(),reason:'架空本人確認と現行権限による再発行',identities:[
  {userId:admin.userId,email:(await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(admin.userId).first<string>('email'))!,identityEvidenceRef:'fictional-identity-admin',authorityEvidenceRef:'fictional-authority-admin',companyAdminIds:[admin.companyId],memberships:[],accountId:crypto.randomUUID(),passwordHash:await hashPassword(passwords[0])},
  {userId:staffUser,email:staffEmail,identityEvidenceRef:'fictional-identity-staff',authorityEvidenceRef:'fictional-authority-staff',companyAdminIds:[],memberships:[{companyId:admin.companyId,teamId:team,role:'staff',staffId:staff.staffId}],accountId:crypto.randomUUID(),passwordHash:await hashPassword(passwords[1])},
 ]});
 return {admin,team,staff,staffUser,absent,absentUser,staffEmail,cookie,resetToken,passwords,command};
}
async function resume(c:{maintenanceId:string}){await changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:c.maintenanceId,expectedRevision:3,reason:'架空再発行後の明示再開'},idle,restoreId);}
it('source-unavailable recovery revokes old passwords/sessions/reset links, drops stale roles and preserves business data; fresh passwords require first change',async()=>{
 const f=await fixture(),before=(await env.DB.batch(['company','team','staff','product_operation'].map(t=>env.DB.prepare('SELECT * FROM '+t+' ORDER BY 1')))).map(r=>r.results);
 expect((await login(f.staffEmail,f.staff.initialPassword!)).status).toBe(503);
 await expect(resume(f.command)).rejects.toThrow('RECOVERY_SECURITY_REQUIRED');
 const done=await reissueRecoverySecurity(target(),f.command);expect(done.found).toBe(true);
 expect((await maintenanceStatus(env.DB)).mode).toBe('FROZEN');
 expect((await env.DB.batch(['company','team','staff','product_operation'].map(t=>env.DB.prepare('SELECT * FROM '+t+' ORDER BY 1')))).map(r=>r.results)).toEqual(before);
 expect(await env.DB.prepare('SELECT role FROM team_member WHERE user_id=?').bind(f.staffUser).first('role')).toBe('staff');
 expect(await env.DB.prepare('SELECT enabled FROM access_state WHERE user_id=?').bind(f.absentUser).first('enabled')).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM account WHERE userId=?').bind(f.absentUser).first('n')).toBe(0);
 expect(JSON.stringify(done)).not.toContain(f.command.identities[0].passwordHash);
 expect((await request('/api/access',undefined,f.cookie,crypto.randomUUID())).status).toBe(503);
 await resume(f.command);
 expect((await request('/api/context',undefined,f.cookie)).status).toBe(401);
 expect((await login(f.staffEmail,f.staff.initialPassword!)).status).toBe(401);
 expect((await request('/api/auth/reset-password',{token:f.resetToken,newPassword:'Fictional-no-reuse-'+crypto.randomUUID()})).ok).toBe(false);
 for(const [i,u] of f.command.identities.entries()){
  const signed=await login(u.email,f.passwords[i]);expect(signed.status).toBe(200);const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  expect((await request('/api/context',undefined,cookie)).status).toBe(403);
  const next='Fictional-changed-'+crypto.randomUUID();const change=await request('/api/password',{currentPassword:f.passwords[i],newPassword:next},cookie);expect(change.status).toBe(200);
  const fresh=(await login(u.email,next)).headers.get('set-cookie')!.split(';')[0];
  const context=await request('/api/context',undefined,fresh);expect(context.status).toBe(200);
  if(i===0){
   const list=await request('/api/companies/'+f.admin.companyId+'/teams/'+f.team+'/staff',undefined,fresh);expect(list.status).toBe(200);
   const rows=(await list.json() as {staff:{id:string;role:string|null}[]}).staff;
   expect(rows.map(s=>s.id).sort()).toEqual([f.staff.staffId,f.absent.staffId].sort());
   expect(rows.find(s=>s.id===f.absent.staffId)?.role).toBeNull();
  }
  if(i===1)expect((await request('/api/companies/'+f.admin.companyId+'/teams',{operationId:crypto.randomUUID(),expectedRevision:3,name:'許可されない架空チーム'},fresh)).status).toBe(403);
 }
});
it('reissue rejects old credential hashes, unknown identities, unverified/expired namespaces, active targets and foreign staff bindings',async()=>{
 const f=await fixture(),old=(await env.DB.prepare('SELECT password FROM account WHERE userId=?').bind(f.staffUser).first<string>('password'))!;
 for(const c of [{...f.command,restoreId:crypto.randomUUID()},{...f.command,sourceDatabaseId:targetId},{...f.command,verifiedAt:Date.now()-900_001},{...f.command,identities:f.command.identities.map((u,i)=>i?{...u,passwordHash:old}:u)},{...f.command,identities:f.command.identities.map((u,i)=>i?{...u,userId:crypto.randomUUID()}:u)}])await expect(reissueRecoverySecurity(target(),c)).rejects.toThrow('RECOVERY_');
 const foreign=structuredClone(f.command);foreign.identities[1].memberships[0].staffId=f.absent.staffId;
 await expect(reissueRecoverySecurity(target(),foreign)).rejects.toThrow('RECOVERY_REISSUE_UNAVAILABLE');
 expect((await inspectRecoveryReissue(env.DB,principal,f.command.operationId,restoreId)).found).toBe(false);
 await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();await expect(reissueRecoverySecurity(target(),f.command)).rejects.toThrow('RECOVERY_TARGET_NOT_FROZEN');
});
it('all credential/authority/state/receipt failures and silent skips roll back together',async()=>{
 const f=await fixture();
 const observe=async()=>JSON.stringify((await env.DB.batch(['user','account','session','verification','access_state','company_admin','team_member','membership','maintenance_state','recovery_security_reissue_receipt'].map(t=>env.DB.prepare('SELECT * FROM '+t+' ORDER BY 1')))).map(r=>r.results));
 const before=await observe();
 for(const [table,event] of [['user','UPDATE'],['account','INSERT'],['access_state','INSERT'],['company_admin','INSERT'],['team_member','INSERT'],['session','DELETE'],['verification','DELETE'],['maintenance_state','UPDATE'],['recovery_security_reissue_receipt','INSERT']]){
  await env.DB.prepare(`CREATE TRIGGER reissue_skip BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();
  await expect(reissueRecoverySecurity(target(),f.command)).rejects.toThrow('RECOVERY_REISSUE_UNAVAILABLE');expect(await observe()).toBe(before);await env.DB.prepare('DROP TRIGGER reissue_skip').run();
 }
 await env.DB.prepare("CREATE TRIGGER reissue_fail BEFORE INSERT ON team_member BEGIN SELECT RAISE(ABORT,'fictional fault'); END").run();
 await expect(reissueRecoverySecurity(target(),f.command)).rejects.toThrow('RECOVERY_REISSUE_UNAVAILABLE');expect(await observe()).toBe(before);await env.DB.prepare('DROP TRIGGER reissue_fail').run();
 await reissueRecoverySecurity(target(),f.command);
});
it('concurrent identical reissuance commits once; changed commands/principals and cross-method repeats cannot replace authority',async()=>{
 const f=await fixture();const checkpoint=await securityCheckpoint({...target(),RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:sourceId},{maintenanceId:f.command.maintenanceId,expectedRevision:2});
 const results=await Promise.all(Array.from({length:4},()=>reissueRecoverySecurity(target(),f.command)));expect(results.every(r=>r.found)).toBe(true);expect((await maintenanceStatus(env.DB)).revision).toBe(3);
 await expect(reissueRecoverySecurity(target(),{...f.command,reason:'different'})).rejects.toThrow('RECOVERY_OPERATION_REUSED');
 await expect(reissueRecoverySecurity({...target(),OPERATOR_PRINCIPAL:'different'},f.command)).rejects.toThrow('RECOVERY_OPERATION_REUSED');
 expect((await inspectRecoveryReissue(env.DB,'different',f.command.operationId,restoreId)).found).toBe(false);
 await expect(reconcileRecoverySecurity(target(),{operationId:crypto.randomUUID(),restoreId,maintenanceId:f.command.maintenanceId,expectedRevision:3,reason:'別方式の架空照合',...checkpoint})).rejects.toThrow('RECOVERY_ALREADY_RECONCILED');
 await expect(env.DB.prepare('DELETE FROM recovery_security_reissue_receipt WHERE id=?').bind(f.command.operationId).run()).rejects.toThrow('IMMUTABLE');
});
it('checkpoint reconciliation wins instead of reissuance and new namespaces cannot reuse the old resume receipt',async()=>{
 const f=await fixture(),sealed=await securityCheckpoint({...target(),RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:sourceId},{maintenanceId:f.command.maintenanceId,expectedRevision:2});
 await reconcileRecoverySecurity(target(),{operationId:crypto.randomUUID(),restoreId,maintenanceId:f.command.maintenanceId,expectedRevision:2,reason:'架空元が再利用できる場合',...sealed});
 await expect(reissueRecoverySecurity(target(),f.command)).rejects.toThrow('RECOVERY_ALREADY_RECONCILED');
 await resume(f.command);
 await expect(changeMaintenance(env.DB,principal,{action:'resume',operationId:crypto.randomUUID(),maintenanceId:f.command.maintenanceId,expectedRevision:4,reason:'別UUID'},idle,crypto.randomUUID())).rejects.toThrow('RECOVERY_SECURITY_REQUIRED');
});
it('operator-only reissue bounds bodies, rejects browser origin/foreign nonce and never returns hashes or email/password handoffs',async()=>{
 const f=await fixture(),token=crypto.randomUUID()+crypto.randomUUID(),cfg={...target(),SOLVER:env.SOLVER,OPERATOR_TOKEN:token};
 const req=(body:unknown,headers:Record<string,string>={})=>new Request('https://operator.example.invalid/recovery/security/reissue',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 expect((await operator.fetch(req(f.command,{authorization:'Bearer wrong'}),cfg)).status).toBe(403);
 expect((await operator.fetch(req(f.command,{origin:env.AUTH_BASE_URL}),cfg)).status).toBe(403);
 expect((await operator.fetch(req({padding:'x'.repeat(1_000_001)}),cfg)).status).toBe(413);
 const r=await operator.fetch(req(f.command),cfg);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');const body=JSON.stringify(await r.json());expect(body).not.toContain('password');expect(body).not.toContain(f.staffEmail);
});

it('an oversized restored credential set cannot be read without bounds or bypass the frozen recovery gate',async()=>{
 const f=await fixture(),at=new Date().toISOString();
 const rows=JSON.stringify(Array.from({length:2001},()=>({id:crypto.randomUUID()})));
 await env.DB.prepare("INSERT INTO account(id,accountId,userId,providerId,password,createdAt,updatedAt) SELECT json_extract(value,'$.id'),? ,? ,'credential','fictional-hash',?,? FROM json_each(?)").bind(f.staffUser,f.staffUser,at,at,rows).run();
 await expect(reissueRecoverySecurity(target(),f.command)).rejects.toThrow('RECOVERY_RESTORED_IDENTITY_LIMIT');
 expect((await maintenanceStatus(env.DB)).revision).toBe(2);
 expect((await inspectRecoveryReissue(env.DB,principal,f.command.operationId,restoreId)).found).toBe(false);
 expect((await login(f.staffEmail,f.staff.initialPassword!)).status).toBe(503);
});
