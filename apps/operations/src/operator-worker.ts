import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {OperatorEnv} from '../operator-configuration';
import {operatorInspect,operatorProvision} from '../../../scripts/operator-contract.mjs';
import {inspectProvision,provisionInitialCompany,OperatorError} from './operator-provision';
import {withMaintenance,MaintenanceError,requireRecoverySecurity} from '../../api/src/maintenance';
import {changeMaintenance,maintenanceCommand,maintenanceStatus,inspectMaintenanceOperation,listMaintenanceLeases,MaintenanceControlError} from './maintenance-control';
import {securityCheckpoint,reconcileRecoverySecurity,inspectRecoverySecurity,RecoverySecurityError} from './recovery-security';
import {reissueRecoverySecurity,inspectRecoveryReissue} from './recovery-reissue';
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
class InputError extends Error{constructor(public status:400|403|413|415,public code:string){super(code);}}
async function body(request:Request,limit=4096){
 if(request.headers.has('origin'))throw new InputError(403,'MACHINE_CLIENT_REQUIRED');
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new InputError(415,'INVALID_CONTENT_TYPE');
 const reader=request.body?.getReader();if(!reader)throw new InputError(400,'INVALID_INPUT');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new InputError(413,'BODY_LIMIT');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as unknown;}catch{throw new InputError(400,'INVALID_INPUT');}
}
export default {
 async fetch(request:Request,env:OperatorEnv){
  const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+env.OPERATOR_TOKEN);
  if(!env.OPERATOR_TOKEN||actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'FORBIDDEN'},{status:403,headers});
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/health')return Response.json({status:'ok',scope:'company-bootstrap-and-maintenance'},{headers});
  if(request.method!=='POST'||!['/provision','/inspect','/maintenance/status','/maintenance/leases','/maintenance/inspect','/maintenance/command','/recovery/security/checkpoint','/recovery/security/reconcile','/recovery/security/inspect','/recovery/security/reissue','/recovery/security/reissue/inspect'].includes(path))return Response.json({error:'NOT_FOUND'},{status:404,headers});
  try{
   const input=await body(request,['/recovery/security/reconcile','/recovery/security/reissue'].includes(path)?1_000_000:4096);
   if(path==='/recovery/security/reissue')return Response.json(await reissueRecoverySecurity(env,input),{headers});
   if(path==='/recovery/security/reissue/inspect')return Response.json(await inspectRecoveryReissue(env.DB,env.OPERATOR_PRINCIPAL,operatorInspect.parse(input).operationId,env.RECOVERY_SECURITY_ID),{headers});
   if(path==='/recovery/security/checkpoint')return Response.json(await securityCheckpoint(env,input),{headers});
   if(path==='/recovery/security/reconcile')return Response.json(await reconcileRecoverySecurity(env,input),{headers});
   if(path==='/recovery/security/inspect')return Response.json(await inspectRecoverySecurity(env.DB,env.OPERATOR_PRINCIPAL,operatorInspect.parse(input).operationId,env.RECOVERY_SECURITY_ID),{headers});
   if(path==='/maintenance/status'){z.object({}).strict().parse(input);return Response.json(await maintenanceStatus(env.DB),{headers});}
   if(path==='/maintenance/leases')return Response.json(await listMaintenanceLeases(env.DB,input),{headers});
   if(path==='/maintenance/inspect')return Response.json(await inspectMaintenanceOperation(env.DB,env.OPERATOR_PRINCIPAL,operatorInspect.parse(input).operationId),{headers});
   if(path==='/maintenance/command')return Response.json(await changeMaintenance(env.DB,env.OPERATOR_PRINCIPAL,maintenanceCommand.parse(input),name=>env.SOLVER.getByName(name).executionState(),env.RECOVERY_SECURITY_ID),{headers});
   if(path==='/provision')await requireRecoverySecurity(env.DB,env.RECOVERY_SECURITY_ID);
   return Response.json(path==='/provision'?await withMaintenance(env.DB,'FOREGROUND',()=>provisionInitialCompany(env.DB,env.OPERATOR_PRINCIPAL,operatorProvision.parse(input))):await inspectProvision(env.DB,env.OPERATOR_PRINCIPAL,operatorInspect.parse(input).operationId),{headers});
  }catch(error){
   if(error instanceof InputError||error instanceof OperatorError||error instanceof MaintenanceError||error instanceof MaintenanceControlError||error instanceof RecoverySecurityError)return Response.json({error:error.code},{status:error.status,headers});
   if(error instanceof z.ZodError)return Response.json({error:'INVALID_INPUT'},{status:400,headers});
   return Response.json({error:'PROVISION_UNAVAILABLE'},{status:500,headers});
  }
 }
} satisfies ExportedHandler<OperatorEnv>;
