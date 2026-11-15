import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {deploymentFixture} from './final-deployment.mjs';
import {deployFinalCohort} from '../../../scripts/final-deployment.mjs';
const ACCOUNT='11111111111111111111111111111111',IMAGE='sha256:'+'2'.repeat(64),DIGEST='sha256:'+'3'.repeat(64);
const registry=async args=>JSON.stringify(args.includes('{{json .Manifest}}')?{digest:DIGEST}:args[0]==='manifest'?{schemaVersion:2,config:{digest:IMAGE}}:{os:'linux',architecture:'amd64'});
export async function observationFixture(work){return deploymentFixture(async f=>{
 const deployed=await deployFinalCohort(f.root,{inspectSource:f.options.inspectSource,execute:f.execute,executeDocker:f.executeDocker,request:f.request}),configs={};
 for(const [role,file]of Object.entries({source:'cohort/source-app.jsonc',sourceOperator:'recovery/source-operator.jsonc',target:'recovery/app.jsonc',targetOperator:'recovery/operator.jsonc'}))configs[role]=JSON.parse(await readFile(f.root+'/'+file));
 const calls=[],registryCalls=[],versions={},apps=[],deployments={},view={listedApps:null};
 for(const [role,cfg]of Object.entries(configs)){
  const id=deployed.workerVersions.find(v=>v.worker===cfg.name).versionId,ns=(role.startsWith('source')?'a':'b').repeat(32);
  const bindings=[{name:'DB',type:'d1',database_id:cfg.d1_databases[0].database_id},{name:'SOLVER',type:'durable_object_namespace',namespace_id:ns,class_name:'OptimizerContainer',script_name:cfg.durable_objects.bindings[0].script_name??cfg.name},...Object.entries(cfg.vars).map(([name,text])=>({name,type:'plain_text',text})),...cfg.secrets.required.map(name=>({name,type:'secret_text'}))];
  if(cfg.r2_buckets)bindings.push({name:'INPUTS',type:'r2_bucket',bucket_name:cfg.r2_buckets[0].bucket_name},{name:'COMPUTE_QUEUE',type:'queue',queue_name:cfg.queues.producers[0].queue},{name:'ASSETS',type:'assets'});
  versions[cfg.name]={id,annotations:{'workers/tag':'final-'+f.plan.cohortId},resources:{bindings}};
  deployments[cfg.name]=[{id:randomUUID(),created_on:new Date().toISOString(),versions:[{version_id:id,percentage:100}]}];
  if(cfg.r2_buckets)apps.push({id:randomUUID(),account_id:ACCOUNT,name:'fictional-'+role,scheduling_policy:'default',max_instances:1,durable_objects:{namespace_id:ns},configuration:{vcpu:1,memory_mib:6144,disk:{size_mb:12000},image:'registry.cloudflare.com/'+ACCOUNT+'/'+role+':fictional'}});
 }
 const queue=name=>({queue_id:(name===configs.source.queues.producers[0].queue?'c':'d').repeat(32),queue_name:name,consumers_total_count:1,producers_total_count:1,consumers:[{script:name===configs.source.queues.producers[0].queue?configs.source.name:configs.target.name,settings:{batch_size:1,max_concurrency:1,max_retries:3,max_wait_time_ms:1000}}],producers:[{script:name===configs.source.queues.producers[0].queue?configs.source.name:configs.target.name}]});
 const request=async(url,init)=>{
  calls.push(url);const u=new URL(url);assert.equal(init.redirect,'error');
  if(u.hostname==='shift-manager-example.example.invalid'){
   if(u.pathname==='/__poc/deploy-preflight')return f.request(url,init);
   const file=u.pathname==='/app'?'index.html':u.pathname.slice('/app-assets/'.length);return new Response(await readFile(f.root+'/cohort/assets/'+file));
  }
  assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(init.method,'GET');assert.equal(init.headers.authorization,'Bearer fictional-ephemeral-token-for-test');
  let result;if(u.pathname.includes('/workers/scripts/')){const name=u.pathname.split('/')[7];result=u.pathname.endsWith('/deployments')?{deployments:deployments[name]}:versions[name];}
  else if(u.pathname.endsWith('/containers/applications'))result=view.listedApps??apps;
  else if(u.pathname.includes('/containers/applications/'))result=apps.find(a=>u.pathname.endsWith(a.id));
  else if(u.pathname.endsWith('/queues'))result=[queue(u.searchParams.get('name'))];
  else if(u.pathname.includes('/queues/'))result=queue(u.pathname.endsWith('c'.repeat(32))?configs.source.queues.producers[0].queue:configs.target.queues.producers[0].queue);
  else throw Error('UNEXPECTED_TEST_ROUTE');return Response.json({success:true,result});
 };
 return work({...f,configs,calls,versions,apps,view,deployments,request,registry:async args=>{registryCalls.push(args);return registry(args);},registryCalls});
});}
