export const BACKUP_BUCKET: string;
export const ACCOUNT_ID: string;
export const UUID: RegExp;
export const RETENTION_MS: number;
export const MAX_AGE_MS: number;
export const MAX_ARCHIVE_BYTES: number;
export interface RemoteBackupMarker {
  version:'shift-remote-backup-v1'; id:string; bucket:string;
  source:{mode:'local'|'remote';databaseId:string;bucket:string};
  createdAt:number;completedAt:number;publishedAt:number;expiresAt:number;
  sqlSha256:string;manifestSha256:string;
  archive:{sha256:string;bytes:number};counts:{tables:number;objects:number};
}
export function archiveKey(id:string):string;
export function markerKey(id:string):string;
export function validateMarker(value:unknown,options?:{id?:string;now?:number;allowExpired?:boolean}):RemoteBackupMarker;
