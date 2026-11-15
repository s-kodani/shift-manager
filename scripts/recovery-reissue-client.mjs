import {mkdir,realpath,lstat,chmod,rm} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {save} from './backup-lib.mjs';
import {privateRecoveryFile} from './recovery-security-client.mjs';
import {recoveryDigest} from './recovery-security-contract.mjs';
import {recoveryReissueDetails,recoveryReissue,reissueFingerprint,recoveryReissueReceipt} from './recovery-reissue-contract.mjs';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export async function prepareRecoveryReissue(root,target,details){
 const input=recoveryReissueDetails.parse(details),id=randomUUID(),identities=[],credentials=[];
 if(input.restoreId!==target.rehearsalId||input.sourceDatabaseId===target.databaseId)throw new Error('RECOVERY_TARGET_MISMATCH');
 // Sequential local scrypt generation. Plaintext never crosses the API or
 // enters the recovery receipt; persist the handoff before any dispatch.
 for(const u of input.identities){const password=randomBytes(24).toString('base64url');
  identities.push({...u,accountId:randomUUID(),passwordHash:await hashPassword(password)});
  credentials.push({userId:u.userId,email:u.email,initialPassword:password});
 }
 const payload=recoveryReissue.parse({...input,operationId:id,identities});
 if(new TextEncoder().encode(JSON.stringify(payload)).length>900_000)throw new Error('RECOVERY_REISSUE_LIMIT');
 await mkdir(root,{recursive:true,mode:0o700});if(await realpath(path.resolve(root))!==path.resolve(root))throw new Error('RECOVERY_PRIVATE_DIRECTORY_REQUIRED');await chmod(root,0o700);
 const dir=path.resolve(root,id);await mkdir(dir,{mode:0o700});
 const handoff={id,restoreId:input.restoreId,credentials};
 await save(path.join(dir,'handoff.json'),handoff);
 await save(path.join(dir,'operation.json'),{version:'recovery-reissue-command-v1',id,payload,target,fingerprint:await reissueFingerprint(payload,target.databaseId),handoffSha256:await recoveryDigest(handoff),stage:'PREPARED',createdAt:Date.now()});
 return {id,stage:'PREPARED',handoffPath:path.join(dir,'handoff.json')};
}
export async function readRecoveryReissue(root,id){
 if(!UUID.test(id))throw new Error('RECOVERY_OPERATION_ID');const dir=path.resolve(root,id);
 if(await realpath(dir)!==dir||((await lstat(dir)).mode&0o077)!==0)throw new Error('RECOVERY_PRIVATE_DIRECTORY_REQUIRED');
 const owner=await privateRecoveryFile(path.join(dir,'operation.json'));
 if(owner.version==='recovery-reissue-retired-v1'){
  const r=recoveryReissueReceipt.parse(owner.receipt);
  if(owner.id!==id||owner.stage!=='RETIRED'||r.id!==id||r.restore_id!==owner.target.rehearsalId||r.principal!==owner.target.principal||r.fingerprint!==owner.fingerprint||Object.hasOwn(owner,'payload'))throw new Error('RECOVERY_OWNER_INVALID');
  return {dir,owner};
 }
 const handoff=await privateRecoveryFile(path.join(dir,'handoff.json'));
 if(owner.version!=='recovery-reissue-command-v1'||owner.id!==id||owner.payload.operationId!==id||owner.payload.restoreId!==owner.target.rehearsalId||owner.fingerprint!==await reissueFingerprint(owner.payload,owner.target.databaseId)||owner.handoffSha256!==await recoveryDigest(handoff)||!['PREPARED','DISPATCHED','UNCERTAIN','REJECTED','COMMITTED'].includes(owner.stage))throw new Error('RECOVERY_OWNER_INVALID');
 owner.payload=recoveryReissue.parse(owner.payload);return {dir,owner};
}
async function commit(dir,owner,value){
 if(owner.stage==='RETIRED'){
  const r=recoveryReissueReceipt.parse(value);
  if(JSON.stringify(r)!==JSON.stringify(recoveryReissueReceipt.parse(owner.receipt)))throw new Error('RECOVERY_RECEIPT_MISMATCH');
  return {id:owner.id,stage:'RETIRED',restoreId:r.restore_id,revision:r.revision,counts:r.counts};
 }
 const r=recoveryReissueReceipt.parse(value),c=owner.payload;
 const confirmations=c.identities.map(({userId,identityEvidenceRef,authorityEvidenceRef})=>({userId,identityEvidenceRef,authorityEvidenceRef}));
 if(r.id!==owner.id||r.restore_id!==c.restoreId||r.fingerprint!==owner.fingerprint||r.principal!==owner.target.principal||r.backup_id!==c.backupId||r.source_database_id!==c.sourceDatabaseId||r.maintenance_id!==c.maintenanceId||r.revision!==c.expectedRevision+1||r.verified_at!==c.verifiedAt||r.isolation_evidence_ref!==c.isolationEvidenceRef||JSON.stringify(r.confirmations)!==JSON.stringify(confirmations)||r.counts.confirmedUsers!==c.identities.length)throw new Error('RECOVERY_RECEIPT_MISMATCH');
 owner.stage='COMMITTED';owner.receipt=r;owner.confirmedAt=Date.now();await save(path.join(dir,'operation.json'),owner);
 return {id:owner.id,stage:'COMMITTED',restoreId:r.restore_id,revision:r.revision,counts:r.counts};
}
export async function retireRecoveryReissue(root,id){
 const {dir,owner}=await readRecoveryReissue(root,id);
 if(!['COMMITTED','RETIRED'].includes(owner.stage))throw new Error('RECOVERY_COMMITTED_REQUIRED');
 const receipt=recoveryReissueReceipt.parse(owner.receipt);
 // Preserve only nonsecret metadata. A failed unlink can be retried with the
 // same ID; retiring never dispatches another credential update.
 await save(path.join(dir,'operation.json'),{version:'recovery-reissue-retired-v1',id,target:owner.target,fingerprint:owner.fingerprint,stage:'RETIRED',receipt,retiredAt:owner.retiredAt??Date.now()});
 await rm(path.join(dir,'handoff.json'),{force:true});
 return {id,stage:'RETIRED'};
}
export async function inspectRecoveryReissueOwner(root,id,request){
 const {dir,owner}=await readRecoveryReissue(root,id),r=await request('/recovery/security/reissue/inspect',{operationId:id});
 if(r.status!==200)throw new Error('RECOVERY_INSPECTION_UNAVAILABLE');
 if(r.body?.found===false&&Object.keys(r.body).length===1)return {id,stage:owner.stage,found:false};
 return {...await commit(dir,owner,r.body),found:true};
}
export async function sendRecoveryReissue(root,id,request,preflight){
 const {dir,owner}=await readRecoveryReissue(root,id);
 if(!['PREPARED','REJECTED'].includes(owner.stage))throw new Error('RECOVERY_INSPECT_EXISTING_OPERATION');
 if(preflight)await preflight(owner.target);
 owner.stage='DISPATCHED';owner.dispatchedAt=Date.now();await save(path.join(dir,'operation.json'),owner);
 try{const r=await request('/recovery/security/reissue',owner.payload);owner.responseStatus=r.status;owner.producerSettledAt=Date.now();
  if(r.status===200)return await commit(dir,owner,r.body);
  owner.stage=[400,403,409,413,415].includes(r.status)?'REJECTED':'UNCERTAIN';await save(path.join(dir,'operation.json'),owner);throw new Error('RECOVERY_REQUEST_FAILED');
 }catch{if(owner.stage==='DISPATCHED'){owner.stage='UNCERTAIN';owner.producerSettledAt=Date.now();await save(path.join(dir,'operation.json'),owner);}throw new Error(owner.stage==='REJECTED'?'RECOVERY_REQUEST_REJECTED':'RECOVERY_OUTCOME_UNKNOWN');}
}
