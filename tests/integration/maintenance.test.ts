import {env,applyD1Migrations,createExecutionContext,waitOnExecutionContext,createMessageBatch,createScheduledController,getQueueResult} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import {admitMaintenance,releaseMaintenance,withMaintenance,settledMaintenanceWork} from '../../apps/api/src/maintenance';
import {changeMaintenance,maintenanceStatus,inspectMaintenanceOperation,listMaintenanceLeases} from '../../apps/operations/src/maintenance-control';
import {createApp} from '../../apps/api/src/index';
import worker from '../../apps/api/src/index';
import pocWorker from '../../apps/api/src/poc-worker';
import localWorker from '../../apps/api/src/local-ui-worker';
import operator from '../../apps/operations/src/operator-worker';
import {handleJobBatch} from '../../apps/api/src/compute-worker';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,cancelJob} from '../../apps/api/src/compute-jobs';
const idle=()=>Promise.resolve({activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false});
const principal='poc-operator';
const begin=(revision=0)=>({action:'begin' as const,operationId:crypto.randomUUID(),expectedRevision:revision,reason:'架空復元演習の受付停止'});
const freeze=(id:string,revision=1)=>({action:'freeze' as const,operationId:crypto.randomUUID(),maintenanceId:id,expectedRevision:revision,reason:'架空演習の終了確認'});
const resume=(id:string,revision=2)=>({action:'resume' as const,operationId:crypto.randomUUID(),maintenanceId:id,expectedRevision:revision,reason:'架空演習の再開'});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
// Fixture isolation only. Production never clears a lease to unblock a freeze.
beforeEach(async()=>{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN',revision=0,maintenance_id=NULL,last_operation_id=NULL,updated_at=0 WHERE id=1").run();await env.DB.prepare('DELETE FROM maintenance_lease').run();});
it('stops new API/auth/provision/fixture admission before input and credentials; static main health remains available',async()=>{
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 const app=createApp();
 for(const path of ['/api/context','/api/auth/get-session','/api/auth/sign-in/email','/api/password']){
  const r=await app.request(env.AUTH_BASE_URL+path,{method:path.includes('get-session')||path==='/api/context'?'GET':'POST',body:path.includes('get-session')||path==='/api/context'?undefined:'{}'},env);
  expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('60');expect(r.headers.get('cache-control')).toBe('no-store');
 }
 expect((await app.request('/health',{},env)).status).toBe(200);
 const token=crypto.randomUUID()+crypto.randomUUID(),opEnv={DB:env.DB,SOLVER:env.SOLVER,RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:'00000000-0000-0000-0000-000000000000',OPERATOR_TOKEN:token,OPERATOR_PRINCIPAL:principal as 'poc-operator'};
 const request=(path:string,body:unknown)=>new Request('https://operator.example.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 expect((await operator.fetch(request('/provision',{}),opEnv)).status).toBe(503);
 const status=await operator.fetch(request('/maintenance/status',{}),opEnv);expect(status.status).toBe(200);expect(await status.json()).toMatchObject({mode:'DRAINING'});
 expect((await operator.fetch(request('/maintenance/status',{}),{...opEnv,OPERATOR_TOKEN:''})).status).toBe(403);
 const ctx=createExecutionContext();
 expect((await localWorker.fetch(new Request('http://localhost:8787/__local/fixture',{method:'POST'}),env,ctx)).status).toBe(503);
 expect((await pocWorker.fetch(new Request('https://poc.example.invalid/__poc/d1',{method:'POST',headers:{authorization:'Bearer '+env.POC_TOKEN}}),env)).status).toBe(503);
 await waitOnExecutionContext(ctx);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('admission and stop serialize atomically; every admitted operation blocks freeze until its own completion',async()=>{
 const b=begin();const results=await Promise.all([admitMaintenance(env.DB,'FOREGROUND'),changeMaintenance(env.DB,principal,b,idle)]);
 const lease=results[0];expect(await admitMaintenance(env.DB,'FOREGROUND')).toBeNull();
 if(lease){await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),idle)).rejects.toMatchObject({code:'MAINTENANCE_NOT_DRAINED'});await releaseMaintenance(env.DB,lease);}
 const f=await changeMaintenance(env.DB,principal,freeze(b.operationId),idle);expect(f.mode).toBe('FROZEN');
 expect(await admitMaintenance(env.DB,'BACKGROUND')).toBeNull();
 await changeMaintenance(env.DB,principal,resume(b.operationId),idle);const open=await admitMaintenance(env.DB,'FOREGROUND');expect(open).not.toBeNull();await releaseMaintenance(env.DB,open!);
});
it('drains accepted background work and blocks a concurrent final freeze with explicit zero-row conflict',async()=>{
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 let lease:string|null=null;const inspect=async()=>{lease=await admitMaintenance(env.DB,'BACKGROUND');return idle();};
 await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),inspect)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 expect((await maintenanceStatus(env.DB)).mode).toBe('DRAINING');await releaseMaintenance(env.DB,lease!);
 expect((await changeMaintenance(env.DB,principal,freeze(b.operationId),idle)).mode).toBe('FROZEN');
});
it('same command replay is immutable and concurrent, stale revision and changed payload/principal/session fail',async()=>{
 const b=begin(),rows=await Promise.all(Array.from({length:8},()=>changeMaintenance(env.DB,principal,b,idle)));
 expect(rows.every(r=>r.revision===1)).toBe(true);expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_operation WHERE id=?').bind(b.operationId).first('n')).toBe(1);
 await expect(changeMaintenance(env.DB,principal,{...b,reason:'異なる理由'},idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 await expect(changeMaintenance(env.DB,'other',b,idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 await expect(changeMaintenance(env.DB,principal,begin(),idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 await expect(changeMaintenance(env.DB,principal,freeze(crypto.randomUUID()),idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 await changeMaintenance(env.DB,principal,freeze(b.operationId),idle);
 await changeMaintenance(env.DB,principal,resume(b.operationId),idle);
 expect((await changeMaintenance(env.DB,principal,b,idle)).mode).toBe('DRAINING');expect((await maintenanceStatus(env.DB)).mode).toBe('OPEN');
 expect(await inspectMaintenanceOperation(env.DB,'other',b.operationId)).toEqual({found:false});
 await expect(env.DB.prepare('DELETE FROM maintenance_operation WHERE id=?').bind(b.operationId).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_OPERATION');
});
it('audit insertion failure rolls back the stop and leaves admission open',async()=>{
 const b=begin();await env.DB.exec("CREATE TRIGGER maintenance_test_audit BEFORE INSERT ON maintenance_operation BEGIN SELECT RAISE(ABORT,'fictional audit failure'); END;");
 try{await expect(changeMaintenance(env.DB,principal,b,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER maintenance_test_audit');}
 expect((await maintenanceStatus(env.DB)).mode).toBe('OPEN');expect(await inspectMaintenanceOperation(env.DB,principal,b.operationId)).toEqual({found:false});
});
it('elapsed time never deletes an orphan lease, and cleanup failure blocks freeze',async()=>{
 const lease=await admitMaintenance(env.DB,'FOREGROUND');await env.DB.prepare('UPDATE maintenance_lease SET started_at=0 WHERE id=?').bind(lease).run();
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),idle)).rejects.toMatchObject({code:'MAINTENANCE_NOT_DRAINED'});
 await env.DB.exec("CREATE TRIGGER maintenance_test_release BEFORE DELETE ON maintenance_lease BEGIN SELECT RAISE(ABORT,'fictional cleanup failure'); END;");
 try{await expect(releaseMaintenance(env.DB,lease!)).rejects.toThrow();}finally{await env.DB.exec('DROP TRIGGER maintenance_test_release');}
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);await releaseMaintenance(env.DB,lease!);
});
it('completion releases only the owned lease, including a thrown operation',async()=>{
 const owner=await admitMaintenance(env.DB,'FOREGROUND');await expect(withMaintenance(env.DB,'FOREGROUND',async()=>{throw new Error('fictional rejection');})).rejects.toThrow('fictional rejection');
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);await releaseMaintenance(env.DB,owner!);
 await expect(releaseMaintenance(env.DB,owner!)).rejects.toMatchObject({code:'MAINTENANCE_LEASE_LOST'});
});
it('every execution fence and unknown RPC inspection blocks freeze without starting or destroying a container',async()=>{
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 for(const key of ['activeRpc','persistedFence','persistedCheckFence','processRunning']){
  await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),async()=>({...await idle(),[key]:true}))).rejects.toMatchObject({code:'MAINTENANCE_EXECUTION_ACTIVE'});
 }
 for(const inspect of [async()=>{throw new Error('fictional RPC loss');},async()=>({processRunning:false})])await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),inspect)).rejects.toMatchObject({code:'MAINTENANCE_INSPECTION_UNAVAILABLE'});
 expect((await maintenanceStatus(env.DB)).mode).toBe('DRAINING');
});
it('frozen scheduled handler and late queue deliveries do not run RPC, send messages or mutate the database',async()=>{
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);await changeMaintenance(env.DB,principal,freeze(b.operationId),idle);
 const send=vi.fn(),queue={...env.COMPUTE_QUEUE,send};
 await worker.scheduled(createScheduledController(),{...env,COMPUTE_QUEUE:queue});expect(send).not.toHaveBeenCalled();
 const ctx=createExecutionContext(),batch=createMessageBatch<unknown>('fictional-maintenance',[
  {id:'fictional-duplicate',timestamp:Date.now(),attempts:1,body:{version:1,companyId:crypto.randomUUID(),teamId:crypto.randomUUID(),jobId:crypto.randomUUID()}},
 ]);
 const delays:number[]=[];for(const m of batch.messages){const original=m.retry.bind(m);m.retry=o=>{delays.push(o?.delaySeconds??0);original(o);};}
 await handleJobBatch(batch,env);const result=await getQueueResult(batch,ctx);expect(result.explicitAcks).toEqual([]);expect(result.retryMessages.map(r=>r.msgId)).toEqual(['fictional-duplicate']);expect(delays).toEqual([60]);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('queued accepted work prevents freeze; a cancelled duplicate is acknowledged from D1 without RPC',async()=>{
 const f=await inputFixture(env.DB),snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 const id=crypto.randomUUID();await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 const inspection=vi.fn(idle);await expect(changeMaintenance(env.DB,principal,freeze(b.operationId),inspection)).rejects.toMatchObject({code:'MAINTENANCE_NOT_DRAINED'});expect(inspection).not.toHaveBeenCalled();
 // Controlled completion of already admitted work; no new business admission.
 await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:0});
 await changeMaintenance(env.DB,principal,freeze(b.operationId),idle);
 const ctx=createExecutionContext(),batch=createMessageBatch<unknown>('fictional-maintenance',[{id:'fictional-terminal',timestamp:Date.now(),attempts:1,body:{version:1,companyId:f.company.companyId,teamId:f.team,jobId:id}}]);
 await handleJobBatch(batch,env);const result=await getQueueResult(batch,ctx);expect(result.explicitAcks).toEqual(['fictional-terminal']);expect(result.retryMessages).toEqual([]);
});
it('a test runtime without Container bindings refuses freeze and permits explicit drain abort',async()=>{
 const token=crypto.randomUUID()+crypto.randomUUID(),opEnv={DB:env.DB,SOLVER:env.SOLVER,RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:'00000000-0000-0000-0000-000000000000',OPERATOR_TOKEN:token,OPERATOR_PRINCIPAL:principal as 'poc-operator'};
 const request=(input:unknown)=>new Request('https://operator.example.invalid/maintenance/command',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input)});
 const b=begin();expect((await operator.fetch(request(b),opEnv)).status).toBe(200);
 const f=await operator.fetch(request(freeze(b.operationId)),opEnv);expect(f.status).toBe(503);expect(await f.json()).toMatchObject({error:'MAINTENANCE_INSPECTION_UNAVAILABLE'});
 expect((await maintenanceStatus(env.DB)).mode).toBe('DRAINING');
 expect((await operator.fetch(request(resume(b.operationId,1)),opEnv)).status).toBe(200);expect((await maintenanceStatus(env.DB)).mode).toBe('OPEN');
});

