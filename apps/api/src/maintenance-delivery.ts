import {admitMaintenance,releaseMaintenance,MaintenanceError} from './maintenance';
import {maintenanceDeliveryDatabase} from './maintenance-database';
import {maintenanceBucket,maintenanceQueue} from './maintenance-business';
import {jobMessage,type JobMessage} from './compute-jobs';
import {revalidationMessage,type RevalidationMessage} from './revalidation-contract';

export async function withMaintenanceDelivery<T>(env:Env,work:(scoped:Env,leaseId:string)=>Promise<T>):Promise<T>{
 const id=await admitMaintenance(env.DB,'BACKGROUND',0,0,1);
 if(!id)throw new MaintenanceError();
 const scoped=deliveryEnvironment(env,id),DB=scoped.DB;
 try{const result=await work(scoped,id);await DB.prepare('SELECT 1 AS admitted').first();return result;}
 finally{await releaseMaintenance(env.DB,id);}
}
export function deliveryEnvironment(env:Env,id:string):Env{
 const DB=maintenanceDeliveryDatabase(env.DB,id);
 return {...env,DB,INPUTS:maintenanceBucket(env.INPUTS,DB),COMPUTE_QUEUE:maintenanceQueue(env.COMPUTE_QUEUE,DB),SOLVER:deliverySolver(env.SOLVER,id,DB)};
}
function deliverySolver(solver:Env['SOLVER'],leaseId:string,db:D1Database):Env['SOLVER']{
 return new Proxy(solver,{get(target,key){
  if(key==='getByName')return (...args:Parameters<Env['SOLVER']['getByName']>)=>{
   const stub=target.getByName(...args);
   return new Proxy(stub,{get(object,method){
    if(method==='runJob')return async(input:JobMessage)=>{
     const command=jobMessage.parse(input);await db.prepare('SELECT 1').first();
     const result=await object.runJob(command,leaseId);await db.prepare('SELECT 1').first();return result;
    };
    if(method==='runRevalidation')return async(input:RevalidationMessage)=>{
     const command=revalidationMessage.parse(input);await db.prepare('SELECT 1').first();
     const result=await object.runRevalidation(command,leaseId);await db.prepare('SELECT 1').first();return result;
    };
    throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_SOLVER_METHOD');
   }});
  };
  throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_SOLVER_METHOD');
 }});
}
