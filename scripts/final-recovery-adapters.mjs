import {targetFetch} from './deployment-target.mjs';
// Reuses the existing maintenance, backup, schema and auth protocols. Remote
// callers must resolve the immutable execution before this factory reads keys.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {save,startBackup,restoreBackup,verifyRestored} from './backup-lib.mjs';
import {prepareSchemaUpgrade,applySchemaUpgrade} from './backup-schema-upgrade.mjs';
import {prepareMaintenance,sendMaintenance,currentMaintenance} from './maintenance-client.mjs';
import {resolveFinalMaintenance} from './final-maintenance-runtime.mjs';
import {readFinalRecoveryBinding,assertFinalRecoveryCurrentSource} from './final-recovery-profile.mjs';
import {privateRecoveryFile} from './recovery-security-client.mjs';
import {finalRecoveryProduct} from './final-recovery-product.mjs';
import {operatorRequest} from './recovery-runtime.mjs';
import {boundedJson} from './operator-client.mjs';
import {verifyRecoveryAssets} from './final-recovery-assets.mjs';
async function security(args){
 const r=await promisify(execFile)(process.execPath,['scripts/recovery-security.mjs',...args],{timeout:240000,maxBuffer:1_000_000});const lines=r.stdout.trim().split('\n');assert.equal(lines.length,1);return JSON.parse(lines[0]);
}
export async function finalRecoveryAdapters(env){
 const {root,info,pocToken}=env,c=await readFinalRecoveryBinding(root);assertFinalRecoveryCurrentSource({...c.p,targetIdentity:{sourceCommit:c.release.sourceCommit}});
 const fixtures=await privateRecoveryFile(root+'/acceptance/fixtures.json'),credentials=await privateRecoveryFile(root+'/acceptance/recovery-credentials.json'),jar=await privateRecoveryFile(root+'/acceptance/sessions.json'),report=await privateRecoveryFile(info.artifact+'/final-acceptance.json');
 const targetKeys=await privateRecoveryFile(c.dir+'/secrets.json');assert(targetKeys.POC_TOKEN?.length>=32);
 const assetManifest=await privateRecoveryFile(root+'/cohort/asset-manifest.json');
 return composeFinalRecoveryAdapters(env,c,{fixtures,credentials,jar,report,targetKeys,assetManifest});
}
export async function composeFinalRecoveryAdapters(env,c,{fixtures,credentials,jar,report,targetKeys,existingCookies,assetManifest},services={}){
 const {root,info,pocToken}=env;const api={security,save,startBackup,restoreBackup,verifyRestored,prepareSchemaUpgrade,applySchemaUpgrade,resolveFinalMaintenance,privateRecoveryFile,fetch:targetFetch,...services};
 const cookies=existingCookies??{source:structuredClone(jar),current:structuredClone(jar)},privateFile=c.dir+'/product-private.json';
 const persist=()=>api.save(privateFile,{cookies});await persist();
 const source=finalRecoveryProduct({fixtures,ids:report.ids,base:env.base,token:pocToken,cookies:{source:jar,current:jar},credentials,fetchImpl:api.fetch}),target=finalRecoveryProduct({fixtures,ids:report.ids,base:c.binding.target.appOrigin,token:targetKeys.POC_TOKEN,cookies,credentials,persist,fetchImpl:api.fetch});
 const assetCookie=side=>Object.entries((side==='source'?jar:cookies.current).singleStaff??{}).map(([k,v])=>k+'='+v).join('; ');
 const assets=side=>verifyRecoveryAssets({manifest:assetManifest,base:side==='source'?env.base:c.binding.target.appOrigin,token:side==='source'?pocToken:targetKeys.POC_TOKEN,cookie:assetCookie(side),request:api.fetch});
 async function maintenance(side,action,state,{remember}){
  const ctx=await api.resolveFinalMaintenance(c.profileFile,side,{mutating:true}),request=operatorRequest(ctx,api.fetch,16384),before=await currentMaintenance(request);
  assert.equal(before.activeJobs,0);assert.equal(before.activeLeases,0);assert.equal(before.activeRevalidations,0);
  assert.equal(before.mode,action==='begin'?'OPEN':action==='freeze'?'DRAINING':'FROZEN');
  const prepared=await prepareMaintenance(ctx.root,{action,expectedRevision:before.revision,reason:'架空の最終一括・技術復旧',...(action==='begin'?{}:{maintenanceId:before.maintenance_id})});await remember(side+'-'+action,prepared.id);
  const sent=await sendMaintenance(ctx.root,prepared.id,request);assert.equal(sent.stage,'COMMITTED');const after=await currentMaintenance(request);assert.equal(after.mode,action==='begin'?'DRAINING':action==='freeze'?'FROZEN':'OPEN');assert.equal(after.revision,before.revision+1);return {id:prepared.id,mode:after.mode,revision:after.revision};
 }
 return {
  SOURCE_DOCUMENTS:async()=>({assets:await assets('source'),records:await source.capture()}),
  SOURCE_FREEZE:async(s,h)=>{await maintenance('source','begin',s,h);return maintenance('source','freeze',s,h);},
  CHECKPOINT:async(s,h)=>{const r=await api.security(['capture',root]);assert.equal(r.stage,'CAPTURED');await rememberCheckpoint(r,h);return {stage:r.stage};},
  BACKUP:async s=>{const {manifest}=await api.startBackup(true,{id:s.backupId});assert.equal(manifest.state,'COMPLETE');return {id:manifest.id,tables:Object.keys(manifest.catalog.tables).length,objects:manifest.catalog.objects.length};},
  RESTORE:async s=>{const r=await api.restoreBackup(s.backupId,c.profileFile);assert.equal(r.stage,'COMPLETE');return {backupId:s.backupId,rehearsalId:r.rehearsalId,stage:r.stage};},
  RESTORE_CONTENTS:async s=>{const r=await api.verifyRestored(s.backupId,c.profileFile);assert.equal(r.databaseMatches,true);assert.equal(r.foreignKeyViolations,0);return r;},
  TARGET_GUARD:()=>target.guarded(),
  SCHEMA_PREPARE:async s=>{const r=await api.prepareSchemaUpgrade(s.backupId,c.profileFile);assert.equal(r.stage,'PREPARED');return r;},
  SCHEMA_APPLY:async s=>{const r=await api.applySchemaUpgrade(s.backupId,c.profileFile);assert.equal(r.stage,'VERIFIED');return r;},
  AUTH_PREPARE:async(s,h)=>{const r=await api.security(['prepare',s.backupId,c.profileFile,s.children.checkpoint]);assert.equal(r.stage,'PREPARED');await h.remember('authOperation',r.id);return r;},
  AUTH_APPLY:async s=>{const r=await api.security(['send',s.children.authOperation]);assert.equal(r.stage,'COMMITTED');assert(r.counts.removedSessions>=4);const cp=await api.privateRecoveryFile(s.children.checkpoint);assert.equal(r.counts.confirmedUsers,cp.checkpoint.users.length);return r;},
  TARGET_RESUME:(s,h)=>maintenance('target','resume',s,h),
  TARGET_LOGIN:()=>target.login(),
  RESTORED_DOCUMENTS:async s=>{const restoredAssets=await assets('target'),original=s.phases.find(p=>p.name==='SOURCE_DOCUMENTS').result;assert.deepEqual(restoredAssets,original.assets,'FINAL_RESTORED_ASSETS_CHANGED');const records=await target.capture();assert.deepEqual(records,original.records,'FINAL_RESTORED_PRODUCT_CHANGED');return {records,matchedResponses:22,assets:restoredAssets,matchedAssetResponses:restoredAssets.length};},
  TARGET_RETIRE:async()=>{
   for(const f of Object.values(fixtures)){
    const request=async action=>{const r=await api.fetch(c.binding.target.appOrigin+'/__poc/final-control',{method:'POST',headers:{authorization:'Bearer '+targetKeys.POC_TOKEN,'content-type':'application/json'},body:JSON.stringify({ownerId:f.ownerId,action}),redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return boundedJson(r);};
    const status=await request('status');assert.equal(status.ownerId,f.ownerId);assert(status.jobs.every(j=>j.state==='SUCCEEDED'));assert(status.execution&&!status.execution.activeRpc&&!status.execution.persistedFence&&!status.execution.persistedCheckFence&&!status.execution.processRunning);
    const cleaned=await request('cleanup');assert.equal(cleaned.cleaned,true);assert.deepEqual(cleaned.credentials,{enabled:0,sessions:0,passwords:0});
   }return {fixturesRetired:2,credentialsRemaining:0};
  },
  SOURCE_RESUME:(s,h)=>maintenance('source','resume',s,h),
  PRIVATE_RETIRE:async s=>{await unlink(privateFile);await unlink(s.children.checkpoint);return {productCookiesRemoved:true,sealedCheckpointRemoved:true,sourceCleanupStillRequired:true,authOperationRetainedPrivate:true};},
 };
 async function rememberCheckpoint(r,h){assert.equal(path.dirname(r.checkpointFile),path.resolve('.cache/recovery-security-checkpoints'));assert.match(path.basename(r.checkpointFile),/^[a-f0-9-]{36}\.json$/);await h.remember('checkpoint',r.checkpointFile);}
}
