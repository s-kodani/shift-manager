import {z} from 'zod';
import {recoveryDigest} from './recovery-security-contract.mjs';
const uuid=z.string().uuid(),id=z.string().min(1).max(128),integer=z.number().int().nonnegative();
// Opaque case references only. Identity documents and free-form personal data
// belong to the operator's separate verification process, not the receipt.
const evidence=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const member=z.object({companyId:uuid,teamId:uuid,role:z.enum(['team_admin','staff']),staffId:uuid.nullable()}).strict();
const identity=z.object({userId:id,email:z.email().max(254).transform(x=>x.toLowerCase()),identityEvidenceRef:evidence,authorityEvidenceRef:evidence,
 companyAdminIds:z.array(uuid).max(100),memberships:z.array(member).max(100)}).strict();
const fields={restoreId:uuid,maintenanceId:uuid,expectedRevision:integer,backupId:uuid,sourceDatabaseId:uuid,
 sourceUnavailable:z.literal(true),oldEnvironmentIsolated:z.literal(true),isolationEvidenceRef:evidence,
 verifiedAt:integer,reason:z.string().trim().min(1).max(500)};
function uniqueIdentities(s,c){
 const unique=(values)=>{if(new Set(values).size!==values.length)c.addIssue({code:'custom',message:'DUPLICATE_REISSUE_ID'});};
 unique(s.identities.map(x=>x.userId));unique(s.identities.map(x=>x.email));
 for(const u of s.identities){unique(u.companyAdminIds);unique(u.memberships.map(m=>JSON.stringify([m.companyId,m.teamId])));
  if(u.memberships.some(m=>m.role==='staff'&&!m.staffId))c.addIssue({code:'custom',message:'STAFF_ID_REQUIRED'});
 }
 if(!s.identities.some(u=>u.companyAdminIds.length))c.addIssue({code:'custom',message:'CONFIRMED_COMPANY_ADMIN_REQUIRED'});
}
export const recoveryReissueDetails=z.object({...fields,identities:z.array(identity).min(1).max(2000)}).strict().superRefine(uniqueIdentities);
export const recoveryReissueVerification=z.object({sourceUnavailable:fields.sourceUnavailable,oldEnvironmentIsolated:fields.oldEnvironmentIsolated,
 isolationEvidenceRef:fields.isolationEvidenceRef,verifiedAt:fields.verifiedAt,reason:fields.reason,identities:z.array(identity).min(1).max(2000)}).strict().superRefine(uniqueIdentities);
export const recoveryReissue=z.object({operationId:uuid,...fields,identities:z.array(identity.extend({accountId:uuid,
 // CLI generates random temporary passwords locally. The API accepts only
 // pinned Better Auth native hashes and rejects hashes present in the backup.
 passwordHash:z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{128}$/)})).min(1).max(2000)}).strict().superRefine((s,c)=>{
 uniqueIdentities(s,c);
 for(const field of ['accountId','passwordHash'])if(new Set(s.identities.map(u=>u[field])).size!==s.identities.length)c.addIssue({code:'custom',message:'DUPLICATE_REISSUE_CREDENTIAL'});
});
export const recoveryReissueReceipt=z.object({found:z.literal(true),id:uuid,restore_id:uuid,principal:id,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
 backup_id:uuid,source_database_id:uuid,isolation_evidence_ref:evidence,verified_at:integer,maintenance_id:uuid,revision:integer,reason:z.string(),created_at:integer,
 confirmations:z.array(z.object({userId:id,identityEvidenceRef:evidence,authorityEvidenceRef:evidence}).strict()).min(1).max(2000),
 counts:z.object({restoredUsers:integer,confirmedUsers:integer,removedSessions:integer,removedResetTokens:integer}).strict()}).strict();
export async function reissueFingerprint(input,targetDatabaseId){return recoveryDigest({targetDatabaseId:uuid.parse(targetDatabaseId),...recoveryReissue.parse(input)});}
