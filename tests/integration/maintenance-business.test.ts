import {env,applyD1Migrations,runInDurableObject,createExecutionContext,waitOnExecutionContext} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import {withMaintenanceBusiness,guardedBusinessPath,maintenanceBucket,maintenanceQueue} from '../../apps/api/src/maintenance-business';
import {admitMaintenance,releaseMaintenance} from '../../apps/api/src/maintenance';
import {maintenanceDatabase} from '../../apps/api/src/maintenance-database';
import {changeMaintenance,maintenanceStatus,listMaintenanceLeases} from '../../apps/operations/src/maintenance-control';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot,snapshotRow} from '../../apps/api/src/input-snapshots';
import {createApp} from '../../apps/api/src/index';
import type {CandidateCommand} from '../../apps/api/src/draft-contract';
const idle=async()=>({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
// The Vitest runtime has no native Container binding. DO storage/RPC and D1/R2
// remain real; process/transport below are controlled and not physical proof.
vi.mock('@cloudflare/containers',async()=>{
 const {DurableObject}=await import('cloudflare:workers');
 return {Container:class extends DurableObject<Env>{
  constructor(state:DurableObjectState,bindings:Env){super(state,bindings);Object.defineProperty(state,'container',{configurable:true,value:{running:false,async destroy(){}}});}
  async containerFetch(_request:RequestInfo,_init?:RequestInit):Promise<Response>{throw Error('CONTROLLED_TRANSPORT_REQUIRED');}
  renewActivityTimeout(){}
 }};
});
const begin=()=>({action:'begin' as const,operationId:crypto.randomUUID(),expectedRevision:0,reason:'架空業務の権限失効'});
async function retire(id:string){const b=begin();await changeMaintenance(env.DB,'poc-operator',b,idle);await changeMaintenance(env.DB,'poc-operator',{action:'retire',operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:[id],reason:'架空業務受付の全SQL権限失効'},idle);return b.operationId;}
async function reopen(id:string){await changeMaintenance(env.DB,'poc-operator',{action:'resume',operationId:crypto.randomUUID(),expectedRevision:2,maintenanceId:id,reason:'架空再開'},idle);}
async function currentLease(){const leases=(await listMaintenanceLeases(env.DB,{})).leases;expect(leases).toHaveLength(1);expect(leases[0]).toMatchObject({guard_version:1,resource_guard:1,completed_at:null});return leases[0].id;}
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();await env.DB.prepare('DELETE FROM maintenance_lease').run();});

