// Explicit local rehearsal or one archived final Cloudflare execution. The checkpoint includes credential hashes and
// stays in an owned private file; only IDs/counts are printed.
import {mkdir,lstat,realpath,readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {save,loadManifest} from './backup-lib.mjs';
import {verifyPreAuthRestore} from './backup-schema-upgrade.mjs';
import {privateOperatorToken} from './operator-client.mjs';
import {assertLocalFinalRecoveryDirectConfig} from './local-direct-config.mjs';
import {currentMaintenance} from './maintenance-client.mjs';
import {resolveRecoveryProfile,authenticatedRecoveryOperator,operatorRequest} from './recovery-runtime.mjs';
import {readFinalRecoveryBinding,FINAL_RECOVERY_KIND} from './final-recovery-profile.mjs';
import {recoveryCheckpoint,recoveryDigest} from './recovery-security-contract.mjs';
import {privateRecoveryFile,prepareRecoverySecurity,readRecoverySecurity,sendRecoverySecurity,inspectRecoveryOwner} from './recovery-security-client.mjs';
import {prepareRecoveryReissue,readRecoveryReissue,sendRecoveryReissue,inspectRecoveryReissueOwner,retireRecoveryReissue} from './recovery-reissue-client.mjs';
import {recoveryReissueVerification} from './recovery-reissue-contract.mjs';
const reissueRoot=path.resolve('.cache/recovery-reissue-commands');
const root=path.resolve('.cache/recovery-security-commands'),checkpointRoot=path.resolve('.cache/recovery-security-checkpoints');
const [action,a,b,c,...extra]=process.argv.slice(2),UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest=v=>createHash('sha256').update(v).digest('hex');
let request;
async function selectTarget(p){const c=await authenticatedRecoveryOperator(p,{mutating:['send','reissue-send'].includes(action)});request=operatorRequest(c);return c.cfg;}
try{
 assert.equal(extra.length,0);let result;
 if(action==='capture'&&a&&!b){
  const source=path.resolve(a),id=path.basename(source);assert(UUID.test(id));
  let cfg,configFile,sourceCohort;
  if(source===path.resolve('.cache/final-cloudflare',id)){
   sourceCohort=await readFinalRecoveryBinding(source);const c=await authenticatedRecoveryOperator(sourceCohort.p,{source:true});request=operatorRequest(c);cfg=c.cfg;configFile=sourceCohort.dir+'/source-operator.jsonc';
  }else{
   const finalLocal=source===path.resolve('.cache/bounded-sdk',id);assert(finalLocal||source===path.resolve('.cache/local-recovery-sources',id));assert.equal(await realpath(source),source);assert(((await lstat(source)).mode&0o077)===0);
   cfg=await privateRecoveryFile(path.join(source,'app.jsonc'));if(finalLocal)assertLocalFinalRecoveryDirectConfig(cfg,{config:path.join(source,'app.jsonc'),port:8787});else assert.equal(cfg.vars?.ENVIRONMENT,'local');assert.equal(cfg.vars?.RECOVERY_SECURITY_ID,'');assert.equal(cfg.d1_databases.length,1);
   request=operatorRequest({base:'http://localhost:8788',token:await privateOperatorToken(path.join(source,'secrets.json'))});configFile=path.join(source,'app.jsonc');
  }
  const state=await currentMaintenance(request);assert.equal(state.mode,'FROZEN');
  const r=await request('/recovery/security/checkpoint',{maintenanceId:state.maintenance_id,expectedRevision:state.revision});assert.equal(r.status,200);
  const checkpoint=recoveryCheckpoint.parse(r.body.checkpoint);assert.equal(checkpoint.sourceDatabaseId,cfg.d1_databases[0].database_id);assert.equal(await recoveryDigest(checkpoint),r.body.checkpointSha256);
  await mkdir(checkpointRoot,{recursive:true,mode:0o700});assert.equal(await realpath(checkpointRoot),checkpointRoot);assert(((await lstat(checkpointRoot)).mode&0o077)===0);
  const file=path.join(checkpointRoot,randomUUID()+'.json');await save(file,{checkpoint,checkpointSha256:r.body.checkpointSha256,sourceConfigSha256:digest(await readFile(configFile)),...(sourceCohort?{sourceCohortRoot:sourceCohort.root,sourceBindingSha256:sourceCohort.bindingSha256}:{})});
  result={stage:'CAPTURED',checkpointFile:file,sourceRevision:state.revision};
 }else if(action==='prepare-reissue'&&a&&b&&c){
  const {manifest}=await loadManifest(a),profile=await privateRecoveryFile(b),p=await resolveRecoveryProfile(manifest,b,profile);await verifyPreAuthRestore(a,b);
  const cfg=await selectTarget(p);
  const state=await currentMaintenance(request);assert.equal(state.mode,'FROZEN');
  const details=recoveryReissueVerification.parse(await privateRecoveryFile(c));
  result=await prepareRecoveryReissue(reissueRoot,{databaseId:p.databaseId,rehearsalId:p.rehearsalId,principal:cfg.vars.OPERATOR_PRINCIPAL,profileFile:path.resolve(b),targetIdentity:p.targetIdentity,backupId:a},{...details,restoreId:p.rehearsalId,maintenanceId:state.maintenance_id,expectedRevision:state.revision,backupId:a,sourceDatabaseId:manifest.source.databaseId});
 }else if(action==='reissue-retire'&&a&&!b){
  result=await retireRecoveryReissue(reissueRoot,a);
 }else if(['reissue-send','reissue-inspect'].includes(action)&&a&&!b){
  const {owner}=await readRecoveryReissue(reissueRoot,a),{manifest}=await loadManifest(owner.target.backupId),profile=await privateRecoveryFile(owner.target.profileFile),p=await resolveRecoveryProfile(manifest,owner.target.profileFile,profile);assert.deepEqual(p.targetIdentity,owner.target.targetIdentity);
  assert.equal(owner.payload?.sourceDatabaseId??owner.receipt?.source_database_id,manifest.source.databaseId);assert.equal(owner.payload?.backupId??owner.receipt?.backup_id,manifest.id);
  const cfg=await selectTarget(p);assert.equal(cfg.vars.OPERATOR_PRINCIPAL,owner.target.principal);
  result=action==='reissue-send'?await sendRecoveryReissue(reissueRoot,a,request,t=>verifyPreAuthRestore(t.backupId,t.profileFile)):await inspectRecoveryReissueOwner(reissueRoot,a,request);
 }else if(action==='prepare'&&a&&b&&c){
  const file=path.resolve(c);assert(path.dirname(file)===checkpointRoot&&UUID.test(path.basename(file,'.json')));assert.equal(await realpath(checkpointRoot),checkpointRoot);assert(((await lstat(checkpointRoot)).mode&0o077)===0);
  const sealed=await privateRecoveryFile(file),checkpoint=recoveryCheckpoint.parse(sealed.checkpoint);assert.equal(await recoveryDigest(checkpoint),sealed.checkpointSha256);
  const {manifest}=await loadManifest(a),profile=await privateRecoveryFile(b),p=await resolveRecoveryProfile(manifest,b,profile);
  if(p.kind===FINAL_RECOVERY_KIND){const context=await readFinalRecoveryBinding(p.cohortRoot);assert.equal(sealed.sourceCohortRoot,context.root);assert.equal(sealed.sourceBindingSha256,context.bindingSha256);assert.equal(sealed.sourceConfigSha256,context.binding.files['source-operator.jsonc']);}
  await verifyPreAuthRestore(a,b);
  const cfg=await selectTarget(p);
  const state=await currentMaintenance(request);assert.equal(state.mode,'FROZEN');
  result=await prepareRecoverySecurity(root,{databaseId:p.databaseId,rehearsalId:p.rehearsalId,principal:cfg.vars.OPERATOR_PRINCIPAL,profileFile:path.resolve(b),targetIdentity:p.targetIdentity,backupId:a},{restoreId:p.rehearsalId,maintenanceId:state.maintenance_id,expectedRevision:state.revision,reason:'運営者が現行認証・権限を確認した架空復旧',checkpoint,checkpointSha256:sealed.checkpointSha256});
 }else if(['send','inspect'].includes(action)&&a&&!b){
  const {owner}=await readRecoverySecurity(root,a),{manifest}=await loadManifest(owner.target.backupId),profile=await privateRecoveryFile(owner.target.profileFile),p=await resolveRecoveryProfile(manifest,owner.target.profileFile,profile);assert.deepEqual(p.targetIdentity,owner.target.targetIdentity);
  const cfg=await selectTarget(p);assert.equal(cfg.vars.OPERATOR_PRINCIPAL,owner.target.principal);
  result=action==='send'?await sendRecoverySecurity(root,a,request,t=>verifyPreAuthRestore(t.backupId,t.profileFile)):await inspectRecoveryOwner(root,a,request);
 }else throw new Error('RECOVERY_USAGE');
 console.log(JSON.stringify(result));
}catch(error){console.error(/^RECOVERY_[A-Z_]+$/.test(error.message)?error.message:'RECOVERY_SECURITY_COMMAND_FAILED');process.exitCode=1;}
