// Pin a real historical source for an upgrade rehearsal; never reset main.
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
export const LEGACY_RECOVERY_SHA='f83164e3d2c2a3190c7f5c86e7c897b205c53e0e';
const paths=['.dockerignore','package.json','package-lock.json','apps','scripts','infra','services','packages','tests/fixtures'];
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function git(args){const r=spawnSync('git',args,{maxBuffer:32_000_000});assert.equal(r.status,0,'LEGACY_GIT_READ_FAILED');return r.stdout;}
export const legacyRecoveryRoot=id=>path.resolve('.cache/legacy-recovery-code',id);
export function assertLegacyLocalBindings(id,cfg){
 assert(uuid.test(id));const owner='shift-planner-bounded-sdk-'+id.replaceAll('-','').slice(0,12);
 assert.equal(cfg.name,owner);assert.equal(cfg.vars.ENVIRONMENT,'local');assert.equal(cfg.vars.MAIL_DELIVERY,'disabled');assert.equal(cfg.vars.AI_EXPLANATIONS,'disabled');assert.equal(cfg.vars.RECOVERY_SECURITY_ID,'');
 assert.equal(cfg.env,undefined);assert.equal(cfg.account_id,undefined);assert.equal(cfg.ai,undefined);assert.equal(cfg.services,undefined);
 assert.equal(cfg.d1_databases.length,1);assert.deepEqual(Object.keys(cfg.d1_databases[0]).sort(),['binding','database_id','database_name','migrations_dir']);assert.equal(cfg.d1_databases[0].binding,'DB');assert.equal(cfg.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000');
 assert.deepEqual(cfg.r2_buckets,[{binding:'INPUTS',bucket_name:'shift-planner-inputs-local'}]);
 assert.deepEqual(cfg.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer'}]});
 assert.deepEqual(cfg.dev,{container_engine:'unix:///tmp/shift-business-'+id+'.sock'});
 assert.deepEqual(cfg.queues.producers,[{binding:'COMPUTE_QUEUE',queue:owner+'-compute'}]);assert.equal(cfg.queues.consumers.length,1);assert.equal(cfg.queues.consumers[0].queue,owner+'-compute');
}
export async function verifyLegacyBlob(root,row){
 const match=row.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);assert(match,'LEGACY_UNSUPPORTED_TREE_ENTRY');
 const file=path.join(root,match[3]);assert(file.startsWith(root+path.sep),'LEGACY_CODE_OUTSIDE_ROOT');assert.equal(await realpath(file),file,'LEGACY_CODE_SYMLINK');assert((await lstat(file)).isFile());
 const b=await readFile(file);assert.equal(createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),match[2],'LEGACY_CODE_CHANGED');
}
export async function extractLegacyRecoveryCode(id){
 assert(uuid.test(id));const root=legacyRecoveryRoot(id);await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700});
 const archive=path.join(root,'source.tar');await writeFile(archive,git(['archive','--format=tar',LEGACY_RECOVERY_SHA,'--',...paths]),{mode:0o600,flag:'wx'});
 const extracted=spawnSync('tar',['-xf',archive,'-C',root]);assert.equal(extracted.status,0,'LEGACY_EXTRACTION_FAILED');
 await verifyLegacyRecoveryCode(id,root);return root;
}
export async function verifyLegacyRecoveryCode(id,root){
 assert(uuid.test(id));assert.equal(root,legacyRecoveryRoot(id));assert.equal(await realpath(root),root);assert(((await lstat(root)).mode&0o077)===0);
 const rows=git(['ls-tree','-r','-z',LEGACY_RECOVERY_SHA,'--',...paths]).toString().split('\0').filter(Boolean);
 for(const row of rows)await verifyLegacyBlob(root,row);
 const old=JSON.parse(await readFile(path.join(root,'package.json'))),current=JSON.parse(await readFile('package.json'));
 assert.deepEqual(old.dependencies,current.dependencies,'LEGACY_DEPENDENCIES_CHANGED');assert.deepEqual(old.devDependencies,current.devDependencies,'LEGACY_DEPENDENCIES_CHANGED');
 assert.equal(git(['diff','--name-only',LEGACY_RECOVERY_SHA,'--','services/optimizer/optimizer','packages/contracts','scripts/build-optimizer-runtime.py']).length,0,'LEGACY_OPTIMIZER_DIFFERS');
 return {sha:LEGACY_RECOVERY_SHA,filesVerified:rows.length,root};
}
export async function legacyRecoverySource(root,cfg){
 const id=path.basename(root);assert(uuid.test(id)&&root===path.resolve('.cache/local-recovery-sources',id));
 assertLegacyLocalBindings(id,cfg);
 const file=path.join(root,'legacy-source.json');assert.equal(await realpath(file),file);assert(((await lstat(file)).mode&0o077)===0);
 const meta=JSON.parse(await readFile(file));assert.equal(meta.version,'legacy-recovery-source-v1');assert.equal(meta.sourceId,id);assert.equal(meta.commit,LEGACY_RECOVERY_SHA);
 const tree=await verifyLegacyRecoveryCode(id,meta.codeRoot);
 assert.equal(cfg.main,path.join(tree.root,'apps/api/src/local-business-recovery-worker.ts'));
 assert.equal(cfg.d1_databases[0].migrations_dir,path.join(tree.root,'infra/migrations'));
 assert.equal(cfg.containers[0].image,path.join(tree.root,'services/optimizer/Dockerfile'));assert.equal(cfg.containers[0].image_build_context,tree.root);
 return tree;
}
