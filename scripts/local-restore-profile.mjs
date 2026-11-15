import {deploymentTarget} from './deployment-target.mjs';
// An isolated, operator-owned local target. No Cloudflare resource is created.
import {assertLocalFinalRecoveryDirectConfig} from './local-direct-config.mjs';
import assert from 'node:assert/strict';
import {readFile,realpath,lstat,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
export const localRestoreRoot=id=>path.resolve('.cache/local-restores',id);
async function privateFile(file){
 assert.equal(await realpath(file),file,'LOCAL_RESTORE_SYMLINK');
 const s=await lstat(file);assert(s.isFile()&&(s.mode&0o077)===0&&s.size<=1_000_000,'LOCAL_RESTORE_PRIVATE_FILE_REQUIRED');
 return readFile(file);
}
function localOnly(value){
 if(!value||typeof value!=='object')return;
 for(const [key,item] of Object.entries(value)){
  assert(!(key==='remote'&&item!==false),'LOCAL_RESTORE_REMOTE_BINDING');
  localOnly(item);
 }
}
async function ownedStateTree(root){
 // A local config alone is insufficient: a symlinked persistence directory
 // could redirect an otherwise local command into the source database.
 let inspected=0;
 async function visit(file){
  let s;try{s=await lstat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
  assert(++inspected<=20_000,'LOCAL_RESTORE_STATE_SCAN_LIMIT');
  assert(!s.isSymbolicLink()&&await realpath(file)===file,'LOCAL_RESTORE_STATE_SYMLINK');
  assert(s.isDirectory()||s.isFile(),'LOCAL_RESTORE_UNEXPECTED_STATE_FILE');
  if(s.isDirectory())for(const name of await readdir(file))await visit(path.join(file,name));
 }
 await visit(path.join(root,'.wrangler'));
}
export async function validateLocalRestoreProfile(manifest,profileFile,p){
 assert.equal(p.kind,'owned-fictional-local-restore-rehearsal');assert(UUID.test(p.rehearsalId),'INVALID_LOCAL_RESTORE_ID');
 const root=localRestoreRoot(p.rehearsalId),file=path.join(root,'profile.json'),config=path.join(root,'app.jsonc');
 assert.equal(path.resolve(profileFile),file,'LOCAL_RESTORE_PROFILE_PATH');
 assert.equal(await realpath(root),root,'LOCAL_RESTORE_DIRECTORY_SYMLINK');
 assert(((await lstat(root)).mode&0o077)===0,'LOCAL_RESTORE_PRIVATE_DIRECTORY_REQUIRED');
 await privateFile(file);assert.equal(path.resolve(p.configFile),config,'LOCAL_RESTORE_CONFIG_PATH');
 await ownedStateTree(root);
 const bytes=await privateFile(config),cfg=JSON.parse(bytes),name='shift-planner-restore-'+p.rehearsalId.replaceAll('-','').slice(0,12);
 assert.equal(p.mode,'local');assert.equal(p.databaseName,name);assert.equal(p.bucket,name);assert(UUID.test(p.databaseId));
 assert.notEqual(p.databaseId,manifest.source.databaseId,'LOCAL_RESTORE_SOURCE_DATABASE');
 assert.notEqual(p.databaseId,deploymentTarget.databaseId);assert.notEqual(p.bucket,manifest.source.bucket);
 assert.equal(cfg.name,name);if(cfg.vars?.LOCAL_FINAL_RECOVERY)assertLocalFinalRecoveryDirectConfig(cfg,{config,port:8789});else assert.equal(cfg.vars?.ENVIRONMENT,'local');
 assert.equal(cfg.vars?.MAIL_DELIVERY,'disabled');assert.equal(cfg.vars?.AI_EXPLANATIONS,'disabled');
 assert.equal(cfg.vars?.RECOVERY_SECURITY_ID,p.rehearsalId,'LOCAL_RESTORE_SECURITY_GATE_REQUIRED');
 const allowed=new Set(['name','main','compatibility_date','compatibility_flags','rules','vars','d1_databases','r2_buckets','observability','assets','containers','durable_objects','exports','queues','secrets','dev']);
 assert(Object.keys(cfg).every(key=>allowed.has(key)),'LOCAL_RESTORE_UNEXPECTED_CONFIG');localOnly(cfg);
 if(cfg.dev)assert.deepEqual(cfg.dev,{container_engine:'unix:///tmp/shift-restore-'+p.rehearsalId+'.sock'},'LOCAL_RESTORE_UNOWNED_DOCKER_GATE');
 assert.equal(cfg.d1_databases?.length,1,'AMBIGUOUS_TARGET_DATABASE');assert.equal(cfg.r2_buckets?.length,1);
 assert.deepEqual(Object.keys(cfg.d1_databases[0]).sort(),['binding','database_id','database_name','migrations_dir']);
 assert.equal(cfg.d1_databases[0].binding,'DB');assert.equal(cfg.d1_databases[0].database_id,p.databaseId);assert.equal(cfg.d1_databases[0].database_name,name);
 assert.deepEqual(cfg.r2_buckets[0],{binding:'INPUTS',bucket_name:name});
 // Each Worker/Queue/DO must belong to this rehearsal. Default local state is
 // adjacent to this config; dev.persist_to/env/service bindings are forbidden.
 if(cfg.durable_objects)assert.deepEqual(cfg.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer'}]});
 if(cfg.queues){
  assert.equal(cfg.queues.producers?.length,1);assert.equal(cfg.queues.consumers?.length,1);
  assert.deepEqual(cfg.queues.producers[0],{binding:'COMPUTE_QUEUE',queue:name+'-compute'});
  assert.equal(cfg.queues.consumers[0].queue,name+'-compute');
 }
 return {...p,configFile:config,flags:['--local','--config',config],targetIdentity:{mode:'local',configFile:config,configSha256:hash(bytes),stateDirectory:path.join(root,'.wrangler/state')}};
}

export async function assertFreshLocalRuntime(p){
 if(p.mode!=='local')return;
 for(const component of ['r2','do','queues']){
  let present=false;try{await lstat(path.join(p.targetIdentity.stateDirectory,'v3',component));present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  assert(!present,'LOCAL_RESTORE_RUNTIME_MUST_BE_FRESH');
 }
}