it('business admission covers core APIs while external mail and AI remain completion-only',()=>{
 for(const path of ['/api/context','/api/companies/x/inputs','/api/companies/x/leave','/api/companies/x/compute'])expect(guardedBusinessPath(path)).toBe(true);
 for(const path of ['/api/auth/request-password-reset','/api/auth/sign-in/email','/api/password','/api/access','/api/companies/x/explanations/teams/y'])expect(guardedBusinessPath(path)).toBe(false);
});
it('explicit business retirement fences pre-created SQL and preserves resource scope in its immutable receipt',async()=>{
 await expect(withMaintenanceBusiness(env,async scoped=>{
  const id=await currentLease(),statement=scoped.DB.prepare('UPDATE maintenance_state SET updated_at=999');
  const maintenanceId=await retire(id);await reopen(maintenanceId);
  await expect(statement.run()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
  expect(await env.DB.prepare('SELECT resource_guard FROM maintenance_lease_retirement WHERE lease_id=?').bind(id).first('resource_guard')).toBe(1);
  expect(await env.DB.prepare('SELECT completed_at FROM maintenance_lease_recovery WHERE lease_id=?').bind(id).first()).toBeNull();
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('immutable R2 writes preserve winner bytes and reject overwrite, deletion, multipart and extra conditions',async()=>{
 await withMaintenanceBusiness(env,async scoped=>{
  const key='fictional-immutable/'+crypto.randomUUID();
  expect(await scoped.INPUTS.put(key,'winner',{onlyIf:{etagDoesNotMatch:'*'}})).not.toBeNull();
  expect(await scoped.INPUTS.put(key,'loser',{onlyIf:{etagDoesNotMatch:'*'}})).toBeNull();
  const options={onlyIf:{etagDoesNotMatch:'*'}},pending=scoped.INPUTS.put(key,'mutated overwrite',options);
  options.onlyIf.etagDoesNotMatch='';expect(await pending).toBeNull();
  expect(await(await scoped.INPUTS.get(key))!.text()).toBe('winner');
  for(const options of [undefined,{onlyIf:{etagMatches:'*'}},{onlyIf:new Headers({'if-none-match':'*'})},{onlyIf:{etagDoesNotMatch:'*',uploadedBefore:new Date()}}])
   await expect(scoped.INPUTS.put(key,'unsafe',options)).rejects.toMatchObject({code:'MAINTENANCE_IMMUTABLE_UPLOAD_REQUIRED'});
  for(const call of [()=>scoped.INPUTS.delete(key),()=>scoped.INPUTS.createMultipartUpload(key)])expect(call).toThrow('MAINTENANCE_UNSUPPORTED_BUCKET_METHOD');
 });
});
it('retired and authentication-only capabilities cannot be used for business reads or uploads',async()=>{
 const id=(await admitMaintenance(env.DB,'FOREGROUND',1))!,wrong=maintenanceDatabase(env.DB,id,1),bucket=maintenanceBucket(env.INPUTS,wrong);
 await expect(bucket.put('fictional/'+crypto.randomUUID(),'late',{onlyIf:{etagDoesNotMatch:'*'}})).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
 await expect(bucket.list()).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});await releaseMaintenance(env.DB,id);
});
it('legacy and authentication leases cannot be upgraded into business authority',async()=>{
 for(const guard of [0,1] as const){const id=(await admitMaintenance(env.DB,'FOREGROUND',guard))!;
  await expect(env.DB.prepare('UPDATE maintenance_lease SET resource_guard=1 WHERE id=?').bind(id).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_GUARD');await releaseMaintenance(env.DB,id);
 }
 await expect(admitMaintenance(env.DB,'BACKGROUND',1,1)).rejects.toMatchObject({code:'MAINTENANCE_UNAVAILABLE'});
});
it('a skipped business retirement audit rolls back revocation and preserves the original request authority',async()=>{
 const id=(await admitMaintenance(env.DB,'FOREGROUND',1,1))!,db=maintenanceDatabase(env.DB,id,1),b=begin();
 await changeMaintenance(env.DB,'poc-operator',b,idle);
 await env.DB.prepare('CREATE TRIGGER business_retirement_skip BEFORE INSERT ON maintenance_lease_retirement WHEN NEW.resource_guard=1 BEGIN SELECT RAISE(IGNORE); END').run();
 try{
  await expect(changeMaintenance(env.DB,'poc-operator',{action:'retire',operationId:crypto.randomUUID(),expectedRevision:1,maintenanceId:b.operationId,leaseIds:[id],reason:'架空監査障害'},idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});
  expect(await db.prepare('SELECT 1 AS ok').first('ok')).toBe(1);
  expect(await env.DB.prepare('SELECT 1 FROM maintenance_lease_retirement WHERE lease_id=?').bind(id).first()).toBeNull();
  expect(await maintenanceStatus(env.DB)).toMatchObject({revision:1,activeLeases:1});
 }finally{await env.DB.prepare('DROP TRIGGER business_retirement_skip').run();await releaseMaintenance(env.DB,id);}
});
it('an R2 upload in flight may leave only an orphan; real authenticated snapshot adoption and response stay rejected after reopening',async()=>{
 const f=await inputFixture(env.DB,env.INPUTS),app=createApp(),url=env.AUTH_BASE_URL;
 const login=await app.request(url+'/api/auth/sign-in/email',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
 expect(login.status).toBe(200);const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const INPUTS=new Proxy(env.INPUTS,{get(target,key){if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{enter();await gate;return target.put(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const operationId=crypto.randomUUID(),base=url+'/api/companies/'+f.company.companyId+'/inputs/teams/'+f.team;
 const pending=app.request(base+'/snapshots',{method:'POST',headers:{origin:url,cookie,'content-type':'application/json'},body:JSON.stringify({operationId,expectedRevision:f.revision,month:'2026-10'})},{...env,INPUTS});
 try{await started;const id=await currentLease(),maintenanceId=await retire(id);await reopen(maintenanceId);}
 finally{release();}
 const response=await pending;expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'MAINTENANCE_LEASE_RETIRED'});
 expect(await snapshotRow(env.DB,f.company.companyId,operationId)).toBeNull();
 expect((await env.INPUTS.list({prefix:`companies/${f.company.companyId}/teams/${f.team}/snapshots/${operationId}/`})).objects).toHaveLength(1);
 expect(await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(f.company.companyId).first('revision')).toBe(f.revision);
 expect((await app.request(url+'/api/context',{headers:{cookie}},env)).status).toBe(200);
});
it('delivery is limited to canonical compute/revalidation messages; a lost authority rejects the late acknowledgement',async()=>{
 await expect(withMaintenanceBusiness(env,async scoped=>{
  const send=vi.spyOn(env.COMPUTE_QUEUE,'send').mockImplementation(async()=>({metadata:{metrics:{backlogCount:0,backlogBytes:0}}}));
  try{
   const queue=maintenanceQueue(env.COMPUTE_QUEUE,scoped.DB);
   await expect(queue.send({version:1,kind:'arbitrary-external-effect'})).rejects.toMatchObject({code:'MAINTENANCE_DELIVERY_SCOPE'});expect(send).not.toHaveBeenCalled();
   const id=await currentLease();send.mockImplementation(async()=>{await retire(id);return {metadata:{metrics:{backlogCount:0,backlogBytes:0}}};});
   await expect(queue.send({version:1,companyId:crypto.randomUUID(),teamId:crypto.randomUUID(),jobId:crypto.randomUUID()})).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
   expect(send).toHaveBeenCalledTimes(1);
   expect(()=>queue.sendBatch([])).toThrow('MAINTENANCE_UNSUPPORTED_QUEUE_METHOD');
  }finally{send.mockRestore();}
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
});
it('a retired delayed checker RPC cannot create a fence or start transport, even after reopening',async()=>{
 const command:CandidateCommand={companyId:crypto.randomUUID(),teamId:crypto.randomUUID(),userId:crypto.randomUUID(),snapshotId:crypto.randomUUID(),assignments:[],locks:[],exceptions:[]};
 await expect(withMaintenanceBusiness(env,async scoped=>{
  const id=await currentLease(),name='business-delayed:'+crypto.randomUUID();await reopen(await retire(id));
  // Initialize the controlled Container adapter in the test DO before RPC.
  // Production/native initialization remains an independent SDK acceptance.
  await runInDurableObject(env.SOLVER.getByName(name),async instance=>{
   const fetch=vi.spyOn(instance,'containerFetch');try{
    await expect(scoped.SOLVER.getByName(name).checkDraft(command)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
    await expect(instance.checkDraft(command,id)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');expect(fetch).not.toHaveBeenCalled();expect(instance.executionState()).toMatchObject({activeRpc:false,persistedCheckFence:false,processRunning:false});
   }finally{fetch.mockRestore();}
  });
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
});
it('retirement while a checker runs cannot authorize freeze before confirmed stop; later RPCs cannot restart it',async()=>{
 const f=await inputFixture(env.DB,env.INPUTS),snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 const command:CandidateCommand={companyId:f.company.companyId,teamId:f.team,userId:f.company.userId,snapshotId,assignments:[],locks:[],exceptions:[]};const name=`company:${f.company.companyId}:team:${f.team}`,stub=env.SOLVER.getByName(name);
 await expect(withMaintenanceBusiness(env,async()=>{
  const id=await currentLease();await runInDurableObject(stub,async(instance,state)=>{
   let running=false,enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
   Object.defineProperty(state,'container',{configurable:true,value:{get running(){return running;},async destroy(){running=false;}}});
   const transport=vi.spyOn(instance,'containerFetch').mockImplementation(async()=>{running=true;enter();await gate;return Response.json({scope:'multi-task-v1',status:'HISTORY_UNVERIFIED',violations:[]});});
   const checking=instance.checkDraft(command,id);let maintenanceId='';
   try{
    await started;maintenanceId=await retire(id);const inspect=async(n:string)=>n===name?instance.executionState():idle();
    await expect(changeMaintenance(env.DB,'poc-operator',{action:'freeze',operationId:crypto.randomUUID(),maintenanceId,expectedRevision:2,reason:'架空停止待ち'},inspect)).rejects.toMatchObject({code:'MAINTENANCE_EXECUTION_ACTIVE'});
   }finally{release();await checking;transport.mockRestore();}
   expect(instance.executionState()).toMatchObject({activeRpc:false,persistedCheckFence:false,processRunning:false});
   await changeMaintenance(env.DB,'poc-operator',{action:'freeze',operationId:crypto.randomUUID(),maintenanceId,expectedRevision:2,reason:'架空停止確認後凍結'},async(n:string)=>n===name?instance.executionState():idle());
   await changeMaintenance(env.DB,'poc-operator',{action:'resume',operationId:crypto.randomUUID(),maintenanceId,expectedRevision:3,reason:'架空再開'},idle);
   await expect(instance.checkDraft(command,id)).rejects.toThrow('MAINTENANCE_LEASE_RETIRED');
  });
 })).rejects.toMatchObject({code:'MAINTENANCE_LEASE_RETIRED'});
});
it('normal HTTP background dispatch owns its separate admission after the foreground response',async()=>{
 const f=await inputFixture(env.DB,env.INPUTS),snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 const app=createApp(),url=env.AUTH_BASE_URL,login=await app.request(url+'/api/auth/sign-in/email',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env),cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 const send=vi.spyOn(env.COMPUTE_QUEUE,'send').mockResolvedValue({metadata:{metrics:{backlogCount:0,backlogBytes:0}}}),ctx=createExecutionContext(),operationId=crypto.randomUUID();
 try{
  const response=await app.fetch(new Request(url+'/api/companies/'+f.company.companyId+'/compute/teams/'+f.team+'/jobs',{method:'POST',headers:{origin:url,cookie,'content-type':'application/json'},body:JSON.stringify({operationId,snapshotId,expectedRevision:f.revision})}),env,ctx);
  expect(response.status).toBe(202);await waitOnExecutionContext(ctx);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toEqual({version:1,companyId:f.company.companyId,teamId:f.team,jobId:operationId});expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
 }finally{send.mockRestore();}
});
