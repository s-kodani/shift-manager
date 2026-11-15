import assert from 'node:assert/strict';
import path from 'node:path';
export const DIRECT_WRANGLER_VERSION='4.149.0';
export function assertLocalRecoveryDirectConfig(cfg,{config,port,appConfig,enableContainers=false,browserRestore=false}){
 const root=path.dirname(path.resolve(config)),id=path.basename(root),restored=root===path.resolve('.cache/local-restores',id);
 assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id),'LOCAL_OWNER_UUID_REQUIRED');
 assert(restored||root===path.resolve('.cache/local-recovery-sources',id),'LOCAL_RECOVERY_ROOT_REQUIRED');
 const name=(restored?'shift-planner-restore-':'shift-planner-recovery-source-')+id.replaceAll('-','').slice(0,12),operator=path.basename(config)==='operator.jsonc';
 assert(operator||path.basename(config)==='app.jsonc');assert.equal(port,operator?8788:8787);
 assert.equal(cfg.name,name+(operator?'-operator':''));
 for(const key of ['env','account_id','ai','services'])assert.equal(cfg[key],undefined,'LOCAL_DIRECT_UNSUPPORTED_'+key);
 const local=value=>{if(value&&typeof value==='object'){if('remote' in value)assert.equal(value.remote,false,'REMOTE_BINDING_REJECTED');for(const v of Object.values(value))local(v);}};local(cfg);
 assert.equal(cfg.dev,undefined,'RECOVERY_DIRECT_NO_CONTAINER_GATE');
 assert.equal(cfg.vars.RECOVERY_SECURITY_ID,restored?id:'');
 if(operator){
  assert(appConfig,'LOCAL_RECOVERY_APP_REQUIRED');
  assertLocalRecoveryDirectConfig(appConfig,{config:path.join(root,'app.jsonc'),port:8787,browserRestore:appConfig.main===path.resolve('apps/api/src/index.ts')});
  assert.equal(cfg.main,path.resolve('apps/operations/src/operator-worker.ts'));
  assert.equal(cfg.vars.OPERATOR_PRINCIPAL,'local-recovery-operator');
  assert.equal(cfg.vars.RECOVERY_DATABASE_ID,appConfig.d1_databases[0].database_id);
  assert.deepEqual(cfg.d1_databases,appConfig.d1_databases);
  assert.deepEqual(cfg.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:name}]});
  for(const key of ['containers','queues','r2_buckets','assets'])assert.equal(cfg[key],undefined);
 }else{
  const allowed=[path.resolve('apps/api/src/local-ui-worker.ts')];
  if(browserRestore){assert(restored,'BROWSER_RESTORE_TARGET_ONLY');allowed.push(path.resolve('apps/api/src/index.ts'));}
  if(!restored)allowed.push(path.resolve('apps/api/src/local-delivery-recovery-worker.ts'),path.resolve('apps/api/src/local-business-recovery-worker.ts'));
  assert(allowed.includes(cfg.main),'LOCAL_RECOVERY_ENTRY_REQUIRED');
  assert.equal(cfg.vars.ENVIRONMENT,'local');assert.equal(cfg.vars.MAIL_DELIVERY,'disabled');assert.equal(cfg.vars.AI_EXPLANATIONS,'disabled');assert.equal(cfg.vars.AUTH_BASE_URL,'http://localhost:8787');
  assert.equal(cfg.d1_databases.length,1);assert.equal(cfg.d1_databases[0].binding,'DB');assert.equal(cfg.r2_buckets.length,1);assert.equal(cfg.r2_buckets[0].binding,'INPUTS');
  assert.equal(cfg.queues.producers[0].queue,name+'-compute');assert.equal(cfg.queues.consumers[0].queue,name+'-compute');
  assert.equal(cfg.containers.length,1);assert.equal(cfg.containers[0].class_name,'OptimizerContainer');assert.equal(cfg.containers[0].max_instances,1);
 }
 assert(!enableContainers||!operator,'RECOVERY_CONTAINERS_APP_ONLY');
 return {root,enableContainers,persist:path.join(root,'.wrangler/state'),registry:path.join(root,'registry')};
}
export function assertLocalDirectConfig(cfg,{config,port,bounded,finalAcceptance=false}){
 assert.equal(cfg.vars.ENVIRONMENT,finalAcceptance?'poc':'local');assert.equal(cfg.vars.MAIL_DELIVERY,'disabled');assert.equal(cfg.vars.AI_EXPLANATIONS,'disabled');
 if(finalAcceptance){assert(bounded,'FINAL_LOCAL_SDK_REQUIRED');assert.equal(cfg.main,path.resolve('apps/api/src/poc-worker.ts'));assert.equal(cfg.vars.OPTIMIZER_SOLVE_PROFILE,'mvp-joint-calendar-fallback-v1');}
 assert.equal(cfg.vars.AUTH_BASE_URL,'http://localhost:'+port);
 for(const key of ['env','account_id','ai','services'])assert.equal(cfg[key],undefined,'LOCAL_DIRECT_UNSUPPORTED_'+key);
 const check=value=>{if(value&&typeof value==='object'){if('remote' in value)assert.equal(value.remote,false,'REMOTE_BINDING_REJECTED');for(const nested of Object.values(value))check(nested);}};check(cfg);
 const root=path.dirname(path.resolve(config)),id=path.basename(root);
 assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id),'LOCAL_OWNER_UUID_REQUIRED');
 if(bounded){
  assert.equal(root,path.resolve('.cache/bounded-sdk',id));assert.equal(cfg.name,'shift-planner-bounded-sdk-'+id.replaceAll('-','').slice(0,12));
  assert.equal(port,8787);assert.deepEqual(cfg.dev,{container_engine:'unix:///tmp/shift-sdk-'+id+'.sock'});
  assert.equal(cfg.containers.length,1);assert.equal(cfg.containers[0].class_name,'OptimizerContainer');assert.equal(cfg.containers[0].max_instances,1);
 }else{
  assert.equal(root,path.resolve('.cache/local-auth-proxy',id));assert.equal(cfg.name,'shift-auth-proxy-'+id.replaceAll('-','').slice(0,12));
  assert.equal(cfg.dev.enable_containers,false);
 }
 return {root,enableContainers:bounded,containerEngine:bounded?cfg.dev.container_engine:undefined};
}

