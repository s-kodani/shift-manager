import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,symlink,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateDeploymentTarget,loadDeploymentTarget,EXAMPLE_TARGET} from '../../scripts/deployment-target.mjs';
const target=()=>({...EXAMPLE_TARGET,accountId:'0123456789abcdef0123456789abcdef',databaseId:randomUUID(),databaseName:'owned-db',workerName:'owned-app',operatorWorkerName:'owned-operator',backupWorkerName:'owned-backup',workersDomain:'owned-subdomain.workers.dev',appOrigin:'https://owned-app.owned-subdomain.workers.dev',operatorOrigin:'https://owned-operator.owned-subdomain.workers.dev',inputBucket:'owned-inputs',queue:'owned-compute',backupBucket:'owned-backups'});
async function fixture(fn){await mkdir('.cache',{recursive:true});const root=await mkdtemp(path.resolve('.cache/target-test-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('remote targets require complete explicit ownership and matching HTTPS origins',()=>{
 assert.equal(validateDeploymentTarget(target()).workerName,'owned-app');assert.throws(()=>validateDeploymentTarget(EXAMPLE_TARGET));
 for(const change of [{accountId:''},{databaseId:'00000000-0000-0000-0000-000000000000'},{appOrigin:'https://foreign.invalid'},{appOrigin:'http://owned-app.owned-subdomain.workers.dev'},{operatorWorkerName:'owned-app'},{extra:'unexpected'},{appSecretsFile:'relative.json'}])assert.throws(()=>validateDeploymentTarget({...target(),...change}));
});
test('private profiles reject exposed permissions and symlinks',()=>fixture(async root=>{
 const file=root+'/target.json';await writeFile(file,JSON.stringify(target()),{mode:0o600});assert.equal(loadDeploymentTarget(file).workerName,'owned-app');await chmod(file,0o644);assert.throws(()=>loadDeploymentTarget(file));await chmod(file,0o600);await symlink(file,root+'/link.json');assert.throws(()=>loadDeploymentTarget(root+'/link.json'));
}));
test('unconfigured CLI actions stop before creating receipts or contacting any remote',()=>{
 for(const action of ['status','deploy','migrate','deploy-operator']){
  const env={...process.env};delete env.SHIFT_MANAGER_TARGET;
  const r=spawnSync(process.execPath,['scripts/remote.mjs',action],{env,encoding:'utf8'});assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).directory,null);
 }
});
test('wrong origins, accounts and redirects are rejected before fetch; owned requests and loopback work',()=>fixture(async root=>{
 const file=root+'/target.json',t=target();await writeFile(file,JSON.stringify(t),{mode:0o600});
 const prior=process.env.SHIFT_MANAGER_TARGET;process.env.SHIFT_MANAGER_TARGET=file;
 const mod=await import('../../scripts/deployment-target.mjs?'+randomUUID());if(prior===undefined)delete process.env.SHIFT_MANAGER_TARGET;else process.env.SHIFT_MANAGER_TARGET=prior;
 const fetchBefore=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};
 try{
  for(const u of ['https://foreign.invalid/','https://api.cloudflare.com/client/v4/accounts/foreign/workers/scripts'])await assert.rejects(mod.targetFetch(u,{redirect:'error'}));
  await assert.rejects(mod.targetFetch(t.appOrigin,{redirect:'follow'}));assert.equal(calls,0);
  await mod.targetFetch(t.appOrigin+'/app',{redirect:'error'});await mod.targetFetch('http://localhost:8787/health');assert.equal(calls,2);
 }finally{globalThis.fetch=fetchBefore;}
}));
test('rendered configs retain explicit resource bindings and do not enable backup cron',()=>fixture(async root=>{
 const file=root+'/target.json',t=target();await writeFile(file,JSON.stringify(t),{mode:0o600});
 const script=`process.env.SHIFT_MANAGER_TARGET=process.argv[1];const {renderTargetConfigs}=await import('./scripts/render-target.mjs');console.log(JSON.stringify(await renderTargetConfigs(process.argv[2])));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script,file,root+'/configs'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const files=JSON.parse(r.stdout),app=JSON.parse(await readFile(files.app)),operator=JSON.parse(await readFile(files.operator)),backup=JSON.parse(await readFile(files.backup));
 assert.equal(app.account_id,t.accountId);assert.equal(app.d1_databases[0].database_id,t.databaseId);assert.equal(app.vars.AUTH_BASE_URL,t.appOrigin);assert.equal(app.containers[0].max_instances,1);assert.equal(operator.durable_objects.bindings[0].script_name,t.workerName);assert.equal(backup.triggers,undefined);assert.equal(backup.r2_buckets[0].bucket_name,t.backupBucket);
}));
test('source config substitution preserves an explicitly owned restore target',()=>fixture(async root=>{
 const file=root+'/target.json',t=target();await writeFile(file,JSON.stringify(t),{mode:0o600});const own=root+'/restore.json';await writeFile(own,JSON.stringify({account_id:t.accountId,d1_databases:[{database_id:randomUUID()}]}),{mode:0o600});
 const prior=process.env.SHIFT_MANAGER_TARGET;process.env.SHIFT_MANAGER_TARGET=file;const m=await import('../../scripts/deployment-target.mjs?'+randomUUID());if(prior===undefined)delete process.env.SHIFT_MANAGER_TARGET;else process.env.SHIFT_MANAGER_TARGET=prior;
 const args=['d1','execute','DB','--remote','--config',own];assert.deepEqual(m.remoteWranglerArgs(args,{app:'source.json'}),args);
 assert.deepEqual(m.remoteWranglerArgs(['d1','execute','DB','--remote','--config','infra/wrangler.jsonc','--env','poc'],{app:'source.json'}),['d1','execute','DB','--remote','--config','source.json']);
 await writeFile(own,JSON.stringify({account_id:'foreign'}),{mode:0o600});assert.throws(()=>m.remoteWranglerArgs(args,{app:'source.json'}));
}));