const reclaim=(maintenanceId:string,leaseIds:string[],expectedRevision=1)=>({action:'reclaim' as const,operationId:crypto.randomUUID(),maintenanceId,leaseIds,expectedRevision,reason:'終了記録のある架空受付だけを回収'});
// Failure injection at the release boundary, after actual D1 completion writes.
function interceptDelete(before:()=>Promise<void>){
 function wrap(statement:D1PreparedStatement):D1PreparedStatement{
  return new Proxy(statement,{get(target,key){
   if(key==='bind')return (...args:unknown[])=>wrap(target.bind(...args));
   if(key==='run')return async()=>{await before();return target.run();};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
 }
 return {batch:env.DB.batch.bind(env.DB),prepare(sql:string){const statement=env.DB.prepare(sql);return sql.startsWith('DELETE FROM maintenance_lease')?wrap(statement):statement;}};
}
async function failedRelease(kind:'FOREGROUND'|'BACKGROUND'='FOREGROUND'){
 const id=await admitMaintenance(env.DB,kind);expect(id).not.toBeNull();
 await expect(releaseMaintenance(interceptDelete(async()=>{throw new Error('fictional deletion transport failure');}),id!)).rejects.toThrow('fictional deletion transport failure');
 return id!;
}
it('completion is recorded after work settles; pending and old unknown work cannot be reclaimed',async()=>{
 let settle!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{settle=resolve;});
 const task=withMaintenance(env.DB,'FOREGROUND',async()=>{entered();await pending;});await ready;
 const row=(await listMaintenanceLeases(env.DB,{})).leases[0];expect(row.completed_at).toBeNull();
 await env.DB.prepare('UPDATE maintenance_lease SET started_at=0 WHERE id=?').bind(row.id).run();
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 await expect(changeMaintenance(env.DB,principal,reclaim(b.operationId,[row.id]),idle)).rejects.toMatchObject({code:'MAINTENANCE_COMPLETION_REQUIRED'});
 expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);
 settle();await task;expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
});
it('both fulfilled and rejected work leave completion evidence when only cleanup fails',async()=>{
 for(const rejection of [false,true]){
  await expect(withMaintenance(interceptDelete(async()=>{throw new Error('fictional cleanup loss');}),'FOREGROUND',async()=>{if(rejection)throw new Error('fictional business failure');return 'settled';})).rejects.toThrow('fictional cleanup loss');
 }
 const page=await listMaintenanceLeases(env.DB,{});expect(page.leases).toHaveLength(2);expect(page.leases.every(l=>l.completed_at!==null)).toBe(true);
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 const r=await changeMaintenance(env.DB,principal,reclaim(b.operationId,page.leases.map(l=>l.id)),idle);expect(r.mode).toBe('DRAINING');expect(r.revision).toBe(2);
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_lease_recovery WHERE operation_id=?').bind(r.id).first('n')).toBe(2);
});
it('completed selection is atomic, exact and replayable; unrelated active leases still block freeze',async()=>{
 const a=await failedRelease(),bkg=await failedRelease('BACKGROUND'),active=await admitMaintenance(env.DB,'FOREGROUND');
 const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 await expect(changeMaintenance(env.DB,principal,reclaim(b.operationId,[a,active!]),idle)).rejects.toMatchObject({code:'MAINTENANCE_COMPLETION_REQUIRED'});
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(3);expect((await maintenanceStatus(env.DB)).revision).toBe(1);
 const command=reclaim(b.operationId,[bkg,a]),results=await Promise.all(Array.from({length:6},()=>changeMaintenance(env.DB,principal,command,idle)));
 expect(results.every(r=>r.revision===2)).toBe(true);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);
 expect((await changeMaintenance(env.DB,principal,{...command,leaseIds:[a,bkg]},idle)).id).toBe(command.operationId);
 for(const changed of [{...command,leaseIds:[a]},{...command,reason:'違う理由'}])await expect(changeMaintenance(env.DB,principal,changed,idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 await expect(changeMaintenance(env.DB,'other',command,idle)).rejects.toMatchObject({code:'MAINTENANCE_OPERATION_REUSED'});
 await expect(changeMaintenance(env.DB,principal,freeze(b.operationId,2),idle)).rejects.toMatchObject({code:'MAINTENANCE_NOT_DRAINED'});
 await releaseMaintenance(env.DB,active!);await changeMaintenance(env.DB,principal,freeze(b.operationId,2),idle);
 expect((await changeMaintenance(env.DB,principal,command,idle)).mode).toBe('DRAINING');expect((await maintenanceStatus(env.DB)).mode).toBe('FROZEN');
 expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_lease_recovery WHERE operation_id=?').bind(command.operationId).first('n')).toBe(2);
 await releaseMaintenance(env.DB,a); // A late owned cleanup accepts the exact durable recovery receipt.
});
it('reclaim refuses wrong mode, session, revision, missing IDs, duplicates and oversized selection',async()=>{
 const completed=await failedRelease(),b=begin(),command=reclaim(b.operationId,[completed]);
 await expect(changeMaintenance(env.DB,principal,command,idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 await changeMaintenance(env.DB,principal,b,idle);
 for(const changed of [{...command,maintenanceId:crypto.randomUUID()},{...command,expectedRevision:0}])await expect(changeMaintenance(env.DB,principal,changed,idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 await expect(changeMaintenance(env.DB,principal,{...command,leaseIds:[crypto.randomUUID()]},idle)).rejects.toMatchObject({code:'MAINTENANCE_COMPLETION_REQUIRED'});
 for(const ids of [[],[completed,completed],Array.from({length:41},()=>crypto.randomUUID())])await expect(changeMaintenance(env.DB,principal,{...command,leaseIds:ids},idle)).rejects.toThrow();
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);expect(await inspectMaintenanceOperation(env.DB,principal,command.operationId)).toEqual({found:false});
});
it('operation, recovery-audit and deletion failures each roll back the whole reclaim',async()=>{
 const id=await failedRelease(),b=begin();await changeMaintenance(env.DB,principal,b,idle);
 for(const table of ['maintenance_operation','maintenance_lease_recovery','maintenance_lease']){
  const c=reclaim(b.operationId,[id]);await env.DB.exec(`CREATE TRIGGER maintenance_test_reclaim BEFORE ${table==='maintenance_lease'?'DELETE':'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'fictional recovery audit failure'); END;`);
  try{await expect(changeMaintenance(env.DB,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER maintenance_test_reclaim');}
  expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);
  expect(await inspectMaintenanceOperation(env.DB,principal,c.operationId)).toEqual({found:false});expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_lease_recovery WHERE operation_id=?').bind(c.operationId).first('n')).toBe(0);
 }
 expect((await changeMaintenance(env.DB,principal,reclaim(b.operationId,[id]),idle)).revision).toBe(2);
});
it('owned cleanup concurrent with reclaim never converts an active lease into completed',async()=>{
 const id=await admitMaintenance(env.DB,'FOREGROUND'),b=begin();await changeMaintenance(env.DB,principal,b,idle);
 let recoveryId='';
 await releaseMaintenance(interceptDelete(async()=>{const r=await changeMaintenance(env.DB,principal,reclaim(b.operationId,[id!]),idle);recoveryId=r.id;}),id!);
 expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);expect(await env.DB.prepare('SELECT operation_id FROM maintenance_lease_recovery WHERE lease_id=?').bind(id).first('operation_id')).toBe(recoveryId);
 const active=await admitMaintenance(env.DB,'BACKGROUND');await expect(releaseMaintenance(env.DB,crypto.randomUUID())).rejects.toMatchObject({code:'MAINTENANCE_LEASE_LOST'});expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);await releaseMaintenance(env.DB,active!);
});
it('completion and recovery evidence cannot be rewritten, erased or forged for active work',async()=>{
 const id=await failedRelease(),active=await admitMaintenance(env.DB,'FOREGROUND'),b=begin();await changeMaintenance(env.DB,principal,b,idle);
 await expect(env.DB.prepare('UPDATE maintenance_lease SET completed_at=NULL WHERE id=?').bind(id).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_COMPLETION');
 const r=await changeMaintenance(env.DB,principal,reclaim(b.operationId,[id]),idle);
 await expect(env.DB.prepare("INSERT INTO maintenance_lease_recovery VALUES (?,?,'FOREGROUND',0,0)").bind(active,r.id).run()).rejects.toThrow('MAINTENANCE_COMPLETION_REQUIRED');
 for(const sql of ['DELETE FROM maintenance_lease_recovery','UPDATE maintenance_lease_recovery SET completed_at=0'])await expect(env.DB.prepare(sql).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_RECOVERY');
 await releaseMaintenance(env.DB,active!);
});
it('lease inventory pages are bounded and operator-only, without exposing authentication or business input',async()=>{
 const statements=Array.from({length:53},()=>env.DB.prepare("INSERT INTO maintenance_lease(id,kind,started_at) VALUES (?,'FOREGROUND',0)").bind(crypto.randomUUID()));await env.DB.batch(statements);
 const page=await listMaintenanceLeases(env.DB,{});expect(page.leases).toHaveLength(50);expect(page.nextCursor).toBe(page.leases[49].id);
 const second=await listMaintenanceLeases(env.DB,{cursor:page.nextCursor});expect(second.leases).toHaveLength(3);expect(second.nextCursor).toBeNull();expect(new Set([...page.leases,...second.leases].map(l=>l.id)).size).toBe(53);
 const token=crypto.randomUUID()+crypto.randomUUID(),opEnv={DB:env.DB,SOLVER:env.SOLVER,RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:'00000000-0000-0000-0000-000000000000',OPERATOR_TOKEN:token,OPERATOR_PRINCIPAL:principal as 'poc-operator'};
 const request=(authorization:string,body:unknown={},origin=false)=>new Request('https://operator.example.invalid/maintenance/leases',{method:'POST',headers:{authorization,'content-type':'application/json',...(origin?{origin:'https://fictional.example.invalid'}:{})},body:JSON.stringify(body)});
 expect((await operator.fetch(request('Bearer '+token),opEnv)).status).toBe(200);expect((await operator.fetch(request('Bearer fictional-business-token'),opEnv)).status).toBe(403);expect((await operator.fetch(request('Bearer '+token,{},true),opEnv)).status).toBe(403);expect((await operator.fetch(request('Bearer '+token,{cursor:'invalid'}),opEnv)).status).toBe(400);
});
it('a failed parallel operation waits for its writing sibling before completion and preserves the failure',async()=>{
 let finish!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
 const failure=new Error('fictional parallel failure');let rejected=false;
 const task=withMaintenance(env.DB,'FOREGROUND',()=>settledMaintenanceWork([
  Promise.reject(failure),
  (async()=>{started();await gate;await env.DB.prepare("UPDATE maintenance_state SET updated_at=123 WHERE id=1").run();return 'late sibling';})(),
 ])).catch(error=>{rejected=true;expect(error).toBe(failure);});
 await ready;const b=begin();await changeMaintenance(env.DB,principal,b,idle);
 expect(rejected).toBe(false);const leases=(await listMaintenanceLeases(env.DB,{})).leases;expect(leases).toHaveLength(1);expect(leases[0].completed_at).toBeNull();
 await expect(changeMaintenance(env.DB,principal,reclaim(b.operationId,[leases[0].id]),idle)).rejects.toMatchObject({code:'MAINTENANCE_COMPLETION_REQUIRED'});
 finish();await task;expect(rejected).toBe(true);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);expect((await maintenanceStatus(env.DB)).updated_at).toBe(123);
});
it('an owned release between the readiness read and batch produces a zero-row conflict without a receipt',async()=>{
 const id=await failedRelease(),b=begin();await changeMaintenance(env.DB,principal,b,idle);const c=reclaim(b.operationId,[id]);
 const racing={prepare:env.DB.prepare.bind(env.DB),async batch<T=unknown>(statements:D1PreparedStatement[]){await releaseMaintenance(env.DB,id);return env.DB.batch<T>(statements);}};
 await expect(changeMaintenance(racing,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_CONFLICT'});
 expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(0);
 expect(await inspectMaintenanceOperation(env.DB,principal,c.operationId)).toEqual({found:false});
 expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_lease_recovery WHERE operation_id=?').bind(c.operationId).first('n')).toBe(0);
});
it('silently skipped recovery or deletion cannot commit a success receipt',async()=>{
 const id=await failedRelease(),b=begin();await changeMaintenance(env.DB,principal,b,idle);
 for(const table of ['maintenance_lease_recovery','maintenance_lease']){
  const c=reclaim(b.operationId,[id]);await env.DB.exec(`CREATE TRIGGER maintenance_test_skip BEFORE ${table==='maintenance_lease'?'DELETE':'INSERT'} ON ${table} BEGIN SELECT RAISE(IGNORE); END;`);
  try{await expect(changeMaintenance(env.DB,principal,c,idle)).rejects.toMatchObject({code:'MAINTENANCE_COMMAND_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER maintenance_test_skip');}
  expect((await maintenanceStatus(env.DB)).revision).toBe(1);expect((await maintenanceStatus(env.DB)).activeLeases).toBe(1);
  expect(await inspectMaintenanceOperation(env.DB,principal,c.operationId)).toEqual({found:false});expect(await env.DB.prepare('SELECT count(*) AS n FROM maintenance_recovery_commit WHERE operation_id=?').bind(c.operationId).first('n')).toBe(0);
 }
 const r=await changeMaintenance(env.DB,principal,reclaim(b.operationId,[id]),idle);
 expect(await env.DB.prepare('SELECT expected_count FROM maintenance_recovery_commit WHERE operation_id=?').bind(r.id).first('expected_count')).toBe(1);
 await expect(env.DB.prepare('DELETE FROM maintenance_recovery_commit WHERE operation_id=?').bind(r.id).run()).rejects.toThrow('IMMUTABLE_MAINTENANCE_RECOVERY');
});
