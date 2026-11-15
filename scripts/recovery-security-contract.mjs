import {z} from 'zod';
const id=z.string().min(1).max(128),uuid=z.string().uuid(),bit=z.union([z.literal(0),z.literal(1)]),integer=z.number().int().nonnegative();
const date=z.union([z.string().min(1).max(40),z.number().int()]);
const user=z.object({id,email:z.email().max(254),emailVerified:bit,role:z.literal('user').nullable(),banned:bit.nullable(),banReason:z.string().max(1000).nullable(),banExpires:date.nullable()}).strict();
const account=z.object({id,accountId:id,userId:id,password:z.string().min(12).max(1024).nullable(),createdAt:date,updatedAt:date}).strict();
const access=z.object({user_id:id,enabled:bit,must_change_password:bit}).strict();
const admin=z.object({company_id:uuid,user_id:id}).strict();
const member=z.object({company_id:uuid,team_id:uuid,user_id:id,role:z.enum(['team_admin','staff']),staff_id:uuid.nullable()}).strict();
const legacy=z.object({user_id:id,tenant_id:id,team_id:id,role:z.enum(['company_admin','team_admin','staff']),staff_id:id.nullable()}).strict();
export const recoveryUsers=z.array(user).max(2000);
export const recoveryCheckpointRequest=z.object({maintenanceId:uuid,expectedRevision:integer}).strict();
export const recoveryCheckpoint=z.object({schema:z.literal('recovery-security-checkpoint-v1'),sourceDatabaseId:uuid,maintenanceId:uuid,revision:integer,capturedAt:integer,expiresAt:integer,
 users:recoveryUsers,accounts:z.array(account).max(2000),access:z.array(access).max(2000),admins:z.array(admin).max(8000),members:z.array(member).max(8000),legacy:z.array(legacy).max(8000)}).strict().superRefine((s,c)=>{
 const unique=(rows,key)=>{const keys=rows.map(key);if(new Set(keys).size!==keys.length)c.addIssue({code:'custom',message:'DUPLICATE_SECURITY_ID'});};
 unique(s.users,u=>u.id);unique(s.users,u=>u.email);unique(s.accounts,a=>a.id);unique(s.accounts,a=>a.userId);unique(s.access,a=>a.user_id);
 unique(s.admins,a=>JSON.stringify([a.company_id,a.user_id]));unique(s.members,a=>JSON.stringify([a.company_id,a.team_id,a.user_id]));unique(s.legacy,a=>JSON.stringify([a.user_id,a.tenant_id,a.team_id]));
 const known=new Set(s.users.map(u=>u.id));for(const rows of [s.accounts,s.access,s.admins,s.members,s.legacy])for(const row of rows){if(!known.has('userId' in row?row.userId:row.user_id))c.addIssue({code:'custom',message:'UNKNOWN_SECURITY_USER'});}
 if(s.accounts.some(a=>a.accountId!==a.userId))c.addIssue({code:'custom',message:'INVALID_CREDENTIAL_ACCOUNT'});
 if(s.expiresAt!==s.capturedAt+15*60*1000)c.addIssue({code:'custom',message:'INVALID_CHECKPOINT_EXPIRY'});
});
export const recoveryReconcile=z.object({operationId:uuid,restoreId:uuid,maintenanceId:uuid,expectedRevision:integer,reason:z.string().trim().min(1).max(500),checkpoint:recoveryCheckpoint,checkpointSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const recoveryReceipt=z.object({found:z.literal(true),id:uuid,restore_id:uuid,principal:z.string().min(1).max(128),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),source_database_id:uuid,source_maintenance_id:uuid,source_revision:integer,source_captured_at:integer,source_sha256:z.string().regex(/^[a-f0-9]{64}$/),maintenance_id:uuid,revision:integer,reason:z.string(),created_at:integer,counts:z.object({restoredUsers:integer,confirmedUsers:integer,removedSessions:integer,removedResetTokens:integer}).strict()}).strict();
export async function recoveryDigest(value){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');}
export async function recoveryFingerprint(input,targetDatabaseId){return recoveryDigest({targetDatabaseId:uuid.parse(targetDatabaseId),...recoveryReconcile.parse(input)});}
