import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {verifyPassword} from 'better-auth/crypto';
import {save} from '../../scripts/backup-lib.mjs';
import {recoveryReissueDetails,recoveryReissueVerification} from '../../scripts/recovery-reissue-contract.mjs';
import {prepareRecoveryReissue,readRecoveryReissue,sendRecoveryReissue,inspectRecoveryReissueOwner,retireRecoveryReissue} from '../../scripts/recovery-reissue-client.mjs';
async function fixture(){
 const root=await mkdtemp(path.resolve('.cache/recovery-reissue-test-')),target={databaseId:randomUUID(),rehearsalId:randomUUID(),principal:'fictional-operator'},userId=randomUUID();
 const details={restoreId:target.rehearsalId,maintenanceId:randomUUID(),expectedRevision:2,backupId:randomUUID(),sourceDatabaseId:randomUUID(),sourceUnavailable:true,oldEnvironmentIsolated:true,isolationEvidenceRef:'fictional-isolation',verifiedAt:Date.now(),reason:'架空の別途本人確認',identities:[{userId,email:'fictional@example.invalid',identityEvidenceRef:'fictional-identity',authorityEvidenceRef:'fictional-authority',companyAdminIds:[randomUUID()],memberships:[]}]};
 const created=await prepareRecoveryReissue(root,target,details),{dir,owner}=await readRecoveryReissue(root,created.id),c=owner.payload;
 const receipt={found:true,id:c.operationId,restore_id:c.restoreId,principal:target.principal,fingerprint:owner.fingerprint,backup_id:c.backupId,source_database_id:c.sourceDatabaseId,isolation_evidence_ref:c.isolationEvidenceRef,verified_at:c.verifiedAt,maintenance_id:c.maintenanceId,revision:3,reason:c.reason,created_at:Date.now(),confirmations:c.identities.map(({userId,identityEvidenceRef,authorityEvidenceRef})=>({userId,identityEvidenceRef,authorityEvidenceRef})),counts:{restoredUsers:1,confirmedUsers:1,removedSessions:0,removedResetTokens:0}};
 return {root,target,details,created,dir,owner,receipt};
}
test('operator verification is explicit, unique and bounded; arbitrary hashes/passwords and staff without a bound identity are refused',async()=>{
 const f=await fixture();try{
  const {sourceUnavailable,oldEnvironmentIsolated,isolationEvidenceRef,verifiedAt,reason,identities}=f.details;
  const verification={sourceUnavailable,oldEnvironmentIsolated,isolationEvidenceRef,verifiedAt,reason,identities};
  assert.equal(recoveryReissueVerification.safeParse(verification).success,true);
  assert.equal(recoveryReissueVerification.safeParse({...verification,restoreId:randomUUID()}).success,false);
  for(const changed of [{sourceUnavailable:false},{oldEnvironmentIsolated:false},{isolationEvidenceRef:'PII free-form text'},{identities:[]},{identities:[...f.details.identities,...f.details.identities]},{identities:[{...f.details.identities[0],initialPassword:'must not accept'}]},{identities:[{...f.details.identities[0],memberships:[{companyId:randomUUID(),teamId:randomUUID(),role:'staff',staffId:null}]}]}])assert.equal(recoveryReissueDetails.safeParse({...f.details,...changed}).success,false);
 }finally{await rm(f.root,{recursive:true});}
});
test('fresh random handoff is private and persists before transport; only its hash enters the API and nothing secret is printed',async()=>{
 const f=await fixture();try{
  const handoff=JSON.parse(await readFile(f.created.handoffPath,'utf8')),password=handoff.credentials[0].initialPassword;
  assert.match(password,/^[A-Za-z0-9_-]{32}$/);assert.equal(await verifyPassword({hash:f.owner.payload.identities[0].passwordHash,password}),true);
  assert.equal(JSON.stringify(f.created).includes(password),false);
  const result=await sendRecoveryReissue(f.root,f.created.id,async(route,body)=>{
   assert.equal(route,'/recovery/security/reissue');assert.equal((await readRecoveryReissue(f.root,f.created.id)).owner.stage,'DISPATCHED');assert(!JSON.stringify(body).includes(password));return {status:200,body:f.receipt};
  });assert.equal(result.stage,'COMMITTED');assert(!JSON.stringify(result).includes(password));
  await assert.rejects(sendRecoveryReissue(f.root,f.created.id,()=>{throw Error('never resend');}),/INSPECT_EXISTING/);
 }finally{await rm(f.root,{recursive:true});}
});
test('uncertain outcomes keep the handoff and same ID; missing inspection never authorizes a new POST',async()=>{
 const f=await fixture();try{
  await assert.rejects(sendRecoveryReissue(f.root,f.created.id,async()=>{throw Error('untrusted provider detail');}),/^Error: RECOVERY_OUTCOME_UNKNOWN$/);
  assert.equal((await readRecoveryReissue(f.root,f.created.id)).owner.stage,'UNCERTAIN');
  await assert.rejects(retireRecoveryReissue(f.root,f.created.id),/COMMITTED_REQUIRED/);
  assert.equal((await inspectRecoveryReissueOwner(f.root,f.created.id,async()=>({status:200,body:{found:false}}))).found,false);
  await assert.rejects(sendRecoveryReissue(f.root,f.created.id,()=>{throw Error('never resend');}),/INSPECT_EXISTING/);
  assert.equal((await inspectRecoveryReissueOwner(f.root,f.created.id,async()=>({status:200,body:f.receipt}))).stage,'COMMITTED');
 }finally{await rm(f.root,{recursive:true});}
});
test('mismatched receipt principal, proof, source, nonce or extra secret fields cannot authorize committed state',async()=>{
 for(const changed of [{principal:'other'},{backup_id:randomUUID()},{restore_id:randomUUID()},{confirmations:[]},{password:'extra-secret'}]){
  const f=await fixture();try{await assert.rejects(sendRecoveryReissue(f.root,f.created.id,async()=>({status:200,body:{...f.receipt,...changed}})),/OUTCOME_UNKNOWN/);assert.equal((await readRecoveryReissue(f.root,f.created.id)).owner.stage,'UNCERTAIN');}finally{await rm(f.root,{recursive:true});}
 }
});
test('private owner/handoff permissions and contents are checked before dispatch; failed SQL/R2 proof stays unsent',async()=>{
 const f=await fixture();try{
  await assert.rejects(sendRecoveryReissue(f.root,f.created.id,()=>{throw Error('no request');},async()=>{throw Error('RESTORED_CONTENT_DIFFERENT');}),/RESTORED_CONTENT_DIFFERENT/);assert.equal((await readRecoveryReissue(f.root,f.created.id)).owner.stage,'PREPARED');
  await chmod(f.created.handoffPath,0o644);await assert.rejects(readRecoveryReissue(f.root,f.created.id),/PRIVATE_FILE/);await chmod(f.created.handoffPath,0o600);
  const handoff=JSON.parse(await readFile(f.created.handoffPath,'utf8'));handoff.credentials[0].initialPassword='modified';await save(f.created.handoffPath,handoff);await assert.rejects(readRecoveryReissue(f.root,f.created.id),/OWNER_INVALID/);
 }finally{await rm(f.root,{recursive:true});}
});
test('handoff retirement refuses uncertain outcomes and removes plaintext/hash payload while retaining same-ID readonly inspection',async()=>{
 const f=await fixture();try{
  await assert.rejects(retireRecoveryReissue(f.root,f.created.id),/COMMITTED_REQUIRED/);
  await sendRecoveryReissue(f.root,f.created.id,async()=>({status:200,body:f.receipt}));
  assert.equal((await retireRecoveryReissue(f.root,f.created.id)).stage,'RETIRED');
  await assert.rejects(readFile(f.created.handoffPath),{code:'ENOENT'});
  const metadata=await readFile(path.join(f.dir,'operation.json'),'utf8');assert(!metadata.includes('passwordHash'));assert(!metadata.includes('initialPassword'));assert(!metadata.includes('fictional@example.invalid'));
  await assert.rejects(sendRecoveryReissue(f.root,f.created.id,()=>{throw Error('no mutation');}),/INSPECT_EXISTING/);
  assert.equal((await inspectRecoveryReissueOwner(f.root,f.created.id,async()=>({status:200,body:f.receipt}))).stage,'RETIRED');
  assert.equal((await retireRecoveryReissue(f.root,f.created.id)).stage,'RETIRED');
 }finally{await rm(f.root,{recursive:true});}
});
