import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requireDeploymentTarget} from './deployment-target.mjs';
export const projectRoot=path.resolve(new URL('..',import.meta.url).pathname);
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function renderTargetConfigs(directory){
 const t=requireDeploymentTarget();await mkdir(directory,{recursive:true,mode:0o700});
 const base=JSON.parse(await readFile(projectRoot+'/infra/wrangler.jsonc'));
 const cfg={...base,...base.env.poc};delete cfg.env;delete cfg.$schema;
 Object.assign(cfg,{name:t.workerName,account_id:t.accountId,main:projectRoot+'/apps/api/src/poc-worker.ts'});
 cfg.vars={...cfg.vars,AUTH_BASE_URL:t.appOrigin,MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled'};
 cfg.assets={...cfg.assets,directory:projectRoot+'/dist/app'};
 cfg.d1_databases=[{binding:'DB',database_id:t.databaseId,database_name:t.databaseName,migrations_dir:projectRoot+'/infra/migrations'}];
 cfg.r2_buckets=[{binding:'INPUTS',bucket_name:t.inputBucket}];
 cfg.queues={producers:[{binding:'COMPUTE_QUEUE',queue:t.queue}],consumers:[{queue:t.queue,max_batch_size:1,max_batch_timeout:1,max_retries:3,max_concurrency:1}]};
 cfg.containers=cfg.containers.map(c=>({...c,image:projectRoot+'/services/optimizer/Dockerfile',image_build_context:projectRoot,max_instances:1}));
 cfg.secrets={required:['BETTER_AUTH_SECRET','POC_TOKEN','BROWSER_BASIC_USER','BROWSER_BASIC_PASSWORD']};
 const operator=JSON.parse(await readFile(projectRoot+'/infra/operator-provision.jsonc'));
 Object.assign(operator,{name:t.operatorWorkerName,account_id:t.accountId,main:projectRoot+'/apps/operations/src/operator-worker.ts'});delete operator.$schema;
 operator.vars={...operator.vars,RECOVERY_DATABASE_ID:t.databaseId};operator.d1_databases=cfg.d1_databases;operator.durable_objects.bindings[0].script_name=t.workerName;
 const backup=JSON.parse(await readFile(projectRoot+'/infra/backup-monitor.jsonc'));
 Object.assign(backup,{name:t.backupWorkerName,account_id:t.accountId,main:projectRoot+'/apps/operations/src/backup-monitor.ts'});delete backup.$schema;delete backup.triggers;
 backup.r2_buckets=[{binding:'BACKUPS',bucket_name:t.backupBucket}];
 const files={},hashes={};for(const [kind,value]of Object.entries({app:cfg,operator,backup})){const bytes=JSON.stringify(value,null,2)+'\n';files[kind]=path.join(directory,kind+'.jsonc');await writeFile(files[kind],bytes,{mode:0o600,flag:'wx'});hashes[kind]=sha(bytes);}
 await writeFile(directory+'/binding.json',JSON.stringify({schema:'shift-manager-rendered-target-v1',accountId:t.accountId,databaseId:t.databaseId,files,hashes},null,2)+'\n',{mode:0o600,flag:'wx'});
 return files;
}
