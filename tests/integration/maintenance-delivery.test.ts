import {env,applyD1Migrations,runInDurableObject,createMessageBatch,createExecutionContext,getQueueResult} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import {admitMaintenance,releaseMaintenance} from '../../apps/api/src/maintenance';
import {withMaintenanceDelivery} from '../../apps/api/src/maintenance-delivery';
import {maintenanceDatabase,maintenanceDeliveryDatabase} from '../../apps/api/src/maintenance-database';
import {changeMaintenance,maintenanceStatus,listMaintenanceLeases,inspectMaintenanceOperation} from '../../apps/operations/src/maintenance-control';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,loadJob,cancelJob} from '../../apps/api/src/compute-jobs';
import {handleJobBatch} from '../../apps/api/src/compute-worker';
import type {OptimizerInput} from '../../packages/contracts/optimizer-input.generated';

// Real workerd SQL/R2 and DO storage/RPC; controlled transport/destroy below.
// These cases are authority/fault tests, not an OR-Tools or physical-stop proof.
vi.mock('@cloudflare/containers',async()=>{
 const {DurableObject}=await import('cloudflare:workers');
 return {Container:class extends DurableObject<Env>{
  constructor(state:DurableObjectState,bindings:Env){super(state,bindings);Object.defineProperty(state,'container',{configurable:true,value:{running:false,async destroy(){}}});}
  async containerFetch(_request:RequestInfo,_init?:RequestInit):Promise<Response>{throw Error('CONTROLLED_TRANSPORT_REQUIRED');}
  renewActivityTimeout(){}
 }};
});
const idle=async()=>({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
const begin=()=>({action:'begin' as const,operationId:crypto.randomUUID(),expectedRevision:0,reason:'架空配送受付の停止'});
async function retire(ids:string[],b=begin()){
 await changeMaintenance(env.DB,'poc-operator',b,idle);
 const command={action:'retire' as const,operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:ids,reason:'架空配送権限の失効'};
 await changeMaintenance(env.DB,'poc-operator',command,idle);return {maintenanceId:b.operationId,id:command.operationId};
}
const reopen=(id:string)=>changeMaintenance(env.DB,'poc-operator',{action:'resume',operationId:crypto.randomUUID(),expectedRevision:2,maintenanceId:id,reason:'架空再開'},idle);
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();await env.DB.prepare('DELETE FROM maintenance_lease').run();});

