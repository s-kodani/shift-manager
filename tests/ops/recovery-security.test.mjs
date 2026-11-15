import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,symlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {save} from '../../scripts/backup-lib.mjs';
import {recoveryCheckpoint,recoveryDigest,recoveryFingerprint} from '../../scripts/recovery-security-contract.mjs';
import {prepareRecoverySecurity,readRecoverySecurity,sendRecoverySecurity,inspectRecoveryOwner,privateRecoveryFile} from '../../scripts/recovery-security-client.mjs';
async function fixture(){
 const root=await mkdtemp(path.resolve('.cache/recovery-security-test-'));
 const target={databaseId:randomUUID(),rehearsalId:randomUUID(),principal:'fictional-operator'},at=Date.now();
 const cp={schema:'recovery-security-checkpoint-v1',sourceDatabaseId:randomUUID(),maintenanceId:randomUUID(),revision:4,capturedAt:at,expiresAt:at+900000,users:[],accounts:[],access:[],admins:[],members:[],legacy:[]};
 const details={restoreId:target.rehearsalId,maintenanceId:randomUUID(),expectedRevision:2,reason:'架空権限を確認',checkpoint:cp,checkpointSha256:await recoveryDigest(cp)};
 const created=await prepareRecoverySecurity(root,target,details),{dir,owner}=await readRecoverySecurity(root,created.id),c=owner.payload;
 const receipt={found:true,id:created.id,restore_id:c.restoreId,principal:target.principal,fingerprint:owner.fingerprint,source_database_id:cp.sourceDatabaseId,source_maintenance_id:cp.maintenanceId,source_revision:4,source_captured_at:at,source_sha256:c.checkpointSha256,maintenance_id:c.maintenanceId,revision:3,reason:c.reason,created_at:Date.now(),counts:{restoredUsers:0,confirmedUsers:0,removedSessions:0,removedResetTokens:0}};
 return {root,dir,owner,created,receipt,target,details,cp};
}
test('security contract bounds complete checkpoints and rejects duplicate identities, orphan rights, mixed credentials and expiry changes',async()=>{
 const f=await fixture();try{
  const id=randomUUID(),u={id,email:'fictional@example.invalid',emailVerified:0,role:'user',banned:0,banReason:null,banExpires:null};
  for(const cp of [{...f.cp,users:[u,u]},{...f.cp,access:[{user_id:id,enabled:1,must_change_password:0}]},{...f.cp,users:[u],accounts:[{id:randomUUID(),accountId:randomUUID(),userId:id,password:'fictional-credential-hash',createdAt:0,updatedAt:0}]},{...f.cp,expiresAt:f.cp.expiresAt+1}])assert.equal(recoveryCheckpoint.safeParse(cp).success,false);
  assert.notEqual(await recoveryFingerprint(f.owner.payload,randomUUID()),f.owner.fingerprint);
 }finally{await rm(f.root,{recursive:true});}
});
test('security CLI persists dispatch before transport and confirms only its exact namespace and source receipt',async()=>{
 const f=await fixture();try{
  const result=await sendRecoverySecurity(f.root,f.created.id,async(route,payload)=>{
   assert.equal(route,'/recovery/security/reconcile');assert.equal(payload.operationId,f.created.id);assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'DISPATCHED');
   return {status:200,body:f.receipt};
  });assert.equal(result.stage,'COMMITTED');assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'COMMITTED');
  await assert.rejects(sendRecoverySecurity(f.root,f.created.id,()=>{throw Error('must not dispatch');}),/INSPECT_EXISTING/);
 }finally{await rm(f.root,{recursive:true});}
});
test('lost security response is inspected by the same ID and absence never authorizes an automatic new dispatch',async()=>{
 const f=await fixture();try{
  await assert.rejects(sendRecoverySecurity(f.root,f.created.id,async()=>{throw Error('fictional provider secret must not escape');}),/^Error: RECOVERY_OUTCOME_UNKNOWN$/);
  assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'UNCERTAIN');
  assert.equal((await inspectRecoveryOwner(f.root,f.created.id,async()=>({status:200,body:{found:false}}))).found,false);
  await assert.rejects(sendRecoverySecurity(f.root,f.created.id,()=>{throw Error('must not dispatch');}),/INSPECT_EXISTING/);
  const observed=await inspectRecoveryOwner(f.root,f.created.id,async(route,body)=>{assert.equal(route,'/recovery/security/inspect');assert.equal(body.operationId,f.created.id);return {status:200,body:f.receipt};});assert.equal(observed.stage,'COMMITTED');
 }finally{await rm(f.root,{recursive:true});}
});
test('mismatched namespace/principal/receipt and raw credential fields remain uncertain rather than accepted',async()=>{
 for(const changed of [{restore_id:randomUUID()},{source_sha256:'0'.repeat(64)},{principal:'other'},{password:'fictional-password'}]){
  const f=await fixture();try{await assert.rejects(sendRecoverySecurity(f.root,f.created.id,async()=>({status:200,body:{...f.receipt,...changed}})),/OUTCOME_UNKNOWN/);assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'UNCERTAIN');}finally{await rm(f.root,{recursive:true});}
 }
});
test('private recovery files refuse broad permissions, symlinks and edited command fingerprints before dispatch',async()=>{
 const f=await fixture();try{
  const file=path.join(f.dir,'operation.json');await chmod(file,0o644);await assert.rejects(privateRecoveryFile(file),/PRIVATE_FILE/);await chmod(file,0o600);
  const link=path.join(f.dir,'link.json');await symlink(file,link);await assert.rejects(privateRecoveryFile(link),/PRIVATE_FILE/);
  const owner=JSON.parse(await readFile(file,'utf8'));owner.payload.reason='別の理由';await save(file,owner);await assert.rejects(readRecoverySecurity(f.root,f.created.id),/OWNER_INVALID/);
 }finally{await rm(f.root,{recursive:true});}
});
test('failed pre-auth content proof leaves the same security command unsent; a successful proof precedes dispatch',async()=>{
 const f=await fixture();try{
  let requests=0,proofs=0;
  await assert.rejects(sendRecoverySecurity(f.root,f.created.id,async()=>{requests++;return {status:200,body:f.receipt};},async target=>{proofs++;assert.deepEqual(target,f.target);throw new Error('RESTORED_DB_CATALOG_DIFFERENT');}),/RESTORED_DB_CATALOG_DIFFERENT/);
  assert.equal(requests,0);assert.equal(proofs,1);assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'PREPARED');
  const r=await sendRecoverySecurity(f.root,f.created.id,async()=>{requests++;assert.equal(proofs,2);assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'DISPATCHED');return {status:200,body:f.receipt};},async()=>{proofs++;assert.equal((await readRecoverySecurity(f.root,f.created.id)).owner.stage,'PREPARED');});
  assert.equal(r.stage,'COMMITTED');assert.equal(requests,1);
  await assert.rejects(sendRecoverySecurity(f.root,f.created.id,()=>{requests++;},()=>{proofs++;}),/INSPECT_EXISTING/);assert.equal(proofs,2);assert.equal(requests,1);
 }finally{await rm(f.root,{recursive:true});}
});
