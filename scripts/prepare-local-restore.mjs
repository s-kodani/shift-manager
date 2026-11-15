// Explicit local rehearsal only. The source configuration/state is untouched.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {localRestoreRoot,validateLocalRestoreProfile} from './local-restore-profile.mjs';
import assert from 'node:assert/strict';
assert(process.argv.length===2||(process.argv.length===3&&['--bounded-sdk','--browser'].includes(process.argv[2])),'LOCAL_RESTORE_PREPARATION_USAGE');
const id=randomUUID(),root=localRestoreRoot(id),name='shift-planner-restore-'+id.replaceAll('-','').slice(0,12);
await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700});
const cfg=JSON.parse(await readFile('infra/wrangler.jsonc','utf8'));
delete cfg.env;delete cfg.account_id;delete cfg.$schema;
cfg.name=name;cfg.main=path.resolve('apps/api/src/local-ui-worker.ts');
if(process.argv[2]==='--browser')cfg.main=path.resolve('apps/api/src/index.ts');
if(process.argv[2]==='--bounded-sdk')cfg.dev={container_engine:'unix:///tmp/shift-restore-'+id+'.sock'};
cfg.vars={...cfg.vars,AUTH_BASE_URL:'http://localhost:8787',ENVIRONMENT:'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',OPTIMIZER_SOLVE_PROFILE:'mvp-joint-calendar-fallback-v1',RECOVERY_SECURITY_ID:id};
cfg.assets.directory=path.resolve('infra',cfg.assets.directory);
cfg.containers=cfg.containers.map(c=>({...c,image:path.resolve('infra',c.image),image_build_context:path.resolve('infra',c.image_build_context)}));
const databaseId=randomUUID();
cfg.d1_databases=[{binding:'DB',database_name:name,database_id:databaseId,migrations_dir:path.resolve('infra/migrations')}];
cfg.r2_buckets=[{binding:'INPUTS',bucket_name:name}];
cfg.queues.producers[0].queue=name+'-compute';cfg.queues.consumers[0].queue=name+'-compute';
const configFile=path.join(root,'app.jsonc'),profileFile=path.join(root,'profile.json'),
 profile={kind:'owned-fictional-local-restore-rehearsal',mode:'local',rehearsalId:id,databaseName:name,databaseId,bucket:name,configFile};
await writeFile(configFile,JSON.stringify(cfg,null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(profileFile,JSON.stringify(profile,null,2)+'\n',{mode:0o600,flag:'wx'});
await validateLocalRestoreProfile({source:{databaseId:'00000000-0000-0000-0000-000000000000',bucket:'shift-planner-inputs-local'}},profileFile,profile);
console.log(JSON.stringify({rehearsalId:id,mode:'local',profileFile,configFile}));
// Secrets are supplied separately in this directory's private .dev.vars when
// starting the restored Worker. Never copy DO/Queue state from the source.
