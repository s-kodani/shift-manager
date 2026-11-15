import {requireDeploymentTarget,remoteWranglerArgs} from './deployment-target.mjs';
import {renderTargetConfigs} from './render-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod,stat,realpath,readdir,rm,open,rename} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {assertLocalFinalRecoveryDirectConfig} from './local-direct-config.mjs';
import {validateLocalRestoreProfile,assertFreshLocalRuntime} from './local-restore-profile.mjs';
import {validateFinalRecoveryProfile,FINAL_RECOVERY_KIND,assertFinalRecoveryCurrentSource} from './final-recovery-profile.mjs';

export const RETENTION_MS=30*24*60*60*1000;
const ROOT=path.resolve('.cache/backups'),UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest=b=>createHash('sha256').update(b).digest('hex');
async function syncDirectory(file){const handle=await open(path.dirname(file),'r');try{await handle.sync();}finally{await handle.close();}}
async function exclusiveSave(file,value){const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await syncDirectory(file);}
export async function save(file,value){
  const temporary=file+'.'+randomUUID()+'.tmp';await exclusiveSave(temporary,value);
  await rename(temporary,file);await syncDirectory(file);
}
export async function command(stage,args,{python=false}={}){
  let configDirectory;
  if(!python&&args.some(a=>/^--remote(?:=true)?$/.test(a))){requireDeploymentTarget();configDirectory=path.resolve('.cache/target-commands',randomUUID());args=remoteWranglerArgs(args,await renderTargetConfigs(configDirectory));}
  try{
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(python?'python3':process.execPath,python?args:['node_modules/wrangler/bin/wrangler.js',...args],{stdio:['ignore','pipe','pipe']});
    let out='',err='';p.stdout.on('data',b=>{out+=b;if(out.length>16_000_000)p.kill();});p.stderr.on('data',b=>{if(err.length<100_000)err+=b;});
    p.on('error',reject);p.on('close',code=>resolve({code,out,err}));
  });
  // Wrangler output can contain signed URLs, SQL rows or configuration values.
  // Never include it in terminal errors or committed evidence.
  if(result.code!==0){
    const logs=path.resolve('.cache/operations-diagnostics');await mkdir(logs,{recursive:true,mode:0o700});await chmod(logs,0o700);
    await writeFile(path.join(logs,Date.now()+'-'+randomUUID()+'.log'),result.out+'\n'+result.err,{mode:0o600});
    const failure=new Error('OPS_STAGE_FAILED:'+stage);
    if((result.out+'\n'+result.err).includes('The specified key does not exist'))failure.kind='OBJECT_NOT_FOUND';
    throw failure;
  }
  return result.out;
  }finally{if(configDirectory)await rm(configDirectory,{recursive:true,force:true});}
}
export async function sqlCatalog(file){return JSON.parse(await command('catalog',['scripts/backup-catalog.py',file],{python:true}));}
export async function prepareImport(file,target){return JSON.parse(await command('prepare-import',['scripts/backup-catalog.py','prepare-import',file,target],{python:true}));}
async function ownedDirectory(id,root=ROOT){
  assert(UUID.test(id),'INVALID_BACKUP_ID');const dir=path.join(path.resolve(root),id);
  assert.equal(await realpath(dir),dir,'SYMLINK_BACKUP_DIRECTORY');return dir;
}
export async function loadManifest(id,{root=ROOT}={}){
  const dir=await ownedDirectory(id,root);assert((await stat(path.join(dir,'manifest.json'))).size<8_000_000,'MANIFEST_TOO_LARGE');
  assert.equal(await realpath(path.join(dir,'manifest.json')),path.join(dir,'manifest.json'),'SYMLINK_BACKUP_MANIFEST');
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(manifest.version,'shift-backup-v1');assert.equal(manifest.id,id);assert.equal(manifest.state,'COMPLETE');
  assert(Number.isSafeInteger(manifest.createdAt)&&Number.isSafeInteger(manifest.completedAt));
  assert(manifest.createdAt>=0&&manifest.completedAt>=manifest.createdAt);
  assert.equal(manifest.retentionDays,30);assert.equal(manifest.expiresAt,manifest.completedAt+RETENTION_MS);
  return{dir,manifest};
}
export async function verifyBackup(id,options={}){
  const {dir,manifest}=await loadManifest(id,options);
  const sqlFile=path.join(dir,'database.sql');assert.equal(await realpath(sqlFile),sqlFile,'SYMLINK_BACKUP_SQL');
  assert((await stat(sqlFile)).size<=128_000_000,'EXPORT_TOO_LARGE_FOR_MVP_TOOL');
  const sql=await readFile(sqlFile);assert.equal(digest(sql),manifest.sql.sha256);assert.equal(sql.length,manifest.sql.bytes);
  const actual=await sqlCatalog(path.join(dir,'database.sql'));assert.deepEqual(actual,manifest.catalog);
  assert.equal(actual.activeJobs,0,'ACTIVE_JOBS_IN_RESTORE_POINT');assert.equal(actual.runningRevalidations,0,'ACTIVE_CHECKS_IN_RESTORE_POINT');
  if(actual.maintenance)assertFrozenMaintenance(actual.maintenance);
  for(const o of actual.objects){
    const file=path.join(dir,'objects',o.sha256+'.json');assert.equal(await realpath(file),file,'SYMLINK_BACKUP_OBJECT');
    const b=await readFile(file);assert.equal(b.length,o.bytes,'BACKUP_OBJECT_SIZE');assert.equal(digest(b),o.sha256,'BACKUP_OBJECT_HASH');
  }
  return{dir,manifest};
}
export async function startBackup(remote=false,{id=randomUUID()}={}){
  assert(UUID.test(id),'INVALID_BACKUP_ID');
  await mkdir(ROOT,{recursive:true,mode:0o700});await chmod(ROOT,0o700);
  const dir=path.join(ROOT,id);await mkdir(dir,{mode:0o700});await mkdir(path.join(dir,'objects'),{mode:0o700});
  const source=remote?{mode:'remote',database:'DB',databaseId:deploymentTarget.databaseId,bucket:deploymentTarget.inputBucket,env:'poc'}:{mode:'local',database:'DB',databaseId:'00000000-0000-0000-0000-000000000000',bucket:'shift-planner-inputs-local',env:null};
  await save(path.join(dir,'operation.json'),{id,source,createdAt:Date.now(),stage:'CREATED'});
  console.log(JSON.stringify({backupId:id,stage:'CREATED'}));
  return resumeBackup(id);
}
export function assertFrozenMaintenance(value){
  assert(value&&value.mode==='FROZEN'&&Number.isSafeInteger(value.revision)&&value.revision>0&&UUID.test(value.maintenanceId),'MAINTENANCE_NOT_FROZEN');
  assert.equal(value.activeLeases,0,'MAINTENANCE_NOT_DRAINED');
  assert.equal(value.activeRevalidations,0,'MAINTENANCE_NOT_DRAINED');
  return value;
}
async function sourceMaintenance(flags){
  const text=await command('maintenance-inspection',['d1','execute','DB',...flags,'--json','--command',`SELECT mode,revision,maintenance_id AS maintenanceId,
   (SELECT count(*) FROM maintenance_lease) AS activeLeases,
   (SELECT count(*) FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING')) AS activeRevalidations
   FROM maintenance_state WHERE id=1`]);
  const row=JSON.parse(text)?.[0]?.results?.[0];return assertFrozenMaintenance(row);
}
export async function resumeBackup(id){
  const dir=await ownedDirectory(id),op=JSON.parse(await readFile(path.join(dir,'operation.json'),'utf8'));
  assert.equal(op.id,id);assert(['local','remote'].includes(op.source.mode));
  assert.equal(op.source.bucket,op.source.mode==='remote'?deploymentTarget.inputBucket:'shift-planner-inputs-local');
  assert.equal(op.source.env,op.source.mode==='remote'?'poc':null);
  assert.equal(op.source.databaseId,op.source.mode==='remote'?deploymentTarget.databaseId:'00000000-0000-0000-0000-000000000000');
  if(op.stage==='COMPLETE')return verifyBackup(id);
  const localConfig=op.source.mode==='local'?process.env.SHIFT_LOCAL_BACKUP_CONFIG:undefined;
  let config='infra/wrangler.jsonc';
  if(localConfig){
    config=path.resolve(localConfig);assert(config.startsWith(path.resolve('.cache')+path.sep),'LOCAL_BACKUP_CONFIG_OUTSIDE_CACHE');
    assert.equal(await realpath(config),config,'LOCAL_BACKUP_CONFIG_SYMLINK');
    const value=JSON.parse(await readFile(config,'utf8'));
    if(value.vars?.LOCAL_FINAL_RECOVERY)assertLocalFinalRecoveryDirectConfig(value,{config,port:8787});
    assert((value.vars?.ENVIRONMENT==='local'||value.vars?.LOCAL_FINAL_RECOVERY&&value.vars?.ENVIRONMENT==='poc')&&value.d1_databases?.length===1&&value.d1_databases[0].binding==='DB'&&value.d1_databases[0].database_id===op.source.databaseId&&value.r2_buckets?.length===1&&value.r2_buckets[0].binding==='INPUTS'&&value.r2_buckets[0].bucket_name===op.source.bucket,'LOCAL_BACKUP_CONFIG_MISMATCH');
  }
  const selected={path:path.resolve(config),sha256:digest(await readFile(config))};
  if(op.localConfig)assert.deepEqual(selected,op.localConfig,'LOCAL_BACKUP_CONFIG_CHANGED');
  else{op.localConfig=selected;await save(path.join(dir,'operation.json'),op);}
  const flags=['--config',config,op.source.mode==='remote'?'--remote':'--local',...(op.source.env?['--env',op.source.env]:[])];
  const sql=path.join(dir,'database.sql');
  const frozen=await sourceMaintenance(flags);
  if(op.maintenance)assert.deepEqual(frozen,op.maintenance,'BACKUP_MAINTENANCE_CHANGED');
  else{op.maintenance=frozen;await save(path.join(dir,'operation.json'),op);}
  if(op.stage==='CREATED'){
    // Record before dispatch. An unknown export is preserved for operator
    // inspection; never rerun it solely because a response was lost.
    op.stage='EXPORT_DISPATCHED';await save(path.join(dir,'operation.json'),op);
    await command('d1-export',['d1','export','DB',...flags,'--output',sql]);await chmod(sql,0o600);
    op.stage='EXPORTED';await save(path.join(dir,'operation.json'),op);
  }
  assert(['EXPORTED','COPYING'].includes(op.stage),'EXPORT_OUTCOME_UNKNOWN_INSPECT_EXISTING_FILE');
  const sqlDigest=digest(await readFile(sql));
  if(op.sqlSha256)assert.equal(sqlDigest,op.sqlSha256,'EXPORT_CHANGED_DURING_BACKUP');
  else{op.sqlSha256=sqlDigest;await save(path.join(dir,'operation.json'),op);}
  const catalog=await sqlCatalog(sql);assert.equal(catalog.activeJobs,0,'ACTIVE_JOBS_IN_RESTORE_POINT');assert.equal(catalog.runningRevalidations,0,'ACTIVE_CHECKS_IN_RESTORE_POINT');
  assert.deepEqual(catalog.maintenance,op.maintenance,'BACKUP_MAINTENANCE_CHANGED');
  op.stage='COPYING';await save(path.join(dir,'operation.json'),op);
  let done=0;
  for(const o of catalog.objects){
    const file=path.join(dir,'objects',o.sha256+'.json');
    let valid=false;try{const b=await readFile(file);valid=b.length===o.bytes&&digest(b)===o.sha256;}catch{}
    if(!valid){await command('r2-copy',['r2','object','get',op.source.bucket+'/'+o.key,...flags,'--file',file]);await chmod(file,0o600);}
    const b=await readFile(file);assert.equal(b.length,o.bytes,'SOURCE_OBJECT_SIZE');assert.equal(digest(b),o.sha256,'SOURCE_OBJECT_HASH');
    done++;if(done%20===0||done===catalog.objects.length)console.log(JSON.stringify({backupId:id,stage:'COPYING',verifiedObjects:done,total:catalog.objects.length}));
  }
  assert.deepEqual(await sourceMaintenance(flags),op.maintenance,'BACKUP_MAINTENANCE_CHANGED');
  const bytes=await readFile(sql),completedAt=Date.now(),manifest={version:'shift-backup-v1',id,state:'COMPLETE',source:op.source,createdAt:op.createdAt,completedAt,retentionDays:30,expiresAt:completedAt+RETENTION_MS,sql:{file:'database.sql',bytes:bytes.length,sha256:digest(bytes)},catalog};
  await save(path.join(dir,'manifest.json'),manifest);op.stage='COMPLETE';await save(path.join(dir,'operation.json'),op);
  await verifyBackup(id);console.log(JSON.stringify({backupId:id,stage:'COMPLETE',tables:Object.keys(catalog.tables).length,objects:catalog.objects.length}));
  return{dir,manifest};
}
async function restoreProfile(manifest,profileFile){
  const p=JSON.parse(await readFile(profileFile,'utf8'));
  if(p.kind==='owned-fictional-local-restore-rehearsal')return validateLocalRestoreProfile(manifest,profileFile,p);
  if(p.kind===FINAL_RECOVERY_KIND)return validateFinalRecoveryProfile(manifest,profileFile,p);
  assert.equal(p.kind,'owned-fictional-restore-rehearsal');assert(UUID.test(p.rehearsalId));
  assert(p.mode===undefined||p.mode==='remote','RESTORE_PROFILE_MODE_MISMATCH');
  const suffix=p.rehearsalId.replaceAll('-','').slice(0,12),expected='shift-planner-restore-'+suffix;
  assert.equal(p.databaseName,expected);assert.equal(p.bucket,expected);assert(UUID.test(p.databaseId));
  assert.notEqual(p.databaseId,manifest.source.databaseId);assert.notEqual(p.databaseId,deploymentTarget.databaseId);assert.notEqual(p.bucket,manifest.source.bucket);
  const cfg=JSON.parse(await readFile(p.configFile,'utf8'));
  assert.equal(cfg.account_id,deploymentTarget.accountId);
  assert.equal(cfg.d1_databases.length,1,'AMBIGUOUS_TARGET_DATABASE');assert.equal(cfg.d1_databases[0].binding,'DB');
  assert.equal(cfg.r2_buckets.length,1);assert.equal(cfg.r2_buckets[0].binding,'INPUTS');
  assert.equal(cfg.d1_databases[0].database_id,p.databaseId);assert.equal(cfg.d1_databases[0].database_name,p.databaseName);assert.equal(cfg.r2_buckets[0].bucket_name,p.bucket);
  return {...p,flags:['--remote','--config',p.configFile]};
}
function sameRestoreTarget(op,p,id){
  assert.equal(op.databaseId,p.databaseId);assert.equal(op.backupId,id);assert.equal(op.bucket,p.bucket);assert.equal(op.rehearsalId,p.rehearsalId);
  if(p.mode==='local'||p.kind===FINAL_RECOVERY_KIND)assert.deepEqual(op.targetIdentity,p.targetIdentity,'LOCAL_RESTORE_TARGET_CHANGED');
  else assert.equal(op.targetIdentity,undefined,'RESTORE_PROFILE_MODE_MISMATCH');
}
export async function restoreBackup(id,profileFile){
  const {dir,manifest}=await verifyBackup(id),p=await restoreProfile(manifest,profileFile);
  assertFinalRecoveryCurrentSource(p);
  const flags=p.flags,receipt=path.join(dir,'restore-'+p.rehearsalId+'.json');
  let op;try{op=JSON.parse(await readFile(receipt,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!op){
    await assertFreshLocalRuntime(p);
    const importFile=path.join(dir,'import-'+p.rehearsalId+'.sql');await prepareImport(path.join(dir,'database.sql'),importFile);
    const pre=JSON.parse(await command('empty-target',['d1','execute','DB',...flags,'--command',"SELECT count(*) AS tables_count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'",'--json']));
    assert.equal(pre[0].results[0].tables_count,0,'RESTORE_TARGET_MUST_BE_EMPTY');
    op={rehearsalId:p.rehearsalId,backupId:id,databaseId:p.databaseId,bucket:p.bucket,startedAt:Date.now(),stage:'IMPORT_DISPATCHED',objects:0,importSha256:digest(await readFile(importFile)),...(p.targetIdentity?{targetIdentity:p.targetIdentity}:{})};await exclusiveSave(receipt,op);
    await command('d1-import',['d1','execute','DB',...flags,'--file',importFile,'--yes']);
    op.stage='IMPORTED';await save(receipt,op);
  }
  sameRestoreTarget(op,p,id);assert(Number.isSafeInteger(op.objects)&&op.objects>=0&&op.objects<=manifest.catalog.objects.length,'INVALID_RESTORE_PROGRESS');
  assert(['IMPORTED','COPYING','COMPLETE'].includes(op.stage),'IMPORT_OUTCOME_UNKNOWN_INSPECT_SAME_TARGET');
  if(op.stage!=='COMPLETE'){
    op.stage='COPYING';await save(receipt,op);
    for(let i=op.objects;i<manifest.catalog.objects.length;i++){
      const o=manifest.catalog.objects[i];await command('r2-restore',['r2','object','put',p.bucket+'/'+o.key,...flags,'--file',path.join(dir,'objects',o.sha256+'.json'),'--content-type','application/json']);
      op.objects=i+1;await save(receipt,op);if(op.objects%20===0)console.log(JSON.stringify({rehearsalId:p.rehearsalId,stage:'COPYING',restoredObjects:op.objects}));
    }
    op.stage='COMPLETE';op.completedAt=Date.now();await save(receipt,op);
  }
  return op;
}
export async function reconcileImport(id,profileFile){
  const {dir,manifest}=await verifyBackup(id),p=await restoreProfile(manifest,profileFile),file=path.join(dir,'restore-'+p.rehearsalId+'.json');
  const op=JSON.parse(await readFile(file,'utf8'));sameRestoreTarget(op,p,id);assert.equal(op.stage,'IMPORT_DISPATCHED');assert.equal(op.objects,0);
  // A lost response is reconciled by reading this same target, never reimported.
  const sql=path.join(dir,'reconciled-'+p.rehearsalId+'.sql');await command('reconcile-export',['d1','export','DB',...p.flags,'--output',sql]);await chmod(sql,0o600);
  assert.deepEqual(await sqlCatalog(sql),manifest.catalog,'IMPORT_NOT_PROVEN_KEEP_EXISTING_OPERATION');
  op.stage='IMPORTED';op.importVerifiedAt=Date.now();await save(file,op);return{rehearsalId:p.rehearsalId,stage:op.stage};
}
export async function verifyRestored(id,profileFile){
  const {dir,manifest,p}=await restoredTarget(id,profileFile);
  return verifyRestoreContents(p,manifest.catalog,path.join(dir,'verified-'+p.rehearsalId));
}
export async function restoredTarget(id,profileFile){
  const {dir,manifest}=await verifyBackup(id),p=await restoreProfile(manifest,profileFile);
  // Reuse the target guards without issuing writes: restore must already have a
  // terminal receipt. Never call restore as a side effect of verification.
  const receipt=JSON.parse(await readFile(path.join(dir,'restore-'+p.rehearsalId+'.json'),'utf8'));sameRestoreTarget(receipt,p,id);assert.equal(receipt.stage,'COMPLETE');
  return {dir,manifest,p};
}
export async function verifyRestoreContents(p,expectedCatalog,work){
  await mkdir(work,{recursive:true,mode:0o700});
  const sql=path.join(work,'database.sql'),flags=p.flags;
  await command('restored-export',['d1','export','DB',...flags,'--output',sql]);await chmod(sql,0o600);
  const actual=await sqlCatalog(sql);assert.deepEqual(actual,expectedCatalog,'RESTORED_DB_CATALOG_DIFFERENT');
  for(const o of actual.objects){
    const file=path.join(work,o.sha256+'.json');await command('restored-object-read',['r2','object','get',p.bucket+'/'+o.key,...flags,'--file',file]);await chmod(file,0o600);
    const b=await readFile(file);assert.equal(b.length,o.bytes);assert.equal(digest(b),o.sha256,'RESTORED_OBJECT_HASH');
  }
  return {databaseMatches:true,objectsVerified:actual.objects.length,tablesVerified:Object.keys(actual.tables).length,foreignKeyViolations:0,at:Date.now()};
}
export async function pruneBackups(now=Date.now(),{root=ROOT}={}){
  assert(Number.isSafeInteger(now));let removed=0;
  for(const id of await readdir(root).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))){
    if(!UUID.test(id))continue;const {dir,manifest}=await loadManifest(id,{root}).catch(()=>({dir:null,manifest:null}));
    if(!dir||manifest.expiresAt>now)continue;
    // Only a COMPLETE, internally consistent package in the owned backup root.
    // Keep incomplete operations for inspection; never delete source R2/data.
    await verifyBackup(id,{root});await rm(dir,{recursive:true});removed++;
  }
  return {removed,retentionDays:30};
}
