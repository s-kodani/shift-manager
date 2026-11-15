// Public examples are inert contract fixtures, never an implicit remote target.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
export const EXAMPLE_TARGET=Object.freeze({schema:'shift-manager-target-v1',accountId:'11111111111111111111111111111111',databaseId:'11111111-2222-4333-8444-555555555555',databaseName:'shift-manager-example-db',workerName:'shift-manager-example',operatorWorkerName:'shift-manager-operator-example',backupWorkerName:'shift-manager-backup-example',appOrigin:'https://shift-manager-example.example.invalid',operatorOrigin:'https://shift-manager-operator-example.example.invalid',workersDomain:'example.invalid',inputBucket:'shift-manager-example-inputs',queue:'shift-manager-example-compute',backupBucket:'shift-manager-example-backups'});
const fields=new Set([...Object.keys(EXAMPLE_TARGET),'appSecretsFile','operatorSecretsFile']);
export function privateBytes(file){
 const absolute=path.resolve(file),s=lstatSync(absolute);
 assert(s.isFile()&&!s.isSymbolicLink()&&realpathSync(absolute)===absolute&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=65536,'PRIVATE_TARGET_FILE_REQUIRED');
 return readFileSync(absolute);
}
export function validateDeploymentTarget(t){
 assert(t&&typeof t==='object'&&!Array.isArray(t)&&Object.keys(t).every(k=>fields.has(k)),'TARGET_FIELDS_INVALID');
 assert.equal(t.schema,'shift-manager-target-v1','TARGET_SCHEMA_INVALID');
 assert(/^[a-f0-9]{32}$/.test(t.accountId)&&!/^([a-f0-9])\1+$/.test(t.accountId),'TARGET_ACCOUNT_INVALID');
 assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(t.databaseId)&&t.databaseId!==EXAMPLE_TARGET.databaseId&&t.databaseId!=='00000000-0000-0000-0000-000000000000','TARGET_DATABASE_INVALID');
 for(const name of ['databaseName','workerName','operatorWorkerName','backupWorkerName','inputBucket','queue','backupBucket'])assert(typeof t[name]==='string'&&/^[a-z][a-z0-9-]{2,62}$/.test(t[name])&&!t[name].includes('example'),'TARGET_RESOURCE_NAME_INVALID');
 assert.equal(new Set([t.workerName,t.operatorWorkerName,t.backupWorkerName]).size,3,'TARGET_WORKERS_MUST_DIFFER');
 assert(/^[a-z0-9][a-z0-9-]+\.workers\.dev$/.test(t.workersDomain),'TARGET_DOMAIN_INVALID');
 for(const [key,name]of [['appOrigin','workerName'],['operatorOrigin','operatorWorkerName']]){const u=new URL(t[key]);assert(u.origin===t[key]&&u.protocol==='https:'&&!u.username&&!u.password&&u.hostname===t[name]+'.'+t.workersDomain,'TARGET_ORIGIN_INVALID');}
 for(const key of ['appSecretsFile','operatorSecretsFile'])if(t[key]!==undefined)assert(typeof t[key]==='string'&&path.isAbsolute(t[key]),'TARGET_SECRET_PATH_ABSOLUTE_REQUIRED');
 return Object.freeze({...t});
}
export function loadDeploymentTarget(file){return validateDeploymentTarget(JSON.parse(privateBytes(file)));}
const targetFile=process.env.SHIFT_MANAGER_TARGET;
export const deploymentTarget=targetFile?loadDeploymentTarget(targetFile):EXAMPLE_TARGET;
export function requireDeploymentTarget(){assert(targetFile,'REMOTE_TARGET_REQUIRED: set SHIFT_MANAGER_TARGET to an explicit private target file');return deploymentTarget;}
export async function targetFetch(input,init){
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))return fetch(input,init);
 const t=requireDeploymentTarget();
 assert(url.protocol==='https:'&&!url.username&&!url.password,'REMOTE_URL_INVALID');
 const recovery=new RegExp('^shift-planner-restore-[a-f0-9]{12}(?:-operator)?\\.'+t.workersDomain.replaceAll('.','\\.')+'$').test(url.hostname);
 assert([t.appOrigin,t.operatorOrigin].includes(url.origin)||recovery||(url.origin==='https://api.cloudflare.com'&&url.pathname.startsWith('/client/v4/accounts/'+t.accountId+'/')),'REMOTE_ORIGIN_OR_ACCOUNT_MISMATCH');
 assert((init?.redirect??(typeof input==='object'?input.redirect:undefined)??'error')==='error','REMOTE_REDIRECTS_FORBIDDEN');
 return fetch(input,{...init,redirect:'error',signal:init?.signal??AbortSignal.timeout(30000)});
}
export function remoteWranglerArgs(args,configs){
 if(!args.some(a=>/^--remote(?:=true)?$/.test(a)))return args;
 const t=requireDeploymentTarget();
 const result=[...args],i=result.indexOf('--config');
 assert(i>=0&&configs,'REMOTE_CONFIG_REQUIRED');
 const prior=result[i+1];
 const known={'infra/wrangler.jsonc':'app','infra/backup-monitor.jsonc':'backup','infra/operator-provision.jsonc':'operator'};
 if(known[prior]){
  result[i+1]=configs[known[prior]];
  for(let n=result.length-1;n>=0;n--)if(result[n]==='--env'){result.splice(n,2);}
 }else{
  // An owned restore target must retain its own DB/bucket/Worker identities.
  // Never replace it with the protected source config.
  const cfg=JSON.parse(privateBytes(prior));assert.equal(cfg.account_id,t.accountId,'REMOTE_CONFIG_ACCOUNT_MISMATCH');
 }
 return result;
}