// Four simultaneous loopback workers for one owned final rehearsal.
export function assertLocalFinalRecoveryDirectConfig(cfg,{config,port,appConfig}){
 const root=path.dirname(path.resolve(config)),id=path.basename(root),source=root===path.resolve('.cache/bounded-sdk',id),target=root===path.resolve('.cache/local-restores',id),operator=path.basename(config)==='operator.jsonc';
 assert(source||target);assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id));assert.equal(port,source?(operator?8788:8787):(operator?8790:8789));
 const app=operator?appConfig:cfg;assert(app);assert(/^[a-f0-9-]{36}$/.test(app.vars.LOCAL_FINAL_RECOVERY));if(source)assert.equal(app.vars.LOCAL_FINAL_RECOVERY,id);
 const name=(source?'shift-planner-bounded-sdk-':'shift-planner-restore-')+id.replaceAll('-','').slice(0,12);assert.equal(cfg.name,name+(operator?'-operator':''));
 for(const key of ['env','account_id','ai','services'])assert.equal(cfg[key],undefined);const check=v=>{if(v&&typeof v==='object'){if('remote'in v)assert.equal(v.remote,false);for(const x of Object.values(v))check(x);}};check(cfg);
 assert.equal(app.main,path.resolve('apps/api/src/poc-worker.ts'));assert.equal(app.vars.ENVIRONMENT,'poc');assert.equal(app.vars.AUTH_BASE_URL,'http://localhost:'+(source?8787:8789));assert.equal(app.vars.MAIL_DELIVERY,'disabled');assert.equal(app.vars.AI_EXPLANATIONS,'disabled');assert.equal(app.vars.OPTIMIZER_SOLVE_PROFILE,'mvp-joint-calendar-fallback-v1');
 assert.equal(app.vars.RECOVERY_SECURITY_ID,source?'':id);assert.equal(app.d1_databases.length,1);assert.equal(app.d1_databases[0].binding,'DB');assert.equal(app.r2_buckets.length,1);assert.equal(app.r2_buckets[0].binding,'INPUTS');
 if(source){assert.equal(app.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000');assert.equal(app.r2_buckets[0].bucket_name,'shift-planner-inputs-local');assert.deepEqual(app.dev,{container_engine:'unix:///tmp/shift-sdk-'+id+'.sock'});}
 else{assert.notEqual(app.d1_databases[0].database_id,'00000000-0000-0000-0000-000000000000');assert.equal(app.d1_databases[0].database_name,name);assert.equal(app.r2_buckets[0].bucket_name,name);assert.equal(app.dev,undefined);}
 assert.deepEqual(app.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer'}]});assert.equal(app.containers.length,1);assert.equal(app.containers[0].instance_type,'standard-2');assert.equal(app.containers[0].max_instances,1);assert.equal(app.queues.producers[0].queue,name+'-compute');assert.equal(app.queues.consumers[0].queue,name+'-compute');
 if(operator){assert.equal(cfg.main,path.resolve('apps/operations/src/operator-worker.ts'));assert.equal(cfg.vars.OPERATOR_PRINCIPAL,'local-recovery-operator');assert.equal(cfg.vars.RECOVERY_DATABASE_ID,app.d1_databases[0].database_id);assert.equal(cfg.vars.RECOVERY_SECURITY_ID,app.vars.RECOVERY_SECURITY_ID);assert.deepEqual(cfg.d1_databases,app.d1_databases);assert.deepEqual(cfg.durable_objects,{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:name}]});for(const k of ['containers','queues','r2_buckets','assets','dev'])assert.equal(cfg[k],undefined);}
 return {root,persist:root+'/.wrangler/state',registry:root+'/registry',enableContainers:source&&!operator,containerEngine:source&&!operator?app.dev.container_engine:undefined};
}
