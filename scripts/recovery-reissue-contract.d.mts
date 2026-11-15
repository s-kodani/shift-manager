import type {z} from 'zod';
export type ReissueIdentity={userId:string;email:string;identityEvidenceRef:string;authorityEvidenceRef:string;companyAdminIds:string[];memberships:{companyId:string;teamId:string;role:'team_admin'|'staff';staffId:string|null}[]};
export type ReissueDetails={restoreId:string;maintenanceId:string;expectedRevision:number;backupId:string;sourceDatabaseId:string;sourceUnavailable:true;oldEnvironmentIsolated:true;isolationEvidenceRef:string;verifiedAt:number;reason:string;identities:ReissueIdentity[]};
export type ReissueCommand=Omit<ReissueDetails,'identities'>&{operationId:string;identities:(ReissueIdentity&{accountId:string;passwordHash:string})[]};
export const recoveryReissueDetails:z.ZodType<ReissueDetails>;
export const recoveryReissueVerification:z.ZodType<Pick<ReissueDetails,'sourceUnavailable'|'oldEnvironmentIsolated'|'isolationEvidenceRef'|'verifiedAt'|'reason'|'identities'>>;
export const recoveryReissue:z.ZodType<ReissueCommand>;
export function reissueFingerprint(input:unknown,targetDatabaseId:string):Promise<string>;
export const recoveryReissueReceipt:z.ZodType<{found:true;id:string;restore_id:string;principal:string;fingerprint:string;backup_id:string;source_database_id:string;isolation_evidence_ref:string;verified_at:number;maintenance_id:string;revision:number;reason:string;created_at:number;confirmations:{userId:string;identityEvidenceRef:string;authorityEvidenceRef:string}[];counts:{restoredUsers:number;confirmedUsers:number;removedSessions:number;removedResetTokens:number}}>;