it('legacy, auth and foreground business admissions cannot be promoted or used as delivery authority',async()=>{
 for(const [kind,g,r] of [['BACKGROUND',0,0],['FOREGROUND',1,0],['FOREGROUND',1,1]] as const){
  const id=(await admitMaintenance(env.DB,kind,g,r))!;
  await expect(env.DB.prepare('UPDATE maintenance_lease SET delivery_guard=1 WHERE id=?').bind(id).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_GUARD');
  await expect(maintenanceDeliveryDatabase(env.DB,id).prepare('SELECT 1').first()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
  if(kind==='BACKGROUND'){
   const b=begin();await changeMaintenance(env.DB,'poc-operator',b,idle);
   await expect(changeMaintenance(env.DB,'poc-operator',{action:'retire',operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:[id],reason:'旧scopeを拒否'},idle)).rejects.toMatchObject({code:'MAINTENANCE_DATABASE_GUARD_REQUIRED'});
   await changeMaintenance(env.DB,'poc-operator',{action:'resume',operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,reason:'旧受付終了のため再開'},idle);
   await env.DB.prepare('UPDATE maintenance_state SET revision=0 WHERE id=1').run();
  }
  await releaseMaintenance(env.DB,id);
 }
 await expect(admitMaintenance(env.DB,'FOREGROUND',1,1,1)).rejects.toMatchObject({code:'MAINTENANCE_UNAVAILABLE'});
});
it('DRAINING admits guarded delivery; retirement rejects SQL created before revocation even after resume',async()=>{
 const b=begin();await changeMaintenance(env.DB,'poc-operator',b,idle);
 await expect(withMaintenanceDelivery(env,async scoped=>{
  const inventory=await listMaintenanceLeases(env.DB,{});expect(inventory.schema).toBe('maintenance-leases-v4');expect(inventory.leases).toHaveLength(1);
  const id=inventory.leases[0].id;expect(inventory.leases[0]).toMatchObject({kind:'BACKGROUND',guard_version:0,resource_guard:0,delivery_guard:1,completed_at:null});
  await expect(maintenanceDatabase(env.DB,id).prepare('SELECT 1').first()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
  const statement=scoped.DB.prepare('UPDATE maintenance_state SET updated_at=999');
  await changeMaintenance(env.DB,'poc-operator',{action:'retire',operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:[id],reason:'配送だけを失効'},idle);
  await reopen(b.operationId);await expect(statement.run()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
  expect(await env.DB.prepare('SELECT delivery_guard FROM maintenance_delivery_lease_retirement WHERE lease_id=?').bind(id).first('delivery_guard')).toBe(1);
  expect(await env.DB.prepare('SELECT 1 FROM maintenance_lease_recovery WHERE lease_id=?').bind(id).first()).toBeNull();
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('mixed foreground and delivery revocation is atomic and a skipped delivery audit rolls the whole operation back',async()=>{
 const fg=(await admitMaintenance(env.DB,'FOREGROUND',1,1))!,bg=(await admitMaintenance(env.DB,'BACKGROUND',0,0,1))!,b=begin();
 await changeMaintenance(env.DB,'poc-operator',b,idle);
 const c={action:'retire' as const,operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:[fg,bg],reason:'混在受付を原子的に失効'};
 await env.DB.prepare('CREATE TRIGGER delivery_audit_skip BEFORE INSERT ON maintenance_delivery_lease_retirement BEGIN SELECT RAISE(IGNORE); END').run();
 try{
  await expect(changeMaintenance(env.DB,'poc-operator',c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});
  expect(await maintenanceStatus(env.DB)).toMatchObject({revision:1,activeLeases:2});expect(await inspectMaintenanceOperation(env.DB,'poc-operator',c.operationId)).toEqual({found:false});
  expect(await maintenanceDeliveryDatabase(env.DB,bg).prepare('SELECT 1 AS ok').first('ok')).toBe(1);
 }finally{await env.DB.prepare('DROP TRIGGER delivery_audit_skip').run();}
 await changeMaintenance(env.DB,'poc-operator',c,idle);expect((await inspectMaintenanceOperation(env.DB,'poc-operator',c.operationId)).found).toBe(true);
 expect(await env.DB.prepare('SELECT expected_count FROM maintenance_retirement_commit WHERE operation_id=?').bind(c.operationId).first('expected_count')).toBe(2);
 await releaseMaintenance(env.DB,fg);await releaseMaintenance(env.DB,bg);
 await expect(env.DB.prepare('UPDATE maintenance_delivery_lease_retirement SET retired_at=0 WHERE lease_id=?').bind(bg).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_RETIREMENT');
 await expect(env.DB.prepare('INSERT INTO maintenance_lease(id,kind,started_at) VALUES (?,?,0)').bind(bg,'BACKGROUND').run()).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
});
it('an in-flight canonical send may arrive but its retired callback cannot confirm delivery or acknowledge the scope',async()=>{
 await expect(withMaintenanceDelivery(env,async(scoped,id)=>{
  const sent=vi.spyOn(env.COMPUTE_QUEUE,'send').mockImplementation(async()=>{await retire([id]);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};});
  try{
   await expect(scoped.COMPUTE_QUEUE.send({version:1,companyId:crypto.randomUUID(),teamId:crypto.randomUUID(),jobId:crypto.randomUUID()})).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
   expect(sent).toHaveBeenCalledTimes(1);expect(()=>scoped.SOLVER.getByName('arbitrary').executionState()).toThrow('MAINTENANCE_UNSUPPORTED_SOLVER_METHOD');
  }finally{sent.mockRestore();}
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
});
it('retired delayed job and revalidation RPCs cannot create fences or begin transport after reopening',async()=>{
 const id=(await admitMaintenance(env.DB,'BACKGROUND',0,0,1))!,r=await retire([id]);await reopen(r.maintenanceId);
 const message={version:1 as const,companyId:crypto.randomUUID(),teamId:crypto.randomUUID(),jobId:crypto.randomUUID()},stub=env.SOLVER.getByName('delivery-delayed:'+crypto.randomUUID());
 await runInDurableObject(stub,async instance=>{
  const fetch=vi.spyOn(instance,'containerFetch');try{
   await expect(instance.runJob(message,id)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
   await expect(instance.runRevalidation({version:1,kind:'publication-revalidation',companyId:message.companyId,teamId:message.teamId,requestId:crypto.randomUUID().replaceAll('-','')},id)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
   expect(fetch).not.toHaveBeenCalled();expect(instance.executionState()).toMatchObject(await idle());
  }finally{fetch.mockRestore();}
 });await releaseMaintenance(env.DB,id);
});
async function queued(){
 const f=await inputFixture(env.DB,env.INPUTS),snapshotId=crypto.randomUUID(),id=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 return {f,message:{version:1 as const,companyId:f.company.companyId,teamId:f.team,jobId:id}};
}
it('revocation during stopped-result upload preserves the running job and fence; a new delivery recovers the same job without adopting the old result',async()=>{
 const {f,message}=await queued(),stub=env.SOLVER.getByName(`company:${message.companyId}:team:${message.teamId}`),id=(await admitMaintenance(env.DB,'BACKGROUND',0,0,1))!;
 let stopped=0,revoked=false,running=false;
 const rawPut=env.INPUTS.put.bind(env.INPUTS);
 const put=vi.spyOn(env.INPUTS,'put').mockImplementation(async(...args)=>{if(!revoked){revoked=true;await retire([id]);}return rawPut(...args);});
 try{
  await runInDurableObject(stub,async(instance,state)=>{
   Object.defineProperty(state,'container',{configurable:true,value:{get running(){return running;},async destroy(){running=false;stopped++;}}});
   const transport=vi.spyOn(instance,'containerFetch').mockImplementation(async(_url,init)=>{
    if(typeof init==='number')throw Error('UNEXPECTED_CONTAINER_PORT');
    running=true;const input=JSON.parse(String(init?.body)) as OptimizerInput;return Response.json({...input,solverStatus:'UNKNOWN',assignments:null});
   });
   try{
    await expect(instance.runJob(message,id)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
    expect(stopped).toBe(1);expect((await loadJob(env.DB,message.companyId,message.teamId,message.jobId))!).toMatchObject({state:'RUNNING',attempt:1,result_key:null});
    expect(instance.executionState()).toMatchObject({activeRpc:false,persistedFence:true,processRunning:false});
    await expect(changeMaintenance(env.DB,'poc-operator',{action:'freeze',operationId:crypto.randomUUID(),expectedRevision:2,maintenanceId:(await maintenanceStatus(env.DB)).maintenance_id!,reason:'未回復jobは凍結拒否'},idle)).rejects.toMatchObject({code:'MAINTENANCE_NOT_DRAINED'});
    put.mockRestore();
    await withMaintenanceDelivery(env,async(_scoped,newId)=>{expect(await instance.runJob(message,newId)).toBe('DONE');});
    const recovered=(await loadJob(env.DB,message.companyId,message.teamId,message.jobId))!;expect(recovered).toMatchObject({state:'NO_SOLUTION',attempt:2,solver_status:'UNKNOWN',validation_status:'NOT_RUN'});expect(recovered.result_key).not.toBeNull();
    expect(stopped).toBe(2);expect(instance.executionState()).toMatchObject(await idle());
   }finally{transport.mockRestore();}
  });
 }finally{put.mockRestore();await releaseMaintenance(env.DB,id);}
 expect(await env.DB.prepare("SELECT count(*) n FROM product_audit WHERE company_id=? AND kind='compute:completed'").bind(f.company.companyId).first('n')).toBe(1);
});
it('a frozen terminal duplicate is acknowledged without a new RPC or admission',async()=>{
 const {f,message}=await queued();await cancelJob(env.DB,message.companyId,message.teamId,f.company.userId,message.jobId,{operationId:crypto.randomUUID(),expectedAttempt:0});
 await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN' WHERE id=1").run();
 const ctx=createExecutionContext(),batch=createMessageBatch<unknown>('fictional-delivery',[{id:'same-terminal',timestamp:Date.now(),attempts:2,body:message}]);
 await handleJobBatch(batch,env);expect((await getQueueResult(batch,ctx)).explicitAcks).toEqual(['same-terminal']);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('revocation during a running solve retains an unconfirmed process and fence until a fresh delivery can stop and recover the same job',async()=>{
 const {message}=await queued(),stub=env.SOLVER.getByName(`company:${message.companyId}:team:${message.teamId}`),id=(await admitMaintenance(env.DB,'BACKGROUND',0,0,1))!;
 await runInDurableObject(stub,async(instance,state)=>{
  let running=false,stopAllowed=false,revoked=false;
  Object.defineProperty(state,'container',{configurable:true,value:{get running(){return running;},async destroy(){if(!stopAllowed)throw Error('CONTROLLED_STOP_FAILED');running=false;}}});
  const transport=vi.spyOn(instance,'containerFetch').mockImplementation(async(_url,init)=>{
   if(typeof init==='number')throw Error('UNEXPECTED_CONTAINER_PORT');
   running=true;if(!revoked){revoked=true;await retire([id]);}
   return Response.json({...JSON.parse(String(init?.body)),solverStatus:'UNKNOWN',assignments:null});
  });
  try{
   await expect(instance.runJob(message,id)).rejects.toThrow('CONTROLLED_STOP_FAILED');
   expect(instance.executionState()).toMatchObject({activeRpc:false,persistedFence:true,processRunning:true});
   expect((await loadJob(env.DB,message.companyId,message.teamId,message.jobId))!).toMatchObject({state:'RUNNING',attempt:1,result_key:null});
   stopAllowed=true;
   await withMaintenanceDelivery(env,async(_scoped,newId)=>{expect(await instance.runJob(message,newId)).toBe('DONE');});
   expect((await loadJob(env.DB,message.companyId,message.teamId,message.jobId))!).toMatchObject({state:'NO_SOLUTION',attempt:2});
   expect(instance.executionState()).toMatchObject(await idle());
  }finally{transport.mockRestore();}
 });await releaseMaintenance(env.DB,id);
});
it('a late DONE RPC response after delivery revocation cannot acknowledge its queue message',async()=>{
 const {f,message}=await queued();let calls=0;
 // Control only the delayed RPC response at the namespace boundary. Other
 // tests exercise the real DO method and its retained fence independently.
 const SOLVER=new Proxy(env.SOLVER,{get(target,key){
  if(key==='getByName')return (...args:Parameters<Env['SOLVER']['getByName']>)=>new Proxy(target.getByName(...args),{get(stub,method){
   if(method==='runJob')return async(_m:unknown,id:string)=>{calls++;await retire([id]);return 'DONE' as const;};
   return Reflect.get(stub,method,stub);
  }});
  return Reflect.get(target,key,target);
 }});
 const ctx=createExecutionContext(),batch=createMessageBatch<unknown>('fictional-delivery',[{id:'late-done',timestamp:Date.now(),attempts:1,body:message}]);
 await expect(handleJobBatch(batch,{...env,SOLVER})).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 expect(calls).toBe(1);const result=await getQueueResult(batch,ctx);expect(result.explicitAcks).toEqual([]);expect(result.retryMessages.map(r=>r.msgId)).toEqual(['late-done']);
 await cancelJob(env.DB,message.companyId,message.teamId,f.company.userId,message.jobId,{operationId:crypto.randomUUID(),expectedAttempt:0});
});
