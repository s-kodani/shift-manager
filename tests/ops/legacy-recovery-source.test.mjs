import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyLegacyBlob,assertLegacyLocalBindings} from '../../scripts/legacy-recovery-source.mjs';
test('historical source content must match its Git blob; edits and redirects refuse startup authorization',async()=>{
 const root=await mkdtemp(path.resolve('.cache/legacy-blob-test-')),b=Buffer.from('export const fictional = true;\n'),sha=createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),row='100644 blob '+sha+'\tentry.mjs',file=path.join(root,'entry.mjs');
 try{
  await writeFile(file,b);await verifyLegacyBlob(root,row);
  await writeFile(file,'export const fictional = false;');await assert.rejects(verifyLegacyBlob(root,row),/CODE_CHANGED/);
  await rm(file);await writeFile(path.join(root,'other.mjs'),b);await symlink(path.join(root,'other.mjs'),file);await assert.rejects(verifyLegacyBlob(root,row),/CODE_SYMLINK/);
  await assert.rejects(verifyLegacyBlob(root,row.replace('100644','120000')),/UNSUPPORTED_TREE_ENTRY/);
  await assert.rejects(verifyLegacyBlob(root,row.replace('entry.mjs','../foreign.mjs')),/OUTSIDE_ROOT/);
 }finally{await rm(root,{recursive:true});}
});
test('historical source cannot carry a remote binding, service, foreign queue or Docker engine',()=>{
 const id='123456ab-1234-4321-8765-123456abcdef',owner='shift-planner-bounded-sdk-'+id.replaceAll('-','').slice(0,12),cfg={name:owner,vars:{ENVIRONMENT:'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',RECOVERY_SECURITY_ID:''},d1_databases:[{binding:'DB',database_id:'00000000-0000-0000-0000-000000000000',database_name:'fictional',migrations_dir:'fictional'}],r2_buckets:[{binding:'INPUTS',bucket_name:'shift-planner-inputs-local'}],dev:{container_engine:'unix:///tmp/shift-business-'+id+'.sock'},queues:{producers:[{binding:'COMPUTE_QUEUE',queue:owner+'-compute'}],consumers:[{queue:owner+'-compute'}]}};
 cfg.durable_objects={bindings:[{name:'SOLVER',class_name:'OptimizerContainer'}]};assertLegacyLocalBindings(id,cfg);
 for(const changed of [{...cfg,d1_databases:[{...cfg.d1_databases[0],remote:true}]},{...cfg,r2_buckets:[{...cfg.r2_buckets[0],remote:true}]},{...cfg,services:[]},{...cfg,env:{}},{...cfg,durable_objects:{bindings:[{...cfg.durable_objects.bindings[0],script_name:'foreign'}]}},{...cfg,dev:{container_engine:'unix:///var/run/docker.sock'}},{...cfg,queues:{...cfg.queues,consumers:[{queue:'foreign'}]}}])assert.throws(()=>assertLegacyLocalBindings(id,changed));
});
