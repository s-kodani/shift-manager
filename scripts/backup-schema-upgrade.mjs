// Explicit, operator-owned local migration rehearsal. Never changes the backup.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,open,lstat,realpath} from 'node:fs/promises';
import {save,command,restoredTarget,verifyRestoreContents} from './backup-lib.mjs';
import {FINAL_RECOVERY_KIND,assertFinalRecoveryCurrentSource} from './final-recovery-profile.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const migrationRoot=path.resolve('infra/migrations');
const ownerFile=(dir,p)=>path.join(dir,'schema-upgrade-'+p.rehearsalId+'.json');
const workDirectory=(dir,p)=>path.join(dir,'schema-upgrade-'+p.rehearsalId);
async function privateBytes(file,limit=128_000_000){
 assert.equal(await realpath(file),file,'UPGRADE_SYMLINK');const s=await lstat(file);
 assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=limit,'UPGRADE_PRIVATE_FILE_REQUIRED');return readFile(file);
}
async function privateWork(work){
 assert.equal(await realpath(work),work,'UPGRADE_SYMLINK');const s=await lstat(work);
 assert(s.isDirectory()&&(s.mode&0o077)===0,'UPGRADE_PRIVATE_DIRECTORY_REQUIRED');
 for(const name of ['upgrade.sql','expected.sql'])try{await privateBytes(path.join(work,name));}catch(e){if(e.code!=='ENOENT')throw e;}
}
export async function rehearseSchemaUpgrade(source,work,appliedAt){
 await mkdir(work,{mode:0o700});await privateWork(work);
 return JSON.parse(await command('schema-rehearsal',['scripts/backup-schema-upgrade.py',source,migrationRoot,path.join(work,'upgrade.sql'),path.join(work,'expected.sql'),appliedAt],{python:true}));
}
async function context(id,profileFile){
 const c=await restoredTarget(id,profileFile);assert(c.p.mode==='local'||c.p.kind===FINAL_RECOVERY_KIND,'UPGRADE_LOCAL_OR_FROZEN_FINAL_ONLY');return c;
}
async function readOwner(c){
 const file=ownerFile(c.dir,c.p),owner=JSON.parse(await privateBytes(file,8_000_000)),w=workDirectory(c.dir,c.p);
 assert.equal(owner.version,'restore-schema-upgrade-v1');assert.equal(owner.backupId,c.manifest.id);assert.equal(owner.backupSqlSha256,c.manifest.sql.sha256);
 assert.equal(owner.rehearsalId,c.p.rehearsalId);assert.equal(owner.databaseId,c.p.databaseId);assert.equal(owner.bucket,c.p.bucket);assert.deepEqual(owner.targetIdentity,c.p.targetIdentity,'UPGRADE_TARGET_CHANGED');
 assert(['PREPARED','DISPATCHED','UNCERTAIN','APPLIED','VERIFIED'].includes(owner.stage),'UPGRADE_STAGE_INVALID');
 assert.equal(owner.plan.version,'restore-schema-plan-v1');assert(owner.plan.fromVersion>=27&&owner.plan.fromVersion<=34&&owner.plan.toVersion===34);
 assert.equal(owner.plan.bundleSha256,sha(await privateBytes(path.join(w,'upgrade.sql'))),'UPGRADE_BUNDLE_CHANGED');
 assert.equal(owner.plan.expectedSqlSha256,sha(await privateBytes(path.join(w,'expected.sql'))),'UPGRADE_EXPECTATION_CHANGED');
 const names=(await readdir(migrationRoot)).filter(n=>n.endsWith('.sql')).sort();assert.deepEqual(names,owner.plan.migrations.map(m=>m.name),'UPGRADE_MIGRATIONS_CHANGED');
 for(const m of owner.plan.migrations)assert.equal(sha(await readFile(path.join(migrationRoot,m.name))),m.sha256,'UPGRADE_MIGRATIONS_CHANGED');
 // Rebuild the expectation from the immutable original, never from the target
 // under test or a caller-edited catalog in the receipt.
 const fresh=path.join(w,'verify-plan');await mkdir(fresh,{recursive:true,mode:0o700});await privateWork(fresh);
 const plan=JSON.parse(await command('schema-plan-recheck',['scripts/backup-schema-upgrade.py',path.join(c.dir,'database.sql'),migrationRoot,path.join(fresh,'upgrade.sql'),path.join(fresh,'expected.sql'),owner.plan.appliedAt],{python:true}));
 assert.deepEqual(plan,owner.plan,'UPGRADE_PLAN_CHANGED');return {file,owner,w};
}
export async function prepareSchemaUpgrade(id,profileFile){
 const c=await context(id,profileFile),file=ownerFile(c.dir,c.p);
 assertFinalRecoveryCurrentSource(c.p);
 // Preparation is never an implicit resume or a replacement operation.
 const h=await open(file,'wx',0o600);await h.close();
 try{
  await verifyRestoreContents(c.p,c.manifest.catalog,path.join(c.dir,'verified-'+c.p.rehearsalId));
  const createdAt=Date.now(),appliedAt=new Date(createdAt).toISOString().slice(0,19).replace('T',' '),
   plan=await rehearseSchemaUpgrade(path.join(c.dir,'database.sql'),workDirectory(c.dir,c.p),appliedAt),
   owner={version:'restore-schema-upgrade-v1',backupId:id,backupSqlSha256:c.manifest.sql.sha256,rehearsalId:c.p.rehearsalId,databaseId:c.p.databaseId,bucket:c.p.bucket,targetIdentity:c.p.targetIdentity,createdAt,stage:'PREPARED',plan};
  await save(file,owner);return {rehearsalId:c.p.rehearsalId,stage:'PREPARED',fromVersion:plan.fromVersion,toVersion:plan.toVersion};
 }catch{throw new Error('UPGRADE_PREPARATION_FAILED_KEEP_SAME_TARGET');}
}
function assertProducerSettled(owner){
 if(owner.stage!=='DISPATCHED')return;
 assert(Number.isSafeInteger(owner.producerPid)&&owner.producerPid>0,'UPGRADE_PRODUCER_UNKNOWN');
 try{process.kill(owner.producerPid,0);}catch(e){if(e.code==='ESRCH')return;throw new Error('UPGRADE_PRODUCER_UNKNOWN');}
 throw new Error('UPGRADE_PRODUCER_STILL_LIVE');
}
export async function verifySchemaUpgrade(id,profileFile){
 const c=await context(id,profileFile),{file,owner,w}=await readOwner(c);
 assert(owner.stage!=='PREPARED','UPGRADE_NOT_DISPATCHED');assertProducerSettled(owner);
 const result=await verifyRestoreContents(c.p,owner.plan.catalog,path.join(w,'observed'));
 owner.stage='VERIFIED';owner.verifiedAt=result.at;await save(file,owner);
 return {...result,rehearsalId:c.p.rehearsalId,stage:'VERIFIED',fromVersion:owner.plan.fromVersion,toVersion:owner.plan.toVersion};
}
export async function applySchemaUpgrade(id,profileFile){
 const c=await context(id,profileFile),{file,owner,w}=await readOwner(c);assert.equal(owner.stage,'PREPARED','UPGRADE_INSPECT_SAME_TARGET_DO_NOT_RESEND');
 assertFinalRecoveryCurrentSource(c.p);
 await verifyRestoreContents(c.p,c.manifest.catalog,path.join(w,'before-dispatch'));
 owner.stage='DISPATCHED';owner.dispatchedAt=Date.now();owner.producerPid=process.pid;await save(file,owner);
 try{
  if(owner.plan.fromVersion!==owner.plan.toVersion)await command('schema-upgrade',['d1','execute','DB',...c.p.flags,'--file',path.join(w,'upgrade.sql'),'--yes']);
  owner.stage='APPLIED';owner.producerSettledAt=Date.now();await save(file,owner);
 }catch{
  owner.stage='UNCERTAIN';owner.producerSettledAt=Date.now();await save(file,owner);throw new Error('UPGRADE_OUTCOME_UNKNOWN_VERIFY_SAME_TARGET');
 }
 return verifySchemaUpgrade(id,profileFile);
}
export async function verifyPreAuthRestore(id,profileFile){
 // Even current-schema copies receive a no-op reviewed plan: ledger/schema
 // consistency and original-content proof cannot be bypassed by its version.
 const result=await verifySchemaUpgrade(id,profileFile);return {...result,backupId:id};
}
