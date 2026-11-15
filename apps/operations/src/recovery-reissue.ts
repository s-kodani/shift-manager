import {z} from 'zod';
import {recoveryReissue,reissueFingerprint,recoveryReissueReceipt} from '../../../scripts/recovery-reissue-contract.mjs';
import {RecoverySecurityError} from './recovery-security';
type Database=Pick<D1Database,'prepare'|'batch'>;
type ReissueEnv={DB:Database;OPERATOR_PRINCIPAL:string;RECOVERY_DATABASE_ID:string;RECOVERY_SECURITY_ID:string};
const frozenSql=`SELECT mode,revision,maintenance_id,updated_at,
 (SELECT count(*) FROM maintenance_lease) AS leases,
 (SELECT count(*) FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING')) AS jobs,
 (SELECT count(*) FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING')) AS checks
 FROM maintenance_state WHERE id=1`;
const frozen=z.object({mode:z.literal('FROZEN'),revision:z.number().int(),maintenance_id:z.string().uuid(),updated_at:z.number(),leases:z.literal(0),jobs:z.literal(0),checks:z.literal(0)});
const restoredUser=z.object({id:z.string(),email:z.string(),emailVerified:z.number(),role:z.string().nullable(),banned:z.number().nullable(),banReason:z.string().nullable(),banExpires:z.union([z.string(),z.number()]).nullable()});
export async function inspectRecoveryReissue(db:Database,principal:string,id:string,restoreId:string){
 const r=await db.prepare('SELECT * FROM recovery_security_reissue_receipt WHERE id=? AND principal=? AND restore_id=?').bind(z.string().uuid().parse(id),principal,restoreId).first();
 return r?recoveryReissueReceipt.parse({found:true,...r,confirmations:JSON.parse(String(r.confirmations)),counts:JSON.parse(String(r.counts))}):{found:false as const};
}
export async function reissueRecoverySecurity(env:ReissueEnv,input:unknown){
 const c=recoveryReissue.parse(input),db=env.DB,fingerprint=await reissueFingerprint(c,env.RECOVERY_DATABASE_ID);
 if(!z.string().uuid().safeParse(env.RECOVERY_SECURITY_ID).success||c.restoreId!==env.RECOVERY_SECURITY_ID)throw new RecoverySecurityError('RECOVERY_TARGET_REQUIRED');
 if(c.sourceDatabaseId===env.RECOVERY_DATABASE_ID)throw new RecoverySecurityError('RECOVERY_SOURCE_IS_TARGET');
 if(new TextEncoder().encode(JSON.stringify(c)).length>900_000)throw new RecoverySecurityError('RECOVERY_REISSUE_LIMIT');
 const replay=async()=>{
  const r=await db.prepare('SELECT principal,fingerprint FROM recovery_security_reissue_receipt WHERE id=?').bind(c.operationId).first<{principal:string;fingerprint:string}>();
  if(!r)return null;
  if(r.principal!==env.OPERATOR_PRINCIPAL||r.fingerprint!==fingerprint)throw new RecoverySecurityError('RECOVERY_OPERATION_REUSED');
  return inspectRecoveryReissue(db,env.OPERATOR_PRINCIPAL,c.operationId,c.restoreId);
 };
 const previous=await replay();if(previous)return previous;
 if(await db.prepare('SELECT 1 FROM recovery_security_authorization WHERE restore_id=?').bind(c.restoreId).first()){const r=await replay();if(r)return r;throw new RecoverySecurityError('RECOVERY_ALREADY_RECONCILED');}
 const expiresAt=c.verifiedAt+900_000;
 if(c.verifiedAt>Date.now()||expiresAt<=Date.now())throw new RecoverySecurityError('RECOVERY_VERIFICATION_EXPIRED');
 const observed=await db.batch([db.prepare(frozenSql),
  db.prepare('SELECT id,email,emailVerified,role,banned,banReason,banExpires FROM user ORDER BY id LIMIT 2001'),
  db.prepare('SELECT (SELECT count(*) FROM session) AS sessions,(SELECT count(*) FROM verification) AS tokens'),
  db.prepare("SELECT count(*) AS n FROM account WHERE providerId<>'credential'"),
  db.prepare('SELECT password FROM account WHERE password IS NOT NULL LIMIT 2001'),
 ]);
 const state=frozen.safeParse(observed[0].results[0]);
 if(!state.success||state.data.revision!==c.expectedRevision||state.data.maintenance_id!==c.maintenanceId){const r=await replay();if(r)return r;throw new RecoverySecurityError('RECOVERY_TARGET_NOT_FROZEN');}
 if(c.verifiedAt<state.data.updated_at)throw new RecoverySecurityError('RECOVERY_VERIFICATION_PREDATES_RESTORE');
 if(!z.object({n:z.literal(0)}).safeParse(observed[3].results[0]).success)throw new RecoverySecurityError('RECOVERY_ACCOUNT_PROVIDER_UNSUPPORTED');
 if(observed[1].results.length>2000||observed[4].results.length>2000)throw new RecoverySecurityError('RECOVERY_RESTORED_IDENTITY_LIMIT');
 const restored=z.array(restoredUser).max(2000).parse(observed[1].results),known=new Set(restored.map(u=>u.id));
 if(c.identities.some(u=>!known.has(u.userId)))throw new RecoverySecurityError('RECOVERY_UNKNOWN_IDENTITY');
 const oldHashes=new Set(z.array(z.object({password:z.string()})).max(2000).parse(observed[4].results).map(r=>r.password));
 if(c.identities.some(u=>oldHashes.has(u.passwordHash)))throw new RecoverySecurityError('RECOVERY_OLD_CREDENTIAL');
 const confirmed=new Map(c.identities.map(u=>[u.userId,u])),at=new Date().toISOString();
 const users=restored.map(u=>confirmed.has(u.id)?{...u,email:confirmed.get(u.id)!.email,emailVerified:0,role:'user',banned:0,banReason:null,banExpires:null}:{...u,role:'user',banned:1,banReason:'Recovery authority not confirmed',banExpires:null});
 const access=restored.map(u=>({user_id:u.id,enabled:confirmed.has(u.id)?1:0,must_change_password:1}));
 const accounts=c.identities.map(u=>({id:u.accountId,accountId:u.userId,userId:u.userId,providerId:'credential',password:u.passwordHash,createdAt:at,updatedAt:at,
  accessToken:null,refreshToken:null,idToken:null,accessTokenExpiresAt:null,refreshTokenExpiresAt:null,scope:null}));
 const admins=c.identities.flatMap(u=>u.companyAdminIds.map(company_id=>({company_id,user_id:u.userId})));
 const members=c.identities.flatMap(u=>u.memberships.map(m=>({company_id:m.companyId,team_id:m.teamId,user_id:u.userId,role:m.role,staff_id:m.staffId})));
 const confirmations=c.identities.map(({userId,identityEvidenceRef,authorityEvidenceRef})=>({userId,identityEvidenceRef,authorityEvidenceRef}));
 const n=z.object({sessions:z.number().int(),tokens:z.number().int()}).parse(observed[2].results[0]);
 const counts={restoredUsers:restored.length,confirmedUsers:c.identities.length,removedSessions:n.sessions,removedResetTokens:n.tokens};
 const guard=`SELECT CASE WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='FROZEN' AND revision=? AND maintenance_id=?)
  AND NOT EXISTS(SELECT 1 FROM maintenance_lease)
  AND NOT EXISTS(SELECT 1 FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING'))
  AND NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING'))
  AND NOT EXISTS(SELECT 1 FROM recovery_security_authorization WHERE restore_id=?)
  AND NOT EXISTS(SELECT 1 FROM account WHERE providerId<>'credential')
  AND NOT EXISTS(SELECT 1 FROM account a JOIN json_each(?) j ON a.password=json_extract(j.value,'$.passwordHash'))
  AND ?>CAST(strftime('%s','now') AS INTEGER)*1000+1000
  THEN 1 ELSE abs(-9223372036854775808) END AS admitted`;
 const statements=[db.prepare(guard).bind(c.expectedRevision,c.maintenanceId,c.restoreId,JSON.stringify(c.identities),expiresAt),db.prepare('DELETE FROM session'),db.prepare('DELETE FROM verification'),
  db.prepare(`UPDATE user SET (email,emailVerified,role,banned,banReason,banExpires)=(SELECT json_extract(j.value,'$.email'),json_extract(j.value,'$.emailVerified'),json_extract(j.value,'$.role'),json_extract(j.value,'$.banned'),json_extract(j.value,'$.banReason'),json_extract(j.value,'$.banExpires') FROM json_each(?) j WHERE json_extract(j.value,'$.id')=user.id)`).bind(JSON.stringify(users))];
 function compare(table:string,columns:string[],rows:unknown[]){
  const sql=`SELECT ${columns.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`;
  statements.push(db.prepare(`WITH expected AS (${sql}),actual AS (SELECT ${columns.join(',')} FROM ${table})
   SELECT CASE WHEN NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected) AND NOT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual)
   THEN 1 ELSE abs(-9223372036854775808) END AS matched`).bind(JSON.stringify(rows)));
 }
 function replace(table:string,columns:string[],rows:unknown[]){
  statements.push(db.prepare(`DELETE FROM ${table}`),db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(rows)));compare(table,columns,rows);
 }
 compare('user',['id','email','emailVerified','role','banned','banReason','banExpires'],users);
 replace('account',['id','accountId','userId','providerId','password','createdAt','updatedAt','accessToken','refreshToken','idToken','accessTokenExpiresAt','refreshTokenExpiresAt','scope'],accounts);
 replace('access_state',['user_id','enabled','must_change_password'],access);
 replace('company_admin',['company_id','user_id'],admins);
 replace('team_member',['company_id','team_id','user_id','role','staff_id'],members);
 replace('membership',['user_id','tenant_id','team_id','role','staff_id'],[]);
 const now=Date.now();
 statements.push(db.prepare("UPDATE maintenance_state SET revision=revision+1,last_operation_id=?,updated_at=? WHERE id=1 AND mode='FROZEN' AND revision=? AND maintenance_id=?").bind(c.operationId,now,c.expectedRevision,c.maintenanceId),
  db.prepare('INSERT INTO recovery_security_reissue_receipt(id,restore_id,principal,fingerprint,backup_id,source_database_id,isolation_evidence_ref,verified_at,maintenance_id,revision,reason,created_at,confirmations,counts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(c.operationId,c.restoreId,env.OPERATOR_PRINCIPAL,fingerprint,c.backupId,c.sourceDatabaseId,c.isolationEvidenceRef,c.verifiedAt,c.maintenanceId,c.expectedRevision+1,c.reason,now,JSON.stringify(confirmations),JSON.stringify(counts)),
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM recovery_security_reissue_receipt r JOIN maintenance_state s ON s.id=1
   WHERE r.id=? AND r.restore_id=? AND s.mode='FROZEN' AND s.last_operation_id=r.id AND s.revision=r.revision)
   AND NOT EXISTS(SELECT 1 FROM session) AND NOT EXISTS(SELECT 1 FROM verification)
   THEN 1 ELSE abs(-9223372036854775808) END AS committed`).bind(c.operationId,c.restoreId));
 try{await db.batch(statements);}catch{const r=await replay();if(r)return r;throw new RecoverySecurityError('RECOVERY_REISSUE_UNAVAILABLE',503);}
 const r=await replay();if(!r)throw new RecoverySecurityError('RECOVERY_REISSUE_UNAVAILABLE',503);return r;
}
