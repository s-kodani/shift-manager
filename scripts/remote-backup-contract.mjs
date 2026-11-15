import {deploymentTarget} from './deployment-target.mjs';
export const BACKUP_BUCKET=deploymentTarget.backupBucket;
export const ACCOUNT_ID=deploymentTarget.accountId;
export const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const RETENTION_MS=30*24*60*60*1000;
export const MAX_AGE_MS=24*60*60*1000;
// Wrangler's remote R2 object put is limited to 300 MiB (v4.149.0).
export const MAX_ARCHIVE_BYTES=300*1024*1024;
const sha=/^[a-f0-9]{64}$/;
const validSha=value=>typeof value==='string'&&sha.test(value);
const requireValid=(condition)=>{if(!condition)throw new Error('INVALID_REMOTE_BACKUP_MARKER');};
export function archiveKey(id){requireValid(typeof id==='string'&&UUID.test(id));return 'recovery/data/'+id+'.zip';}
export function markerKey(id){requireValid(typeof id==='string'&&UUID.test(id));return 'recovery/complete/'+id+'.json';}
export function validateMarker(value,{id,now=Date.now(),allowExpired=false}={}){
  requireValid(value!==null&&typeof value==='object'&&!Array.isArray(value));
  requireValid(value.version==='shift-remote-backup-v1'&&value.bucket===BACKUP_BUCKET&&typeof value.id==='string'&&UUID.test(value.id));
  if(id!==undefined)requireValid(value.id===id);
  for(const key of ['createdAt','completedAt','publishedAt','expiresAt'])requireValid(Number.isSafeInteger(value[key])&&value[key]>=0);
  requireValid(value.createdAt<=value.completedAt&&value.completedAt<=value.publishedAt&&value.publishedAt<=now+120_000);
  requireValid(value.expiresAt===value.completedAt+RETENTION_MS);
  if(!allowExpired)requireValid(value.expiresAt>now);
  requireValid(value.source&&typeof value.source==='object');
  const source=value.source;
  requireValid((source.mode==='remote'&&source.databaseId===deploymentTarget.databaseId&&source.bucket===deploymentTarget.inputBucket)||(source.mode==='local'&&source.databaseId==='00000000-0000-0000-0000-000000000000'&&source.bucket==='shift-planner-inputs-local'));
  requireValid(validSha(value.sqlSha256)&&validSha(value.manifestSha256));
  requireValid(value.archive&&validSha(value.archive.sha256)&&Number.isSafeInteger(value.archive.bytes)&&value.archive.bytes>0&&value.archive.bytes<=MAX_ARCHIVE_BYTES);
  requireValid(value.counts&&Number.isSafeInteger(value.counts.tables)&&value.counts.tables>0&&value.counts.tables<=1000&&Number.isSafeInteger(value.counts.objects)&&value.counts.objects>=0&&value.counts.objects<=50_000);
  return value;
}
