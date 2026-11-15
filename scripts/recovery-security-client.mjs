import {readFile,mkdir,realpath,lstat,chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {save} from './backup-lib.mjs';
import {recoveryReconcile,recoveryFingerprint,recoveryReceipt} from './recovery-security-contract.mjs';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export async function privateRecoveryFile(file){
 const name=path.resolve(file),s=await lstat(name);
 if(await realpath(name)!==name||!s.isFile()||(s.mode&0o077)!==0||s.size>2_000_000)throw new Error('RECOVERY_PRIVATE_FILE_REQUIRED');
 return JSON.parse(await readFile(name,'utf8'));
}
export async function prepareRecoverySecurity(root,target,details){
 const id=randomUUID(),payload=recoveryReconcile.parse({...details,operationId:id}),fingerprint=await recoveryFingerprint(payload,target.databaseId);
 if(payload.restoreId!==target.rehearsalId)throw new Error('RECOVERY_TARGET_MISMATCH');
 if(new TextEncoder().encode(JSON.stringify(payload.checkpoint)).length>900_000)throw new Error('RECOVERY_CHECKPOINT_LIMIT');
 await mkdir(root,{recursive:true,mode:0o700});if(await realpath(path.resolve(root))!==path.resolve(root))throw new Error('RECOVERY_PRIVATE_DIRECTORY_REQUIRED');await chmod(root,0o700);
 const dir=path.resolve(root,id);await mkdir(dir,{mode:0o700});
 const owner={version:'recovery-security-command-v1',id,payload,fingerprint,target,stage:'PREPARED',createdAt:Date.now()};
 await save(path.join(dir,'operation.json'),owner);return {id,stage:'PREPARED'};
}
export async function readRecoverySecurity(root,id){
 if(!UUID.test(id))throw new Error('RECOVERY_OPERATION_ID');const dir=path.resolve(root,id);
 if(await realpath(dir)!==dir||((await lstat(dir)).mode&0o077)!==0)throw new Error('RECOVERY_PRIVATE_DIRECTORY_REQUIRED');
 const owner=await privateRecoveryFile(path.join(dir,'operation.json'));
 if(owner.version!=='recovery-security-command-v1'||owner.id!==id||owner.payload.operationId!==id||owner.payload.restoreId!==owner.target.rehearsalId||owner.fingerprint!==await recoveryFingerprint(owner.payload,owner.target.databaseId)||!['PREPARED','DISPATCHED','UNCERTAIN','REJECTED','COMMITTED'].includes(owner.stage))throw new Error('RECOVERY_OWNER_INVALID');
 owner.payload=recoveryReconcile.parse(owner.payload);return {dir,owner};
}
async function commit(dir,owner,value){
 const r=recoveryReceipt.parse(value),c=owner.payload;
 if(r.id!==owner.id||r.restore_id!==c.restoreId||r.fingerprint!==owner.fingerprint||r.maintenance_id!==c.maintenanceId||r.revision!==c.expectedRevision+1||r.source_sha256!==c.checkpointSha256||r.source_database_id!==c.checkpoint.sourceDatabaseId||r.principal!==owner.target.principal)throw new Error('RECOVERY_RECEIPT_MISMATCH');
 owner.stage='COMMITTED';owner.receipt=r;owner.confirmedAt=Date.now();await save(path.join(dir,'operation.json'),owner);
 return {id:owner.id,stage:'COMMITTED',restoreId:r.restore_id,revision:r.revision,counts:r.counts};
}
export async function inspectRecoveryOwner(root,id,request){
 const {dir,owner}=await readRecoverySecurity(root,id),r=await request('/recovery/security/inspect',{operationId:id});
 if(r.status!==200)throw new Error('RECOVERY_INSPECTION_UNAVAILABLE');
 if(r.body?.found===false&&Object.keys(r.body).length===1)return {id,stage:owner.stage,found:false};
 return {...await commit(dir,owner,r.body),found:true};
}
export async function sendRecoverySecurity(root,id,request,preflight){
 const {dir,owner}=await readRecoverySecurity(root,id);
 if(!['PREPARED','REJECTED'].includes(owner.stage))throw new Error('RECOVERY_INSPECT_EXISTING_OPERATION');
 // The local CLI rechecks SQL/R2 after preparation, before recording or sending
 // any credential mutation. A failed proof leaves this operation unsent.
 if(preflight)await preflight(owner.target);
 owner.stage='DISPATCHED';owner.dispatchedAt=Date.now();await save(path.join(dir,'operation.json'),owner);
 try{
  const r=await request('/recovery/security/reconcile',owner.payload);owner.responseStatus=r.status;owner.producerSettledAt=Date.now();
  if(r.status===200)return await commit(dir,owner,r.body);
  owner.stage=[400,403,409,413,415].includes(r.status)?'REJECTED':'UNCERTAIN';await save(path.join(dir,'operation.json'),owner);
  throw new Error('RECOVERY_REQUEST_FAILED');
 }catch{
  if(owner.stage==='DISPATCHED'){owner.stage='UNCERTAIN';owner.producerSettledAt=Date.now();await save(path.join(dir,'operation.json'),owner);}
  throw new Error(owner.stage==='REJECTED'?'RECOVERY_REQUEST_REJECTED':'RECOVERY_OUTCOME_UNKNOWN');
 }
}
