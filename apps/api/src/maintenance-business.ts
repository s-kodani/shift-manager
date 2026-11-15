import {admitMaintenance,releaseMaintenance,MaintenanceError} from './maintenance';
import {maintenanceDatabase} from './maintenance-database';
import {jobMessage} from './compute-jobs';
import {revalidationMessage} from './revalidation-contract';
import type {CandidateCommand} from './draft-contract';
import type {CancellationCandidateCommand} from './cancellation-contract';

const admitted=(db:D1Database)=>db.prepare('SELECT 1 AS admitted').first();
// Reset delivery and AI providers are separate external effects. Their existing
// unguarded leases still require completion; SQL fencing cannot revoke a send.
export function guardedBusinessPath(path:string){
 return !path.startsWith('/api/auth/')&&path!=='/api/password'&&path!=='/api/access'
  &&!path.includes('/explanations');
}
export async function withMaintenanceBusiness<T>(env:Env,work:(scoped:Env,leaseId:string)=>Promise<T>):Promise<T>{
 const id=await admitMaintenance(env.DB,'FOREGROUND',1,1);
 if(!id)throw new MaintenanceError();
 const DB=maintenanceDatabase(env.DB,id,1);
 const scoped={...env,DB,INPUTS:maintenanceBucket(env.INPUTS,DB),
  COMPUTE_QUEUE:maintenanceQueue(env.COMPUTE_QUEUE,DB),SOLVER:maintenanceSolver(env.SOLVER,id)};
 try{const result=await work(scoped,id);await admitted(DB);return result;}
 finally{await releaseMaintenance(env.DB,id);}
}
// A late write can create an unreferenced object, but cannot overwrite/delete a
// committed object. Its D1 adoption and final response remain admission-guarded.
export function maintenanceBucket(bucket:R2Bucket,db:D1Database):R2Bucket{
 return new Proxy(bucket,{get(target,key){
  if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
   const onlyIf=args[2]?.onlyIf;
   if(!onlyIf||onlyIf instanceof Headers||onlyIf.etagDoesNotMatch!=='*'
    ||Object.keys(onlyIf).some(k=>k!=='etagDoesNotMatch'))throw new MaintenanceError('MAINTENANCE_IMMUTABLE_UPLOAD_REQUIRED');
   // Copy the condition before yielding; another callback must not turn this
   // accepted immutable upload into an overwrite by mutating its options.
   const options={...args[2],onlyIf:{etagDoesNotMatch:'*'}};
   await admitted(db);const result=await target.put(args[0],args[1],options);await admitted(db);return result;
  };
  if(key==='get')return async(...args:Parameters<R2Bucket['get']>)=>{
   await admitted(db);const result=await target.get(...args);await admitted(db);return result;
  };
  if(key==='head')return async(...args:Parameters<R2Bucket['head']>)=>{
   await admitted(db);const result=await target.head(...args);await admitted(db);return result;
  };
  if(key==='list')return async(...args:Parameters<R2Bucket['list']>)=>{
   await admitted(db);const result=await target.list(...args);await admitted(db);return result;
  };
  // Delete/multipart/unknown capabilities must not escape this append-only scope.
  throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_BUCKET_METHOD');
 }});
}
export function maintenanceQueue(queue:Env['COMPUTE_QUEUE'],db:D1Database):Env['COMPUTE_QUEUE']{
 return new Proxy(queue,{get(target,key){
  if(key==='send')return async(...args:Parameters<Env['COMPUTE_QUEUE']['send']>)=>{
   const job=jobMessage.safeParse(args[0]),revalidation=revalidationMessage.safeParse(args[0]);
   if(!job.success&&!revalidation.success)
    throw new MaintenanceError('MAINTENANCE_DELIVERY_SCOPE');
   const message=job.success?job.data:revalidation.data!;
   await admitted(db);const result=await target.send(message,args[1]);await admitted(db);return result;
  };
  throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_QUEUE_METHOD');
 }});
}
function maintenanceSolver(solver:Env['SOLVER'],leaseId:string):Env['SOLVER']{
 return new Proxy(solver,{get(target,key){
  if(key==='getByName')return (...args:Parameters<Env['SOLVER']['getByName']>)=>{
   const stub=target.getByName(...args);
   return new Proxy(stub,{get(object,method){
    if(method==='checkDraft')return async(command:CandidateCommand)=>await object.checkDraft(command,leaseId);
    if(method==='checkCancellation')return async(command:CancellationCandidateCommand)=>await object.checkCancellation(command,leaseId);
    throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_SOLVER_METHOD');
   }});
  };
  throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_SOLVER_METHOD');
 }});
}
