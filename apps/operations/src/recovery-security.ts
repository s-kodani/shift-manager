import {z} from 'zod';
import {recoveryCheckpoint,recoveryCheckpointRequest,recoveryDigest,recoveryReconcile,recoveryUsers,recoveryFingerprint} from '../../../scripts/recovery-security-contract.mjs';
type Database=Pick<D1Database,'prepare'|'batch'>;
type RecoveryEnv={DB:Database;OPERATOR_PRINCIPAL:string;RECOVERY_DATABASE_ID:string;RECOVERY_SECURITY_ID:string};
export class RecoverySecurityError extends Error{constructor(public code:string,public status:409|503=409){super(code);}}
const frozenSql=`SELECT mode,revision,maintenance_id,updated_at,
 (SELECT count(*) FROM maintenance_lease) AS leases,
 (SELECT count(*) FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING')) AS jobs,
 (SELECT count(*) FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING')) AS checks
 FROM maintenance_state WHERE id=1`;
const frozen=z.object({mode:z.literal('FROZEN'),revision:z.number().int(),maintenance_id:z.string().uuid(),updated_at:z.number(),leases:z.literal(0),jobs:z.literal(0),checks:z.literal(0)});
const usersSql='SELECT id,email,emailVerified,role,banned,banReason,banExpires FROM user ORDER BY id LIMIT 2001';
export async function securityCheckpoint(env:RecoveryEnv,input:unknown){
 const c=recoveryCheckpointRequest.parse(input);
 if(env.RECOVERY_SECURITY_ID&&!await env.DB.prepare('SELECT 1 FROM recovery_security_authorization WHERE restore_id=?').bind(env.RECOVERY_SECURITY_ID).first())throw new RecoverySecurityError('RECOVERY_SOURCE_UNRECONCILED');
 const rows=await env.DB.batch([
  env.DB.prepare(frozenSql),env.DB.prepare(usersSql),
  env.DB.prepare("SELECT id,accountId,userId,password,createdAt,updatedAt FROM account WHERE providerId='credential' ORDER BY userId,id LIMIT 2001"),
  env.DB.prepare('SELECT user_id,enabled,must_change_password FROM access_state ORDER BY user_id LIMIT 2001'),
  env.DB.prepare('SELECT company_id,user_id FROM company_admin ORDER BY company_id,user_id LIMIT 8001'),
  env.DB.prepare('SELECT company_id,team_id,user_id,role,staff_id FROM team_member ORDER BY company_id,team_id,user_id LIMIT 8001'),
  env.DB.prepare('SELECT user_id,tenant_id,team_id,role,staff_id FROM membership ORDER BY user_id,tenant_id,team_id LIMIT 8001'),
  env.DB.prepare("SELECT count(*) AS n FROM account WHERE providerId<>'credential'"),
 ]);
 const state=frozen.safeParse(rows[0].results[0]);
 if(!state.success||state.data.revision!==c.expectedRevision||state.data.maintenance_id!==c.maintenanceId)throw new RecoverySecurityError('RECOVERY_SOURCE_NOT_FROZEN');
 if(z.object({n:z.literal(0)}).safeParse(rows[7].results[0]).success===false)throw new RecoverySecurityError('RECOVERY_ACCOUNT_PROVIDER_UNSUPPORTED');
 const capturedAt=Date.now();
 const checkpoint=recoveryCheckpoint.parse({schema:'recovery-security-checkpoint-v1',sourceDatabaseId:env.RECOVERY_DATABASE_ID,maintenanceId:c.maintenanceId,revision:c.expectedRevision,capturedAt,expiresAt:capturedAt+15*60*1000,
  users:rows[1].results,accounts:rows[2].results,access:rows[3].results,admins:rows[4].results,members:rows[5].results,legacy:rows[6].results});
 if(new TextEncoder().encode(JSON.stringify(checkpoint)).length>900_000)throw new RecoverySecurityError('RECOVERY_CHECKPOINT_LIMIT');
 return {checkpoint,checkpointSha256:await recoveryDigest(checkpoint)};
}
export async function inspectRecoverySecurity(db:Database,principal:string,id:string,restoreId?:string){
 const row=await db.prepare('SELECT * FROM recovery_security_receipt WHERE id=? AND principal=? AND (? IS NULL OR restore_id=?)').bind(z.string().uuid().parse(id),principal,restoreId??null,restoreId??null).first();
 return row?{found:true as const,...row,counts:JSON.parse(String(row.counts))}:{found:false as const};
}
export async function reconcileRecoverySecurity(env:RecoveryEnv,input:unknown){
 const c=recoveryReconcile.parse(input),fingerprint=await recoveryFingerprint(c,env.RECOVERY_DATABASE_ID),db=env.DB;
 if(!z.string().uuid().safeParse(env.RECOVERY_SECURITY_ID).success||c.restoreId!==env.RECOVERY_SECURITY_ID)throw new RecoverySecurityError('RECOVERY_TARGET_REQUIRED');
 if(new TextEncoder().encode(JSON.stringify(c.checkpoint)).length>900_000)throw new RecoverySecurityError('RECOVERY_CHECKPOINT_LIMIT');
 const replay=async()=>{
  const row=await db.prepare('SELECT principal,fingerprint FROM recovery_security_receipt WHERE id=?').bind(c.operationId).first<{principal:string;fingerprint:string}>();
  if(!row)return null;
  if(row.principal!==env.OPERATOR_PRINCIPAL||row.fingerprint!==fingerprint)throw new RecoverySecurityError('RECOVERY_OPERATION_REUSED');
  return inspectRecoverySecurity(db,env.OPERATOR_PRINCIPAL,c.operationId,c.restoreId);
 };
 const previous=await replay();if(previous)return previous;
 if(await db.prepare('SELECT 1 FROM recovery_security_authorization WHERE restore_id=?').bind(c.restoreId).first()){const r=await replay();if(r)return r;throw new RecoverySecurityError('RECOVERY_ALREADY_RECONCILED');}
 if(c.checkpoint.sourceDatabaseId===env.RECOVERY_DATABASE_ID)throw new RecoverySecurityError('RECOVERY_SOURCE_IS_TARGET');
 if(await recoveryDigest(c.checkpoint)!==c.checkpointSha256)throw new RecoverySecurityError('RECOVERY_CHECKPOINT_HASH');
 if(c.checkpoint.capturedAt>Date.now()||c.checkpoint.expiresAt<=Date.now())throw new RecoverySecurityError('RECOVERY_CHECKPOINT_EXPIRED');
 const observed=await db.batch([db.prepare(frozenSql),db.prepare(usersSql),db.prepare('SELECT (SELECT count(*) FROM session) AS sessions,(SELECT count(*) FROM verification) AS tokens'),db.prepare("SELECT count(*) AS n FROM account WHERE providerId<>'credential'")]);
 if(!z.object({n:z.literal(0)}).safeParse(observed[3].results[0]).success)throw new RecoverySecurityError('RECOVERY_ACCOUNT_PROVIDER_UNSUPPORTED');
 const state=frozen.safeParse(observed[0].results[0]);
 if(!state.success||state.data.revision!==c.expectedRevision||state.data.maintenance_id!==c.maintenanceId){const r=await replay();if(r)return r;throw new RecoverySecurityError('RECOVERY_TARGET_NOT_FROZEN');}
 if(c.checkpoint.capturedAt<state.data.updated_at)throw new RecoverySecurityError('RECOVERY_CHECKPOINT_PREDATES_RESTORE');
 const restored=recoveryUsers.parse(observed[1].results),known=new Set(restored.map(u=>u.id)),source=new Map(c.checkpoint.users.map(u=>[u.id,u]));
 const users=restored.map(u=>source.get(u.id)??{...u,role:'user',banned:1,banReason:'Recovery authority not confirmed',banExpires:null});
 const accessMap=new Map(c.checkpoint.access.map(a=>[a.user_id,a]));
 const access=restored.map(u=>accessMap.get(u.id)??{user_id:u.id,enabled:0,must_change_password:1});
 const accounts=c.checkpoint.accounts.filter(a=>known.has(a.userId)).map(a=>({...a,providerId:'credential',accessToken:null,refreshToken:null,idToken:null,accessTokenExpiresAt:null,refreshTokenExpiresAt:null,scope:null}));
 const admins=c.checkpoint.admins.filter(a=>known.has(a.user_id)),members=c.checkpoint.members.filter(a=>known.has(a.user_id)),legacy=c.checkpoint.legacy.filter(a=>known.has(a.user_id));
 const tokenCounts=z.object({sessions:z.number().int().nonnegative(),tokens:z.number().int().nonnegative()}).parse(observed[2].results[0]);
 const counts={restoredUsers:restored.length,confirmedUsers:users.filter(u=>source.has(u.id)).length,removedSessions:tokenCounts.sessions,removedResetTokens:tokenCounts.tokens};
 const guard=`SELECT CASE WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='FROZEN' AND revision=? AND maintenance_id=?)
  AND NOT EXISTS(SELECT 1 FROM maintenance_lease)
  AND NOT EXISTS(SELECT 1 FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING'))
  AND NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING'))
  AND ?>CAST(strftime('%s','now') AS INTEGER)*1000+1000
  THEN 1 ELSE abs(-9223372036854775808) END AS admitted`;
 const statements=[db.prepare(guard).bind(c.expectedRevision,c.maintenanceId,c.checkpoint.expiresAt),
  db.prepare('DELETE FROM session'),db.prepare('DELETE FROM verification'),
  db.prepare(`UPDATE user SET (email,emailVerified,role,banned,banReason,banExpires)=(SELECT json_extract(j.value,'$.email'),json_extract(j.value,'$.emailVerified'),json_extract(j.value,'$.role'),json_extract(j.value,'$.banned'),json_extract(j.value,'$.banReason'),json_extract(j.value,'$.banExpires') FROM json_each(?) j WHERE json_extract(j.value,'$.id')=user.id)`).bind(JSON.stringify(users))];
 // Columns/table names are fixed in code. Only JSON values are bound. Each
 // replacement and its independent set comparison share the same D1 batch.
 function replace(table:string,columns:string[],rows:unknown[]){
  const sql=`SELECT ${columns.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`;
  statements.push(db.prepare(`DELETE FROM ${table}`),db.prepare(`INSERT INTO ${table}(${columns.join(',')}) ${sql}`).bind(JSON.stringify(rows)));
  compare(table,columns,rows);
 }
 function compare(table:string,columns:string[],rows:unknown[]){
  const sql=`SELECT ${columns.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`;
  statements.push(db.prepare(`WITH expected AS (${sql}), actual AS (SELECT ${columns.join(',')} FROM ${table})
   SELECT CASE WHEN NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected)
   AND NOT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual)
   THEN 1 ELSE abs(-9223372036854775808) END AS matched`).bind(JSON.stringify(rows)));
 }
 compare('user',['id','email','emailVerified','role','banned','banReason','banExpires'],users);
 replace('account',['id','accountId','userId','password','createdAt','updatedAt','providerId','accessToken','refreshToken','idToken','accessTokenExpiresAt','refreshTokenExpiresAt','scope'],accounts);
 replace('access_state',['user_id','enabled','must_change_password'],access);
 replace('company_admin',['company_id','user_id'],admins);
 replace('team_member',['company_id','team_id','user_id','role','staff_id'],members);
 replace('membership',['user_id','tenant_id','team_id','role','staff_id'],legacy);
 const now=Date.now();
 statements.push(
  db.prepare('UPDATE maintenance_state SET revision=revision+1,last_operation_id=?,updated_at=? WHERE id=1 AND mode=\'FROZEN\' AND revision=? AND maintenance_id=?').bind(c.operationId,now,c.expectedRevision,c.maintenanceId),
  db.prepare(`INSERT INTO recovery_security_receipt(id,restore_id,principal,fingerprint,source_database_id,source_maintenance_id,source_revision,source_captured_at,source_sha256,maintenance_id,revision,reason,created_at,counts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(c.operationId,c.restoreId,env.OPERATOR_PRINCIPAL,fingerprint,c.checkpoint.sourceDatabaseId,c.checkpoint.maintenanceId,c.checkpoint.revision,c.checkpoint.capturedAt,c.checkpointSha256,c.maintenanceId,c.expectedRevision+1,c.reason,now,JSON.stringify(counts)),
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM recovery_security_receipt r JOIN maintenance_state s ON s.id=1
   WHERE r.id=? AND r.restore_id=? AND s.mode='FROZEN' AND s.last_operation_id=r.id AND s.revision=r.revision)
   AND NOT EXISTS(SELECT 1 FROM session) AND NOT EXISTS(SELECT 1 FROM verification)
   THEN 1 ELSE abs(-9223372036854775808) END AS committed`).bind(c.operationId,c.restoreId));
 try{await db.batch(statements);}catch{
  const r=await replay();if(r)return r;
  throw new RecoverySecurityError('RECOVERY_RECONCILIATION_UNAVAILABLE',503);
 }
 const r=await replay();if(!r)throw new RecoverySecurityError('RECOVERY_RECONCILIATION_UNAVAILABLE',503);return r;
}
