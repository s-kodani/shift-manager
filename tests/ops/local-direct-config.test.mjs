import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {assertLocalDirectConfig,assertLocalRecoveryDirectConfig} from '../../scripts/local-direct-config.mjs';
const id='12345678-1234-1234-1234-123456789abc';
function fixture(bounded){return {name:(bounded?'shift-planner-bounded-sdk-':'shift-auth-proxy-')+id.replaceAll('-','').slice(0,12),vars:{ENVIRONMENT:'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',AUTH_BASE_URL:'http://localhost:8787'},dev:bounded?{container_engine:'unix:///tmp/shift-sdk-'+id+'.sock'}:{enable_containers:false},containers:[{class_name:'OptimizerContainer',max_instances:1}],d1_databases:[{binding:'DB'}]};}
const options=bounded=>({bounded,config:path.resolve(bounded?'.cache/bounded-sdk':'.cache/local-auth-proxy',id,'app.jsonc'),port:8787});
test('SDK bridge accepts only a matching owned gate; diagnostic mode disables containers',()=>{
 assert.equal(assertLocalDirectConfig(fixture(true),options(true)).enableContainers,true);assert.equal(assertLocalDirectConfig(fixture(false),options(false)).enableContainers,false);
 for(const change of [c=>c.dev.container_engine='unix:///var/run/docker.sock',c=>c.name='another-owner',c=>c.containers[0].max_instances=2]){const c=fixture(true);change(c);assert.throws(()=>assertLocalDirectConfig(c,options(true)));}
 assert.throws(()=>assertLocalDirectConfig(fixture(true),{...options(true),config:path.resolve('infra/wrangler.jsonc')}));
});
test('final acceptance enables the private PoC only on the owned loopback SDK with providers disabled',()=>{
 const c=fixture(true);c.main=path.resolve('apps/api/src/poc-worker.ts');c.vars.ENVIRONMENT='poc';c.vars.OPTIMIZER_SOLVE_PROFILE='mvp-joint-calendar-fallback-v1';
 const o={...options(true),finalAcceptance:true};assert.equal(assertLocalDirectConfig(c,o).enableContainers,true);
 assert.throws(()=>assertLocalDirectConfig(c,options(true)));
 for(const change of [x=>x.main=path.resolve('apps/api/src/index.ts'),x=>x.vars.AUTH_BASE_URL='https://shift-manager-example.example.invalid',x=>x.d1_databases[0].remote=true,x=>x.vars.OPTIMIZER_SOLVE_PROFILE='different',x=>x.vars.MAIL_DELIVERY='resend',x=>x.containers[0].max_instances=2]){
  const bad=structuredClone(c);change(bad);assert.throws(()=>assertLocalDirectConfig(bad,o));
 }
});
function recovery(restored=false){const name=(restored?'shift-planner-restore-':'shift-planner-recovery-source-')+id.replaceAll('-','').slice(0,12),app={...fixture(false),name,main:path.resolve('apps/api/src/local-ui-worker.ts'),vars:{...fixture(false).vars,RECOVERY_SECURITY_ID:restored?id:''},queues:{producers:[{queue:name+'-compute'}],consumers:[{queue:name+'-compute'}]},r2_buckets:[{binding:'INPUTS'}]};delete app.dev;const root=path.resolve(restored?'.cache/local-restores':'.cache/local-recovery-sources',id);return {root,app,operator:{name:name+'-operator',main:path.resolve('apps/operations/src/operator-worker.ts'),vars:{RECOVERY_SECURITY_ID:restored?id:'',RECOVERY_DATABASE_ID:undefined,OPERATOR_PRINCIPAL:'local-recovery-operator'},d1_databases:app.d1_databases,durable_objects:{bindings:[{name:'SOLVER',class_name:'OptimizerContainer',script_name:name}]}}};}
test('auth-only recovery bridges use the standard owned state without enabling Containers or changing the restore profile',()=>{
 for(const restored of [false,true]){const {root,app,operator}=recovery(restored);
  const a=assertLocalRecoveryDirectConfig(app,{config:path.join(root,'app.jsonc'),port:8787});assert.equal(a.enableContainers,false);assert.equal(a.persist,path.join(root,'.wrangler/state'));
  assert.equal(assertLocalRecoveryDirectConfig(app,{config:path.join(root,'app.jsonc'),port:8787,enableContainers:true}).enableContainers,true);
  assert.equal(assertLocalRecoveryDirectConfig(operator,{config:path.join(root,'operator.jsonc'),port:8788,appConfig:app}).enableContainers,false);
  assert.throws(()=>assertLocalRecoveryDirectConfig(operator,{config:path.join(root,'operator.jsonc'),port:8788,appConfig:app,enableContainers:true}));
 }
});
test('recovery direct bridge rejects foreign root, wrong namespace/origin/port, external scope and unowned cross-Worker database',()=>{
 for(const change of [x=>x.app.vars.RECOVERY_SECURITY_ID='foreign',x=>x.app.vars.MAIL_DELIVERY='resend',x=>x.app.d1_databases[0].remote=true,x=>x.app.dev={},x=>x.app.name='foreign',x=>x.app.main='/tmp/foreign.ts']){const x=recovery(true);change(x);assert.throws(()=>assertLocalRecoveryDirectConfig(x.app,{config:path.join(x.root,'app.jsonc'),port:8787}));}
 const x=recovery(true);assert.throws(()=>assertLocalRecoveryDirectConfig(x.app,{config:path.resolve('infra/wrangler.jsonc'),port:8787}));assert.throws(()=>assertLocalRecoveryDirectConfig(x.app,{config:path.join(x.root,'app.jsonc'),port:8788}));
 x.operator.durable_objects.bindings[0].script_name='foreign';assert.throws(()=>assertLocalRecoveryDirectConfig(x.operator,{config:path.join(x.root,'operator.jsonc'),port:8788,appConfig:x.app}));
});
test('remote resources, a wrong auth origin, and external providers are rejected',()=>{
 for(const change of [c=>c.d1_databases[0].remote=true,c=>c.vars.AUTH_BASE_URL='https://example.com',c=>c.vars.MAIL_DELIVERY='resend',c=>c.vars.AI_EXPLANATIONS='enabled',c=>c.ai={},c=>c.env={},c=>c.services=[],c=>c.account_id='fictitious']){const c=fixture(true);change(c);assert.throws(()=>assertLocalDirectConfig(c,options(true)));}
});
test('delivery and business admission rehearsal entries are accepted only for a local source, never a restored target',()=>{
 for(const entry of ['local-delivery-recovery-worker.ts','local-business-recovery-worker.ts'])for(const restored of [false,true]){const x=recovery(restored);x.app.main=path.resolve('apps/api/src',entry);
  const check=()=>assertLocalRecoveryDirectConfig(x.app,{config:path.join(x.root,'app.jsonc'),port:8787,enableContainers:true});
  if(restored)assert.throws(check);else assert.equal(check().enableContainers,true);
 }
});
test('browser restoration uses the product entry only in an isolated target and requires explicit mode',()=>{
 for(const restored of [false,true]){const x=recovery(restored);x.app.main=path.resolve('apps/api/src/index.ts');const o={config:path.join(x.root,'app.jsonc'),port:8787,enableContainers:true};
  assert.throws(()=>assertLocalRecoveryDirectConfig(x.app,o));
  if(restored){assert.equal(assertLocalRecoveryDirectConfig(x.app,{...o,browserRestore:true}).enableContainers,true);assert.equal(assertLocalRecoveryDirectConfig(x.operator,{config:path.join(x.root,'operator.jsonc'),port:8788,appConfig:x.app}).enableContainers,false);}
  else assert.throws(()=>assertLocalRecoveryDirectConfig(x.app,{...o,browserRestore:true}));
 }
});
