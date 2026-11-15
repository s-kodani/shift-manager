import {mkdir,chmod,readFile,realpath,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {maintenanceCommand,maintenanceReceipt,maintenanceState,maintenanceFingerprint,maintenanceLeaseQuery,maintenanceLeases} from './maintenance-contract.mjs';
import {save} from './backup-lib.mjs';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function location(root,id){
 if(!UUID.test(id))throw new Error('MAINTENANCE_INVALID_ID');
 const dir=path.resolve(root,id);if(await realpath(dir)!==dir||((await stat(dir)).mode&0o077)!==0)throw new Error('MAINTENANCE_PRIVATE_DIRECTORY_REQUIRED');return dir;
}
export async function prepareMaintenance(root,input){
 const id=randomUUID(),payload=maintenanceCommand.parse({...input,operationId:id});
 await mkdir(root,{recursive:true,mode:0o700});if(await realpath(path.resolve(root))!==path.resolve(root))throw new Error('MAINTENANCE_PRIVATE_DIRECTORY_REQUIRED');await chmod(root,0o700);
 const dir=path.resolve(root,id);await mkdir(dir,{mode:0o700});
 await save(path.join(dir,'operation.json'),{version:'maintenance-command-v1',id,payload,fingerprint:await maintenanceFingerprint(payload),stage:'PREPARED'});
 return {id,action:payload.action,stage:'PREPARED'};
}
export async function readMaintenance(root,id){
 const dir=await location(root,id),file=path.join(dir,'operation.json');
 if(await realpath(file)!==file||((await stat(file)).mode&0o077)!==0||(await stat(file)).size>8000)throw new Error('MAINTENANCE_PRIVATE_FILE_REQUIRED');
 const owner=JSON.parse(await readFile(file,'utf8'));owner.payload=maintenanceCommand.parse(owner.payload);
 if(owner.version!=='maintenance-command-v1'||owner.id!==id||owner.payload.operationId!==id||owner.fingerprint!==await maintenanceFingerprint(owner.payload)||!['PREPARED','DISPATCHED','UNCERTAIN','REJECTED','COMMITTED'].includes(owner.stage))throw new Error('MAINTENANCE_INVALID_OWNER');
 return {dir,owner};
}
async function commit(dir,owner,value){
 const receipt=maintenanceReceipt.parse(value);
 const mode=['begin','reclaim','retire'].includes(owner.payload.action)?'DRAINING':owner.payload.action==='freeze'?'FROZEN':'OPEN';
 const session=owner.payload.action==='begin'?owner.id:owner.payload.action==='resume'?null:owner.payload.maintenanceId;
 if(receipt.id!==owner.id||receipt.fingerprint!==owner.fingerprint||receipt.revision!==owner.payload.expectedRevision+1||receipt.action!==owner.payload.action||receipt.mode!==mode||receipt.maintenance_id!==session)throw new Error('MAINTENANCE_RECEIPT_MISMATCH');
 owner.receipt=receipt;owner.stage='COMMITTED';await save(path.join(dir,'operation.json'),owner);
 // Historical receipt is not evidence of the database's current mode.
 return {id:owner.id,stage:'COMMITTED',receiptMode:receipt.mode,receiptRevision:receipt.revision};
}
export async function inspectMaintenance(root,id,request){
 const {dir,owner}=await readMaintenance(root,id),r=await request('/maintenance/inspect',{operationId:id});
 if(r.status!==200)throw new Error('MAINTENANCE_INSPECTION_UNAVAILABLE');
 if(r.body?.found===false&&Object.keys(r.body).length===1)return {id,stage:owner.stage,found:false};
 return {...await commit(dir,owner,r.body),found:true};
}
export async function sendMaintenance(root,id,request){
 const {dir,owner}=await readMaintenance(root,id);
 if(owner.stage==='COMMITTED')return inspectMaintenance(root,id,request);
 owner.stage='DISPATCHED';await save(path.join(dir,'operation.json'),owner);
 try{
  const r=await request('/maintenance/command',owner.payload);
  if(r.status===200)return await commit(dir,owner,r.body);
  owner.stage=r.status>=400&&r.status<500?'REJECTED':'UNCERTAIN';await save(path.join(dir,'operation.json'),owner);
 }catch{owner.stage='UNCERTAIN';await save(path.join(dir,'operation.json'),owner);}
 throw new Error(owner.stage==='REJECTED'?'MAINTENANCE_COMMAND_REJECTED':'MAINTENANCE_OUTCOME_UNKNOWN');
}
export async function currentMaintenance(request){
 const r=await request('/maintenance/status',{});if(r.status!==200)throw new Error('MAINTENANCE_INSPECTION_UNAVAILABLE');return maintenanceState.parse(r.body);
}
export async function listMaintenanceLeases(request,cursor=null){
 const r=await request('/maintenance/leases',maintenanceLeaseQuery.parse({cursor}));
 if(r.status!==200)throw new Error('MAINTENANCE_INSPECTION_UNAVAILABLE');return maintenanceLeases.parse(r.body);
}
