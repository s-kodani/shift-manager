import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,chmod,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fixture} from './fixtures.mjs';
import {save,restoreBackup,reconcileImport,verifyRestored} from '../../scripts/backup-lib.mjs';
import {localRestoreRoot,validateLocalRestoreProfile,assertFreshLocalRuntime} from '../../scripts/local-restore-profile.mjs';

async function target(){
 const id=randomUUID(),root=localRestoreRoot(id),name='shift-planner-restore-'+id.replaceAll('-','').slice(0,12);
 await mkdir(root,{recursive:true,mode:0o700});
 const p={kind:'owned-fictional-local-restore-rehearsal',mode:'local',rehearsalId:id,databaseName:name,databaseId:randomUUID(),bucket:name,configFile:path.join(root,'app.jsonc')},
  file=path.join(root,'profile.json'),cfg={name,vars:{ENVIRONMENT:'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',RECOVERY_SECURITY_ID:id},d1_databases:[{binding:'DB',database_id:p.databaseId,database_name:name,migrations_dir:path.resolve('infra/migrations')}],r2_buckets:[{binding:'INPUTS',bucket_name:name}]};
 await save(file,p);await save(p.configFile,cfg);return {root,p,file,cfg};
}
test('local recovery refuses source identity, remote bindings and configuration that can redirect local state',async()=>{
 const f=await fixture(),t=await target();try{
  const safe=await validateLocalRestoreProfile(f.manifest,t.file,t.p);assert.deepEqual(safe.flags,['--local','--config',t.p.configFile]);
  for(const change of [
   {databaseId:f.manifest.source.databaseId},
   {bucket:f.manifest.source.bucket},
   {mode:'remote'},
  ])await assert.rejects(validateLocalRestoreProfile(f.manifest,t.file,{...t.p,...change}));
  for(const cfg of [
   {...t.cfg,vars:{...t.cfg.vars,RECOVERY_SECURITY_ID:''}},
   {...t.cfg,vars:{...t.cfg.vars,RECOVERY_SECURITY_ID:randomUUID()}},
   {...t.cfg,env:{poc:{}}}, {...t.cfg,account_id:'11111111111111111111111111111111'},
   {...t.cfg,dev:{persist_to:path.resolve('.wrangler/state')}}, {...t.cfg,ai:{binding:'AI'}},
   {...t.cfg,r2_buckets:[{...t.cfg.r2_buckets[0],remote:true}]},
   {...t.cfg,durable_objects:{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:'shift-manager-example'}]}},
   {...t.cfg,queues:{producers:[{binding:'COMPUTE_QUEUE',queue:'shift-manager-example-compute'}],consumers:[{queue:'shift-manager-example-compute'}]}},
  ]){
   await save(t.p.configFile,cfg);await assert.rejects(restoreBackup(f.id,t.file));
  }
  await assert.rejects(readFile(path.join(f.dir,'restore-'+t.p.rehearsalId+'.json')), {code:'ENOENT'});
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
test('local recovery requires an owned private non-symlink profile and configuration',async()=>{
 const f=await fixture(),t=await target();try{
  await assert.rejects(validateLocalRestoreProfile(f.manifest,path.join(f.dir,'profile.json'),t.p),/PROFILE_PATH/);
  await chmod(t.p.configFile,0o644);await assert.rejects(restoreBackup(f.id,t.file),/PRIVATE_FILE/);await chmod(t.p.configFile,0o600);
  const original=path.join(t.root,'original.json');await writeFile(original,await readFile(t.p.configFile),{mode:0o600});await rm(t.p.configFile);await symlink(original,t.p.configFile);
  await assert.rejects(restoreBackup(f.id,t.file),/SYMLINK/);
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
test('a symlinked local persistence tree cannot redirect recovery writes into the source',async()=>{
 const f=await fixture(),t=await target();try{
  await symlink(f.dir,path.join(t.root,'.wrangler'));
  await assert.rejects(restoreBackup(f.id,t.file),/STATE_SYMLINK/);
  await assert.rejects(readFile(path.join(f.dir,'restore-'+t.p.rehearsalId+'.json')), {code:'ENOENT'});
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
test('an unknown local import is retained; all continuation paths reject a changed target before dispatch',async()=>{
 const f=await fixture(),t=await target();try{
  const safe=await validateLocalRestoreProfile(f.manifest,t.file,t.p),file=path.join(f.dir,'restore-'+t.p.rehearsalId+'.json');
  await save(file,{rehearsalId:t.p.rehearsalId,backupId:f.id,databaseId:t.p.databaseId,bucket:t.p.bucket,stage:'IMPORT_DISPATCHED',objects:0,targetIdentity:safe.targetIdentity});
  const before=await readFile(file,'utf8');await assert.rejects(restoreBackup(f.id,t.file),/IMPORT_OUTCOME_UNKNOWN/);assert.equal(await readFile(file,'utf8'),before);
  await save(t.p.configFile,{...t.cfg,observability:{enabled:true}});
  for(const operation of [restoreBackup,reconcileImport,verifyRestored])await assert.rejects(operation(f.id,t.file),/TARGET_CHANGED/);
  assert.equal(await readFile(file,'utf8'),before);
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
test('local recovery rejects inherited R2, DO or Queue storage rather than treating it as a fresh runtime',async()=>{
 const f=await fixture(),t=await target();try{
  const safe=await validateLocalRestoreProfile(f.manifest,t.file,t.p);await assertFreshLocalRuntime(safe);
  for(const component of ['r2','do','queues']){
   const dir=path.join(safe.targetIdentity.stateDirectory,'v3',component);await mkdir(dir,{recursive:true});
   await assert.rejects(restoreBackup(f.id,t.file),/RUNTIME_MUST_BE_FRESH/);await rm(dir,{recursive:true});
  }
  await assert.rejects(readFile(path.join(f.dir,'restore-'+t.p.rehearsalId+'.json')), {code:'ENOENT'});
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
test('a bounded restored SDK permits only the socket owned by the exact restore UUID',async()=>{
 const f=await fixture(),t=await target();try{
  const good={...t.cfg,dev:{container_engine:'unix:///tmp/shift-restore-'+t.p.rehearsalId+'.sock'}};await save(t.p.configFile,good);await validateLocalRestoreProfile(f.manifest,t.file,t.p);
  for(const dev of [{container_engine:'unix:///var/run/docker.sock'},{container_engine:'unix:///tmp/shift-restore-'+randomUUID()+'.sock'},{...good.dev,persist_to:path.resolve('.wrangler/state')}]){await save(t.p.configFile,{...good,dev});await assert.rejects(validateLocalRestoreProfile(f.manifest,t.file,t.p),/UNOWNED_DOCKER_GATE/);}
 }finally{await rm(f.dir,{recursive:true});await rm(t.root,{recursive:true});}
});
